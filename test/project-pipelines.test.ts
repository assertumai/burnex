import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { listPipelineEntries, listPipelineFiles } from '../src/parts/pipeline/domain/project/pipelines.js';
import { tempDir } from './tmp.js';

const PIPELINE = 'version: 1\nkind: pipeline\nname: p\njobs: {}\n';

function writePackage(packagesDir: string, name: string, pipelines: Record<string, string>, broken = false): void {
  const dir = join(packagesDir, name);
  mkdirSync(join(dir, 'pipelines'), { recursive: true });
  writeFileSync(
    join(dir, 'package.yml'),
    broken ? 'not: [valid' : `version: 1\nkind: package\nname: ${name}\ndescription: Пример\npackage_version: 0.1.0\n`,
  );
  for (const [file, text] of Object.entries(pipelines)) writeFileSync(join(dir, 'pipelines', file), text);
}

function layout(): { project: string; globalConfigDir: string } {
  const base = tempDir('project-pipelines-');
  const project = join(base, 'work');
  const globalConfigDir = join(base, 'home', '.stepcast');
  mkdirSync(join(project, '.stepcast', 'pipelines'), { recursive: true });
  mkdirSync(globalConfigDir, { recursive: true });
  return { project, globalConfigDir };
}

describe('project-pipelines: перечень пайплайнов', () => {
  it('без пакетов перечень записей совпадает с listPipelineFiles, адресов нет', () => {
    const { project, globalConfigDir } = layout();
    writeFileSync(join(project, 'stepcast.yml'), PIPELINE);
    writeFileSync(join(project, '.stepcast', 'pipelines', 'nightly.yml'), PIPELINE);
    writeFileSync(join(project, '.stepcast', 'pipelines', 'helper-job.yml'), 'version: 1\nkind: job\n');

    const files = listPipelineFiles(project);
    assert.equal(files.length, 2);
    const entries = listPipelineEntries(project, { globalConfigDir });
    assert.deepEqual(entries, files.map((path) => ({ path })));
  });

  it('пайплайны исправных пакетов проекта и home входят с адресом <пакет>:<имя>', () => {
    const { project, globalConfigDir } = layout();
    writeFileSync(join(project, 'stepcast.yml'), PIPELINE);
    writePackage(join(project, '.stepcast', 'packages'), 'hello', { 'greet.yml': PIPELINE, 'wave.yaml': PIPELINE });
    writePackage(join(globalConfigDir, 'packages'), 'tools', { 'report.yml': PIPELINE });

    const entries = listPipelineEntries(project, { globalConfigDir });
    assert.deepEqual(
      entries.filter((entry) => entry.address !== undefined).map((entry) => [entry.address, entry.packageLayer]),
      [['hello:greet', 'project'], ['hello:wave', 'project'], ['tools:report', 'home']],
    );
    assert.equal(entries[0]?.address, undefined, 'файлы проекта идут первыми');
  });

  it('сломанный, затенённый пакеты и файл не-пайплайн в перечень не входят', () => {
    const { project, globalConfigDir } = layout();
    writePackage(join(project, '.stepcast', 'packages'), 'broken', { 'x.yml': PIPELINE }, true);
    writePackage(join(project, '.stepcast', 'packages'), 'hello', { 'job.yml': 'version: 1\nkind: job\n' });
    writePackage(join(globalConfigDir, 'packages'), 'hello', { 'greet.yml': PIPELINE });

    assert.deepEqual(listPipelineEntries(project, { globalConfigDir }), []);
  });
});
