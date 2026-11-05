import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/agents/declaration.ts';
import type { RouteTarget } from '../../../src/parts/ui/routes.ts';
import { Agents, tabOf, type AgentTab } from '../pages/Agents';
import { hrefForTarget } from '../router';
import { SCREEN } from '@burnex/slots';

/** Цель экрана агентов — по ней собираются ссылки на вкладки (`ui-routes`, Решение 8). */
export const AGENTS_TARGET: RouteTarget = { kind: 'screen', id: declaration.id };

/**
 * Вкладка — часть адреса (`ui-agents-settings-merge`, design.md Решение 1):
 * читается из параметра маршрута `tab`, а переключение идёт через `navigate`
 * по действующей таблице, как период на `/usage/:period?`. Без действующего
 * маршрута к цели переключать некуда — тогда страница меняет вкладку только
 * на экране, не трогая адрес.
 */
function AgentsScreen({
  params,
  navigate,
}: {
  readonly params: Readonly<Record<string, string>>;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const select = (tab: AgentTab): boolean => {
    const href = hrefForTarget(AGENTS_TARGET, tab === 'default' ? {} : { tab });
    if (href === undefined) return false;
    navigate(href);
    return true;
  };
  return <Agents tab={tabOf(params.tab)} onSelectTab={select} />;
}

export default function agents(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: AgentsScreen, key: declaration.id });
}
