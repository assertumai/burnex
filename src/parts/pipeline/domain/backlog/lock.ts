import { execFileSync } from 'node:child_process';
import {
  closeSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { ExitCode, StepcastError } from '../../../../kernel/errors.js';
import { isProcessAlive } from '../../../../kernel/process.js';

/**
 * Lock очереди: один на репозиторий, берётся на цикл «прочитать → поправить →
 * записать» файлов `backlog.md` / `archived.md`.
 *
 * `atomicWrite` защищает читателя от половины файла, но не писателя от
 * писателя: между чтением и записью соседний процесс успевает записать своё, и
 * правка пропадает, а два параллельных `pick` выдают один пункт дважды.
 */

/** Опрос занятого lock'а и предел ожидания. Наружу (флаги, окружение) не выставлены. */
const POLL_INTERVAL_MS = 50;
const WAIT_LIMIT_MS = 10_000;
/** Вспомогательный `.break` живёт мгновения; старше этого — остаток упавшего процесса. */
const STALE_BREAK_MS = 10_000;

export interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
  readonly acquired_at: string;
}

/** Параметры ожидания; умолчания — договор, параметры нужны тестам, чтобы не ждать 10 с. */
export interface LockWaitOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Путь lock'а файла очереди.
 *
 * Общий каталог git, а не `.git` рабочей копии: дерево дорожки, интеграционное
 * дерево `merge-lanes` и основная копия правят одну логическую очередь. В
 * рабочем дереве файл лёг бы мусором, который увидел бы `assertCleanTree`.
 * Вне git — рядом с файлом очереди.
 */
export function backlogLockPath(file: string): string {
  const dir = dirname(resolve(file));
  try {
    const common = execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // Результат относителен каталогу, где выполнена команда (в основной копии —
    // просто `.git`). Реальный путь выравнивает символьные ссылки платформы:
    // от него зависит и счётчик повторного входа.
    const resolved = resolve(dir, common);
    let real = resolved;
    try {
      real = realpathSync(resolved);
    } catch {
      // Каталог не читается — остаётся разрешённый путь.
    }
    return join(real, 'stepcast-backlog.lock');
  } catch {
    return join(dir, '.backlog.lock');
  }
}

/** Владелец lock'а: объект, `unreadable` (пустой/битый файл) или `undefined` (файла нет). */
function readOwner(path: string): LockOwner | 'unreadable' | undefined {
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

function sameOwner(a: LockOwner, b: LockOwner): boolean {
  return a.pid === b.pid && a.acquired_at === b.acquired_at;
}

/**
 * Брошен ли lock: машина та же, а процесса уже нет. Чужую машину не проверить,
 * а снять живой lock значит вернуть ровно ту гонку, ради которой он заведён.
 */
function isAbandoned(owner: LockOwner): boolean {
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
function breakAbandoned(path: string, abandoned: LockOwner): boolean {
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
function tryCreate(path: string, command: string): LockOwner | undefined {
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

/**
 * Отказ ожидания. Отдельный класс, чтобы демон отличил «очередь занята» (409:
 * запрос верен, повторить можно) от прочих отказов (400).
 */
export class BacklogLockTimeoutError extends StepcastError {}

function timeoutError(path: string, command: string, waitedMs: number): BacklogLockTimeoutError {
  const owner = readOwner(path);
  const who =
    owner === undefined
      ? 'владельца прочитать не удалось'
      : owner === 'unreadable'
        ? 'содержимое lock-файла нечитаемо'
        : `владелец: ${owner.command}, pid ${owner.pid}, host ${owner.host}, с ${owner.acquired_at}`;
  return new BacklogLockTimeoutError(
    `очередь занята другим писателем: lock ${path} не освободился за ${Math.round(waitedMs / 1000)} с (${who}); «${command}» очередь не тронул`,
    {
      exitCode: ExitCode.configError,
      file: path,
      hint:
        'если процесс-владелец мёртв на другой машине или имя машины сменилось, удалите lock-файл руками',
    },
  );
}

/**
 * Вся логика захвата в одном месте: генератор отдаёт, сколько спать до
 * следующей попытки, а сам сон выбирает вызывающий — блокирующий в CLI,
 * через таймер в демоне, чей цикл событий замораживать нельзя.
 */
function* acquire(
  path: string,
  command: string,
  options: LockWaitOptions,
): Generator<number, LockOwner, void> {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? WAIT_LIMIT_MS;
  const started = Date.now();
  for (;;) {
    const mine = tryCreate(path, command);
    if (mine !== undefined) return mine;

    const owner = readOwner(path);
    if (owner === undefined) continue; // освободился между попытками
    // Снятие, которому помешал чужой `.break`, — обычное ожидание со сном и
    // пределом: иначе цикл крутится вхолостую, пока `.break` не устареет, и в
    // демоне замораживает цикл событий.
    if (owner !== 'unreadable' && isAbandoned(owner) && breakAbandoned(path, owner)) continue;
    const waited = Date.now() - started;
    if (waited >= timeoutMs) throw timeoutError(path, command, waited);
    yield Math.min(intervalMs, timeoutMs - waited);
  }
}

/** Освободить lock, только если он всё ещё наш: брошенным признанный и снятый за нас не должен унести чужой. */
function release(path: string, mine: LockOwner): void {
  const current = readOwner(path);
  if (current === undefined || current === 'unreadable' || !sameOwner(current, mine)) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Сколько раз этот процесс уже держит lock данного пути (повторный вход синхронного варианта). */
const held = new Map<string, number>();

/**
 * Выполнить цикл правки очереди под lock'ом (синхронно, для CLI).
 *
 * Повторный вход в пределах процесса не трогает диск: иначе процесс, уже
 * держащий lock, ждал бы сам себя до предела — его `pid` жив. Синхронное
 * ожидание блокирует цикл событий, поэтому демон им не пользуется.
 */
export function withBacklogLock<T>(
  file: string,
  command: string,
  fn: () => T,
  options: LockWaitOptions = {},
): T {
  const path = backlogLockPath(file);
  const depth = held.get(path) ?? 0;
  if (depth > 0) {
    held.set(path, depth + 1);
    try {
      return fn();
    } finally {
      held.set(path, depth);
    }
  }

  const steps = acquire(path, command, options);
  let step = steps.next();
  while (!step.done) {
    sleepSync(step.value);
    step = steps.next();
  }
  const mine = step.value;
  held.set(path, 1);
  try {
    return fn();
  } finally {
    held.delete(path);
    release(path, mine);
  }
}

/**
 * То же для обработчиков демона: сон через таймер, цикл событий отзывается.
 * Без повторного входа — обработчики независимы, и два переноса одной доски
 * должны исключать друг друга.
 */
export async function withBacklogLockAsync<T>(
  file: string,
  command: string,
  fn: () => Promise<T> | T,
  options: LockWaitOptions = {},
): Promise<T> {
  const path = backlogLockPath(file);
  const steps = acquire(path, command, options);
  let step = steps.next();
  while (!step.done) {
    await sleepAsync(step.value);
    step = steps.next();
  }
  const mine = step.value;
  try {
    return await fn();
  } finally {
    release(path, mine);
  }
}
