import {
  Component,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { Context } from 'cordis';

import { buildNavMenu, hrefForRoute, type RouteDefinition } from '../../../src/parts/ui/routes.ts';
import { KernelContext, ROOT } from '../kernel';
import { HOME_ROUTES_FILE, RoutesListing } from '../pages/Routes';
import { useRoute, useRoutes, useScreens } from '../router';
import { Slot } from '../slots.tsx';
import { Alert, Button, Icon } from '@burnex/ui';
import { WidgetHost } from '../widgetHost';
import { GenericNavItem } from './navItem';
import {
  NAV,
  NAV_ACTIONS,
  ROUTES_LISTING_KEY,
  ROUTE_TARGET,
  SCREEN,
  SCREEN_FRAME,
  type ChainLinkProps,
  type RouteTargetSlotProps,
} from '@burnex/slots';

/**
 * Каркас витрины — встроенный плагин (design.md `cordis-kernel-browser`,
 * Решение 8; `ui-routes`, design.md Решения 5, 12, 13). Вносит компонент
 * каркаса в `root` с тремя дочерними слотами — `nav` (пункты меню по
 * действующей таблице маршрутов), `route.target` (цель разобранного
 * маршрута по её виду), `screen.frame` (обрамление; сюда же вносит границу
 * ошибок).
 *
 * Каркас не знает ни одного имени экрана и ни одного вида цели сверх двух
 * встроенных (`screen`, `widget`): оба заводит сам, третий (дашборд —
 * `dashboards-as-files`) добавится вкладом в тот же слот `route.target`, не
 * трогая этот файл.
 *
 * Подписка на сервис `live` — здесь и только здесь (design.md, Решение 10):
 * каркас раздаёт данные вкладчикам через props слотов, сами вкладчики к
 * контексту не обращаются вовсе.
 */

// Дескрипторы — из поверхности `@burnex/slots` (design.md изменения
// `shared-module-table`, Решение 5), не копии. Ре-экспорт сохраняет прежний
// путь импорта тем, кто уже на него полагается (`ui/test/shell.test.tsx`).
export { NAV, SCREEN, SCREEN_FRAME };

interface BoundaryState {
  readonly error: Error | undefined;
}

/** Граница ошибок — единственный сегодняшний вкладчик `chain` (design.md, открытый вопрос про второго пользователя). */
class ScreenErrorBoundary extends Component<ChainLinkProps<Record<string, never>>, BoundaryState> {
  override state: BoundaryState = { error: undefined };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override render(): ReactNode {
    if (this.state.error !== undefined) {
      return <div className="screen-error">This screen crashed: {this.state.error.message}</div>;
    }
    return this.props.next;
  }
}

function useKernelContext(): Context {
  const ctx = useContext(KernelContext);
  if (ctx === undefined) throw new Error('Shell rendered outside the kernel tree');
  return ctx;
}

/**
 * Состояние меню этой вкладки — узкая колонка и свёрнутые группы — живёт в
 * `localStorage`, а не в `routes.yml`: это привычка человека за этим
 * браузером, а не состав меню проекта. Хранилище недоступно (приватный
 * режим, тест без него) — меню просто не помнит состояние.
 */
const RAIL_KEY = 'burnex.nav.rail';
const COLLAPSED_KEY = 'burnex.nav.collapsed';

function readStored(key: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Нет хранилища — нет памяти; меню работает и без неё.
  }
}

function readCollapsedGroups(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(readStored(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Подсказка узкой колонки: подпись пункта рядом с ним, вне прокручиваемой области (та обрезала бы её). */
interface NavTip {
  readonly text: string;
  readonly top: number;
  readonly left: number;
}

const LIVE_LABEL = {
  connecting: 'connecting to daemon…',
  live: 'live updates',
  offline: 'daemon unreachable',
} as const;

/**
 * Отпечаток сборки этой страницы — `<meta name="burnex-build">`, который
 * демон вставляет в отдаваемую разметку (`src/parts/ui/daemon/assets.ts`,
 * `BUILD_META`). `undefined` вне браузера и под дев-сервером Vite: страницу
 * там отдаёт не демон, и сравнивать не с чем.
 */
export function pageBuild(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.querySelector('meta[name="burnex-build"]')?.getAttribute('content') ?? undefined;
}

/**
 * Плашка перезагрузки: демон перезапущен на другой сборке витрины, а вкладка
 * держит прежний бандл. Новые маршруты и экраны приходят ей потоком, а их
 * браузерных половин в старом бандле нет — без перезагрузки экран покажет
 * «browser half is unavailable».
 */
export function ReloadBar({
  page,
  daemon,
  reload = () => window.location.reload(),
}: {
  readonly page: string | undefined;
  readonly daemon: string | undefined;
  readonly reload?: () => void;
}): JSX.Element | null {
  if (page === undefined || daemon === undefined || page === daemon) return null;
  return (
    <Alert variant="warning" className="reload-bar">
      The dashboard was updated. Reload to get the new version.{' '}
      <Button size="sm" onClick={reload}>
        Reload
      </Button>
    </Alert>
  );
}

/** Причина, по которой цель маршрута не показана, — общий вид для обоих встроенных видов цели (design.md, Решение 5). */
function MissingTarget({ reason }: { readonly reason: string }): JSX.Element {
  return <div className="screen-error">{reason}</div>;
}

/**
 * Причина отказа сборки — полосой над содержимым (`ui-daemon`, «Отказ сборки
 * состава не гасит витрину»): причина приходит вместе с составом либо
 * таблицей и показывается пользователю. Отдельно от полосы диагностик ядра
 * витрины (`ui/src/slots.tsx`): та про отказы плагинов страницы, эта — про
 * отказ сборки на демоне.
 */
function BuildErrorBar({ label, reason }: { readonly label: string; readonly reason: string }): JSX.Element {
  return (
    <Alert variant="destructive">
      {label} was not rebuilt: {reason}
    </Alert>
  );
}

/**
 * Вид цели `screen` — ключ слота экранов, тем же приёмом, что и прежде.
 * Присутствие `id` проверяется реактивно по сервису `screens`: отключённая
 * или незнакомая строка перестаёт быть экраном сразу по следующему событию
 * потока, без хот-свопа слотов (`ui-daemon`, «Состав экранов изменён без
 * перезагрузки»).
 */
function ScreenTargetView({ target, pathParams, targetParams, ...live }: RouteTargetSlotProps): JSX.Element {
  const { table, buildError } = useScreens();

  if (!table.has(target.id)) {
    return (
      <MissingTarget
        reason={
          buildError === undefined
            ? `Screen “${target.id}” is not in the active composition`
            : `Screen “${target.id}” is not in the active composition (composition build: ${buildError})`
        }
      />
    );
  }

  // Параметры пути доезжают до экрана по своим именам, а объявленные
  // маршрутом параметры цели — поверх них (`ui-routes`, Решение 6): их
  // подстановки уже применены разбором адреса (`parseRoute`), а литерал,
  // названный маршрутом явно, сильнее одноимённого сегмента пути — иначе
  // объявить его было бы невозможно.
  const params = { ...pathParams, ...targetParams };

  return (
    <Slot
      of={SCREEN}
      k={target.id}
      props={{ ...live, params }}
      default={<MissingTarget reason={`Screen “${target.id}” is declared, but its browser half is unavailable`} />}
    />
  );
}

/**
 * Вид цели `widget` — хост виджета, тем же компонентом, каким виджет
 * показан на экране виджетов (`ui-routes`, Решение 5). Параметры цели
 * маршруту на виджет пока недоступны — контракт `props` виджета откладывает
 * `dashboards-as-files` (`docs/widgets.md`, Non-Goals).
 */
function WidgetTargetView({ target, targetParams, widgets }: RouteTargetSlotProps): JSX.Element {
  const paramNames = Object.keys(targetParams);
  if (paramNames.length > 0) {
    return (
      <MissingTarget
        reason={`The route declares widget target params (${paramNames.join(', ')}), but widgets have no props contract yet`}
      />
    );
  }

  const parts = target.id.split('/');
  if (parts.length !== 2) {
    return <MissingTarget reason={`Widget target “${target.id}” must have the form <project>/<id>`} />;
  }
  const [projectKey, id] = parts as [string, string];
  const found = widgets?.projects
    .find((project) => project.projectKey === projectKey)
    ?.widgets.find((widget) => widget.id === id);
  if (found === undefined) {
    return <MissingTarget reason={`Widget “${id}” of project “${projectKey}” is not in the active composition`} />;
  }
  return <WidgetHost projectKey={projectKey} id={id} version={found.version} />;
}

function UnknownTargetKind({ kind }: { readonly kind: string }): JSX.Element {
  return <MissingTarget reason={`Target kind “${kind}” is unknown to the active composition`} />;
}

function Shell(): JSX.Element {
  const ctx = useKernelContext();
  const live = useSyncExternalStore(
    (listener) => ctx.live.subscribe(listener),
    () => ctx.live.get(),
    () => ctx.live.get(),
  );
  const { route, navigate } = useRoute();
  const routesSnapshot = useRoutes();
  const { table: screensTable, buildError: screensBuildError } = useScreens();

  // Прогон, за которым следит поток событий, — по разобранным параметрам
  // адреса, а не по имени экрана: каркас не знает ни одного (`ui-screens`,
  // «каркас витрины MUST NOT содержать перечня экранов»). Пара «проект и
  // прогон» и есть адрес прогона, кто бы её ни объявил.
  const { projectKey, runId } = route?.pathParams ?? {};
  const followed = projectKey === undefined || runId === undefined ? undefined : `${projectKey}/${runId}`;

  // Единственное место подписки: смена адреса пересоздаёт её через `follow`,
  // а не размонтирование компонента (design.md, Решение 10).
  useEffect(() => {
    ctx.live.follow(followed);
  }, [ctx, followed]);

  const liveProps = {
    overview: live.overview,
    navigate,
    backlog: live.backlog,
    widgets: live.widgets,
    snapshot: live.snapshot,
    proposals: live.proposals,
  };

  const activeRouteId = route?.route.id;
  const isActive = (navRoute: RouteDefinition): boolean =>
    activeRouteId !== undefined &&
    (activeRouteId === navRoute.id || navRoute.nav?.activeFor?.includes(activeRouteId) === true);

  // Раскладка по группам — общая с экраном настройки меню (`buildNavMenu`);
  // каркас не знает ни одной группы и ни одного экрана: и те и другие
  // объявлены файлом маршрутов. Скрытые пункты и опустевшие группы меню
  // пропускает.
  const menu = buildNavMenu(routesSnapshot.table, routesSnapshot.navGroups);
  const visible = (routes: readonly RouteDefinition[]): readonly RouteDefinition[] =>
    routes.filter((candidate) => candidate.nav?.hidden !== true);
  const groups = menu.groups
    .map((group) => ({ ...group, items: visible(group.items) }))
    .filter((group) => group.items.length > 0);
  const ungrouped = visible(menu.ungrouped);

  const [rail, setRail] = useState(() => readStored(RAIL_KEY) === '1');
  const [collapsed, setCollapsed] = useState(readCollapsedGroups);
  const [tip, setTip] = useState<NavTip | undefined>(undefined);

  const toggleRail = (): void => {
    setTip(undefined);
    setRail((current) => {
      writeStored(RAIL_KEY, current ? '0' : '1');
      return !current;
    });
  };
  const setGroupCollapsed = (id: string, value: boolean): void => {
    setCollapsed((current) => {
      if (current.has(id) === value) return current;
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      writeStored(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  // Переход на экран свёрнутой группы раскрывает её: текущий пункт должен
  // быть виден. Свернуть её после этого пользователь вправе — заголовок
  // такой группы остаётся отмеченным как содержащий текущую страницу.
  const activeGroupId = groups.find((group) => group.items.some(isActive))?.id;
  useEffect(() => {
    if (activeGroupId !== undefined) setGroupCollapsed(activeGroupId, false);
    // Зависимости — только текущий пункт: раскрытие не должно повторяться на каждую отрисовку.
  }, [activeGroupId, activeRouteId]);

  const showTip = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>): void => {
    if (!rail) return;
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-nav-tip]');
    const text = item?.dataset.navTip;
    if (item === null || item === undefined || text === undefined) return;
    const box = item.getBoundingClientRect();
    setTip({ text, top: box.top + box.height / 2, left: box.right + 8 });
  };
  const hideTip = (): void => setTip(undefined);

  const renderNavItem = (navRoute: RouteDefinition): JSX.Element => {
    const title =
      navRoute.nav?.title ??
      (navRoute.target.kind === 'screen' ? screensTable.get(navRoute.target.id)?.title : undefined) ??
      navRoute.target.id;
    // Ссылка пункта — адрес своего маршрута, а не поиск по цели: цель
    // вправе иметь несколько маршрутов, и пункт обязан вести на тот, чей
    // `nav` его и породил (`ui-routes`, Решение 13).
    const href = hrefForRoute(navRoute);
    const props = {
      route: navRoute,
      title,
      href,
      active: isActive(navRoute),
      navigate,
      ...(navRoute.nav?.icon === undefined ? {} : { icon: navRoute.nav.icon }),
      compact: rail,
    };
    return <Slot key={navRoute.id} of={NAV} k={navRoute.id} props={props} default={<GenericNavItem {...props} />} />;
  };

  const liveLabel = LIVE_LABEL[live.state];

  return (
    <div className="shell">
      <nav className={rail ? 'sidebar rail' : 'sidebar'} aria-label="Main">
        <a
          className="brand"
          href="/"
          aria-label="burnex"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            navigate('/');
          }}
        >
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">burnex</span>
        </a>

        {/* Прокручивается только середина: бренд и подвал остаются на месте при любой высоте окна. */}
        <div className="nav-scroll" onMouseOver={showTip} onMouseLeave={hideTip} onFocus={showTip} onBlur={hideTip}>
          {groups.map((group) => {
            // В узкой колонке группы не сворачиваются: без подписей свёрнутую группу не найти.
            const isCollapsed = !rail && collapsed.has(group.id);
            const holdsCurrent = group.id === activeGroupId;
            return (
              <div className={isCollapsed ? 'nav-group collapsed' : 'nav-group'} key={group.id}>
                <button
                  type="button"
                  className={holdsCurrent ? 'nav-group-label holds-current' : 'nav-group-label'}
                  aria-expanded={!isCollapsed}
                  aria-controls={`nav-group-${group.id}`}
                  onClick={() => setGroupCollapsed(group.id, !isCollapsed)}
                >
                  <span className="nav-group-title">{group.title}</span>
                  <Icon name="chevron-down" size={13} className="nav-group-chevron" />
                </button>
                <div className="nav-group-items" id={`nav-group-${group.id}`}>
                  {group.items.map(renderNavItem)}
                </div>
              </div>
            );
          })}
          {ungrouped.length === 0 ? null : (
            <div className="nav-group">
              <div className="nav-group-items">{ungrouped.map(renderNavItem)}</div>
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <div className={live.state === 'live' ? 'live on' : 'live off'} title={liveLabel}>
            <span className="live-label">{liveLabel}</span>
          </div>
          <div className="sidebar-actions">
            <Slot of={NAV_ACTIONS} props={{ navigate, compact: rail }} />
            <button
              type="button"
              className="sidebar-action sidebar-toggle"
              aria-label={rail ? 'Expand menu' : 'Collapse menu'}
              title={rail ? 'Expand menu' : 'Collapse menu'}
              aria-pressed={rail}
              onClick={toggleRail}
            >
              <Icon name={rail ? 'panel-left-open' : 'panel-left-close'} size={16} />
            </button>
          </div>
        </div>
        {tip === undefined ? null : (
          <div className="nav-tip" style={{ top: tip.top, left: tip.left }} aria-hidden="true">
            {tip.text}
          </div>
        )}
      </nav>

      <main className="content">
        <ReloadBar page={pageBuild()} daemon={live.build} />
        {screensBuildError === undefined ? null : <BuildErrorBar label="Screen composition" reason={screensBuildError} />}
        {routesSnapshot.buildError === undefined ? null : (
          <BuildErrorBar label="Route table" reason={routesSnapshot.buildError} />
        )}
        <Slot
          of={SCREEN_FRAME}
          props={{}}
          default={
            route === undefined ? (
              <Slot
                of={SCREEN}
                k={ROUTES_LISTING_KEY}
                props={{ ...liveProps, params: {} }}
                default={
                  <RoutesListing
                    pathname={window.location.pathname}
                    table={routesSnapshot.table}
                    buildError={routesSnapshot.buildError}
                    layerFile={HOME_ROUTES_FILE}
                  />
                }
              />
            ) : (
              <Slot
                of={ROUTE_TARGET}
                k={route.route.target.kind}
                props={{
                  ...liveProps,
                  target: route.route.target,
                  pathParams: route.pathParams,
                  targetParams: route.targetParams,
                }}
                default={<UnknownTargetKind kind={route.route.target.kind} />}
              />
            )
          }
        />
      </main>
    </div>
  );
}

export default function shell(ctx: Context): void {
  ctx.slots.contribute(ROOT, { component: Shell, slots: [NAV, NAV_ACTIONS, SCREEN, SCREEN_FRAME, ROUTE_TARGET] });
  ctx.slots.contribute<Record<string, never>, 'chain'>(SCREEN_FRAME, { component: ScreenErrorBoundary });
  ctx.slots.contribute(ROUTE_TARGET, { component: ScreenTargetView, key: 'screen' });
  ctx.slots.contribute(ROUTE_TARGET, { component: WidgetTargetView, key: 'widget' });
}
