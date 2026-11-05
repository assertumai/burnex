import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { ExitCode, StepcastError } from '../../../../kernel/errors.js';
import {
  acquire,
  readOwner,
  release,
  sleepAsync,
  sleepSync,
  type AcquireOptions,
  type LockOwner,
} from '../lockfile.js';

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
    return join(real, 'burnex-backlog.lock');
  } catch {
    return join(dir, '.backlog.lock');
  }
}

/**
 * Отказ ожидания. Отдельный класс, чтобы демон отличил «очередь занята» (409:
 * запрос верен, повторить можно) от прочих отказов (400).
 */
export type { LockOwner };

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

function acquireOptions(path: string, command: string, options: LockWaitOptions): AcquireOptions {
  const timeoutMs = options.timeoutMs ?? WAIT_LIMIT_MS;
  return {
    intervalMs: options.intervalMs ?? POLL_INTERVAL_MS,
    limit: { timeoutMs, timeoutError: (waited) => timeoutError(path, command, waited) },
  };
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

  const steps = acquire(path, command, acquireOptions(path, command, options));
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
  const steps = acquire(path, command, acquireOptions(path, command, options));
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
