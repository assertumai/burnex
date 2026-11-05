import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { BurnexError } from '../../../kernel/errors.js';
import { envName, readEngineEnv } from '../../../kernel/env-names.js';
import { mergeJobData } from '../run/journal/data.js';
import { atomicWrite } from '../run/journal/writer.js';

/**
 * Библиотека шага `burnex/step`: тонкая обвязка над контрактом файлов
 * (`docs/pipeline-format.md`, раздел `script`), а не второй способ его
 * исполнить. Пять функций, ровно то, что контракт уже обещает: `input()`
 * читает `input.json`, `output()` пишет `output.json`, `publish()` зовёт тот
 * же писатель, что и `burnex data`, `log()` — обычный `console.log`,
 * `exec()` — дочерний процесс без оболочки.
 *
 * Работает по одним лишь `BURNEX_INPUT`, `BURNEX_OUTPUT` и
 * `BURNEX_JOB_DIR` (design.md, решение 10): ни путей, ни идентификаторов
 * аргументами не принимает, и потому годится в любом процессе, унаследовавшем
 * окружение шага, — не только в самом файле скрипта.
 */

function requireEnv(suffix: string): string {
  const value = readEngineEnv(process.env, suffix, { warn: false });
  if (value === undefined || value.trim() === '') {
    throw new BurnexError('Библиотека burnex/step работает только внутри шага прогона', {
      hint: `Переменная ${envName(suffix)} приходит от движка в окружении шага script; вне прогона читать и писать некуда`,
    });
  }
  return value;
}

/** Прочитать и разобрать вход шага. Файл существует всегда — ветки «входа нет» здесь нет. */
export function input<T = unknown>(): T {
  return JSON.parse(readFileSync(requireEnv('INPUT'), 'utf8')) as T;
}

/** Записать выход шага целиком и атомарно. Повторный вызов заменяет записанное, а не дописывает. */
export function output(value: unknown): void {
  atomicWrite(requireEnv('OUTPUT'), `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Дописать данные работы. Тот же писатель, что и `burnex data set|merge`
 * (`mergeJobData`) — второго на `data.json` не заводится: ключ, которого
 * работа не объявляла, отказывает тем же сообщением, что и команда.
 */
export function publish(key: string, value: string): void;
export function publish(values: Readonly<Record<string, string>>): void;
export function publish(keyOrValues: string | Readonly<Record<string, string>>, value?: string): void {
  const dir = requireEnv('JOB_DIR');
  const patch = typeof keyOrValues === 'string' ? { [keyOrValues]: value ?? '' } : keyOrValues;
  mergeJobData(dir, patch);
}

/** Строка в лог шага — `stdout`, тот же поток, что и у самого скрипта. */
export function log(...parts: readonly unknown[]): void {
  requireEnv('JOB_DIR');
  console.log(...parts);
}

export interface ExecOptions {
  /** По умолчанию ненулевой код возврата — отказ. `true` возвращает его вызывающему. */
  readonly allowFailure?: boolean;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Дочерний процесс без оболочки, наследующий окружение и рабочую директорию
 * шага, — тем и годится передать `BURNEX_INPUT`/`BURNEX_OUTPUT` дальше,
 * скрипту на другом языке или ещё одному `node`.
 *
 * Потоки дочернего процесса идут двумя путями сразу: собираются в
 * `ExecResult` — вызывающему их разобрать — и по мере поступления пишутся в
 * потоки шага, отчего попадают в `stdout.log` и `stderr.log`. Иначе лог шага
 * молчал бы всё время работы дочернего процесса, а у упавшего от него
 * осталась бы одна подрезанная подсказка отказа.
 */
export async function exec(
  command: string,
  args: readonly string[] = [],
  options: ExecOptions = {},
): Promise<ExecResult> {
  requireEnv('JOB_DIR');

  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      reject(new BurnexError(`Не удалось запустить ${command}: ${error.message}`, { cause: error }));
    });
    child.on('close', (code) => {
      const exitCode = code ?? -1;
      if (exitCode !== 0 && options.allowFailure !== true) {
        reject(
          new BurnexError(`Команда ${command} завершилась кодом ${exitCode}`, {
            ...(stderr.trim() === '' ? {} : { hint: stderr.trim() }),
          }),
        );
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
}
