import { REVIEW_STEP_KIND } from '../../document/expand.js';
import { partRow } from '../../services.js';

/**
 * Строка встроенного слоя: вид шага `review` (`review-strategies`, design.md,
 * решение 3). Родной вид, как `agent`: шагу нужно запускать агентские
 * сессии, а плагинному контракту вида шага движок этой способности не даёт.
 * Разбор — в `src/parts/pipeline/document/expand.ts`, исполнение — в
 * `src/parts/pipeline/run/exec/reviewStep.ts`.
 *
 * Импорт верхнего уровня, обращение к `REVIEW_STEP_KIND` — внутри тела
 * `apply`: тот же приём разводки цикла модулей, что у строки `step-agent`.
 */
export const row = partRow('step-review', ['steps'], (ctx) => {
  ctx.steps.register('review', REVIEW_STEP_KIND);
});
