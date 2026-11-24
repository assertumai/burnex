import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildNavMenu } from '../src/parts/ui/routes.js';
import { buildRouteTable, homeRoutesPath, resetNav, writeNavPatch, writeRouteRow } from '../src/parts/ui/routesFile.js';
import { tempDir } from './tmp.js';

function writeHomeRoutes(home: string, content: string): void {
  mkdirSync(join(home, '.burnex'), { recursive: true });
  writeFileSync(homeRoutesPath(home), content);
}

/** Меню поставки и слоя `home`: заголовки групп с `id` видимых пунктов. */
function menuOf(home: string): Record<string, string[]> {
  const result = buildRouteTable({ home });
  const menu = buildNavMenu(result.table, result.navGroups);
  const out: Record<string, string[]> = {};
  for (const group of menu.groups) {
    out[group.title] = group.items.filter((route) => route.nav?.hidden !== true).map((route) => route.id);
  }
  if (menu.ungrouped.length > 0) out['(none)'] = menu.ungrouped.map((route) => route.id);
  return out;
}

describe('ui-nav-menu: меню — содержимое routes.yml', () => {
  it('поставка раскладывает экраны по шести объявленным группам', () => {
    assert.deepEqual(menuOf(tempDir('nav-home-')), {
      Work: ['screen-home', 'screen-runs', 'screen-pipelines', 'screen-schedule', 'screen-backlog', 'screen-scrum'],
      Review: ['screen-decisions', 'screen-proposals'],
      Agents: ['screen-agents', 'screen-review-strategies', 'screen-discussion-strategies'],
      Workspace: ['screen-projects', 'screen-packages', 'screen-secrets'],
      Customize: ['screen-widgets', 'screen-routes', 'screen-navigation'],
      System: ['screen-system', 'screen-usage', 'screen-cleanup'],
    });
  });

  it('у каждого пункта поставки свой значок и свой порядок внутри группы', () => {
    const { table } = buildRouteTable({ home: tempDir('nav-home-') });
    const seen = new Set<string>();
    for (const route of table) {
      if (route.nav === undefined) continue;
      assert.ok(route.nav.icon !== undefined, `${route.id}: нет значка`);
      const key = `${route.nav.group}:${route.nav.order}`;
      assert.ok(!seen.has(key), `${route.id}: порядок ${key} занят`);
      seen.add(key);
    }
  });

  it('группа прежнего состава в слое пользователя остаётся необъявленной группой после объявленных', () => {
    const home = tempDir('nav-home-');
    writeHomeRoutes(home, 'routes:\n  - id: screen-usage\n    nav: { group: config }\n');
    const titles = Object.keys(menuOf(home));
    assert.equal(titles.at(-1), 'Config');
    assert.deepEqual(menuOf(home).Config, ['screen-usage']);
  });

  it('group: null снимает группу нижнего слоя, hidden убирает пункт, но не адрес', () => {
    const home = tempDir('nav-home-');
    writeHomeRoutes(
      home,
      'routes:\n  - id: screen-usage\n    nav: { group: null }\n  - id: screen-cleanup\n    nav: { hidden: true }\n',
    );
    const menu = menuOf(home);
    assert.deepEqual(menu['(none)'], ['screen-usage']);
    assert.deepEqual(menu.System, ['screen-system']);
    const { table } = buildRouteTable({ home });
    assert.equal(table.find((route) => route.id === 'screen-cleanup')?.path, '/cleanup');
  });

  it('значок с внешним адресом или SVG отклоняется схемой', () => {
    for (const icon of ['https://example.com/a.png', 'data:image/svg+xml;base64,AAAA']) {
      const home = tempDir('nav-home-');
      writeHomeRoutes(home, `routes:\n  - id: screen-usage\n    nav: { icon: "${icon}" }\n`);
      assert.throws(() => buildRouteTable({ home }), /icon/);
    }
  });
});

describe('ui-nav-menu: правка меню пишет в слой только названные листья', () => {
  it('создаёт файл слоя, группу и листья пункта; остальное меню не тронуто', () => {
    const home = tempDir('nav-home-');
    writeNavPatch(
      'home',
      {
        routes: [{ id: 'screen-secrets', group: 'mine', order: 10, title: 'Keys', icon: 'text:🔑', hidden: false }],
        groups: [{ id: 'mine', title: 'Mine', order: 15 }],
      },
      { home },
    );
    const menu = menuOf(home);
    assert.deepEqual(Object.keys(menu).slice(0, 2), ['Work', 'Mine']);
    assert.deepEqual(menu.Mine, ['screen-secrets']);
    assert.deepEqual(menu.Workspace, ['screen-projects', 'screen-packages']);
    const nav = buildRouteTable({ home }).table.find((route) => route.id === 'screen-secrets')?.nav;
    assert.equal(nav?.title, 'Keys');
    assert.equal(nav?.icon, 'text:🔑');
  });

  it('null снимает собственный лист, а строка из одного id убирается из файла', () => {
    const home = tempDir('nav-home-');
    writeHomeRoutes(home, '# мои маршруты\nroutes:\n  - id: screen-runs\n    nav: { title: Launches }\n');
    writeNavPatch('home', { routes: [{ id: 'screen-runs', title: null }] }, { home });
    const text = readFileSync(homeRoutesPath(home), 'utf8');
    assert.match(text, /# мои маршруты/);
    assert.doesNotMatch(text, /screen-runs/);
    assert.equal(buildRouteTable({ home }).table.find((route) => route.id === 'screen-runs')?.nav?.title, undefined);
  });

  it('правка, после которой таблица не собирается, откатывает файл', () => {
    const home = tempDir('nav-home-');
    // Строка неизвестного маршрута без пути и цели: таблице её слить не с чем.
    assert.throws(() => writeNavPatch('home', { routes: [{ id: 'no-such-route', title: 'X' }] }, { home }), /neither path nor target/);
    assert.equal(existsSync(homeRoutesPath(home)), false);
  });

  it('сброс снимает настройки меню, оставляя путь, цель и active_for', () => {
    const home = tempDir('nav-home-');
    writeHomeRoutes(
      home,
      [
        'routes:',
        '  - id: screen-runs',
        '    path: /launches',
        '    nav: { title: Launches, order: 5, icon: rocket, active_for: [screen-run, screen-home] }',
        '  - id: screen-usage',
        '    nav: { group: mine, hidden: true }',
        'nav_groups:',
        '  - { id: mine, title: Mine }',
        '',
      ].join('\n'),
    );
    resetNav('home', { home });
    const result = buildRouteTable({ home });
    const runs = result.table.find((route) => route.id === 'screen-runs');
    assert.equal(runs?.path, '/launches');
    assert.equal(runs?.nav?.title, undefined);
    assert.equal(runs?.nav?.icon, 'play');
    assert.deepEqual(runs?.nav?.activeFor, ['screen-run', 'screen-home']);
    assert.equal(result.navGroups.some((group) => group.id === 'mine'), false);
    assert.doesNotMatch(readFileSync(homeRoutesPath(home), 'utf8'), /screen-usage/);
  });

  it('запись строки с экрана «Маршруты» не стирает значок, скрытие и active_for', () => {
    const home = tempDir('nav-home-');
    writeHomeRoutes(home, 'routes:\n  - id: screen-runs\n    nav: { icon: rocket, hidden: true, active_for: [screen-run] }\n');
    writeRouteRow('home', { id: 'screen-runs', nav: { title: 'Launches' }, enabled: true }, { home });
    const nav = buildRouteTable({ home }).table.find((route) => route.id === 'screen-runs')?.nav;
    assert.deepEqual(nav, { title: 'Launches', order: 10, group: 'work', activeFor: ['screen-run'], icon: 'rocket', hidden: true });
  });
});
