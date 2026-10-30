import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  activePackages,
  brokenPackages,
  buildPackageIndex,
  describeBrokenPackages,
  findPackage,
  lookupInPackages,
  resourceLayers,
} from '../src/parts/packages/index.js';
import { tempDir } from './tmp.js';

function writePackage(packagesDir: string, name: string, files: Record<string, string> = {}, manifest?: string): string {
  const dir = join(packagesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.yml'),
    manifest ?? `version: 1\nkind: package\nname: ${name}\ndescription: Пример\npackage_version: 0.1.0\n`,
  );
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(join(dir, relative, '..'), { recursive: true });
    writeFileSync(join(dir, relative), text);
  }
  return dir;
}

interface Roots {
  readonly projectRoot: string;
  readonly homeDir: string;
  readonly globalPath: string;
  readonly projectPackages: string;
  readonly homePackages: string;
}

function roots(): Roots {
  const base = tempDir('packages-index-');
  const projectRoot = join(base, 'project');
  const homeDir = join(base, 'home', '.stepcast');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  return {
    projectRoot,
    homeDir,
    globalPath: join(homeDir, 'config.yml'),
    projectPackages: join(projectRoot, '.stepcast', 'packages'),
    homePackages: join(homeDir, 'packages'),
  };
}

describe('packages-index: указатель пакетов', () => {
  it('каталога packages/ нет ни у проекта, ни у home — указатель пуст без ошибки', () => {
    const r = roots();
    const index = buildPackageIndex({ projectRoot: r.projectRoot, globalPath: r.globalPath });
    assert.deepEqual(index.packages, []);
    assert.deepEqual(describeBrokenPackages(index), []);
  });

  it('пакеты идут в порядке имён каталогов, у каждого слой, каталог и манифест', () => {
    const r = roots();
    writePackage(r.projectPackages, 'zeta');
    writePackage(r.projectPackages, 'alpha');
    writePackage(r.homePackages, 'tools');
    const index = buildPackageIndex({ projectRoot: r.projectRoot, globalPath: r.globalPath });
    assert.deepEqual(
      index.packages.map((p) => [p.name, p.layer]),
      [['alpha', 'project'], ['zeta', 'project'], ['tools', 'home']],
    );
    assert.equal(index.packages[0]?.dir, join(r.projectPackages, 'alpha'));
    assert.equal(index.packages[0]?.manifest?.version, '0.1.0');
  });

  it('без проекта читается только home', () => {
    const r = roots();
    writePackage(r.homePackages, 'tools');
    const index = buildPackageIndex({ globalPath: r.globalPath });
    assert.deepEqual(index.packages.map((p) => p.name), ['tools']);
  });

  it('подставной путь глобального конфига — пакеты home читаются рядом с ним', () => {
    const r = roots();
    writePackage(r.homePackages, 'tools');
    const other = tempDir('packages-index-fake-');
    const index = buildPackageIndex({ projectRoot: r.projectRoot, globalPath: join(other, 'config.yml') });
    assert.deepEqual(index.packages, []);
  });

  it('каталог без манифеста, битый YAML и имя не по каталогу — сломанные пакеты с причиной', () => {
    const r = roots();
    mkdirSync(join(r.projectPackages, 'draft'), { recursive: true });
    writePackage(r.projectPackages, 'broken', {}, 'name: [oops\n');
    writePackage(r.projectPackages, 'renamed', {}, 'version: 1\nkind: package\nname: other\ndescription: x\npackage_version: 1.0.0\n');
    const index = buildPackageIndex({ projectRoot: r.projectRoot, globalPath: r.globalPath });
    assert.equal(brokenPackages(index).length, 3);
    const text = describeBrokenPackages(index).join('\n');
    assert.match(text, /нет манифеста/);
    assert.match(text, /YAML/);
    assert.match(text, /other/);
    assert.deepEqual(activePackages(index, 'project'), []);
  });

  it('сломанный пакет не мешает живым соседям', () => {
    const r = roots();
    writePackage(r.projectPackages, 'broken', {}, 'not: [valid');
    writePackage(r.projectPackages, 'hello');
    const index = buildPackageIndex({ projectRoot: r.projectRoot, globalPath: r.globalPath });
    assert.deepEqual(activePackages(index, 'project').map((p) => p.name), ['hello']);
  });

  it('пакет проекта затеняет одноимённый пакет home целиком, в том числе когда сам сломан', () => {
    const r = roots();
    writePackage(r.projectPackages, 'hello', {}, 'garbage: true\n');
    writePackage(r.homePackages, 'hello', { 'steps/farewell/step.yml': 'x' });
    writePackage(r.homePackages, 'tools');
    const index = buildPackageIndex({ projectRoot: r.projectRoot, globalPath: r.globalPath });
    const homeHello = index.packages.find((p) => p.name === 'hello' && p.layer === 'home');
    assert.equal(homeHello?.shadowedBy, 'project');
    assert.deepEqual(activePackages(index, 'home').map((p) => p.name), ['tools']);
    // Затенённый пакет home в промахах не значится сломанным — он вне поиска.
    assert.deepEqual(brokenPackages(index).map((p) => p.layer), ['project']);
    const found = findPackage(index, 'hello');
    assert.ok(found !== undefined && 'broken' in found);
    const layers = resourceLayers(index, 'steps', { projectRoot: r.projectRoot, homeStepcastDir: r.homeDir });
    const homePackages = layers.find((l) => l.source === 'home-packages');
    assert.deepEqual(homePackages && 'packages' in homePackages ? homePackages.packages.map((p) => p.package) : null, ['tools']);
  });

  it('проект внутри домашнего каталога: слои совпадают, пакет не затеняет сам себя', () => {
    const base = tempDir('packages-index-same-');
    const homeDir = join(base, '.stepcast');
    writePackage(join(homeDir, 'packages'), 'hello');
    const index = buildPackageIndex({ projectRoot: base, globalPath: join(homeDir, 'config.yml') });
    assert.deepEqual(index.packages.map((p) => [p.name, p.layer, p.shadowedBy]), [['hello', 'project', undefined]]);
  });

  it('файл в packages/ и симлинк на каталог: файл пропущен, симлинк — пакет', () => {
    const r = roots();
    mkdirSync(r.projectPackages, { recursive: true });
    writeFileSync(join(r.projectPackages, 'note.txt'), 'x');
    const real = writePackage(join(r.projectRoot, 'elsewhere'), 'linked');
    symlinkSync(real, join(r.projectPackages, 'linked'));
    const index = buildPackageIndex({ projectRoot: r.projectRoot, globalPath: r.globalPath });
    assert.deepEqual(index.packages.map((p) => p.name), ['linked']);
  });
});

describe('packages-index: слои ресурсов', () => {
  it('порядок: свободный проект → пакеты проекта → свободный home → пакеты home → встроенное', () => {
    const r = roots();
    const index = buildPackageIndex({ projectRoot: r.projectRoot, globalPath: r.globalPath });
    const layers = resourceLayers(index, 'steps', { projectRoot: r.projectRoot, homeStepcastDir: r.homeDir });
    assert.deepEqual(layers.map((l) => l.source), ['project', 'project-packages', 'home', 'home-packages', 'builtin']);
    assert.deepEqual(layers[0], { source: 'project', path: join(r.projectRoot, '.stepcast', 'steps') });
    assert.deepEqual(layers[2], { source: 'home', path: join(r.homeDir, 'steps') });
  });

  it('слои вида не выравниваются: у виджетов нет home, у дашбордов — встроенного, у плагинов — встроенного каталога', () => {
    const r = roots();
    const index = buildPackageIndex({ projectRoot: r.projectRoot, globalPath: r.globalPath });
    const sources = (kind: Parameters<typeof resourceLayers>[1]) =>
      resourceLayers(index, kind, { projectRoot: r.projectRoot, homeStepcastDir: r.homeDir }).map((l) => l.source);
    assert.deepEqual(sources('widgets'), ['project', 'project-packages', 'home-packages']);
    assert.deepEqual(sources('dashboards'), ['project', 'project-packages', 'home', 'home-packages']);
    assert.deepEqual(sources('plugins'), ['project', 'project-packages', 'home', 'home-packages']);
    assert.deepEqual(sources('routes'), ['project', 'project-packages', 'home', 'home-packages', 'builtin']);
    assert.deepEqual(sources('pipelines'), ['project', 'project-packages', 'home-packages']);
    assert.deepEqual(sources('scripts'), ['project', 'project-packages', 'home', 'home-packages', 'builtin']);
  });

  it('без проекта свободного слоя проекта нет, слой пакетов проекта пуст', () => {
    const r = roots();
    const index = buildPackageIndex({ globalPath: r.globalPath });
    const layers = resourceLayers(index, 'widgets', { homeStepcastDir: r.homeDir });
    assert.deepEqual(layers.map((l) => l.source), ['project-packages', 'home-packages']);
  });

  it('пути пакетов несут подкаталог вида; у маршрутов — файл routes.yml', () => {
    const r = roots();
    writePackage(r.projectPackages, 'hello');
    const index = buildPackageIndex({ projectRoot: r.projectRoot, globalPath: r.globalPath });
    const roots_ = { projectRoot: r.projectRoot, homeStepcastDir: r.homeDir };
    const widgets = resourceLayers(index, 'widgets', roots_).find((l) => l.source === 'project-packages');
    const routes = resourceLayers(index, 'routes', roots_).find((l) => l.source === 'project-packages');
    assert.deepEqual(widgets && 'packages' in widgets ? widgets.packages : null, [
      { package: 'hello', path: join(r.projectPackages, 'hello', 'widgets') },
    ]);
    assert.deepEqual(routes && 'packages' in routes ? routes.packages : null, [
      { package: 'hello', path: join(r.projectPackages, 'hello', 'routes.yml') },
    ]);
  });
});

describe('packages-index: поиск в слое пакетов', () => {
  function layerPackages(r: Roots, kind: 'steps' | 'widgets', layer: 'project-packages' | 'home-packages') {
    const index = buildPackageIndex({ projectRoot: r.projectRoot, globalPath: r.globalPath });
    const found = resourceLayers(index, kind, { projectRoot: r.projectRoot, homeStepcastDir: r.homeDir }).find(
      (l) => l.source === layer,
    );
    assert.ok(found !== undefined && 'packages' in found);
    return found.packages;
  }

  const locate = (name: string) => (dir: string) => {
    const path = join(dir, name);
    return existsSync(path) ? path : undefined;
  };

  it('находит ресурс единственного пакета; промах — miss', () => {
    const r = roots();
    writePackage(r.projectPackages, 'a', { 'steps/greet/step.yml': 'x' });
    writePackage(r.projectPackages, 'b');
    const packages = layerPackages(r, 'steps', 'project-packages');
    const hit = lookupInPackages(packages, locate('greet'));
    assert.equal(hit.kind, 'found');
    if (hit.kind === 'found') assert.equal(hit.package, 'a');
    assert.equal(lookupInPackages(packages, locate('nope')).kind, 'miss');
  });

  it('два пакета одного слоя с одним ресурсом — конфликт, называющий оба', () => {
    const r = roots();
    writePackage(r.projectPackages, 'b', { 'widgets/clock.tsx': 'x' });
    writePackage(r.projectPackages, 'a', { 'widgets/clock.tsx': 'x' });
    const result = lookupInPackages(layerPackages(r, 'widgets', 'project-packages'), locate('clock.tsx'));
    assert.equal(result.kind, 'conflict');
    if (result.kind === 'conflict') assert.deepEqual(result.packages, ['a', 'b']);
  });

  it('одноимённый ресурс в разных слоях — не конфликт', () => {
    const r = roots();
    writePackage(r.projectPackages, 'a', { 'widgets/clock.tsx': 'x' });
    writePackage(r.homePackages, 'b', { 'widgets/clock.tsx': 'x' });
    assert.equal(lookupInPackages(layerPackages(r, 'widgets', 'project-packages'), locate('clock.tsx')).kind, 'found');
    assert.equal(lookupInPackages(layerPackages(r, 'widgets', 'home-packages'), locate('clock.tsx')).kind, 'found');
  });
});
