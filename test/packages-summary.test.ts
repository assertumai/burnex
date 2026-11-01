import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildPackageIndex, describeConflict } from '../src/parts/packages/index.js';
import { packageConflicts, summarizePackages, type PackageSummary } from '../src/parts/packages/summary.js';
import { tempDir } from './tmp.js';

/** Состав пакета и конфликты имён (`ui-packages-screen`, design.md, Решения 1, 2). */

function manifest(name: string): string {
  return `version: 1\nkind: package\nname: ${name}\ndescription: Пример\npackage_version: 0.1.0\n`;
}

function writePackage(packagesDir: string, name: string, files: Record<string, string> = {}, text?: string): void {
  const dir = join(packagesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.yml'), text ?? manifest(name));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
}

function layers(): { projectPackages: string; homePackages: string; summarize: () => readonly PackageSummary[] } {
  const base = tempDir('packages-summary-');
  const projectRoot = join(base, 'work');
  const homeDir = join(base, 'home', '.stepcast');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  return {
    projectPackages: join(projectRoot, '.stepcast', 'packages'),
    homePackages: join(homeDir, 'packages'),
    summarize: () => summarizePackages(buildPackageIndex({ projectRoot, globalPath: join(homeDir, 'config.yml') })),
  };
}

const find = (summaries: readonly PackageSummary[], name: string, layer: string): PackageSummary => {
  const found = summaries.find((summary) => summary.name === name && summary.layer === layer);
  assert.ok(found, `${layer}/${name}`);
  return found;
};

describe('packages-summary: состав пакета', () => {
  it('имена по всем семи видам, в порядке видов и по алфавиту', () => {
    const bed = layers();
    writePackage(bed.projectPackages, 'full', {
      'pipelines/zeta.yml': 'x',
      'pipelines/alpha.yaml': 'x',
      'steps/greet/step.yml': 'x',
      'steps/no-manifest/readme.md': 'x',
      'scripts/b.sh': 'x',
      'scripts/a.sh': 'x',
      'plugins/p1/plugin.yml': 'x',
      'widgets/clock.tsx': 'x',
      'widgets/notes.txt': 'x',
      'dashboards/ops.yml': 'x',
      'routes.yml': 'routes:\n  - id: r2\n    path: /r2\n  - id: r1\n    path: /r1\n',
    });

    const contents = find(bed.summarize(), 'full', 'project').contents;
    assert.deepEqual(Object.keys(contents), ['pipelines', 'steps', 'scripts', 'plugins', 'widgets', 'dashboards', 'routes']);
    assert.deepEqual(contents, {
      pipelines: ['alpha', 'zeta'],
      steps: ['greet'],
      scripts: ['a.sh', 'b.sh'],
      plugins: ['p1'],
      widgets: ['clock'],
      dashboards: ['ops'],
      routes: ['r1', 'r2'],
    });
  });

  it('пустой вид опущен; состав есть у сломанного и затенённого пакета', () => {
    const bed = layers();
    writePackage(bed.projectPackages, 'dup', { 'scripts/run.sh': 'x' });
    writePackage(bed.homePackages, 'dup', { 'steps/old/step.yml': 'x' });
    writePackage(bed.homePackages, 'broken', { 'widgets/w.tsx': 'x' }, 'name: [oops\n');

    const summaries = bed.summarize();
    assert.deepEqual(find(summaries, 'dup', 'project').contents, { scripts: ['run.sh'] });
    const shadowed = find(summaries, 'dup', 'home');
    assert.equal(shadowed.status, 'shadowed');
    assert.deepEqual(shadowed.contents, { steps: ['old'] });
    const broken = find(summaries, 'broken', 'home');
    assert.equal(broken.status, 'broken');
    assert.deepEqual(broken.contents, { widgets: ['w'] });
  });

  it('нечитаемый routes.yml даёт пустые routes без исключения, а provides по-прежнему называет routes', () => {
    const bed = layers();
    writePackage(bed.projectPackages, 'bad-routes', { 'routes.yml': 'routes: [oops\n' });

    const summary = find(bed.summarize(), 'bad-routes', 'project');
    assert.equal(summary.contents.routes, undefined);
    assert.deepEqual(summary.provides, ['routes']);
  });
});

describe('packages-summary: конфликты имён', () => {
  it('шаг в слое home и скрипт в слое project — по записи с текстом движка', () => {
    const bed = layers();
    writePackage(bed.homePackages, 'a', { 'steps/greet/step.yml': 'x' });
    writePackage(bed.homePackages, 'b', { 'steps/greet/step.yml': 'x' });
    writePackage(bed.projectPackages, 'c', { 'scripts/run.sh': 'x' });
    writePackage(bed.projectPackages, 'd', { 'scripts/run.sh': 'x' });

    const conflicts = packageConflicts(bed.summarize());
    assert.deepEqual(conflicts, [
      { layer: 'project', kind: 'scripts', id: 'run.sh', packages: ['c', 'd'], message: describeConflict('scripts', 'run.sh', ['c', 'd']) },
      { layer: 'home', kind: 'steps', id: 'greet', packages: ['a', 'b'], message: describeConflict('steps', 'greet', ['a', 'b']) },
    ]);
  });

  it('одноимённые шаги в разных слоях, а также одноимённые пайплайны конфликта не дают', () => {
    const bed = layers();
    writePackage(bed.projectPackages, 'a', { 'steps/greet/step.yml': 'x', 'pipelines/p.yml': 'x' });
    writePackage(bed.homePackages, 'b', { 'steps/greet/step.yml': 'x', 'pipelines/p.yml': 'x' });
    writePackage(bed.homePackages, 'c', { 'pipelines/p.yml': 'x' });

    assert.deepEqual(packageConflicts(bed.summarize()), []);
  });

  it('сломанный и затенённый пакет конфликта не даёт', () => {
    const bed = layers();
    writePackage(bed.homePackages, 'a', { 'steps/greet/step.yml': 'x' });
    writePackage(bed.homePackages, 'broken', { 'steps/greet/step.yml': 'x' }, 'name: [oops\n');
    writePackage(bed.projectPackages, 'a', { 'scripts/run.sh': 'x' });
    writePackage(bed.projectPackages, 'b', { 'steps/other/step.yml': 'x' });

    assert.deepEqual(packageConflicts(bed.summarize()), []);
  });

  it('плагин с зарезервированным именем конфликта не даёт, свободный — даёт', () => {
    const bed = layers();
    for (const name of ['a', 'b']) {
      writePackage(bed.homePackages, name, { 'plugins/builtin-row/index.mjs': 'x', 'plugins/free/index.mjs': 'x' });
    }

    assert.deepEqual(
      packageConflicts(bed.summarize(), { reservedPluginIds: ['builtin-row'] }).map((conflict) => conflict.id),
      ['free'],
    );
    assert.deepEqual(packageConflicts(bed.summarize()).map((conflict) => conflict.id), ['builtin-row', 'free']);
  });
});
