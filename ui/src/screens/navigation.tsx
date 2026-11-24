import type { JSX } from 'react';
import type { Context } from 'cordis';

import { hrefForRoute } from '../../../src/parts/ui/routes.ts';
import { declaration } from '../../../src/parts/ui/screens/navigation/declaration.ts';
import { Navigation } from '../pages/Navigation';
import { useRoutes } from '../router';
import { Icon } from '@burnex/ui';
import { NAV_ACTIONS, SCREEN, type NavActionProps } from '@burnex/slots';

/**
 * Вход в настройку меню из подвала самого меню: его не убрать, скрыв пункт
 * «Navigation». Ссылка — адрес действующего маршрута на этот экран; маршрут
 * выключен (`enabled: false`) — кнопки нет, это решение пользователя.
 */
function CustomizeMenuAction({ navigate }: NavActionProps): JSX.Element | null {
  const { table } = useRoutes();
  const route = table.find((candidate) => candidate.target.kind === 'screen' && candidate.target.id === declaration.id);
  const href = route === undefined ? undefined : hrefForRoute(route);
  if (href === undefined) return null;
  return (
    <a
      className="sidebar-action"
      href={href}
      aria-label="Customize menu"
      title="Customize menu"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      <Icon name="sliders-horizontal" size={16} />
    </a>
  );
}

/**
 * Экран «Navigation»: настройка бокового меню. Читает ту же таблицу
 * маршрутов, что и каркас, и пишет разницу `POST /api/nav` в файл слоя.
 */
export default function navigation(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: Navigation, key: declaration.id });
  ctx.slots.contribute(NAV_ACTIONS, { component: CustomizeMenuAction });
}
