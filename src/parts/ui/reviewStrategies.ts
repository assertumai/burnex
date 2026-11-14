import {
  deleteStrategy,
  readStrategies,
  REVIEW_STRATEGY,
  saveStrategy,
  type SaveStrategyRequest,
  type StrategiesOverview,
  type StrategyLayer,
  type StrategyRootsOptions,
} from './strategies.js';
import type { PipelineView } from './pipelines.js';

/**
 * Стратегии ревью экрана «Review strategies» (`ui-review-strategies`) —
 * общий модуль стратегий (`strategies.ts`) с видом `REVIEW_STRATEGY`.
 */

export { StrategyRejected, type StrategyProblem, type StrategyUsage, type StrategyView, type StrategyLayer } from './strategies.js';

export type ReviewStrategiesOverview = StrategiesOverview;

export function readReviewStrategies(
  options: StrategyRootsOptions & {
    readonly backendNames: readonly string[];
    readonly pipelines?: readonly PipelineView[];
    readonly now?: Date;
  },
): ReviewStrategiesOverview {
  return readStrategies(REVIEW_STRATEGY, options);
}

export function saveReviewStrategy(request: SaveStrategyRequest, options: StrategyRootsOptions & { readonly backendNames: readonly string[] }): string {
  return saveStrategy(REVIEW_STRATEGY, request, options);
}

export function deleteReviewStrategy(layer: StrategyLayer, name: string, options: StrategyRootsOptions): void {
  deleteStrategy(REVIEW_STRATEGY, layer, name, options);
}
