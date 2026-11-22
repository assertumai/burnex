import { createWriteStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { execa, type Subprocess } from 'execa';

import type { Masker } from '../journal/mask.js';
import { createScope } from '../scope.js';

/**
 * Запуск дочернего процесса под надзором.
 *
 * Встроенный таймаут библиотеки не подходит: нужен мягкий сигнал с отсрочкой,
 * нужно отдельно ловить молчание при живом процессе, и нужно убивать всё
 * дерево — агент запускает собственные подпроцессы, и убийство одного
 * родителя оставляет сирот.
 */

export const DEFAULT_GRACE_MS = 30_000;

export interface ProcessOptions {
  /** Список argv исполняется без оболочки, строка — через оболочку платформы. */
  readonly command: readonly string[] | string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stallTimeoutMs?: number;
  readonly graceMs?: number;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  /** Текст, который уйдёт процессу на stdin. Без него stdin закрыт. */
  readonly stdin?: string;
  readonly onSpawn?: (pid: number, send: (message: unknown) => void, close: () => void) => void;
  /** Return true when graceful protocol cancellation was sent. */
  readonly onInterrupt?: () => boolean;
  readonly interactive?: boolean;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
  readonly onStall?: (silentMs: number) => void;
  readonly maxCapturedBytes?: number;
  readonly signal?: AbortSignal;
  /**
   * Маскировщик значений секретов (`journal.masker`): строка вывода,
   * попадающая в файл, в `onStdout`/`onStderr` и в накопленный текст,
   * проходит через него. Без поля или с пустым множеством значений вывод
   * идёт как есть.
   */
  readonly masker?: Masker;
}

export type ProcessOutcome = 'exited' | 'timeout' | 'canceled' | 'spawn_failed';

export interface ProcessResult {
  readonly outcome: ProcessOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallclockMs: number;
  /** Пришлось ли добивать процесс после отсрочки. */
  readonly forceKilled: boolean;
}

const DEFAULT_CAPTURE_BYTES = 1_000_000;

export async function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  if (options.signal?.aborted === true) return { outcome: 'canceled', exitCode: null, signal: null,
    stdout: '', stderr: '', wallclockMs: 0, forceKilled: false };
  const grace = options.graceMs ?? DEFAULT_GRACE_MS;
  const capture = options.maxCapturedBytes ?? DEFAULT_CAPTURE_BYTES;

  const useShell = typeof options.command === 'string';
  const [file, ...args] = useShell
    ? [options.command as string]
    : (options.command as readonly string[]);

  if (file === undefined || file === '') {
    throw new Error('Пустая команда шага');
  }

  const subprocess = execa(file, args, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: false,
    // Отдельная группа процессов: только так убийство достаёт до внуков.
    detached: process.platform !== 'win32',
    reject: false,
    buffer: false,
    shell: useShell,
    stdin: options.stdin === undefined && !options.interactive ? 'ignore' : 'pipe',
    stripFinalNewline: false,
  }) as Subprocess;

  if (!options.interactive && options.stdin !== undefined && subprocess.stdin !== null) {
    subprocess.stdin.end(options.stdin);
  }

  const stdout = collect(subprocess.stdout, options.stdoutPath, capture, options.onStdout, options.masker);
  const stderr = collect(subprocess.stderr, options.stderrPath, capture, options.onStderr, options.masker);

  let outcome: ProcessOutcome = 'exited';
  let forceKilled = false;
  let killTimer: NodeJS.Timeout | undefined;

  const terminate = (reason: ProcessOutcome, notifyBackend = true): void => {
    if (outcome !== 'exited') return;
    outcome = reason;
    if (!notifyBackend || options.onInterrupt?.() !== true) killGroup(subprocess, 'SIGTERM');
    killTimer = setTimeout(() => {
      forceKilled = true;
      killGroup(subprocess, 'SIGKILL');
    }, grace);
    killTimer.unref();
  };

  /**
   * Область запуска: таймеры и слушатель снимаются одним `finally` вокруг
   * ожидания процесса. Журнала здесь нет — и не нужно: `clearTimeout` и
   * `removeEventListener` не отказывают, а исключение из них означало бы
   * дефект, который обязан быть виден, а не проглочен.
   */
  const resources = createScope();

  const timeoutTimer = setTimeout(() => terminate('timeout'), options.timeoutMs);
  timeoutTimer.unref();
  resources.defer('снятие таймера предельного времени шага', () => {
    clearTimeout(timeoutTimer);
  });

  const onAbort = (): void => terminate('canceled');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  resources.defer('снятие слушателя отмены процесса', () => {
    options.signal?.removeEventListener('abort', onAbort);
  });
  // Таймер добивания заводит `terminate` уже после этой регистрации, поэтому
  // операция читает переменную, а не её сегодняшнее значение.
  resources.defer('снятие таймера добивания процесса', () => {
    clearTimeout(killTimer);
  });

  subprocess.stdin?.on('error', () => { /* Exit/timeout remains authoritative on EPIPE. */ });

  // Молчание — не отказ: шаг может думать. Сообщаем и продолжаем ждать
  // таймаут, чтобы «непонятно, работает ли оно» стало наблюдаемым.
  let stallTimer: NodeJS.Timeout | undefined;
  const armStall = (): void => {
    if (options.stallTimeoutMs === undefined || options.onStall === undefined) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      options.onStall?.(options.stallTimeoutMs as number);
      armStall();
    }, options.stallTimeoutMs);
    stallTimer.unref();
  };
  stdout.onData(armStall);
  stderr.onData(armStall);
  // Таймер молчания перезаводится на каждом куске вывода: снимается тот, что
  // взведён к моменту снятия области.
  resources.defer('снятие таймера молчания шага', () => {
    clearTimeout(stallTimer);
  });
  armStall();

  let result: Awaited<Subprocess>;
  let startupFailure: { error: unknown } | undefined;
  try {
    try {
      if (subprocess.pid !== undefined) options.onSpawn?.(subprocess.pid,
        (message) => { subprocess.stdin?.write(`${JSON.stringify(message)}\n`); },
        () => { subprocess.stdin?.end(); });
    } catch (error) {
      startupFailure = { error };
      terminate('canceled', false);
    }
    result = await subprocess;
  } finally {
    // Процесс, не сумевший стартовать, доходит сюда исключением: без снятия
    // области его таймеры остались бы взведёнными.
    await resources.dispose();
  }

  await Promise.all([stdout.done(), stderr.done()]);
  if (startupFailure !== undefined) throw startupFailure.error;

  // Процесс, не сумевший стартовать, не имеет ни кода, ни сигнала. Отличать
  // это от обычного отказа нужно, чтобы причина остановки называла отсутствие
  // команды, а не непройденный предикат кода возврата.
  if (
    outcome === 'exited' &&
    result.failed === true &&
    typeof result.exitCode !== 'number' &&
    (result.signal ?? null) === null
  ) {
    outcome = 'spawn_failed';
  }

  return {
    outcome,
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    signal: (result.signal as string | undefined) ?? null,
    stdout: stdout.text(),
    stderr: stderr.text(),
    wallclockMs: Date.now() - started,
    forceKilled,
  };
}

/** Убить всю группу процессов, а не только прямого потомка. */
function killGroup(subprocess: Subprocess, signal: NodeJS.Signals): void {
  const pid = subprocess.pid;
  if (pid === undefined) return;

  try {
    if (process.platform === 'win32') {
      subprocess.kill(signal);
      return;
    }
    process.kill(-pid, signal);
  } catch {
    // Процесс уже завершился — гонка между таймером и выходом обычна.
    try {
      subprocess.kill(signal);
    } catch {
      // И этого уже нет.
    }
  }
}

interface Collector {
  readonly onData: (listener: () => void) => void;
  readonly text: () => string;
  readonly done: () => Promise<void>;
}

/**
 * Копить вывод в память с ограничением и одновременно писать в файл.
 * Ограничение нужно, чтобы бесконечно болтливый шаг не съел память процесса;
 * файл при этом получает всё.
 */
function collect(
  stream: NodeJS.ReadableStream | null,
  path: string | undefined,
  limit: number,
  onChunk?: (chunk: string) => void,
  masker?: Masker,
): Collector {
  const listeners: Array<() => void> = [];
  const chunks: string[] = [];
  let size = 0;
  let truncated = false;

  const file = path === undefined ? undefined : createWriteStream(path, { mode: 0o600 });
  const finished =
    file === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve) => file.on('close', () => resolve()));

  const accept = (text: string): void => {
    file?.write(text);
    onChunk?.(text);

    if (size >= limit) {
      truncated = true;
      return;
    }
    const room = limit - size;
    chunks.push(text.length > room ? text.slice(0, room) : text);
    size += Math.min(text.length, room);
    if (text.length > room) truncated = true;
  };

  // Маскирование применяется к собранной строке, а не к сырому куску: значение
  // на стыке двух чанков иначе прошло бы невредимым. Хвост без перевода строки
  // ждёт продолжения; без маскировщика вывод идёт кусок в кусок, как раньше.
  const mask = masker?.active === true ? masker : undefined;
  let pending = '';
  // Предел хвоста без перевода строки: бесконечно длинная строка не должна
  // копиться в памяти. Маскируется весь хвост целиком, и только потом
  // сбрасывается всё, кроме последних `maxLength - 1` символов: полное
  // значение, пересекающее точку среза, к этому моменту уже заменено, а
  // начало значения, которому не хватает продолжения, целиком лежит в
  // остатке и ждёт следующего куска.
  const PENDING_LIMIT = 65_536;
  // Байты многобайтового символа, разрезанного границей куска, ждут
  // продолжения в декодере: раздельное декодирование превратило бы их в
  // U+FFFD, и не-ASCII значение секрета перестало бы совпадать с маскируемым.
  const decoder = new StringDecoder('utf8');

  const take = (text: string): void => {
    if (text === '') return;
    if (mask === undefined) {
      accept(text);
      return;
    }
    pending += text;
    const cut = pending.lastIndexOf('\n');
    if (cut >= 0) {
      accept(mask.mask(pending.slice(0, cut + 1)));
      pending = pending.slice(cut + 1);
    }
    if (pending.length > PENDING_LIMIT) {
      const masked = mask.mask(pending);
      const keep = Math.min(Math.max(mask.maxLength - 1, 0), masked.length);
      accept(masked.slice(0, masked.length - keep));
      pending = masked.slice(masked.length - keep);
    }
  };

  const flushPending = (): void => {
    take(decoder.end());
    if (mask === undefined || pending === '') return;
    accept(mask.mask(pending));
    pending = '';
  };

  if (stream !== null) {
    stream.on('data', (chunk: Buffer | string) => {
      take(typeof chunk === 'string' ? chunk : decoder.write(chunk));
      for (const listener of listeners) listener();
    });
    stream.on('end', () => {
      flushPending();
      file?.end();
    });
    stream.on('error', () => {
      flushPending();
      file?.end();
    });
  } else {
    file?.end();
  }

  return {
    onData: (listener) => listeners.push(listener),
    text: () => chunks.join('') + (truncated ? '\n[вывод обрезан]' : ''),
    done: () => finished,
  };
}
