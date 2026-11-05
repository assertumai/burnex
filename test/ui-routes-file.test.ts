import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/kernel/errors.js';
import { parseRoute } from '../src/parts/ui/routes.js';
import { buildRouteTable, homeRoutesPath, projectRoutesPath, writeRouteRow } from '../src/parts/ui/routesFile.js';
import { tempDir } from './tmp.js';

/** Домашний и проектный каталоги для трёх слоёв — без .burnex/routes.yml, если тест его не пишет. */
function layerDirs(): { home: string; projectRoot: string } {
  const home = tempDir('routes-home-');
  const projectRoot = tempDir('routes-project-');
  return { home, projectRoot };
}

function writeHomeRoutes(home: string, content: string): void {
  const path = homeRoutesPath(home);
  mkdirSync(join(home, '.burnex'), { recursive: true });
  writeFileSync(path, content);
}

function writeProjectRoutes(projectRoot: string, content: string): void {
  const path = projectRoutesPath(projectRoot);
  mkdirSync(join(projectRoot, '.burnex'), { recursive: true });
  writeFileSync(path, content);
}

describe('ui-routes-file: сборка таблицы трёх слоёв', () => {
  it('без пользовательских файлов действует встроенная таблица без отказа', () => {
    const { home } = layerDirs();
    const result = buildRouteTable({ home });
    const runs = result.entries.find((entry) => entry.id === 'screen-runs');
    assert.ok(runs !== undefined);
    assert.equal(runs?.definition.path, '/runs');
    assert.equal(result.entries.find((entry) => entry.id === 'screen-home')?.definition.path, '/');
    assert.equal(runs?.sources.path.layer, 'builtin');
  });

  it('проектный слой переносит встроенный маршрут на другой путь, не трогая цель и навигацию', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(projectRoot, 'routes:\n  - id: screen-pipelines\n    path: /release\n');

    const result = buildRouteTable({ home, projectRoot });
    const entry = result.entries.find((candidate) => candidate.id === 'screen-pipelines');
    assert.equal(entry?.definition.path, '/release');
    assert.equal(entry?.sources.path.layer, 'project');
    assert.deepEqual(entry?.definition.target, { kind: 'screen', id: 'screen-pipelines' });
    assert.equal(entry?.definition.nav?.order, 1);
    assert.equal(entry?.sources.navOrder?.layer, 'builtin');
  });

  it('домашний слой переименовывает пункт меню, не трогая путь и цель', () => {
    const { home } = layerDirs();
    writeHomeRoutes(home, 'routes:\n  - id: screen-cleanup\n    nav:\n      title: Чистка\n');

    const result = buildRouteTable({ home });
    const entry = result.entries.find((candidate) => candidate.id === 'screen-cleanup');
    assert.equal(entry?.definition.nav?.title, 'Чистка');
    assert.equal(entry?.definition.path, '/cleanup');
    assert.equal(entry?.sources.navTitle?.layer, 'home');
    assert.equal(entry?.sources.path.layer, 'builtin');
  });

  it('домашний слой переносит пункт в другую группу меню, встроенная группа видна у остальных', () => {
    const { home } = layerDirs();
    writeHomeRoutes(home, 'routes:\n  - id: screen-cleanup\n    nav:\n      group: work\n');

    const result = buildRouteTable({ home });
    const cleanup = result.entries.find((candidate) => candidate.id === 'screen-cleanup');
    assert.equal(cleanup?.definition.nav?.group, 'work');
    assert.equal(cleanup?.sources.navGroup?.layer, 'home');
    assert.equal(cleanup?.definition.nav?.order, 6);
    const agents = result.entries.find((candidate) => candidate.id === 'screen-agents');
    assert.equal(agents?.definition.nav?.group, 'config');
    assert.equal(agents?.sources.navGroup?.layer, 'builtin');
    const secrets = result.entries.find((candidate) => candidate.id === 'screen-secrets');
    assert.equal(secrets?.definition.path, '/secrets');
    assert.equal(secrets?.definition.nav?.group, 'config');
    assert.equal(secrets?.definition.nav?.order, 8);
    const schedule = result.entries.find((candidate) => candidate.id === 'screen-schedule');
    assert.equal(schedule?.definition.path, '/schedule');
    assert.equal(schedule?.definition.nav?.group, 'config');
    assert.equal(schedule?.definition.nav?.order, 9);
    const system = result.entries.find((candidate) => candidate.id === 'screen-system');
    assert.equal(system?.definition.path, '/system');
    assert.equal(system?.definition.nav?.group, 'config');
    assert.equal(system?.definition.nav?.order, 10);
  });

  it('enabled: false убирает маршрут из действующей таблицы целиком', () => {
    const { home } = layerDirs();
    writeHomeRoutes(home, 'routes:\n  - id: screen-agents\n    enabled: false\n');

    const result = buildRouteTable({ home });
    assert.equal(result.entries.some((entry) => entry.id === 'screen-agents'), false);
  });

  it('отключённый маршрут остаётся в перечне отключённых с файлом, который его выключил', () => {
    const { home } = layerDirs();
    writeHomeRoutes(home, 'routes:\n  - id: screen-agents\n    enabled: false\n');

    const result = buildRouteTable({ home });
    // Без этого перечня отключённый маршрут исчезал бы из витрины совсем, и
    // включить его обратно можно было бы только правкой файла руками.
    const off = result.disabled.find((entry) => entry.id === 'screen-agents');
    assert.equal(off?.path, '/agents/:tab?', 'поля отключённой строки слиты слоями так же, как у действующей');
    assert.deepEqual(off?.target, { kind: 'screen', id: 'screen-agents' });
    assert.equal(off?.disabledBy.layer, 'home');
    assert.equal(off?.disabledBy.file, homeRoutesPath(home));
  });

  it('отключённая строка не отказывает сборке ни конфликтом пути, ни отсутствием цели', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n' +
        '  - id: my-runs\n    path: /\n    target: { screen: screen-runs }\n    enabled: false\n' +
        '  - id: my-half\n    nav: { title: Пусто }\n    enabled: false\n',
    );

    const result = buildRouteTable({ home, projectRoot });
    assert.equal(result.entries.find((entry) => entry.id === 'screen-home')?.definition.path, '/');
    assert.deepEqual(
      result.disabled.map((entry) => entry.id).sort(),
      ['my-half', 'my-runs'],
    );
  });

  it('отсутствующий встроенный файл — названный отказ с именем файла, без подстановки зашитых адресов', () => {
    const { home } = layerDirs();
    const missing = join(tempDir('routes-builtin-'), 'routes.yml');

    assert.throws(
      () => buildRouteTable({ home, builtinPath: missing }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, missing);
        assert.match(error.message, /cannot be read/);
        return true;
      },
    );
  });

  it('неразбираемый встроенный файл — названный отказ с именем файла', () => {
    const { home } = layerDirs();
    const dir = tempDir('routes-builtin-');
    const broken = join(dir, 'routes.yml');
    writeFileSync(broken, 'routes: [{ id: bad, path: 7 }]\n');

    assert.throws(
      () => buildRouteTable({ home, builtinPath: broken }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, broken);
        return true;
      },
    );
  });

  it('новый id в проектном слое дополняет таблицу, не задевая остальных', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-dashboard\n    path: /team\n    target: { widget: proj/team }\n',
    );

    const result = buildRouteTable({ home, projectRoot });
    // 19 встроенных маршрутов (включая screen-home, screen-scrum,
    // screen-decisions, screen-proposals, screen-secrets, screen-schedule,
    // screen-system и screen-packages) плюс этот новый.
    assert.equal(result.entries.length, 19);
    const entry = result.entries.find((candidate) => candidate.id === 'my-dashboard');
    assert.deepEqual(entry?.definition.target, { kind: 'widget', id: 'proj/team' });
    const runs = result.entries.find((candidate) => candidate.id === 'screen-runs');
    assert.equal(runs?.definition.path, '/runs');
  });

  it('проектный слой — только файл каталога, в котором поднят демон', () => {
    const { home, projectRoot } = layerDirs();
    const otherProject = tempDir('routes-other-project-');
    writeProjectRoutes(otherProject, 'routes:\n  - id: screen-runs\n    path: /elsewhere\n');

    const result = buildRouteTable({ home, projectRoot });
    const runs = result.entries.find((candidate) => candidate.id === 'screen-runs');
    assert.equal(runs?.definition.path, '/runs');
  });

  it('два маршрута с одинаковым нормализованным шаблоном — названный отказ с обоими id и файлами', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-runs\n    path: /runs/:a/:b\n    target: { screen: screen-runs }\n',
    );

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /screen-run\b/);
        assert.match(error.message, /my-runs/);
        assert.match(error.message, /routes\.yml/);
        return true;
      },
    );
  });

  it('путь под зарезервированным префиксом — названный отказ', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-api\n    path: /api/whatever\n    target: { screen: screen-runs }\n',
    );

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /reserved path/);
        return true;
      },
    );
  });

  it('подстановка параметра цели на несуществующее имя — названный отказ со ссылкой на маршрут, файл и имя', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-widget\n    path: /w/:id\n    target: { widget: proj/clock }\n    params: { note: "${params.nope}" }\n',
    );

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /my-widget/);
        assert.match(error.message, /nope/);
        assert.equal(error.file, projectRoutesPath(projectRoot));
        return true;
      },
    );
  });

  it('неразбираемый файл слоя — названный отказ с именем файла и местом разбора', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(projectRoot, 'routes: [{ id: bad, path: 7 }]\n');

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, projectRoutesPath(projectRoot));
        return true;
      },
    );
  });

  it('новый id без path/target ни в одном слое — названный отказ', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(projectRoot, 'routes:\n  - id: my-half\n    nav:\n      title: Пусто\n');

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /my-half/);
        return true;
      },
    );
  });

  it('маршрут с целью-дашбордом собирается тем же вкладом, что и цель-экран/цель-виджет', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-dashboard\n    path: /release/:period\n    target: { dashboard: release }\n    params: { window: "${params.period}" }\n',
    );

    const result = buildRouteTable({ home, projectRoot });
    const entry = result.entries.find((candidate) => candidate.id === 'my-dashboard');
    assert.deepEqual(entry?.definition.target, { kind: 'dashboard', id: 'release' });
    assert.deepEqual(entry?.definition.params, { window: '${params.period}' });
  });

  it('поле цели-дашборда сливается по слоям тем же правилом, что и прочие поля строки', () => {
    const { home, projectRoot } = layerDirs();
    writeHomeRoutes(home, 'routes:\n  - id: my-dashboard\n    path: /release\n    target: { dashboard: release }\n');
    writeProjectRoutes(projectRoot, 'routes:\n  - id: my-dashboard\n    nav:\n      title: Релиз\n');

    const result = buildRouteTable({ home, projectRoot });
    const entry = result.entries.find((candidate) => candidate.id === 'my-dashboard');
    assert.deepEqual(entry?.definition.target, { kind: 'dashboard', id: 'release' });
    assert.equal(entry?.sources.target.layer, 'home');
    assert.equal(entry?.definition.nav?.title, 'Релиз');
    assert.equal(entry?.sources.navTitle?.layer, 'project');
  });

  it('подстановка параметра цели-дашборда на имя вне шаблона пути — названный отказ', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-dashboard\n    path: /release\n    target: { dashboard: release }\n    params: { window: "${params.nope}" }\n',
    );

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /my-dashboard/);
        assert.match(error.message, /nope/);
        return true;
      },
    );
  });

  it('неизвестный ключ строки маршрута — отказ с указанием файла', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-route\n    path: /x\n    target: { screen: screen-runs }\n    bogus: 1\n',
    );

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, projectRoutesPath(projectRoot));
        assert.match(error.message, /bogus/);
        return true;
      },
    );
  });

  it('встроенная таблица: вкладка экрана агентов — параметр пути, а /settings — псевдоним с чужой целью', () => {
    // `ui-agents-settings-merge`: экрана настроек нет, адрес остался.
    const { home } = layerDirs();
    const table = buildRouteTable({ home }).entries.map((entry) => entry.definition);
    assert.equal(table.some((route) => route.target.id === 'screen-settings'), false, 'цели screen-settings нет');

    const policy = parseRoute('/agents/policy', table);
    assert.equal(policy?.route.id, 'screen-agents');
    assert.equal(policy?.pathParams.tab, 'policy');

    const bare = parseRoute('/agents', table);
    assert.equal(bare?.route.id, 'screen-agents');
    assert.equal(bare?.pathParams.tab, undefined);
    assert.equal(bare?.targetParams.tab, undefined);

    const settings = parseRoute('/settings', table);
    assert.equal(settings?.route.id, 'screen-settings');
    assert.deepEqual(settings?.route.target, { kind: 'screen', id: 'screen-agents' });
    assert.equal(settings?.targetParams.tab, 'default', 'параметр цели подставлен литералом');
    assert.equal(settings?.route.nav, undefined, 'пункта меню у псевдонима нет');

    assert.equal(parseRoute('/agents/other', table), undefined, 'значение вне перечня — неразобранный адрес');

    const agents = table.find((route) => route.id === 'screen-agents');
    assert.deepEqual(agents?.nav?.activeFor, ['screen-settings']);
  });

  it('домашний слой отключает псевдоним /settings, не трогая экран агентов', () => {
    const { home } = layerDirs();
    writeHomeRoutes(home, 'routes:\n  - id: screen-settings\n    enabled: false\n');
    const table = buildRouteTable({ home }).entries.map((entry) => entry.definition);
    assert.equal(parseRoute('/settings', table), undefined);
    assert.equal(parseRoute('/agents/tiers', table)?.route.id, 'screen-agents');
  });
});

describe('ui-routes-file: запись строки в слой через Document', () => {
  it('добавляет новую строку, сохраняя комментарии и прочие строки файла', () => {
    const { home } = layerDirs();
    const path = homeRoutesPath(home);
    mkdirSync(join(home, '.burnex'), { recursive: true });
    writeFileSync(path, '# мои маршруты\nroutes:\n  - id: screen-cleanup # правил вручную\n    enabled: false\n');

    writeRouteRow('home', { id: 'my-route', path: '/mine', target: { screen: 'screen-runs' } }, { home });

    const text = readFileSync(path, 'utf8');
    assert.match(text, /# мои маршруты/);
    assert.match(text, /# правил вручную/);
    assert.match(text, /my-route/);

    const result = buildRouteTable({ home });
    const entry = result.entries.find((candidate) => candidate.id === 'my-route');
    assert.equal(entry?.definition.path, '/mine');
  });

  it('файл с повтором ключа не переписывается — отказ называет место разбора', () => {
    const { home } = layerDirs();
    const path = homeRoutesPath(home);
    mkdirSync(join(home, '.burnex'), { recursive: true });
    // Повтор ключа `routes:` YAML не разбирает, но разбор «как получится» даёт
    // схемно верный объект: без проверки `doc.errors` запись прошла бы поверх
    // файла, который чтение слоя считает сломанным, и унесла бы первый блок.
    const broken =
      'routes:\n  - id: mine\n    path: /mine\n    target: { screen: screen-runs }\nroutes:\n  - id: other\n    path: /other\n    target: { screen: screen-runs }\n';
    writeFileSync(path, broken);

    assert.throws(
      () => writeRouteRow('home', { id: 'my-route', path: '/new', target: { screen: 'screen-runs' } }, { home }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, path);
        assert.match(error.message, /is not valid YAML/);
        assert.match(String(error.at), /line 5/);
        return true;
      },
    );
    assert.equal(readFileSync(path, 'utf8'), broken);
  });

  it('правка существующей строки заменяет её на месте, не дублируя', () => {
    const { home } = layerDirs();
    writeHomeRoutes(home, 'routes:\n  - id: my-route\n    path: /old\n    target: { screen: screen-runs }\n');

    writeRouteRow('home', { id: 'my-route', path: '/new', target: { screen: 'screen-runs' } }, { home });

    const result = buildRouteTable({ home });
    const rows = result.entries.filter((candidate) => candidate.id === 'my-route');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.definition.path, '/new');
  });
});

/** Пакет с манифестом и, при желании, своим `routes.yml`. */
function writePackageRoutes(root: string, name: string, routes: string | undefined, broken = false): string {
  const dir = join(root, '.burnex', 'packages', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.yml'),
    broken ? 'not: [valid' : `version: 1\nkind: package\nname: ${name}\ndescription: Пример\npackage_version: 0.1.0\n`,
  );
  const file = join(dir, 'routes.yml');
  if (routes !== undefined) writeFileSync(file, routes);
  return file;
}

describe('ui-routes-file: маршруты пакетов (packages-directory-layer)', () => {
  const OPS = 'routes:\n  - id: ops\n    path: /ops\n    target: { dashboard: ops }\n';

  it('маршрут пакета проекта входит в таблицу, источник называет слой, пакет и файл', () => {
    const { home, projectRoot } = layerDirs();
    const file = writePackageRoutes(projectRoot, 'hello', OPS);

    const entry = buildRouteTable({ home, projectRoot }).entries.find((candidate) => candidate.id === 'ops');
    assert.equal(entry?.definition.path, '/ops');
    assert.deepEqual(entry?.sources.path, { layer: 'project', package: 'hello', file });
  });

  it('маршрут свободного routes.yml проекта перекрывает маршрут пакета проекта', () => {
    const { home, projectRoot } = layerDirs();
    writePackageRoutes(projectRoot, 'hello', OPS);
    writeProjectRoutes(projectRoot, 'routes:\n  - id: ops\n    path: /operations\n');

    const entry = buildRouteTable({ home, projectRoot }).entries.find((candidate) => candidate.id === 'ops');
    assert.equal(entry?.definition.path, '/operations');
    assert.equal(entry?.sources.path.layer, 'project');
    assert.equal(entry?.sources.path.package, undefined);
    // Цель осталась от пакета: слияние идёт по листьям, как у прочих слоёв.
    assert.equal(entry?.sources.target.package, 'hello');
  });

  it('порядок слоёв: встроенное ← пакеты home ← home ← пакеты проекта ← проект', () => {
    const { home, projectRoot } = layerDirs();
    writePackageRoutes(home, 'tools', 'routes:\n  - id: screen-cleanup\n    nav:\n      title: Из пакета home\n');
    assert.equal(
      buildRouteTable({ home, projectRoot }).entries.find((e) => e.id === 'screen-cleanup')?.definition.nav?.title,
      'Из пакета home',
    );

    writeHomeRoutes(home, 'routes:\n  - id: screen-cleanup\n    nav:\n      title: Из home\n');
    assert.equal(
      buildRouteTable({ home, projectRoot }).entries.find((e) => e.id === 'screen-cleanup')?.definition.nav?.title,
      'Из home',
    );

    writePackageRoutes(projectRoot, 'hello', 'routes:\n  - id: screen-cleanup\n    nav:\n      title: Из пакета проекта\n');
    assert.equal(
      buildRouteTable({ home, projectRoot }).entries.find((e) => e.id === 'screen-cleanup')?.definition.nav?.title,
      'Из пакета проекта',
    );

    writeProjectRoutes(projectRoot, 'routes:\n  - id: screen-cleanup\n    nav:\n      title: Из проекта\n');
    assert.equal(
      buildRouteTable({ home, projectRoot }).entries.find((e) => e.id === 'screen-cleanup')?.definition.nav?.title,
      'Из проекта',
    );
  });

  it('конфликт id двух пакетов одного слоя — отказ одной строки, называющий оба пакета; прочее действует', () => {
    const { home, projectRoot } = layerDirs();
    writePackageRoutes(projectRoot, 'a', `${OPS}  - id: only-a\n    path: /only-a\n    target: { dashboard: a }\n`);
    writePackageRoutes(projectRoot, 'b', OPS);
    writeProjectRoutes(projectRoot, 'routes:\n  - id: mine\n    path: /mine\n    target: { dashboard: mine }\n');

    const result = buildRouteTable({ home, projectRoot });
    assert.equal(result.entries.some((entry) => entry.id === 'ops'), false);
    assert.ok(result.entries.some((entry) => entry.id === 'only-a'));
    assert.ok(result.entries.some((entry) => entry.id === 'mine'));
    assert.ok(result.entries.some((entry) => entry.id === 'screen-cleanup'), 'встроенные строки на месте');
    assert.equal(result.failures.length, 1);
    assert.deepEqual(result.failures[0]?.packages, ['a', 'b']);
    assert.equal(result.failures[0]?.id, 'ops');
    assert.match(result.failures[0]?.message ?? '', /a and b/);
  });

  it('строку в конфликте пакетов может объявить слой выше — действует она', () => {
    const { home, projectRoot } = layerDirs();
    writePackageRoutes(projectRoot, 'a', OPS);
    writePackageRoutes(projectRoot, 'b', OPS);
    writeProjectRoutes(projectRoot, 'routes:\n  - id: ops\n    path: /own-ops\n    target: { dashboard: ops }\n');

    const result = buildRouteTable({ home, projectRoot });
    assert.equal(result.entries.find((entry) => entry.id === 'ops')?.definition.path, '/own-ops');
    assert.equal(result.failures.length, 1);
  });

  it('один id в пакете проекта и в пакете home — не конфликт: действует пакет проекта', () => {
    const { home, projectRoot } = layerDirs();
    writePackageRoutes(home, 'tools', 'routes:\n  - id: ops\n    path: /home-ops\n    target: { dashboard: ops }\n');
    writePackageRoutes(projectRoot, 'hello', OPS);

    const entry = buildRouteTable({ home, projectRoot }).entries.find((candidate) => candidate.id === 'ops');
    assert.equal(entry?.definition.path, '/ops');
  });

  it('routes.yml пакета проходит прежнюю схему: ошибка называет файл пакета и исключает только его', () => {
    const { home, projectRoot } = layerDirs();
    const file = writePackageRoutes(projectRoot, 'hello', 'routes:\n  - id: ops\n    unknown_key: 1\n');
    writePackageRoutes(projectRoot, 'tools', 'routes:\n  - id: tools\n    path: /tools\n    target: { dashboard: tools }\n');
    writePackageRoutes(home, 'kit', 'routes:\n  - id: kit\n    path: /kit\n    target: { dashboard: kit }\n');

    const result = buildRouteTable({ home, projectRoot });
    assert.ok(result.entries.some((entry) => entry.id === 'tools'));
    assert.ok(result.entries.some((entry) => entry.id === 'kit'));
    assert.ok(result.entries.some((entry) => entry.id === 'screen-cleanup'));
    assert.equal(result.failures.length, 1);
    assert.deepEqual(result.failures[0]?.packages, ['hello']);
    assert.equal(result.failures[0]?.file, file);
    assert.match(result.failures[0]?.message ?? '', /does not match the format/);
  });

  it('пакет без routes.yml, сломанный пакет и затенённый пакет home таблицу не трогают', () => {
    const { home, projectRoot } = layerDirs();
    writePackageRoutes(projectRoot, 'plain', undefined);
    writePackageRoutes(projectRoot, 'broken', OPS, true);
    writePackageRoutes(projectRoot, 'hello', OPS);
    writePackageRoutes(home, 'hello', 'routes:\n  - id: other\n    path: /other\n    target: { dashboard: other }\n');

    const result = buildRouteTable({ home, projectRoot });
    assert.equal(result.entries.some((entry) => entry.id === 'other'), false);
    assert.equal(result.entries.filter((entry) => entry.id === 'ops').length, 1);
  });
});
