import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { acquire, release, sleepAsync, type LockOwner } from '../lockfile.js';

/**
 * Merge lock: один на репозиторий, держится весь обход `merge-lanes --onto`.
 *
 * Предела ожидания нет: соседнее сведение держит lock минуты (проверка,
 * ожидание чистой копии), и отказ через несколько секунд вернул бы ровно ту
 * беду — «ветка сдвинулась», — ради которой режим заведён. Порядок захвата
 * строгий: этот lock снаружи, lock очереди внутри; `pick`/`finish` этот lock
 * не берут, поэтому взаимной блокировки нет.
 */

/** Опрос занятого lock'а: сведение долгое, частить незачем. */
const POLL_INTERVAL_MS = 500;

export interface MergeLockOptions {
  readonly intervalMs?: number;
  /** Зовётся один раз, когда lock занят: молчащий шаг неотличим от зависшего. */
  readonly onBusy?: (owner: LockOwner | 'unreadable') => void;
}

function gitCommonDir(cwd: string): string {
  const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const resolved = resolve(cwd, common);
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    // Каталог не читается — остаётся разрешённый путь.
  }
  return real;
}

/** `<git common dir>/stepcast-merge.lock`: общий для основной копии и всех worktree. */
export function mergeLockPath(cwd: string): string {
  return join(gitCommonDir(cwd), 'stepcast-merge.lock');
}

/**
 * Запись восстановления публикации `--onto` — рядом с merge lock'ом, а не в
 * каталоге прогона: прерванную публикацию одного прогона должен видеть обход
 * любого другого прогона того же репозитория, иначе тот прочитает сдвинутую
 * вершину и будет бесконечно ждать очистки полувыложенной копии.
 */
export function mergeRecoveryPath(cwd: string): string {
  return join(gitCommonDir(cwd), 'stepcast-merge-recovery.json');
}

export async function withMergeLockAsync<T>(
  cwd: string,
  command: string,
  fn: () => Promise<T> | T,
  options: MergeLockOptions = {},
): Promise<T> {
  const path = mergeLockPath(cwd);
  const steps = acquire(path, command, {
    intervalMs: options.intervalMs ?? POLL_INTERVAL_MS,
    ...(options.onBusy === undefined ? {} : { onBusy: options.onBusy }),
  });
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
