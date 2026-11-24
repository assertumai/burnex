import {
  buildNavMenu,
  navGroupTitle,
  type NavGroupEntry,
  type RouteDefinition,
  type RouteTable,
} from '../../src/parts/ui/routes.ts';
import type { NavPatch } from '../../src/parts/ui/routesFile.ts';

/**
 * Черновик меню экрана «Navigation» и его разница с действующим меню.
 *
 * Экран правит черновик целиком (перетаскивание, названия, значки), а в файл
 * слоя уходит только разница (`navPatch`): слой пользователя хранит его
 * намерения, а не снимок меню, — иначе пункт, добавленный следующей версией
 * поставки, вставал бы не на своё место, а новая встроенная группа терялась.
 */

/** Ключ раскладки для пунктов без группы. */
export const UNGROUPED = '__ungrouped__';

export interface DraftItem {
  readonly id: string;
  readonly path: string;
  /** Название, которое пункт получит без своего `nav.title`: заголовок цели. */
  readonly inheritedTitle: string;
  /** Своё название пункта; пустая строка — наследовать. */
  readonly title: string;
  readonly icon: string | undefined;
  readonly hidden: boolean;
}

export interface DraftGroup {
  readonly id: string;
  readonly title: string;
  /** Объявлена поставкой: удалить нельзя, только переименовать и освободить. */
  readonly builtin: boolean;
  /** Создана в этом черновике: окончательный `id` получит при сохранении, из названия. */
  readonly isNew: boolean;
}

export interface NavDraft {
  readonly groups: readonly DraftGroup[];
  readonly items: Readonly<Record<string, DraftItem>>;
  /** Пункты по группам (ключ — `id` группы либо `UNGROUPED`), в порядке меню. */
  readonly layout: Readonly<Record<string, readonly string[]>>;
}

/** Черновик, равный действующему меню. `titleOf` даёт заголовок цели маршрута. */
export function draftFromMenu(
  table: RouteTable,
  navGroups: readonly NavGroupEntry[],
  titleOf: (route: RouteDefinition) => string,
): NavDraft {
  const menu = buildNavMenu(table, navGroups);
  const builtin = new Set(navGroups.filter((group) => group.layers.includes('builtin')).map((group) => group.id));
  const items: Record<string, DraftItem> = {};
  const layout: Record<string, string[]> = {};
  const place = (key: string, routes: readonly RouteDefinition[]): void => {
    layout[key] = routes.map((route) => route.id);
    for (const route of routes) {
      items[route.id] = {
        id: route.id,
        path: route.path,
        inheritedTitle: titleOf(route),
        title: route.nav?.title ?? '',
        icon: route.nav?.icon,
        hidden: route.nav?.hidden === true,
      };
    }
  };
  for (const group of menu.groups) place(group.id, group.items);
  place(UNGROUPED, menu.ungrouped);
  return {
    groups: menu.groups.map((group) => ({ id: group.id, title: group.title, builtin: builtin.has(group.id), isNew: false })),
    items,
    layout,
  };
}

/** `id` новой группы из её названия: строчные латинские буквы, цифры и дефис; занятый — с номером. */
function groupIdFor(title: string, taken: ReadonlySet<string>): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'group';
  if (!taken.has(slug) && slug !== UNGROUPED) return slug;
  for (let n = 2; ; n += 1) {
    if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
  }
}

/** Порядок уже верен, если значения `order` у последовательности объявлены и строго растут. */
function ordered(orders: readonly (number | undefined)[]): boolean {
  return orders.every((order, index) => order !== undefined && (index === 0 || order > (orders[index - 1] as number)));
}

type RoutePatch = NonNullable<NavPatch['routes']>[number];
type GroupPatch = NonNullable<NavPatch['groups']>[number];

/**
 * Разница черновика с действующим меню — только изменённые листья. Порядок
 * переписывается шагом 10 лишь в той группе, где он действительно сменился,
 * и лишь у пунктов, чей `order` от этого стал другим.
 */
export function navPatch(table: RouteTable, navGroups: readonly NavGroupEntry[], draft: NavDraft): NavPatch {
  const routeById = new Map(table.map((route) => [route.id, route]));
  const groupById = new Map(navGroups.map((group) => [group.id, group]));

  // Окончательные `id` новых групп — из названий, без совпадений с занятыми.
  const taken = new Set([...navGroups.map((group) => group.id), ...draft.groups.filter((g) => !g.isNew).map((g) => g.id)]);
  const finalId = new Map<string, string>();
  for (const group of draft.groups) {
    if (!group.isNew) {
      finalId.set(group.id, group.id);
      continue;
    }
    const id = groupIdFor(group.title, taken);
    taken.add(id);
    finalId.set(group.id, id);
  }

  const groups: GroupPatch[] = [];
  const renumberGroups = !ordered(draft.groups.map((group) => (group.isNew ? undefined : groupById.get(group.id)?.order)));
  draft.groups.forEach((group, index) => {
    const base = groupById.get(group.id);
    const id = finalId.get(group.id) as string;
    const title = group.title.trim();
    const baseTitle = base?.title ?? (group.isNew ? undefined : navGroupTitle(id));
    const order = (index + 1) * 10;
    const patch: GroupPatch = {
      id,
      ...(title !== '' && title !== baseTitle ? { title } : {}),
      ...(renumberGroups && base?.order !== order ? { order } : {}),
    };
    if (Object.keys(patch).length > 1 || group.isNew) groups.push(patch);
  });

  const draftGroupIds = new Set(draft.groups.map((group) => group.id));
  const removeGroups = navGroups.filter((group) => !draftGroupIds.has(group.id)).map((group) => group.id);

  const routes: RoutePatch[] = [];
  for (const [key, ids] of Object.entries(draft.layout)) {
    const group = key === UNGROUPED ? null : (finalId.get(key) ?? key);
    const renumber = !ordered(
      ids.map((id) => {
        const base = routeById.get(id);
        return (base?.nav?.group ?? null) === group ? base?.nav?.order : undefined;
      }),
    );
    ids.forEach((id, index) => {
      const base = routeById.get(id)?.nav;
      const item = draft.items[id];
      if (item === undefined) return;
      const title = item.title.trim();
      const order = (index + 1) * 10;
      const patch: RoutePatch = {
        id,
        ...((base?.group ?? null) !== group ? { group } : {}),
        ...(renumber && base?.order !== order ? { order } : {}),
        ...(title !== (base?.title ?? '') ? { title: title === '' ? null : title } : {}),
        ...(item.icon !== base?.icon ? { icon: item.icon ?? null } : {}),
        ...(item.hidden !== (base?.hidden === true) ? { hidden: item.hidden } : {}),
      };
      if (Object.keys(patch).length > 1) routes.push(patch);
    });
  }

  return {
    ...(routes.length > 0 ? { routes } : {}),
    ...(groups.length > 0 ? { groups } : {}),
    ...(removeGroups.length > 0 ? { removeGroups } : {}),
  };
}

export function isEmptyPatch(patch: NavPatch): boolean {
  return patch.routes === undefined && patch.groups === undefined && patch.removeGroups === undefined;
}
