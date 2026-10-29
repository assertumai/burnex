import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ExitCode } from '../src/kernel/errors.js';
import type { ParsedArgs } from '../src/kernel/cli/types.js';
import { runRunCommand } from '../src/parts/pipeline/commands/run.js';
import { runResumeCommand } from '../src/parts/pipeline/commands/resume.js';
import { projectKey, runPaths } from '../src/parts/pipeline/run/journal/paths.js';
import { listRuns, readManifest } from '../src/parts/pipeline/run/journal/reader.js';
import { RunManifestSchema } from '../src/parts/pipeline/run/journal/schema.js';
import { makeProject, withHome, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * `run --env KEY=VALUE` (`pipeline-execution`, `run-resume`): переопределение
 * объявленного верхнеуровневого `env:` на один прогон. Тесты ходят через
 * команды, как пользователь, — флаг разбирается и проверяется там.
 */

const PIPELINE = `
version: 1
kind: pipeline
name: env-override
env:
  MODE: default
  OTHER: untouched
jobs:
  build:
    steps:
      - id: dump
        run: [sh, -c, 'printf "%s|%s" "$MODE" "$OTHER" > seen.txt']
`;

function args(command: string, positional: string[] = [], flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command, positional, flags };
}

interface Bed {
  readonly project: Project;
  readonly runsRoot: string;
  readonly lines: string[];
  readonly write: (line: string) => void;
}

function bed(): Bed {
  const project = makeProject({ 'stepcast.yml': PIPELINE });
  const runsRoot = tempDir('runs-');
  // `runs.root` допустим только в глобальной конфигурации.
  writeFileSync(join(project.home, '.stepcast', 'config.yml'), `runs:\n  root: ${runsRoot}\n`);
  const lines: string[] = [];
  return { project, runsRoot, lines, write: (line) => lines.push(line) };
}

function run(b: Bed, flags: ParsedArgs['flags']): Promise<number> {
  return withHome(b.project.home, () => runRunCommand(args('run', ['stepcast.yml'], flags), b.write, b.project.root));
}

function seen(b: Bed): string {
  return readFileSync(join(b.project.root, 'seen.txt'), 'utf8');
}

function manifestOf(b: Bed, runId: string) {
  return readManifest(runPaths(b.runsRoot, projectKey(b.project.root), runId));
}

describe('run --env: переопределение объявленного env', () => {
  it('значение видно шагам, остальные ключи нетронуты, lock-хеш прежний', async () => {
    const b = bed();
    assert.equal(await run(b, {}), ExitCode.ok);
    assert.equal(seen(b), 'default|untouched');

    assert.equal(await run(b, { env: { MODE: 'fast' } }), ExitCode.ok);
    assert.equal(seen(b), 'fast|untouched');

    const [second, first] = listRuns(b.runsRoot, b.project.root).map((id) => manifestOf(b, id));
    assert.equal(first?.lock_hash, second?.lock_hash);
  });

  it('`${...}` в значении не раскрывается', async () => {
    const b = bed();
    assert.equal(await run(b, { env: { MODE: '${inputs.x}' } }), ExitCode.ok);
    assert.equal(seen(b), '${inputs.x}|untouched');
  });

  it('необъявленный ключ и многострочное значение — ошибка конфигурации до записи прогона', async () => {
    const b = bed();
    assert.equal(await run(b, { env: { NOPE: '1' } }), ExitCode.configError);
    assert.match(b.lines.join('\n'), /NOPE/);
    assert.equal(await run(b, { env: { MODE: 'a\nb' } }), ExitCode.configError);
    assert.deepEqual(listRuns(b.runsRoot, b.project.root), []);
  });

  it('env_overrides пишется в run.json, а у прогона без переопределений ключа нет', async () => {
    const b = bed();
    await run(b, {});
    await run(b, { env: { MODE: 'fast' } });
    const manifests = listRuns(b.runsRoot, b.project.root).map((id) => manifestOf(b, id));
    assert.equal(manifests.filter((m) => m.env_overrides === undefined).length, 1);
    assert.deepEqual(manifests.find((m) => m.env_overrides !== undefined)?.env_overrides, { MODE: 'fast' });
  });

  it('манифест прежней версии без env_overrides читается', () => {
    const parsed = RunManifestSchema.safeParse({
      run_id: 'r',
      pipeline: 'p',
      pipeline_file: '/p.yml',
      lock_hash: 'abc',
      project_root: '/',
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: new Date().toISOString(),
    });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  it('resume берёт переопределения из манифеста и переносит их в новый прогон', async () => {
    const b = bed();
    await run(b, { env: { MODE: 'fast' } });
    const sourceId = listRuns(b.runsRoot, b.project.root)[0] as string;
    rmSync(join(b.project.root, 'seen.txt'));

    const code = await withHome(b.project.home, () =>
      runResumeCommand(args('resume', [sourceId], { from: 'build' }), b.write, b.project.root),
    );
    assert.equal(code, ExitCode.ok);
    assert.equal(seen(b), 'fast|untouched');

    const resumedId = listRuns(b.runsRoot, b.project.root).find((id) => id !== sourceId) as string;
    assert.deepEqual(manifestOf(b, resumedId).env_overrides, { MODE: 'fast' });
  });
});
