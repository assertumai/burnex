import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finalizeInterruptedRun } from '../pipeline/run/journal/recover.js';

const RECOVERY_RETRY_DELAYS_MS = [0, 100, 1_000] as const;

/**
 * Запуск прогона отсоединённым дочерним процессом (`ui-daemon`, design.md
 * Решение 13). Демон сам прогон не исполняет: `stepcast run` порождается тем
 * же приёмом, что и отсоединённый подъём демона (`startDetached`,
 * `src/parts/ui/daemon/daemon.ts`), но без pid-файла и без своего лога — журналом прогона
 * распоряжается сам дочерний процесс, как и при запуске из терминала.
 */

function binPath(): string {
  return fileURLToPath(new URL('../../bin.js', import.meta.url));
}

export interface LaunchRunOptions {
  /** Корень проекта — рабочий каталог дочернего процесса. */
  readonly cwd: string;
  /** Корень журналов: по нему демон связывает завершившийся pid с прогоном. */
  readonly runsRoot: string;
  /** Стабильный ключ проекта из указателя, не требующий realpath после выхода. */
  readonly projectKey: string;
  /** Файл пайплайна относительно `cwd`, тем же именем, что видит `PipelineView.file`. */
  readonly pipeline: string;
  /**
   * Значения объявленных входов пайплайна — доезжают ключами `--input имя=значение`,
   * тем же порядком, каким их набрал бы человек в терминале.
   *
   * Ради доски: пункт, выбранный в колонке, передаётся запускаемому пайплайну
   * входом (`item=<слаг>`), а не угадывается им заново из очереди.
   */
  readonly inputs?: Readonly<Record<string, string>>;
  /** Переопределения объявленного `env:` — ключами `--env имя=значение`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Shadow-режим прогона — флагом `--shadow` (`shadow-run-mode`). */
  readonly shadow?: boolean;
  /**
   * Прогон по расписанию — флагами `--scheduled`, `--schedule-entry` и
   * `--catchup` (`ui-schedule-view`). Опция для сервиса в демоне; `POST
   * /api/run` её от формы не принимает.
   */
  readonly scheduled?: { readonly entry: number; readonly moment: string; readonly catchup: boolean };
  readonly execPath?: string;
  /** Куда сказать об отказе самого порождения. По умолчанию — журнал демона (`stderr`). */
  readonly onError?: (error: Error) => void;
}

export type LaunchRunFn = (options: LaunchRunOptions) => void;

/**
 * Восстановление меняет несколько файлов журнала. Короткий ограниченный
 * повтор позволяет демону закончить начатое после временного отказа записи;
 * устойчивый `run.interrupted` делает каждый следующий вызов безопасным.
 */
export async function retryInterruptedRunRecovery(
  recover: () => void,
  report: (error: Error) => void,
  delays: readonly number[] = RECOVERY_RETRY_DELAYS_MS,
): Promise<void> {
  let lastError: Error | undefined;
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      recover();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (lastError !== undefined) report(lastError);
}

/**
 * Породить `stepcast run <pipeline>` отсоединённым процессом. Вывод никуда не
 * читается демоном (`stdio: 'ignore'`): прогон пишет свой журнал сам, а
 * дочерний процесс не должен держать открытым ни файловый дескриптор демона,
 * ни его собственный.
 */
export const launchRun: LaunchRunFn = (options) => {
  const argv = [binPath(), 'run', options.pipeline];
  for (const [name, value] of Object.entries(options.inputs ?? {})) argv.push('--input', `${name}=${value}`);
  for (const [name, value] of Object.entries(options.env ?? {})) argv.push('--env', `${name}=${value}`);
  if (options.shadow === true) argv.push('--shadow');
  if (options.scheduled !== undefined) {
    argv.push('--scheduled', options.scheduled.moment, '--schedule-entry', String(options.scheduled.entry));
    if (options.scheduled.catchup) argv.push('--catchup');
  }

  const child = spawn(options.execPath ?? process.execPath, argv, {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
  });
  // Отказ самого порождения (ENOENT, EACCES, недоступный `cwd`) приходит
  // событием уже после возврата `spawn` — то есть после того, как `POST
  // /api/run` ответил 202. Без слушателя это необработанное исключение, и оно
  // роняет демон целиком: витрина гасла бы от одной неудачной кнопки запуска.
  child.on('error', (error) => {
    const report = options.onError ?? ((cause: Error) => process.stderr.write(`stepcast run не запустился: ${cause.message}\n`));
    report(error);
  });
  // Демон остаётся жить после отсоединённого runner и потому является
  // единственным процессом, который может заметить его внезапный выход.
  // Обычный runner к этому моменту уже записал терминальный статус; функция
  // восстановления идемпотентно ничего не сделает. Если последней записью
  // осталось `running`, она завершит журнал диагностическим отказом.
  child.on('exit', (exitCode, signal) => {
    const pid = child.pid;
    if (pid === undefined) return;
    const report = options.onError ?? ((cause: Error) => process.stderr.write(`журнал прогона не завершён после выхода runner: ${cause.message}\n`));
    void retryInterruptedRunRecovery(() => {
      finalizeInterruptedRun(options.runsRoot, options.projectKey, {
        pid,
        exitCode,
        signal,
      });
    }, report);
  });
  child.unref();
};

export interface LaunchResumeOptions {
  /** Корень проекта — рабочий каталог дочернего процесса. */
  readonly cwd: string;
  readonly run: string;
  /** Работа, с которой возобновляется прогон (`--from`). */
  readonly from: string;
  readonly execPath?: string;
  readonly onError?: (error: Error) => void;
}

export type LaunchResumeFn = (options: LaunchResumeOptions) => void;

/**
 * Породить `stepcast resume <run> --from <job>` отсоединённым процессом тем же
 * приёмом, что `launchDecide`: новый прогон с `resumed_from` создаёт сама
 * команда, демон журнал не пишет. Предстартовая проверка — в маршруте демона.
 */
export const launchResume: LaunchResumeFn = (options) => {
  const argv = [binPath(), 'resume', options.run, '--from', options.from];

  const child = spawn(options.execPath ?? process.execPath, argv, {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (error) => {
    const report =
      options.onError ?? ((cause: Error) => process.stderr.write(`stepcast resume не запустился: ${cause.message}\n`));
    report(error);
  });
  child.unref();
};

export interface LaunchDecideOptions {
  /** Корень проекта — рабочий каталог дочернего процесса. */
  readonly cwd: string;
  readonly run: string;
  readonly outcome: string;
  readonly step?: string;
  readonly reason?: string;
  readonly from?: string;
  readonly execPath?: string;
  readonly onError?: (error: Error) => void;
}

export type LaunchDecideFn = (options: LaunchDecideOptions) => void;

/**
 * Породить `stepcast decide <run> <outcome>` отсоединённым процессом — тем же
 * приёмом, что `launchRun` (design.md изменения `user-decision-steps`,
 * решение 5): демон в файлы прогонов не пишет, единственный писатель решения
 * — бинарь. Проверка запроса — до порождения, в маршруте демона; здесь
 * порождается уже проверенная команда.
 */
export const launchDecide: LaunchDecideFn = (options) => {
  const argv = [binPath(), 'decide', options.run, options.outcome];
  if (options.step !== undefined) argv.push('--step', options.step);
  if (options.reason !== undefined) argv.push('--reason', options.reason);
  if (options.from !== undefined) argv.push('--from', options.from);

  const child = spawn(options.execPath ?? process.execPath, argv, {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (error) => {
    const report =
      options.onError ?? ((cause: Error) => process.stderr.write(`stepcast decide не запустился: ${cause.message}\n`));
    report(error);
  });
  child.unref();
};

export type MaintenanceKind = 'update' | 'autostart';

export interface LaunchMaintenanceOptions {
  readonly kind: MaintenanceKind;
  /** Исполняемый файл и его argv целиком: оболочка — только там, где нужна цепочка команд. */
  readonly command: string;
  readonly args: readonly string[];
  /** Корень проекта демона: `up --install` записывает его в `WorkingDirectory` plist. */
  readonly cwd: string;
}

/**
 * Последний запуск действия, как его видит демон. Успешное действие
 * перезапускает демон, и знать о своём исходе ему уже некому; завершившийся
 * при живом демоне процесс значит, что перезапуска не было: «обновлять нечего»,
 * отказ или сбой — экран отличает это от зависшего перезапуска по коду выхода.
 */
export interface MaintenanceRun {
  readonly startedAt: string;
  readonly running: boolean;
  /** Код выхода; `null` — процесс убит сигналом или не запустился вовсе. */
  readonly exitCode?: number | null;
  readonly finishedAt?: string;
}

/**
 * Процессы обслуживания, которые порождает демон (`ui-system-health`): обновление
 * движка и переключение автозапуска. Оба перезапускают сам демон, поэтому
 * исполняются отсоединённым процессом, а не кодом в обработчике запроса.
 */
export interface LaunchMaintenance {
  /** Породить процесс; вывод дописывается в журнал действия. Отказ самого порождения уходит туда же. */
  launch(options: LaunchMaintenanceOptions): void;
  /** Какое действие идёт прямо сейчас: два наперегонки ломают друг другу `current` и plist. */
  busy(): MaintenanceKind | undefined;
  /** Последний запуск действия этим демоном; `undefined` — с подъёма не запускалось. */
  last(kind: MaintenanceKind): MaintenanceRun | undefined;
  /** Журнал действия: `update.log`, `autostart.log`. */
  logPath(kind: MaintenanceKind): string;
}

/**
 * Знание о живом ребёнке — в памяти демона: после перезапуска удерживать
 * нечего, а чужой процесс обслуживания (из терминала) демон всё равно не видит.
 *
 * `detached` — новая сессия: launchd убивает группу процессов задания при
 * `bootout` и `kickstart -k`, а ребёнок в эту группу не входит и доводит
 * перезапуск до конца.
 */
export function createMaintenance(logDir: string): LaunchMaintenance {
  let running: MaintenanceKind | undefined;
  const runs = new Map<MaintenanceKind, MaintenanceRun>();
  const logPath = (kind: MaintenanceKind): string => join(logDir, `${kind}.log`);

  return {
    logPath,
    busy: () => running,
    last: (kind) => runs.get(kind),
    launch: (options) => {
      const log = logPath(options.kind);
      mkdirSync(logDir, { recursive: true });
      appendFileSync(log, `\n--- ${new Date().toISOString()} ${[options.command, ...options.args].join(' ')}\n`);
      const fd = openSync(log, 'a');

      running = options.kind;
      const startedAt = new Date().toISOString();
      runs.set(options.kind, { startedAt, running: true });
      let settled = false;
      const settle = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        if (running === options.kind) running = undefined;
        runs.set(options.kind, { startedAt, running: false, exitCode, finishedAt: new Date().toISOString() });
      };
      try {
        const child = spawn(options.command, [...options.args], {
          cwd: options.cwd,
          detached: true,
          stdio: ['ignore', fd, fd],
        });
        child.on('exit', (code) => settle(code));
        // Отказ порождения приходит событием уже после ответа 202; без слушателя он роняет демон.
        child.on('error', (error) => {
          appendFileSync(log, `не запустилось: ${error.message}\n`);
          settle(null);
        });
        child.unref();
      } catch (error) {
        settle(null);
        throw error;
      } finally {
        closeSync(fd);
      }
    },
  };
}
