import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ExitCode, StepcastError } from '../src/kernel/errors.js';
import type { ParsedArgs } from '../src/kernel/cli/types.js';
import { runLintCommand } from '../src/parts/pipeline/commands/lint.js';
import { runResumeCommand } from '../src/parts/pipeline/commands/resume.js';
import { runRunCommand } from '../src/parts/pipeline/commands/run.js';
import { projectKey, runPaths } from '../src/parts/pipeline/run/journal/paths.js';
import { listRuns, readManifest, readStatus } from '../src/parts/pipeline/run/journal/reader.js';
import { packagedPipelinePath, resolvePipelineTarget } from '../src/parts/pipeline/domain/package-schema.js';
import { makeProject, withHome, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Адрес пайплайна пакета `<пакет>:<имя>` (`packages-directory-layer`,
 * Решение 5): разрешение цели, `run` и `lint` одним правилом.
 */

const PIPELINE = `
version: 1
kind: pipeline
name: greet
jobs:
  build:
    steps:
      - { id: hi, run: [echo, привет] }
`;

function writePackage(packagesDir: string, name: string, pipelines: Record<string, string> = {}, manifest?: string): string {
  const dir = join(packagesDir, name);
  mkdirSync(join(dir, 'pipelines'), { recursive: true });
  writeFileSync(
    join(dir, 'package.yml'),
    manifest ?? `version: 1\nkind: package\nname: ${name}\ndescription: Пример\npackage_version: 0.1.0\n`,
  );
  for (const [file, text] of Object.entries(pipelines)) writeFileSync(join(dir, 'pipelines', file), text);
  return dir;
}

function projectPackages(project: Project): string {
  return join(project.root, '.burnex', 'packages');
}

function homePackages(project: Project): string {
  return join(project.home, '.burnex', 'packages');
}

function options(project: Project): { globalConfigDir: string } {
  return { globalConfigDir: join(project.home, '.burnex') };
}

function failureOf(fn: () => unknown): StepcastError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof StepcastError, String(error));
    return error;
  }
  assert.fail('ожидался отказ');
}

function args(command: 'run' | 'lint', target: string, flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command, positional: [target], flags };
}

describe('package address: разрешение цели', () => {
  it('пакет проекта: адрес ведёт в pipelines/<имя>.yml, цель вне проекта', () => {
    const project = makeProject();
    const dir = writePackage(projectPackages(project), 'hello', { 'greet.yml': PIPELINE });
    const resolved = resolvePipelineTarget(project.root, 'hello:greet', options(project));
    // Корень проекта разрешается по реальному пути (`findProjectRoot`).
    assert.equal(realpathSync(resolved.pipelinePath), realpathSync(join(dir, 'pipelines', 'greet.yml')));
    assert.equal(resolved.outsideProject, true);
    assert.equal(resolved.address, 'hello:greet');
  });

  it('пакет home находится, когда проект такого пакета не имеет; .yaml тоже пайплайн', () => {
    const project = makeProject();
    const dir = writePackage(homePackages(project), 'tools', { 'report.yaml': PIPELINE });
    const resolved = resolvePipelineTarget(project.root, 'tools:report', options(project));
    assert.equal(resolved.pipelinePath, join(dir, 'pipelines', 'report.yaml'));
  });

  it('пакет проекта затеняет одноимённый пакет home целиком', () => {
    const project = makeProject();
    writePackage(projectPackages(project), 'hello', { 'other.yml': PIPELINE });
    writePackage(homePackages(project), 'hello', { 'greet.yml': PIPELINE });
    const error = failureOf(() => resolvePipelineTarget(project.root, 'hello:greet', options(project)));
    assert.match(error.message, /нет пайплайна greet/);
    assert.match(error.hint ?? '', /other/);
  });

  it('burnex:<имя> не перехвачен', () => {
    const project = makeProject();
    writePackage(projectPackages(project), 'stepcast-clone', { 'migrate-widgets.yml': PIPELINE });
    const resolved = resolvePipelineTarget(project.root, 'burnex:migrate-widgets', options(project));
    assert.equal(resolved.pipelinePath, packagedPipelinePath('migrate-widgets'));
    assert.equal(resolved.address, undefined);
  });

  it('путь остаётся путём: ./foo:bar.yml, пути с / и имя с расширением', () => {
    const project = makeProject();
    for (const target of ['./foo:bar.yml', 'dir/hello:greet', 'hello:greet.yml', 'Hello:greet']) {
      const resolved = resolvePipelineTarget(project.root, target, options(project));
      assert.equal(resolved.outsideProject, false, target);
      assert.equal(resolved.address, undefined, target);
      assert.equal(resolved.pipelinePath, join(project.root, target), target);
    }
  });

  it('пакет не найден: отказ с перечнем известных пакетов', () => {
    const project = makeProject();
    writePackage(projectPackages(project), 'hello', { 'greet.yml': PIPELINE });
    const error = failureOf(() => resolvePipelineTarget(project.root, 'nope:greet', options(project)));
    assert.match(error.message, /Пакет nope не найден/);
    assert.match(error.hint ?? '', /hello/);
  });

  it('пакетов нет вовсе: отказ называет, где искали', () => {
    const project = makeProject();
    const error = failureOf(() => resolvePipelineTarget(project.root, 'nope:greet', options(project)));
    assert.match(error.hint ?? '', /\.burnex\/packages/);
  });

  it('пакет сломан: отказ называет причину и файл манифеста', () => {
    const project = makeProject();
    writePackage(projectPackages(project), 'hello', { 'greet.yml': PIPELINE }, 'name: [oops\n');
    const error = failureOf(() => resolvePipelineTarget(project.root, 'hello:greet', options(project)));
    assert.match(error.message, /Пакет hello сломан/);
    assert.match(error.message, /YAML/);
    assert.match(error.file ?? '', /package\.yml$/);
  });

  it('пайплайна в пакете нет: отказ перечисляет пайплайны пакета', () => {
    const project = makeProject();
    writePackage(projectPackages(project), 'hello', { 'greet.yml': PIPELINE, 'wave.yml': PIPELINE });
    const error = failureOf(() => resolvePipelineTarget(project.root, 'hello:missing', options(project)));
    assert.match(error.message, /В пакете hello нет пайплайна missing/);
    assert.match(error.hint ?? '', /greet, wave/);
  });
});

describe('package address: lint и run', () => {
  const USING_STEP = `
version: 1
kind: pipeline
name: greet
jobs:
  build:
    steps:
      - { id: hi, uses: local-step }
`;

  function writeLocalStep(project: Project): void {
    project.write(
      '.burnex/steps/local-step/step.yml',
      'version: 1\nkind: step\nname: local-step\ndescription: Шаг проекта.\nfile: ./main.sh\n',
    );
    project.write('.burnex/steps/local-step/main.sh', '#!/bin/sh\necho ok\n');
  }

  it('lint адресом пакета проекта: слои шагов идут от каталога запуска', () => {
    const project = makeProject();
    writeLocalStep(project);
    writePackage(projectPackages(project), 'hello', { 'greet.yml': USING_STEP });
    const lines: string[] = [];
    const code = withHome(project.home, () =>
      runLintCommand(args('lint', 'hello:greet'), (line) => lines.push(line), project.root),
    );
    assert.equal(code, ExitCode.ok, lines.join('\n'));
    assert.match(lines.join('\n'), /ok: hello:greet/);
  });

  it('lint адресом пакета home: пайплайн из home разрешает шаги проекта', () => {
    const project = makeProject();
    writeLocalStep(project);
    writePackage(homePackages(project), 'tools', { 'report.yml': USING_STEP });
    const lines: string[] = [];
    const code = withHome(project.home, () =>
      runLintCommand(args('lint', 'tools:report'), (line) => lines.push(line), project.root),
    );
    assert.equal(code, ExitCode.ok, lines.join('\n'));
  });

  it('lint пайплайна пакета без шага в слоях называет промах — пакет не привносит шаги проекта', () => {
    const project = makeProject();
    writePackage(homePackages(project), 'tools', { 'report.yml': USING_STEP });
    const lines: string[] = [];
    const code = withHome(project.home, () =>
      runLintCommand(args('lint', 'tools:report'), (line) => lines.push(line), project.root),
    );
    assert.equal(code, ExitCode.configError);
    assert.match(lines.join('\n'), /local-step/);
  });

  it('run --dry-run адресом пакета проходит проверку без запуска', async () => {
    const project = makeProject();
    writePackage(projectPackages(project), 'hello', { 'greet.yml': PIPELINE });
    const lines: string[] = [];
    const code = await withHome(project.home, () =>
      runRunCommand(args('run', 'hello:greet', { 'dry-run': true }), (line) => lines.push(line), project.root),
    );
    assert.equal(code, ExitCode.ok, lines.join('\n'));
    assert.match(lines.join('\n'), /ok: hello:greet — проверка пройдена/);
  });

  it('run адресом пакета home запускает пайплайн в проекте и пишет прогон в журнал проекта', async () => {
    const project = makeProject();
    writePackage(homePackages(project), 'tools', { 'report.yml': PIPELINE });
    const lines: string[] = [];
    const code = await withHome(project.home, () =>
      runRunCommand(args('run', 'tools:report'), (line) => lines.push(line), project.root),
    );
    assert.equal(code, ExitCode.ok, lines.join('\n'));
    assert.match(lines.join('\n'), /прогон [0-9a-f]+: succeeded|прогон [0-9a-f]+: /);
  });
});

describe('package address: журнал прогона', () => {
  const TWO_JOBS = `
version: 1
kind: pipeline
name: report
jobs:
  first:
    steps:
      - { id: one, uses: greet-step }
  second:
    needs: [first]
    steps:
      - { id: two, run: [echo, второй] }
`;

  function bed(): { project: Project; runsRoot: string; lines: string[]; write: (line: string) => void } {
    const project = makeProject();
    const runsRoot = tempDir('runs-');
    // `runs.root` допустим только в глобальной конфигурации.
    writeFileSync(join(project.home, '.burnex', 'config.yml'), `runs:\n  root: ${runsRoot}\n`);
    const lines: string[] = [];
    return { project, runsRoot, lines, write: (line) => lines.push(line) };
  }

  function writePackageStep(packageDir: string): void {
    const dir = join(packageDir, 'steps', 'greet-step');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'step.yml'),
      'version: 1\nkind: step\nname: greet-step\ndescription: Шаг пакета.\nfile: ./main.sh\n',
    );
    writeFileSync(join(dir, 'main.sh'), '#!/bin/sh\necho ok\n');
  }

  it('манифест несёт названный адрес рядом с разрешённым путём, шаг — пакет и его слой', async () => {
    const b = bed();
    const dir = writePackage(projectPackages(b.project), 'hello', { 'report.yml': TWO_JOBS });
    writePackageStep(dir);

    const code = await withHome(b.project.home, () =>
      runRunCommand(args('run', 'hello:report'), b.write, b.project.root),
    );
    assert.equal(code, ExitCode.ok, b.lines.join('\n'));

    const runId = listRuns(b.runsRoot, b.project.root)[0] as string;
    const paths = runPaths(b.runsRoot, projectKey(b.project.root), runId);
    const manifest = readManifest(paths);
    assert.equal(manifest.pipeline_address, 'hello:report');
    assert.equal(realpathSync(manifest.pipeline_file), realpathSync(join(dir, 'pipelines', 'report.yml')));

    const step = readStatus(paths).jobs.flatMap((job) => job.steps).find((item) => item.id === 'one');
    assert.equal(step?.uses?.package, 'hello');
    assert.equal(step?.uses?.layer, 'project');
    assert.equal(step?.script?.package, 'hello');
  });

  it('resume идёт по сохранённому пути: пакет можно убрать, адрес не разрешается заново', async () => {
    const b = bed();
    const dir = writePackage(homePackages(b.project), 'tools', { 'report.yml': TWO_JOBS });
    // Шаг первой работы — шаг проекта, пакет приносит только пайплайн.
    b.project.write(
      '.burnex/steps/greet-step/step.yml',
      'version: 1\nkind: step\nname: greet-step\ndescription: Шаг проекта.\nfile: ./main.sh\n',
    );
    b.project.write('.burnex/steps/greet-step/main.sh', '#!/bin/sh\necho ok\n');

    const first = await withHome(b.project.home, () =>
      runRunCommand(args('run', 'tools:report'), b.write, b.project.root),
    );
    assert.equal(first, ExitCode.ok, b.lines.join('\n'));
    const sourceId = listRuns(b.runsRoot, b.project.root)[0] as string;

    // Файл пайплайна остаётся на месте (resume читает его по сохранённому пути);
    // пакет при этом из указателя выпал бы — сломанный манифест.
    writeFileSync(join(dir, 'package.yml'), 'name: [oops\n');

    const resumed = await withHome(b.project.home, () =>
      runResumeCommand({ command: 'resume', positional: [sourceId], flags: { from: 'second' } }, b.write, b.project.root),
    );
    assert.equal(resumed, ExitCode.ok, b.lines.join('\n'));
    const resumedId = listRuns(b.runsRoot, b.project.root).find((id) => id !== sourceId) as string;
    const manifest = readManifest(runPaths(b.runsRoot, projectKey(b.project.root), resumedId));
    assert.equal(manifest.pipeline_address, 'tools:report');
  });

  it('манифест прежнего журнала без адреса читается как прежде', async () => {
    const b = bed();
    b.project.write('burnex.yml', PIPELINE);
    const code = await withHome(b.project.home, () =>
      runRunCommand(args('run', 'burnex.yml'), b.write, b.project.root),
    );
    assert.equal(code, ExitCode.ok, b.lines.join('\n'));
    const runId = listRuns(b.runsRoot, b.project.root)[0] as string;
    const paths = runPaths(b.runsRoot, projectKey(b.project.root), runId);
    assert.equal(readManifest(paths).pipeline_address, undefined);

    // Журнал прежней версии: ключа нет вовсе — читатель его не требует.
    const raw = JSON.parse(readFileSync(paths.manifest, 'utf8')) as Record<string, unknown>;
    delete raw['pipeline_address'];
    writeFileSync(paths.manifest, JSON.stringify(raw));
    assert.equal(readManifest(paths).pipeline_address, undefined);
  });
});
