import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildRouteTable } from '../../src/parts/ui/routesFile.ts';
import { UNGROUPED, draftFromMenu, isEmptyPatch, navPatch, type NavDraft } from '../src/navDraft.ts';
import { tempDir } from '../../test/tmp.ts';

/** Действующее меню поставки и равный ему черновик экрана «Navigation». */
function builtinMenu(): { table: ReturnType<typeof buildRouteTable>['table']; groups: ReturnType<typeof buildRouteTable>['navGroups']; draft: NavDraft } {
  const result = buildRouteTable({ home: tempDir('nav-draft-home-') });
  return {
    table: result.table,
    groups: result.navGroups,
    draft: draftFromMenu(result.table, result.navGroups, (route) => route.target.id),
  };
}

describe('ui-navigation: черновик меню и его разница с действующим', () => {
  it('нетронутый черновик не даёт правки', () => {
    const { table, groups, draft } = builtinMenu();
    assert.ok(isEmptyPatch(navPatch(table, groups, draft)));
  });

  it('название, значок и скрытие дают по одному листу, порядок не трогается', () => {
    const { table, groups, draft } = builtinMenu();
    const runs = draft.items['screen-runs']!;
    const edited: NavDraft = {
      ...draft,
      items: { ...draft.items, 'screen-runs': { ...runs, title: 'Launches', icon: 'rocket', hidden: true } },
    };
    assert.deepEqual(navPatch(table, groups, edited), {
      routes: [{ id: 'screen-runs', title: 'Launches', icon: 'rocket', hidden: true }],
    });
  });

  it('перенос пункта в конец другой группы пишет только его группу и порядок', () => {
    const { table, groups, draft } = builtinMenu();
    const edited: NavDraft = {
      ...draft,
      layout: {
        ...draft.layout,
        system: draft.layout.system!.filter((id) => id !== 'screen-usage'),
        review: [...draft.layout.review!, 'screen-usage'],
      },
    };
    assert.deepEqual(navPatch(table, groups, edited), {
      routes: [{ id: 'screen-usage', group: 'review', order: 30 }],
    });
  });

  it('новая группа получает id из названия, удаление группы уводит пункты в «без группы»', () => {
    const { table, groups, draft } = builtinMenu();
    const withGroup: NavDraft = {
      ...draft,
      groups: [...draft.groups, { id: 'new-group-1', title: 'My Stuff', builtin: false, isNew: true }],
      layout: {
        ...draft.layout,
        workspace: draft.layout.workspace!.filter((id) => id !== 'screen-secrets'),
        'new-group-1': ['screen-secrets'],
      },
    };
    assert.deepEqual(navPatch(table, groups, withGroup), {
      routes: [{ id: 'screen-secrets', group: 'my-stuff', order: 10 }],
      groups: [{ id: 'my-stuff', title: 'My Stuff', order: 70 }],
    });

    const { review: orphans = [], ...rest } = draft.layout;
    const withoutReview: NavDraft = {
      ...draft,
      groups: draft.groups.filter((group) => group.id !== 'review'),
      layout: { ...rest, [UNGROUPED]: orphans },
    };
    const patch = navPatch(table, groups, withoutReview);
    assert.deepEqual(patch.removeGroups, ['review']);
    assert.deepEqual(patch.routes, [
      { id: 'screen-decisions', group: null },
      { id: 'screen-proposals', group: null },
    ]);
  });
});
