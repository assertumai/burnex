import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';

import { isProcessAlive } from '../../../kernel/process.js';

/**
 * Общее устройство lock-файла с владельцем: им пользуются lock очереди
 * (`backlog/lock.ts`) и merge lock (`lanes/mergeLock.ts`). Различаются они
 * путём, пределом ожидания и тем, что делают с отказом, — не способом занять,
 * прочитать и снять брошенный lock.
 */

/** Вспомогательный `.break` живёт мгновения; старше этого — остаток упавшего процесса. */
const STALE_BREAK_MS = 10_000;

export interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
  readonly acquired_at: string;
}

/** Владелец lock'а: объект, `unreadable` (пустой/битый файл) или `undefined` (файла нет). */
export function readOwner(path: string): LockOwner | 'unreadable' | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return 'unreadable';
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null) return 'unreadable';
    const record = raw as Record<string, unknown>;
    if (
      typeof record['pid'] !== 'number' ||
      typeof record['host'] !== 'string' ||
      typeof record['command'] !== 'string' ||
      typeof record['acquired_at'] !== 'string'
    ) {
      return 'unreadable';
    }
    return {
      pid: record['pid'],
      host: record['host'],
      command: record['command'],
      acquired_at: record['acquired_at'],
    };
  } catch {
    return 'unreadable';
  }
}

export function sameOwner(a: LockOwner, b: LockOwner): boolean {
  return a.pid === b.pid && a.acquired_at === b.acquired_at;
}

/**
 * Брошен ли lock: машина та же, а процесса уже нет. Чужую машину не проверить,
 * а снять живой lock значит вернуть ровно ту гонку, ради которой он заведён.
 */
export function isAbandoned(owner: LockOwner): boolean {
  return owner.host === hostname() && !isProcessAlive(owner.pid, Date.parse(owner.acquired_at));
}

/**
 * Снять брошенный lock.
 *
 * Без вспомогательного `.break` два ожидающих, увидев один мёртвый lock,
 * ломали бы друг друга: первый снимает и второй писатель берёт свежий, а
 * второй ожидающий снимает уже его. Под `.break` владелец перечитывается и
 * снимается, только если он всё ещё тот, кого признали брошенным — пока
 * брошенный файл существует, свежий создать нельзя.
 */
export function breakAbandoned(path: string, abandoned: LockOwner): boolean {
  const breakPath = `${path}.break`;
  let fd: number;
  try {
    fd = openSync(breakPath, 'wx', 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Чужой `.break` либо мгновенный, либо остаток упавшего процесса.
    try {
      if (Date.now() - statSync(breakPath).mtimeMs > STALE_BREAK_MS) {
        unlinkSync(breakPath);
        return true;
      }
    } catch {
      // Исчез между проверками — следующая попытка разберётся.
    }
    return false;
  }
  closeSync(fd);
  try {
    const current = readOwner(path);
    if (current !== undefined && current !== 'unreadable' && sameOwner(current, abandoned)) {
      unlinkSync(path);
    }
  } finally {
    unlinkSync(breakPath);
  }
  return true;
}

/**
 * Попытка занять lock: `wx` создаёт файл, только если его нет, и запись
 * владельца идёт тем же дескриптором — окно, где файл есть, а владельца в нём
 * нет, ограничено одним `write`.
 */
export function tryCreate(path: string, command: string): LockOwner | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    command,
    acquired_at: new Date().toISOString(),
  };
  try {
    writeSync(fd, `${JSON.stringify(owner)}\n`);
  } catch (error) {
    closeSync(fd);
    unlinkSync(path);
    throw error;
  }
  closeSync(fd);
  return owner;
}

/** Освободить lock, только если он всё ещё наш: брошенным признанный и снятый за нас не должен унести чужой. */
export function release(path: string, mine: LockOwner): void {
  const current = readOwner(path);
  if (current === undefined || current === 'unreadable' || !sameOwner(current, mine)) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export interface AcquireOptions {
  readonly intervalMs: number;
  /** Предел ожидания; без него lock ждётся бесконечно, и `timeoutError` не нужен. */
  readonly limit?: {
    readonly timeoutMs: number;
    readonly timeoutError: (waitedMs: number) => Error;
  };
  /**
   * Зовётся один раз, когда lock оказался занят живым (не брошенным) владельцем:
   * молчащее ожидание неотличимо от зависшего. `unreadable` — файл есть, но
   * владельца прочитать нельзя.
   */
  readonly onBusy?: (owner: LockOwner | 'unreadable') => void;
}

/**
 * Вся логика захвата в одном месте: генератор отдаёт, сколько спать до
 * следующей попытки, а сам сон выбирает вызывающий — блокирующий в CLI,
 * через таймер в демоне, чей цикл событий замораживать нельзя.
 */
export function* acquire(
  path: string,
  command: string,
  options: AcquireOptions,
): Generator<number, LockOwner, void> {
  const { intervalMs, limit, onBusy } = options;
  const started = Date.now();
  let reported = false;
  for (;;) {
    const mine = tryCreate(path, command);
    if (mine !== undefined) return mine;

    const owner = readOwner(path);
    if (owner === undefined) continue; // освободился между попытками
    // Снятие, которому помешал чужой `.break`, — обычное ожидание со сном и
    // пределом: иначе цикл крутится вхолостую, пока `.break` не устареет, и в
    // демоне замораживает цикл событий.
    if (owner !== 'unreadable' && isAbandoned(owner) && breakAbandoned(path, owner)) continue;
    if (!reported && onBusy !== undefined) {
      reported = true;
      onBusy(owner);
    }
    const waited = Date.now() - started;
    if (limit === undefined) {
      yield intervalMs;
      continue;
    }
    if (waited >= limit.timeoutMs) throw limit.timeoutError(waited);
    yield Math.min(intervalMs, limit.timeoutMs - waited);
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sleepAsync(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
