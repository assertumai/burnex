import { DISCUSS_STEP_KIND } from '../../document/expand.js';
import { partRow } from '../../services.js';

/**
 * Строка встроенного слоя: вид шага `discuss` (`discuss-step`, design.md,
 * решение 1). Родной вид, как `review`: шагу нужно запускать агентские сессии,
 * а плагинному контракту вида шага движок этой способности не даёт. Разбор —
 * в `src/parts/pipeline/document/expand.ts`, исполнение — в
 * `src/parts/pipeline/run/exec/discussStep.ts`.
 *
 * Импорт верхнего уровня, обращение к `DISCUSS_STEP_KIND` — внутри тела
 * `apply`: тот же приём разводки цикла модулей, что у строки `step-review`.
 */
export const row = partRow('step-discuss', ['steps'], (ctx) => {
  ctx.steps.register('discuss', DISCUSS_STEP_KIND);
});
