import { parentPort, workerData } from 'node:worker_threads';

import { removeRunWithStats, removeRuns } from '../../../pipeline/run/cleanup.js';
import { runPaths } from '../../../pipeline/run/journal/paths.js';
import { isRunAlive } from '../../../pipeline/run/journal/reader.js';
import type { RemovalJob, SingleRemoval } from './removal.js';

/**
 * Вход рабочего потока снятия прогонов: одно задание на поток, результат —
 * одним сообщением. Отказ не ловится: он доходит до демона событием `error`
 * потока с тем же сообщением.
 */
const job = workerData as RemovalJob;

function removeOne(one: Extract<RemovalJob, { kind: 'one' }>): SingleRemoval {
  // Живость проверяется здесь, а не только в обработчике: задание могло
  // простоять в очереди за другим снятием, а прогон за это время — продолжиться.
  if (isRunAlive(runPaths(one.runsRoot, one.key, one.runId))) return { alive: true };
  return { alive: false, ...removeRunWithStats(one.runsRoot, one.key, one.runId, one.stats) };
}

parentPort?.postMessage(job.kind === 'one' ? removeOne(job) : removeRuns(job.runsRoot, job.addresses, job.stats));
