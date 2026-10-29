import { existsSync } from 'node:fs';

import type { FinishOwner } from '../../domain/backlog/file.js';
import { parseRunOwner, runOwner, type OwnerJudge, type OwnerState } from '../../domain/backlog/owner.js';
import { projectKey, runPaths } from './paths.js';
import { isRunAlive, listRuns, readManifest } from './reader.js';

/**
 * Владелец пункта очереди как прогон: живость и родство по `resumed_from`.
 * Отбор (`domain/backlog/select.ts`) этого модуля не знает — судья приходит к
 * нему аргументом, и очередь остаётся чистой от каталогов прогонов.
 */

/**
 * Прогон `ancestor` — сам `runId` либо его предок по цепочке `resumed_from`.
 *
 * `resume` ведёт ту же работу новым прогоном, и исход пункта, взятого
 * источником, законно проставляет продолжение. Цепочка обходится по
 * манифестам; повтор идентификатора обрывает обход — цикл в чужих манифестах
 * не должен вешать `finish`. Нечитаемый манифест обрывает цепочку: родство,
 * которое не доказано, не признаётся.
 */
export function isRunOrAncestor(
  runsRoot: string,
  key: string,
  ancestor: string,
  runId: string,
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = runId;
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    try {
      current = readManifest(runPaths(runsRoot, key, current)).resumed_from;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * «Свой» для исхода от имени прогона `runId`: владелец пункта — этот же прогон
 * либо его предок по `resume`. Владелец иной формы, чем `run:<id>`, своим не
 * признаётся: родства с ним не доказать.
 */
export function finishOwnerOfRun(
  runsRoot: string,
  projectRoot: string,
  runId: string,
  onForeign?: (claimedBy: string, slug: string) => void,
): FinishOwner {
  const key = projectKey(projectRoot);
  return {
    isOwn: (claimedBy) => {
      if (claimedBy === runOwner(runId)) return true;
      const id = parseRunOwner(claimedBy);
      return id !== undefined && isRunOrAncestor(runsRoot, key, id, runId);
    },
    ...(onForeign === undefined ? {} : { onForeign }),
  };
}

/**
 * Судья живости прогона-владельца для проекта `projectRoot`.
 *
 * - формы иной, чем `run:<id>`, — `unknown`;
 * - каталога прогона нет — `unknown`: прогон мог идти на другой машине либо
 *   быть убран уборкой, и признать его мёртвым значило бы отдать чужой машине
 *   идущую работу; решает порог давности;
 * - прогон жив (`isRunAlive`) — `alive`;
 * - иначе `alive`, если среди прогонов проекта есть живой, у которого владелец
 *   в цепочке `resumed_from` (его работу продолжает `resume`), и `dead`, если
 *   такого нет.
 *
 * Ответы кэшируются на время жизни судьи: очередь из десятка пунктов одного
 * прогона не читает его манифест десять раз.
 */
export function runOwnerJudge(runsRoot: string, projectRoot: string): OwnerJudge {
  const key = projectKey(projectRoot);
  const answers = new Map<string, OwnerState>();
  let aliveRuns: readonly string[] | undefined;

  const aliveRunIds = (): readonly string[] => {
    aliveRuns ??= listRuns(runsRoot, projectRoot).filter((id) =>
      isRunAlive(runPaths(runsRoot, key, id)),
    );
    return aliveRuns;
  };

  const judge = (id: string): OwnerState => {
    const paths = runPaths(runsRoot, key, id);
    if (!existsSync(paths.dir)) return 'unknown';
    if (isRunAlive(paths)) return 'alive';
    return aliveRunIds().some((alive) => isRunOrAncestor(runsRoot, key, id, alive)) ? 'alive' : 'dead';
  };

  return (owner) => {
    const cached = answers.get(owner);
    if (cached !== undefined) return cached;
    const id = parseRunOwner(owner);
    const state = id === undefined ? 'unknown' : judge(id);
    answers.set(owner, state);
    return state;
  };
}
