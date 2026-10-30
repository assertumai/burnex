import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/kernel/errors.js';
import {
  buildDashboards,
  dashboardFingerprint,
  homeDashboardsDirPath,
  projectDashboardsDirPath,
  writableDashboardPath,
  writeDashboard,
  type DashboardFileDocument,
} from '../src/parts/ui/dashboardsFile.js';
import { tempDir } from './tmp.js';

function layerDirs(): { home: string; projectRoot: string } {
  return { home: tempDir('dash-home-'), projectRoot: tempDir('dash-project-') };
}

function writeHomeDashboard(home: string, id: string, content: string): void {
  const dir = homeDashboardsDirPath(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.yml`), content);
}

function writeProjectDashboard(projectRoot: string, id: string, content: string): void {
  const dir = projectDashboardsDirPath(projectRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.yml`), content);
}

const SIMPLE_YAML = 'title: Релиз\ngrid:\n  columns: 12\ncells:\n  - id: a\n    widget: runs\n    at: { column: 0, row: 0, width: 4, height: 2 }\n';

describe('ui-dashboards-file: сборка двух слоёв', () => {
  it('файл становится дашбордом с ячейками на объявленных местах', () => {
    const { home } = layerDirs();
    writeHomeDashboard(home, 'release', SIMPLE_YAML);

    const result = buildDashboards({ home });
    assert.equal(result.failures.length, 0);
    const entry = result.dashboards.find((d) => d.id === 'release');
    assert.equal(entry?.document.title, 'Релиз');
    assert.equal(entry?.document.cells[0]?.id, 'a');
    assert.equal(entry?.layer, 'home');
  });

  it('проектный дашборд перекрывает домашний целиком — ни одна ячейка домашнего не попадает', () => {
    const { home, projectRoot } = layerDirs();
    writeHomeDashboard(home, 'release', SIMPLE_YAML);
    writeProjectDashboard(
      projectRoot,
      'release',
      'grid:\n  columns: 6\ncells:\n  - id: only-project\n    widget: usage\n    at: { column: 0, row: 0, width: 2, height: 2 }\n',
    );

    const result = buildDashboards({ home, projectRoot });
    const entry = result.dashboards.find((d) => d.id === 'release');
    assert.equal(entry?.layer, 'project');
    assert.equal(entry?.document.cells.length, 1);
    assert.equal(entry?.document.cells[0]?.id, 'only-project');
    assert.equal(entry?.document.title, undefined);
  });

  it('дашборд только домашнего слоя действует и назван файлом домашнего слоя', () => {
    const { home, projectRoot } = layerDirs();
    writeHomeDashboard(home, 'release', SIMPLE_YAML);

    const result = buildDashboards({ home, projectRoot });
    const entry = result.dashboards.find((d) => d.id === 'release');
    assert.equal(entry?.layer, 'home');
    assert.equal(entry?.file, join(homeDashboardsDirPath(home), 'release.yml'));
  });

  it('каталогов дашбордов нет — пустой состав без отказа', () => {
    const { home, projectRoot } = layerDirs();
    const result = buildDashboards({ home, projectRoot });
    assert.deepEqual(result.dashboards, []);
    assert.deepEqual(result.failures, []);
  });

  it('вложенный файл и чужое расширение не считаются дашбордами', () => {
    const { home } = layerDirs();
    const dir = homeDashboardsDirPath(home);
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'deep.yml'), SIMPLE_YAML);
    writeFileSync(join(dir, 'notes.md'), 'не дашборд');
    writeHomeDashboard(home, 'release', SIMPLE_YAML);

    const result = buildDashboards({ home });
    assert.deepEqual(result.dashboards.map((d) => d.id), ['release']);
  });

  it('сломанный файл одного дашборда не гасит соседний исправный', () => {
    const { home } = layerDirs();
    writeHomeDashboard(home, 'release', SIMPLE_YAML);
    writeHomeDashboard(home, 'broken', 'cells: [{ id: a, widget: x, at: { column: 0, row: 0, width: 999, height: 1 } }]\n');

    const result = buildDashboards({ home });
    assert.equal(result.dashboards.some((d) => d.id === 'release'), true);
    const failure = result.failures.find((f) => f.id === 'broken');
    assert.ok(failure !== undefined);
    assert.match(failure.reason, /broken/);
  });

  it('неизвестный ключ в файле — отказ, называющий файл и место', () => {
    const { home } = layerDirs();
    writeHomeDashboard(home, 'release', 'title: X\ngrid: { columns: 12 }\ncells: []\nbogus: 1\n');

    const result = buildDashboards({ home });
    const failure = result.failures.find((f) => f.id === 'release');
    assert.ok(failure !== undefined);
    assert.match(failure.reason, /bogus/);
    assert.equal(failure.file, join(homeDashboardsDirPath(home), 'release.yml'));
  });

  it('каталог слоя, который не читается, — пустой состав без исключения наружу', () => {
    const { home, projectRoot } = layerDirs();
    // Каталог слоя занят файлом: `readdirSync` отвечает ENOTDIR — тем же
    // отказом, каким отвечает исчезнувший между тактами или недоступный на
    // чтение каталог. Наружу он уйти не должен: на старте это отказ подъёма
    // демона, в такте таймера — необработанное исключение.
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    writeFileSync(homeDashboardsDirPath(home), 'не каталог');
    writeProjectDashboard(projectRoot, 'release', SIMPLE_YAML);

    const result = buildDashboards({ home, projectRoot });
    assert.deepEqual(result.dashboards.map((d) => d.id), ['release']);
    assert.deepEqual(result.failures, []);
  });

  it('grid.columns по умолчанию — 12, когда grid не объявлен', () => {
    const { home } = layerDirs();
    writeHomeDashboard(home, 'release', 'cells: []\n');
    const result = buildDashboards({ home });
    assert.equal(result.dashboards[0]?.document.grid.columns, 12);
  });
});

describe('ui-dashboards-file: запись документа через Document', () => {
  const document: DashboardFileDocument = {
    title: 'Релиз',
    grid: { columns: 12 },
    cells: [
      { id: 'a', widget: 'runs', at: { column: 0, row: 0, width: 4, height: 2 } },
      { id: 'b', widget: 'usage', at: { column: 4, row: 0, width: 4, height: 2 } },
    ],
  };

  it('запись нового дашборда создаёт файл слоя', () => {
    const { home } = layerDirs();
    writeDashboard('home', 'release', document, undefined, { home });

    const result = buildDashboards({ home });
    const entry = result.dashboards.find((d) => d.id === 'release');
    assert.equal(entry?.document.cells.length, 2);
  });

  it('запись сохраняет комментарий ячейки, которую правка не коснулась', () => {
    const { home } = layerDirs();
    const path = join(homeDashboardsDirPath(home), 'release.yml');
    mkdirSync(homeDashboardsDirPath(home), { recursive: true });
    writeFileSync(
      path,
      'title: Релиз\ngrid:\n  columns: 12\ncells:\n  - id: a\n    widget: runs # правил вручную\n    at: { column: 0, row: 0, width: 4, height: 2 }\n',
    );
    const base = dashboardFingerprint(path);

    const changed: DashboardFileDocument = {
      title: 'Релиз',
      grid: { columns: 12 },
      cells: [
        { id: 'a', widget: 'runs', at: { column: 0, row: 0, width: 4, height: 2 } },
        { id: 'b', widget: 'usage', at: { column: 4, row: 0, width: 4, height: 2 } },
      ],
    };
    writeDashboard('home', 'release', changed, base, { home });

    const text = readFileSync(path, 'utf8');
    assert.match(text, /# правил вручную/);
    assert.match(text, /id: b/);
  });

  it('перемещение ячейки меняет в документе только её место', () => {
    const { home } = layerDirs();
    writeDashboard('home', 'release', document, undefined, { home });
    const path = join(homeDashboardsDirPath(home), 'release.yml');
    const base = dashboardFingerprint(path);

    const moved: DashboardFileDocument = {
      ...document,
      cells: [
        { id: 'a', widget: 'runs', at: { column: 0, row: 2, width: 4, height: 2 } },
        document.cells[1] as DashboardFileDocument['cells'][number],
      ],
    };
    writeDashboard('home', 'release', moved, base, { home });

    const result = buildDashboards({ home });
    const cells = result.dashboards.find((d) => d.id === 'release')?.document.cells;
    assert.equal(cells?.find((c) => c.id === 'a')?.at.row, 2);
    assert.equal(cells?.find((c) => c.id === 'b')?.at.column, 4);
  });

  it('перемещение ячейки сохраняет её собственный комментарий', () => {
    const { home } = layerDirs();
    const path = join(homeDashboardsDirPath(home), 'release.yml');
    mkdirSync(homeDashboardsDirPath(home), { recursive: true });
    writeFileSync(
      path,
      'grid:\n  columns: 12\ncells:\n  - id: a\n    widget: runs # мой виджет\n    at:\n      column: 0\n      row: 0\n      width: 4\n      height: 2\n',
    );
    const base = dashboardFingerprint(path);

    const moved: DashboardFileDocument = {
      grid: { columns: 12 },
      cells: [{ id: 'a', widget: 'runs', at: { column: 0, row: 3, width: 4, height: 2 } }],
    };
    writeDashboard('home', 'release', moved, base, { home });

    const text = readFileSync(path, 'utf8');
    // Подвинутая ячейка правится на месте: пересоздание узла унесло бы
    // комментарий пользователя вместе со строкой `widget`.
    assert.match(text, /# мой виджет/);
    assert.match(text, /row: 3/);
  });

  it('документ с наложением ячеек не записывается — отказ вместо удачи и пропавшего дашборда', () => {
    const { home } = layerDirs();
    const path = join(homeDashboardsDirPath(home), 'release.yml');
    writeDashboard('home', 'release', document, undefined, { home });
    const original = readFileSync(path, 'utf8');

    const overlapping: DashboardFileDocument = {
      grid: { columns: 12 },
      cells: [
        { id: 'a', widget: 'runs', at: { column: 0, row: 0, width: 4, height: 2 } },
        { id: 'b', widget: 'usage', at: { column: 2, row: 1, width: 4, height: 2 } },
      ],
    };
    assert.throws(
      () => writeDashboard('home', 'release', overlapping, dashboardFingerprint(path), { home }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /overlap/);
        return true;
      },
    );
    assert.equal(readFileSync(path, 'utf8'), original);
  });

  it('документ с повтором id ячейки и с ячейкой за колонками сетки не записывается', () => {
    const { home } = layerDirs();
    const twice: DashboardFileDocument = {
      grid: { columns: 12 },
      cells: [
        { id: 'a', widget: 'runs', at: { column: 0, row: 0, width: 4, height: 2 } },
        { id: 'a', widget: 'usage', at: { column: 4, row: 0, width: 4, height: 2 } },
      ],
    };
    assert.throws(() => writeDashboard('home', 'twice', twice, undefined, { home }), /is repeated/);

    const wide: DashboardFileDocument = {
      grid: { columns: 6 },
      cells: [{ id: 'a', widget: 'runs', at: { column: 4, row: 0, width: 4, height: 2 } }],
    };
    assert.throws(() => writeDashboard('home', 'wide', wide, undefined, { home }), /exceeds the grid/);

    assert.deepEqual(buildDashboards({ home }).dashboards, []);
  });

  it('запись в файл с повтором ключа отклонена местом разбора, а не молча переписана', () => {
    const { home } = layerDirs();
    const path = join(homeDashboardsDirPath(home), 'release.yml');
    mkdirSync(homeDashboardsDirPath(home), { recursive: true });
    // Повтор ключа `cells:` — синтаксический отказ YAML, но разбор «как
    // получится» даёт схемно верный объект: без проверки `doc.errors` запись
    // прошла бы поверх файла, который чтение состава считает сломанным, и
    // унесла бы первый блок пользователя.
    const broken =
      'grid:\n  columns: 12\ncells:\n  - id: a\n    widget: runs\n    at: { column: 0, row: 0, width: 4, height: 2 }\ncells:\n  - id: b\n    widget: usage\n    at: { column: 0, row: 0, width: 4, height: 2 }\n';
    writeFileSync(path, broken);
    assert.equal(buildDashboards({ home }).failures.length, 1, 'чтение обязано считать такой файл сломанным');

    assert.throws(
      () => writeDashboard('home', 'release', document, dashboardFingerprint(path), { home }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, path);
        assert.match(error.message, /is not valid YAML/);
        assert.match(String(error.at), /line 7/);
        return true;
      },
    );
    assert.equal(readFileSync(path, 'utf8'), broken);
  });

  it('запись в неразбираемый файл отклонена, файл не изменён', () => {
    const { home } = layerDirs();
    const path = join(homeDashboardsDirPath(home), 'release.yml');
    mkdirSync(homeDashboardsDirPath(home), { recursive: true });
    writeFileSync(path, 'cells: [{ id: a, widget: 1 }\n'); // невалидный YAML
    const original = readFileSync(path, 'utf8');

    assert.throws(
      () => writeDashboard('home', 'release', document, dashboardFingerprint(path), { home }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, path);
        return true;
      },
    );
    assert.equal(readFileSync(path, 'utf8'), original);
  });

  it('запись с разошедшимся отпечатком отклонена, файл не изменён', () => {
    const { home } = layerDirs();
    writeDashboard('home', 'release', document, undefined, { home });
    const path = join(homeDashboardsDirPath(home), 'release.yml');
    const original = readFileSync(path, 'utf8');
    // Отпечаток, снятый до внешней правки: файл поменялся снаружи с тех пор.
    writeFileSync(path, `${original}\n# внешняя правка\n`);

    assert.throws(
      () =>
        writeDashboard('home', 'release', { ...document, title: 'Другое' }, { mtimeMs: 0, size: 0 }, { home }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /has changed since it was opened/);
        return true;
      },
    );
    assert.equal(readFileSync(path, 'utf8'), `${original}\n# внешняя правка\n`);
  });

  it('проектный слой без известного корня отказывает как writableLayerPath маршрутов', () => {
    const { home } = layerDirs();
    assert.throws(
      () => writeDashboard('project', 'release', document, undefined, { home }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /project root/);
        return true;
      },
    );
  });
});

function writePackageDashboard(root: string, name: string, id: string, content: string, broken = false): string {
  const dir = join(root, '.stepcast', 'packages', name);
  mkdirSync(join(dir, 'dashboards'), { recursive: true });
  writeFileSync(
    join(dir, 'package.yml'),
    broken ? 'not: [valid' : `version: 1\nkind: package\nname: ${name}\ndescription: Пример\npackage_version: 0.1.0\n`,
  );
  const file = join(dir, 'dashboards', `${id}.yml`);
  writeFileSync(file, content);
  return file;
}

describe('ui-dashboards-file: дашборды пакетов (packages-directory-layer)', () => {
  it('дашборд пакета проекта действует и назван пакетом и файлом внутри него', () => {
    const { home, projectRoot } = layerDirs();
    const file = writePackageDashboard(projectRoot, 'hello', 'ops', SIMPLE_YAML);

    const entry = buildDashboards({ home, projectRoot }).dashboards.find((d) => d.id === 'ops');
    assert.equal(entry?.layer, 'project');
    assert.equal(entry?.package, 'hello');
    assert.equal(entry?.file, file);
  });

  it('порядок: свободный проект → пакет проекта → свободный home → пакет home', () => {
    const { home, projectRoot } = layerDirs();
    writePackageDashboard(home, 'tools', 'ops', SIMPLE_YAML);
    assert.equal(buildDashboards({ home, projectRoot }).dashboards[0]?.package, 'tools');

    writeHomeDashboard(home, 'ops', SIMPLE_YAML);
    const free = buildDashboards({ home, projectRoot }).dashboards[0];
    assert.equal(free?.package, undefined);
    assert.equal(free?.layer, 'home');

    writePackageDashboard(projectRoot, 'hello', 'ops', SIMPLE_YAML);
    assert.equal(buildDashboards({ home, projectRoot }).dashboards[0]?.package, 'hello');

    writeProjectDashboard(projectRoot, 'ops', SIMPLE_YAML);
    const top = buildDashboards({ home, projectRoot }).dashboards[0];
    assert.equal(top?.package, undefined);
    assert.equal(top?.layer, 'project');
  });

  it('конфликт id в слое пакетов — запись с ошибкой, называющей оба пакета, без провала вниз', () => {
    const { home, projectRoot } = layerDirs();
    writePackageDashboard(projectRoot, 'a', 'ops', SIMPLE_YAML);
    writePackageDashboard(projectRoot, 'b', 'ops', SIMPLE_YAML);
    writePackageDashboard(projectRoot, 'b', 'other', SIMPLE_YAML);
    writeHomeDashboard(home, 'ops', SIMPLE_YAML);

    const result = buildDashboards({ home, projectRoot });
    assert.equal(result.dashboards.some((d) => d.id === 'ops'), false);
    assert.deepEqual(result.dashboards.map((d) => d.id), ['other']);
    assert.match(result.failures.find((f) => f.id === 'ops')?.reason ?? '', /a and b/);
  });

  it('дашборд пакета не прошёл схему — запись с ошибкой, называющей файл внутри пакета', () => {
    const { home, projectRoot } = layerDirs();
    const file = writePackageDashboard(projectRoot, 'hello', 'ops', 'cells: not-a-list\n');
    writePackageDashboard(projectRoot, 'hello', 'fine', SIMPLE_YAML);

    const result = buildDashboards({ home, projectRoot });
    assert.equal(result.failures[0]?.file, file);
    assert.equal(result.failures[0]?.package, 'hello');
    assert.deepEqual(result.dashboards.map((d) => d.id), ['fine']);
  });

  it('сломанный пакет и затенённый пакет home дашбордов не дают', () => {
    const { home, projectRoot } = layerDirs();
    writePackageDashboard(projectRoot, 'broken', 'ghost', SIMPLE_YAML, true);
    writePackageDashboard(projectRoot, 'hello', 'mine', SIMPLE_YAML);
    writePackageDashboard(home, 'hello', 'theirs', SIMPLE_YAML);

    assert.deepEqual(buildDashboards({ home, projectRoot }).dashboards.map((d) => d.id), ['mine']);
  });

  it('writableDashboardPath: для дашборда пакета — свободный каталог проекта, даже из пакета home', () => {
    const { home, projectRoot } = layerDirs();
    assert.equal(
      writableDashboardPath('home', 'ops', { home, projectRoot }, true),
      join(projectDashboardsDirPath(projectRoot), 'ops.yml'),
    );
    assert.equal(
      writableDashboardPath('project', 'ops', { home, projectRoot }, true),
      join(projectDashboardsDirPath(projectRoot), 'ops.yml'),
    );
    assert.equal(writableDashboardPath('home', 'ops', { home, projectRoot }), join(homeDashboardsDirPath(home), 'ops.yml'));
  });

  it('сохранение дашборда пакета пишет копию в проект: файл пакета не изменён, копия затеняет пакетный', () => {
    const { home, projectRoot } = layerDirs();
    const file = writePackageDashboard(projectRoot, 'hello', 'ops', SIMPLE_YAML);
    const before = readFileSync(file, 'utf8');
    const base = dashboardFingerprint(file);
    const changed: DashboardFileDocument = {
      title: 'Моя копия',
      grid: { columns: 12 },
      cells: [{ id: 'a', widget: 'runs', at: { column: 0, row: 0, width: 6, height: 2 } }],
    };

    writeDashboard('project', 'ops', changed, base, { home, projectRoot }, 'hello');

    assert.equal(readFileSync(file, 'utf8'), before, 'файл пакета нетронут');
    const copy = join(projectDashboardsDirPath(projectRoot), 'ops.yml');
    assert.match(readFileSync(copy, 'utf8'), /Моя копия/);
    const entry = buildDashboards({ home, projectRoot }).dashboards.find((d) => d.id === 'ops');
    assert.equal(entry?.package, undefined);
    assert.equal(entry?.document.title, 'Моя копия');
  });

  it('сохранение дашборда пакета home тоже пишет в проект, а не в свободный home', () => {
    const { home, projectRoot } = layerDirs();
    const file = writePackageDashboard(home, 'tools', 'ops', SIMPLE_YAML);
    const changed: DashboardFileDocument = {
      grid: { columns: 12 },
      cells: [{ id: 'a', widget: 'runs', at: { column: 0, row: 0, width: 6, height: 2 } }],
    };

    writeDashboard('home', 'ops', changed, dashboardFingerprint(file), { home, projectRoot }, 'tools');

    assert.equal(readFileSync(join(projectDashboardsDirPath(projectRoot), 'ops.yml'), 'utf8').includes('width: 6'), true);
    assert.throws(() => readFileSync(join(homeDashboardsDirPath(home), 'ops.yml'), 'utf8'));
  });

  it('файл пакета изменился с момента открытия — отказ, копия не записана', () => {
    const { home, projectRoot } = layerDirs();
    const file = writePackageDashboard(projectRoot, 'hello', 'ops', SIMPLE_YAML);
    const base = { mtimeMs: 1, size: 1 };
    const changed: DashboardFileDocument = {
      grid: { columns: 12 },
      cells: [{ id: 'a', widget: 'runs', at: { column: 0, row: 0, width: 6, height: 2 } }],
    };

    assert.throws(
      () => writeDashboard('project', 'ops', changed, base, { home, projectRoot }, 'hello'),
      (error: unknown) => error instanceof StepcastError && /changed since it was opened/.test(error.message),
    );
    assert.equal(readFileSync(file, 'utf8'), SIMPLE_YAML);
  });
});
