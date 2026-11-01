import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ExitCode, StepcastError } from '../src/kernel/errors.js';
import type { ParsedArgs } from '../src/kernel/cli/types.js';
import { createFakeBackend, initLine, resultLine } from '../src/parts/pipeline/backend/fake.js';
import { runRunCommand } from '../src/parts/pipeline/commands/run.js';
import { row as resumeRow, runResumeCommand } from '../src/parts/pipeline/commands/resume.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { projectKey, runPaths, stepDir } from '../src/parts/pipeline/run/journal/paths.js';
import { listRuns, readEvents, readManifest } from '../src/parts/pipeline/run/journal/reader.js';
import { runPipeline, type RunResult } from '../src/parts/pipeline/run/runner.js';
import { assertShadowDeclarations, stepsMissingExternal } from '../src/parts/pipeline/run/shadow.js';
import { gitCommit, gitInit, makeProject, testBaseEnv, withHome, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * `run --shadow` (`shadow-run-mode`): внешние действия объявленных шагов
 * записываются, а не совершаются. Тесты ходят и через команду (отказ до
 * старта), и через `runPipeline` (содержимое журнала).
 */

const SECRET = 'токен-секрета-12345';
const ENV_VALUE = 'значение-окружения-шага';

function args(flags: ParsedArgs['flags']): ParsedArgs {
  return { command: 'run', positional: ['stepcast.yml'], flags };
}

interface Bed {
  readonly project: Project;
  readonly runsRoot: string;
  readonly lines: string[];
  readonly write: (line: string) => void;
}

function bed(files: Record<string, string>): Bed {
  const project = makeProject(files);
  const runsRoot = tempDir('runs-');
  // `runs.root` допустим только в глобальной конфигурации.
  writeFileSync(join(project.home, '.stepcast', 'config.yml'), `runs:\n  root: ${runsRoot}\n`);
  const lines: string[] = [];
  return { project, runsRoot, lines, write: (line) => lines.push(line) };
}

function runCommand(b: Bed, flags: ParsedArgs['flags']): Promise<number> {
  return withHome(b.project.home, () => runRunCommand(args(flags), b.write, b.project.root));
}

const UNDECLARED = `
version: 1
kind: pipeline
name: undeclared
jobs:
  build:
    steps:
      - { id: compile, run: [sh, -c, 'echo built > built.txt'] }
  publish:
    needs: [build]
    steps:
      - { id: push, run: [sh, -c, 'echo pushed > pushed.txt'] }
      - { id: tag, run: [echo, ok], external: false }
`;

describe('run --shadow: проверка объявлений до старта', () => {
  it('одна ошибка называет все необъявленные шаги адресами <работа>.<шаг>', () => {
    const project = makeProject({ 'stepcast.yml': UNDECLARED });
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    assert.throws(
      () => assertShadowDeclarations(expanded.pipeline),
      (error) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /build\.compile/);
        assert.match(error.message, /publish\.push/);
        assert.doesNotMatch(error.message, /publish\.tag/);
        return true;
      },
    );
  });

  it('stepsMissingExternal называет те же шаги без броска, готовый пайплайн даёт пустой перечень', () => {
    const project = makeProject({ 'stepcast.yml': UNDECLARED });
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    assert.deepEqual(stepsMissingExternal(expanded.pipeline), ['build.compile', 'publish.push']);

    const ready = makeProject({
      'stepcast.yml': UNDECLARED.replace("'echo built > built.txt'] }", "'echo built > built.txt'], external: false }").replace(
        "'echo pushed > pushed.txt'] }",
        "'echo pushed > pushed.txt'], external: true }",
      ),
    });
    const readyExpanded = expandPipeline({ pipelinePath: ready.path('stepcast.yml'), config: ready.config });
    assert.deepEqual(stepsMissingExternal(readyExpanded.pipeline), []);
  });

  it('отказ команды — ошибка конфигурации без каталога прогона, и при --dry-run тоже', async () => {
    const b = bed({ 'stepcast.yml': UNDECLARED });
    for (const flags of [{ shadow: true }, { shadow: true, 'dry-run': true }]) {
      b.lines.length = 0;
      assert.equal(await runCommand(b, flags), ExitCode.configError);
      const text = b.lines.join('\n');
      assert.match(text, /build\.compile/);
      assert.match(text, /publish\.push/);
    }
    assert.deepEqual(listRuns(b.runsRoot, b.project.root), []);
    assert.equal(existsSync(b.project.path('built.txt')), false, 'ничего не исполнено');
  });

  it('--shadow --dry-run с полными объявлениями проходит и ничего не исполняет', async () => {
    const b = bed({
      'stepcast.yml': UNDECLARED.replace("'echo built > built.txt'] }", "'echo built > built.txt'], external: false }").replace(
        "'echo pushed > pushed.txt'] }",
        "'echo pushed > pushed.txt'], external: true }",
      ),
    });
    assert.equal(await runCommand(b, { shadow: true, 'dry-run': true }), ExitCode.ok);
    assert.equal(existsSync(b.project.path('built.txt')), false);
    assert.deepEqual(listRuns(b.runsRoot, b.project.root), []);
  });

  it('обычный прогон без external идёт как прежде, а run.json без mode', async () => {
    const b = bed({ 'stepcast.yml': UNDECLARED });
    assert.equal(await runCommand(b, {}), ExitCode.ok);
    assert.equal(readFileSync(b.project.path('pushed.txt'), 'utf8'), 'pushed\n');
    const id = listRuns(b.runsRoot, b.project.root)[0] as string;
    assert.equal('mode' in readManifest(runPaths(b.runsRoot, projectKey(b.project.root), id)), false);
  });
});

const SHADOW_PIPELINE = `
version: 1
kind: pipeline
name: shadow
secrets:
  svc:
    provider: env-file
    file: .env.local
    env: SVC_CRED
env:
  STAGE: ${ENV_VALUE}
jobs:
  build:
    steps:
      - id: local
        run: [sh, -c, 'echo built > built.txt']
        external: false
        expect: [{ cmd: 'test -f built.txt' }]
      - id: push
        run: 'echo -H ${SECRET} https://example.test > pushed.txt'
        shell: [sh, -c]
        external: true
        secrets: [svc]
        env: { LOCAL_ONLY: ${ENV_VALUE} }
        expect: [{ file_exists: never-created.txt }, { exit_code: 7 }]
      - id: script
        script: ./publish.sh
        args: [--go]
        input: { target: prod }
        external: true
      - id: think
        agent: fake
        prompt: отправь письмо
        external: true
`;

async function runShadow(
  project: Project,
  shadow = true,
  envOverrides?: Readonly<Record<string, string>>,
): Promise<RunResult> {
  const config = { ...project.config, runs: { ...project.config.runs, root: tempDir('runs-') } };
  const never = createFakeBackend({ lines: [initLine(), resultLine({ text: 'готово' })] });
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config }),
    config,
    projectRoot: project.root,
    cwd: project.root,
    baseEnv: testBaseEnv(),
    adapterFor: () => never.adapter,
    ...(shadow ? { mode: 'shadow' as const } : {}),
    ...(envOverrides === undefined ? {} : { envOverrides }),
  });
}

function shadowProject(): Project {
  const project = makeProject({
    '.env.local': `SVC_CRED=${SECRET}\n`,
    'publish.sh': '#!/bin/sh\necho published > published.txt\n',
    'stepcast.yml': SHADOW_PIPELINE,
  });
  gitInit(project.root);
  gitCommit(project.root, 'init');
  return project;
}

const actionOf = (result: RunResult, index: number, id: string, n = 1): Record<string, unknown> =>
  JSON.parse(readFileSync(join(stepDir(result.journal.paths, 'build', index, id), `action-${n}.json`), 'utf8'));

describe('run --shadow: исполнение', () => {
  it('локальный шаг исполняется и решает исход, внешние не исполняются и успешны с причиной shadow', async () => {
    const project = shadowProject();
    const result = await runShadow(project);
    assert.equal(result.status, 'success');
    assert.equal(readFileSync(project.path('built.txt'), 'utf8'), 'built\n');
    for (const file of ['pushed.txt', 'published.txt']) {
      assert.equal(existsSync(project.path(file)), false, `${file} не должен появиться`);
    }

    const steps = JSON.parse(readFileSync(join(result.journal.paths.dir, 'status.json'), 'utf8')).jobs[0].steps;
    const byId = new Map<string, { status: string; reason?: string; attempts: unknown[] }>(
      steps.map((step: { id: string }) => [step.id, step]),
    );
    assert.equal(byId.get('local')?.reason, undefined);
    for (const id of ['push', 'script', 'think']) {
      assert.equal(byId.get(id)?.status, 'success', id);
      assert.equal(byId.get(id)?.reason, 'shadow', id);
      assert.equal(byId.get(id)?.attempts.length, 1, id);
    }
  });

  it('запись команды: оболочка, имена env и секретов, без значений; секрет в команде замаскирован', async () => {
    const result = await runShadow(shadowProject());
    const action = actionOf(result, 2, 'push');
    assert.equal(action.kind, 'run');
    assert.deepEqual(action.shell, ['sh', '-c']);
    assert.equal(action.command, 'echo -H *** https://example.test > pushed.txt');
    assert.deepEqual(action.secrets, ['svc']);
    // Только объявленный `env:` (пайплайн, работа, шаг): ни переменных
    // окружения процесса (`PATH` из базового окружения теста), ни внедрённых
    // `STEPCAST_*`, ни переменной секрета — его имя несёт поле `secrets`.
    assert.deepEqual(action.env_names, ['LOCAL_ONLY', 'STAGE']);
    const raw = readFileSync(join(stepDir(result.journal.paths, 'build', 2, 'push'), 'action-1.json'), 'utf8');
    assert.equal(raw.includes(ENV_VALUE), false, 'значения env не пишутся');
    assert.equal(raw.includes(SECRET), false);
  });

  it('env_names учитывает env работы и переопределения --env, но не окружение процесса', async () => {
    const project = shadowProject();
    writeFileSync(
      project.path('stepcast.yml'),
      SHADOW_PIPELINE.replace('  build:\n    steps:', '  build:\n    env: { JOB_LEVEL: x }\n    steps:'),
    );
    gitCommit(project.root, 'job env');
    const result = await runShadow(project, true, { STAGE: 'override' });
    assert.deepEqual(actionOf(result, 2, 'push').env_names, ['JOB_LEVEL', 'LOCAL_ONLY', 'STAGE']);
    assert.ok(Object.keys(testBaseEnv()).length > 0, 'базовое окружение не пусто — иначе проверка вакуумна');
  });

  it('записи script и agent несут путь, argv, input, агента, промпт', async () => {
    const result = await runShadow(shadowProject());
    const script = actionOf(result, 3, 'script');
    assert.equal(script.kind, 'script');
    assert.match(String(script.path), /publish\.sh$/);
    assert.ok((script.argv as string[]).includes('--go'));
    assert.deepEqual(script.input, { target: 'prod' });
    const agent = actionOf(result, 4, 'think');
    assert.equal(agent.kind, 'agent');
    assert.equal(agent.agent, 'fake');
    assert.equal(agent.prompt, 'отправь письмо');
    assert.equal(typeof agent.session, 'string');
  });

  it('событие step.action на каждое действие, run.json несёт mode: shadow', async () => {
    const result = await runShadow(shadowProject());
    const events = readEvents(result.journal.paths).filter((event) => event.kind === 'step.action');
    assert.deepEqual(
      events.map((event) => (event.kind === 'step.action' ? `${event.step}:${event.n}` : '')),
      ['push:1', 'script:1', 'think:1'],
    );
    assert.equal(readManifest(result.journal.paths).mode, 'shadow');
  });

  it('тот же пайплайн в обычном режиме исполняет всё, mode в run.json нет', async () => {
    const project = shadowProject();
    const result = await runShadow(project, false);
    assert.equal(result.status, 'failed', 'exit_code: 7 в expect внешнего шага теперь решает исход');
    assert.equal(existsSync(project.path('pushed.txt')), true);
    assert.equal('mode' in readManifest(result.journal.paths), false);
    assert.equal(existsSync(join(stepDir(result.journal.paths, 'build', 2, 'push'), 'action-1.json')), false);
  });

  it('ссылка ниже по графу на выход неисполненного шага — штатная ошибка отсутствующего выхода', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: downstream
jobs:
  plan:
    output: { from: ask }
    steps:
      - id: ask
        run: [echo, '{"target":"x"}']
        output_schema: schema/out.json
        external: true
  use:
    needs: [plan]
    steps:
      - { id: show, run: [echo, "\${jobs.plan.output.target}"], external: false }
`,
      'schema/out.json': '{"type":"object"}',
    });
    gitInit(project.root);
    gitCommit(project.root, 'init');
    const result = await runShadow(project);
    assert.equal(result.status, 'failed');
    // Падает именно работа ниже по графу и тем же текстом, что в обычном
    // режиме дала бы работа без выхода: сама `plan` успешна (её
    // `output_schema` в shadow-режиме не проверяется), а `show` не начинался.
    const jobs = JSON.parse(readFileSync(join(result.journal.paths.dir, 'status.json'), 'utf8')).jobs as {
      id: string;
      status: string;
      reason?: string;
      steps: { id: string; status: string; reason?: string }[];
    }[];
    const byId = new Map(jobs.map((job) => [job.id, job]));
    assert.equal(byId.get('plan')?.status, 'success');
    assert.equal(byId.get('plan')?.steps[0]?.reason, 'shadow');
    const use = byId.get('use');
    assert.equal(use?.status, 'failed');
    assert.match(use?.reason ?? '', /Подстановка jobs\.plan\.output\.target не определена/);
    assert.match(use?.reason ?? '', /Работа plan завершилась успехом, но выхода не публикует/);
    assert.deepEqual(use?.steps, [], 'шаг show не начинался');
  });
});

const TWO_JOBS = `
version: 1
kind: pipeline
name: two-jobs
jobs:
  build:
    steps:
      - { id: compile, run: [sh, -c, 'echo built > built.txt'], external: false }
  publish:
    needs: [build]
    steps:
      - { id: push, run: [sh, -c, 'echo pushed > pushed.txt'], external: true }
`;

describe('run --shadow: resume наследует режим исходного прогона', () => {
  const resume = (b: Bed, source: string) =>
    withHome(b.project.home, () =>
      runResumeCommand({ command: 'resume', positional: [source], flags: { from: 'publish' } }, b.write, b.project.root),
    );

  it('возобновлённый shadow-прогон остаётся shadow: внешний шаг не исполняется, mode переписан в новый run.json', async () => {
    const b = bed({ 'stepcast.yml': TWO_JOBS });
    assert.equal(await runCommand(b, { shadow: true }), ExitCode.ok);
    const sourceId = listRuns(b.runsRoot, b.project.root)[0] as string;
    assert.equal(existsSync(b.project.path('pushed.txt')), false);

    assert.equal(await resume(b, sourceId), ExitCode.ok);
    const resumedId = listRuns(b.runsRoot, b.project.root).find((id) => id !== sourceId) as string;
    const paths = runPaths(b.runsRoot, projectKey(b.project.root), resumedId);
    assert.equal(readManifest(paths).mode, 'shadow');
    assert.equal(existsSync(b.project.path('pushed.txt')), false, 'внешний шаг не исполнялся и после resume');
    assert.ok(readEvents(paths).some((event) => event.kind === 'step.action' && event.step === 'push'));
  });

  it('манифест без mode возобновляется в обычном режиме', async () => {
    const b = bed({ 'stepcast.yml': TWO_JOBS });
    assert.equal(await runCommand(b, {}), ExitCode.ok);
    const sourceId = listRuns(b.runsRoot, b.project.root)[0] as string;
    rmSync(b.project.path('pushed.txt'));

    assert.equal(await resume(b, sourceId), ExitCode.ok);
    const resumedId = listRuns(b.runsRoot, b.project.root).find((id) => id !== sourceId) as string;
    assert.equal('mode' in readManifest(runPaths(b.runsRoot, projectKey(b.project.root), resumedId)), false);
    assert.equal(existsSync(b.project.path('pushed.txt')), true);
  });

  it('у resume нет флага --shadow', () => {
    assert.equal(resumeRow.command.spec?.flags?.shadow, undefined);
  });
});
