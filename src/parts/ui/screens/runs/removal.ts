import { Worker } from 'node:worker_threads';

import type {
  RemovalSummary,
  RunAddress,
  RunCleanupResult,
  StatsDisposition,
  StatsOutcome,
} from '../../../pipeline/run/cleanup.js';

/**
 * Снятие прогонов вне цикла событий демона.
 *
 * Снятие синхронно по устройству: на каждое рабочее дерево — свой
 * `git worktree remove`, и на сотне прогонов составного проекта это минуты.
 * В обработчике запроса оно останавливало бы витрину целиком — ни обзор, ни
 * расписание не двигались бы до конца уборки. Поэтому работа уходит в рабочий
 * поток, а демон ждёт только её итога.
 */

export type RemovalJob =
  | {
      readonly kind: 'one';
      readonly runsRoot: string;
      readonly key: string;
      readonly runId: string;
      readonly stats: StatsDisposition;
    }
  | {
      readonly kind: 'many';
      readonly runsRoot: string;
      readonly addresses: readonly RunAddress[];
      readonly stats: StatsDisposition;
    };

/** Исход одиночного снятия: прогон мог ожить, пока задание ждало очереди. */
export type SingleRemoval =
  | { readonly alive: true }
  | ({ readonly alive: false } & RunCleanupResult & { readonly stats: StatsOutcome });

function runInWorker<T>(job: RemovalJob): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(new URL('./removalWorker.js', import.meta.url), { workerData: job });
    let settled = false;
    worker.once('message', (result: T) => {
      settled = true;
      resolve(result);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Run removal worker exited with code ${code} before reporting a result`));
    });
  });
}

/**
 * Очередь из одного потока: пока обработчик блокировал цикл событий, два
 * снятия не могли идти разом, и это свойство сохраняется — параллельные
 * снятия делили бы одни и те же репозитории и хранилище статистики.
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: RemovalJob): Promise<T> {
  const result = queue.then(() => runInWorker<T>(job));
  queue = result.catch(() => undefined);
  return result;
}

export function removeRunOffLoop(
  runsRoot: string,
  key: string,
  runId: string,
  stats: StatsDisposition,
): Promise<SingleRemoval> {
  return enqueue({ kind: 'one', runsRoot, key, runId, stats });
}

export function removeRunsOffLoop(
  runsRoot: string,
  addresses: readonly RunAddress[],
  stats: StatsDisposition,
): Promise<RemovalSummary> {
  return enqueue({ kind: 'many', runsRoot, addresses, stats });
}
