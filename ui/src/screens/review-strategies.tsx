import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/review-strategies/declaration.ts';
import type { RouteTarget } from '../../../src/parts/ui/routes.ts';
import { ReviewStrategies } from '../pages/ReviewStrategies';
import { hrefForTarget } from '../router';
import { SCREEN } from '@burnex/slots';

/** Цель экрана стратегий — по ней собирается адрес выбранной стратегии. */
export const REVIEW_STRATEGIES_TARGET: RouteTarget = { kind: 'screen', id: declaration.id };

/**
 * Выбранная стратегия — часть адреса (`/review-strategies/:name?`), как
 * вкладка экрана Agents: смена идёт через `navigate` по действующей таблице,
 * а без маршрута к цели страница держит выбор только у себя.
 */
function ReviewStrategiesScreen({
  params,
  navigate,
}: {
  readonly params: Readonly<Record<string, string>>;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const select = (name: string | undefined): boolean => {
    const href = hrefForTarget(REVIEW_STRATEGIES_TARGET, name === undefined ? {} : { name });
    if (href === undefined) return false;
    navigate(href);
    return true;
  };
  return <ReviewStrategies name={params.name} onSelectName={select} navigate={navigate} />;
}

export default function reviewStrategies(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: ReviewStrategiesScreen, key: declaration.id });
}
