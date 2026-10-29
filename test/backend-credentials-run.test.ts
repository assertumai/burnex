import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/kernel/errors.js';
import { applyDeclarativePlugin } from '../src/kernel/load.js';
import { registryFromKernel, type Registry } from '../src/kernel/registry.js';
import { createBuiltinKernel } from '../src/parts/builtin.js';
import { createFakeBackend, initLine, resultLine } from '../src/parts/pipeline/backend/fake.js';
import type { BackendAdapter } from '../src/parts/pipeline/backend/types.js';
import { DECLARATIVE_CONTRIBUTION_FIELDS, type StepKindContribution } from '../src/parts/pipeline/contract.js';
import type { Predicate } from '../src/parts/pipeline/document/model.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { runJudgePass } from '../src/parts/pipeline/run/exec/judgePass.js';
import { RunJournal } from '../src/parts/pipeline/run/journal/writer.js';
import { readEvents } from '../src/parts/pipeline/run/journal/reader.js';
import { planResume, readSourceRun } from '../src/parts/pipeline/run/resumePlan.js';
import { runPipeline, type RunResult } from '../src/parts/pipeline/run/runner.js';
import { gitCommit, gitInit, makeProject, testBaseEnv, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * `backends.<id>.credentials` (`secrets-keychain-provider`): значение берёт
 * провайдер плагина `vault`, который считает вызовы, — настоящая связка ключей
 * тесту не нужна.
 */

const VALUE = 'ключ-бэкенда-4242';
const VARIABLE = 'OPENAI_API_KEY';

interface Vault {
  registry: Registry;
  /** Путь записи (`secret` входа) каждого вызова провайдера. */
  readonly calls: string[];
  fail: boolean;
}

async function vault(steps: readonly StepKindContribution[] = []): Promise<Vault> {
  const calls: string[] = [];
  const state = { calls, fail: false } as Vault;
  const kernel = createBuiltinKernel();
  await applyDeclarativePlugin(
    kernel,
    {
      name: 'vault-plugin',
      steps,
      secretProviders: [
        {
          name: 'vault',
          schema: { type: 'object' },
          resolve: async (input) => {
            calls.push(input.secret);
            if (state.fail) throw new Error('хранилище недоступно');
            return VALUE;
          },
        },
      ],
    },
    '/модуль/vault.js',
    DECLARATIVE_CONTRIBUTION_FIELDS,
  );
  state.registry = registryFromKernel(kernel);
  return state;
}

function configWith(
  project: Project,
  runsRoot: string,
  options: { readonly backends?: readonly string[]; readonly envDeny?: readonly string[] } = {},
) {
  const credentials = { [VARIABLE]: { provider: 'vault', params: {} } };
  const clone = project.config.backends['claude']!;
  const backends = { ...project.config.backends };
  for (const name of options.backends ?? ['fake']) backends[name] = { ...clone, credentials };
  return {
    ...project.config,
    runs: { ...project.config.runs, root: runsRoot },
    backends,
    ...(options.envDeny === undefined ? {} : { envDeny: options.envDeny }),
  };
}

/** Агент, чей процесс записывает полученную переменную в файл рабочего дерева. */
function dumpingAgent(lines: readonly string[]): BackendAdapter {
  const base = createFakeBackend({ lines });
  return {
    ...base.adapter,
    launch(invocation) {
      const spec = base.adapter.launch(invocation);
      const [node, flag, script] = spec.command as [string, string, string];
      const dump = `require('fs').writeFileSync('agent.seen', process.env.${VARIABLE} ?? 'ABSENT');`;
      return { ...spec, command: [node, flag, dump + script] };
    },
  };
}

interface Started {
  readonly result: RunResult;
  readonly runsRoot: string;
}

async function start(
  project: Project,
  vaultState: Vault,
  options: {
    readonly adapter?: BackendAdapter;
    readonly runsRoot?: string;
    readonly backends?: readonly string[];
    readonly envDeny?: readonly string[];
  } = {},
): Promise<Started> {
  const runsRoot = options.runsRoot ?? tempDir('runs-');
  const config = configWith(project, runsRoot, {
    ...(options.backends === undefined ? {} : { backends: options.backends }),
    ...(options.envDeny === undefined ? {} : { envDeny: options.envDeny }),
  });
  const adapter = options.adapter ?? dumpingAgent([initLine(), resultLine({ text: `ответ с ключом ${VALUE}` })]);
  const result = await runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config, registry: vaultState.registry }),
    config,
    projectRoot: project.root,
    cwd: project.root,
    baseEnv: testBaseEnv(),
    registry: vaultState.registry,
    adapterFor: () => adapter,
  });
  return { result, runsRoot };
}

const read = (result: RunResult, relative: string): string =>
  readFileSync(join(result.journal.paths.dir, relative), 'utf8');

const AGENT = '      - { id: think, agent: fake, prompt: подумай }\n';

function pipeline(steps: string, header = ''): string {
  return `
kind: pipeline
name: p
${header}jobs:
  build:
    steps:
${steps}
`;
}

describe('backend-credentials: доставка процессу CLI', () => {
  it('значение доходит до процесса CLI поверх env_deny, вывод агента замаскирован', async () => {
    const project = makeProject({ 'stepcast.yml': pipeline(AGENT) });
    const state = await vault();
    const { result } = await start(project, state, { envDeny: ['*_KEY'] });

    assert.equal(result.status, 'success');
    assert.equal(readFileSync(project.path('agent.seen'), 'utf8'), VALUE);
    assert.deepEqual(state.calls, [`backends.fake.credentials.${VARIABLE}`]);

    const log = read(result, 'jobs/build/steps/01-think/stdout.log');
    assert.match(log, /\*\*\*/);
    assert.doesNotMatch(log, new RegExp(VALUE));
    assert.doesNotMatch(readFileSync(result.journal.paths.events, 'utf8'), new RegExp(VALUE));
    assert.doesNotMatch(read(result, 'pipeline.lock.yml'), new RegExp(VALUE));
  });

  it('командный шаг того же прогона значения не получает', async () => {
    const project = makeProject({
      'stepcast.yml': pipeline(
        AGENT + `      - { id: cmd, run: [sh, -c, 'printenv ${VARIABLE} || echo ABSENT'] }\n`,
      ),
    });
    const { result } = await start(project, await vault());

    assert.equal(result.status, 'success');
    assert.equal(read(result, 'jobs/build/steps/02-cmd/stdout.log'), 'ABSENT\n');
  });

  it('${env.*}, чьё значение содержит учётные данные, не раскрывается', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: p
jobs:
  build:
    env: { WRAPPED: "prefix-${VALUE}" }
    steps:
${AGENT}      - { id: cmd, run: [echo, "\${env.WRAPPED}"] }
`,
    });
    const { result } = await start(project, await vault());

    assert.equal(result.status, 'failed');
    const finished = readEvents(result.journal.paths).find((event) => event.kind === 'job.finished');
    assert.ok(finished?.kind === 'job.finished');
    assert.match(finished.reason ?? '', /WRAPPED/);
    assert.doesNotMatch(readFileSync(result.journal.paths.events, 'utf8'), new RegExp(VALUE));
  });

  it('судья получает учётные данные своего бэкенда', async () => {
    const dir = tempDir('judge-');
    mkdirSync(join(dir, 'runs'));
    mkdirSync(join(dir, 'project'));
    const journal = RunJournal.create({ runsRoot: join(dir, 'runs'), projectRoot: join(dir, 'project') });
    const adapter = dumpingAgent([initLine(), resultLine({ structured: { pass: true, reason: 'ок' } })]);
    const claim: Extract<Predicate, { kind: 'judge' }> = { kind: 'judge', claim: 'готово', hard: true, agent: 'fake' };

    await runJudgePass({
      predicates: [claim],
      firstPass: [{ predicate: 'judge', passed: true, hard: true, expected: claim.claim }],
      task: 'задача',
      text: 'готово',
      structured: {},
      cwd: dir,
      stepDir: dir,
      attempt: 1,
      timeoutMs: 5_000,
      adapterFor: () => adapter,
      credentialsFor: (name) => (name === 'fake' ? { [VARIABLE]: VALUE } : undefined),
      defaultAgent: 'claude',
      journal,
      nextCallIndex: () => 1,
      canCall: () => true,
      onUsage: () => undefined,
    });

    assert.equal(readFileSync(join(dir, 'agent.seen'), 'utf8'), VALUE);
  });

  it('судья в expect плагинного шага получает учётные данные своего бэкенда', async () => {
    const project = makeProject({
      'stepcast.yml': pipeline(`      - id: probe
        probe: {}
        expect:
          - judge: "ответ похож на здоровый"
            hard: true
            agent: fake
`),
    });
    const probe: StepKindContribution = {
      name: 'probe',
      title: 'Проба',
      fields: { type: 'object', additionalProperties: false },
      execute: () => ({ exitCode: 0, text: 'ответ получен' }),
    };
    const state = await vault([probe]);
    const adapter = dumpingAgent([initLine(), resultLine({ structured: { pass: true, reason: 'ок' } })]);
    const { result } = await start(project, state, { adapter, envDeny: ['*_KEY'] });

    assert.equal(result.status, 'success');
    assert.equal(readFileSync(project.path('agent.seen'), 'utf8'), VALUE);
    assert.deepEqual(state.calls, [`backends.fake.credentials.${VARIABLE}`]);
  });
});

describe('backend-credentials: разрешение до старта', () => {
  it('учётные данные бэкенда, которым прогон не идёт, не разрешаются', async () => {
    const project = makeProject({ 'stepcast.yml': pipeline(AGENT) });
    const state = await vault();
    const { result } = await start(project, state, { backends: ['fake', 'codex'] });

    assert.equal(result.status, 'success');
    assert.deepEqual(state.calls, [`backends.fake.credentials.${VARIABLE}`], 'запись codex не вызывала провайдера');
  });

  it('прогон без агентских шагов провайдера не вызывает', async () => {
    const project = makeProject({ 'stepcast.yml': pipeline('      - { id: cmd, run: [echo, ok] }\n') });
    const state = await vault();
    const { result } = await start(project, state);

    assert.equal(result.status, 'success');
    assert.deepEqual(state.calls, []);
  });

  it('сбой провайдера: отказ с путём записи, каталога прогона нет', async () => {
    const project = makeProject({ 'stepcast.yml': pipeline(AGENT) });
    const state = await vault();
    state.fail = true;
    const runsRoot = tempDir('runs-');

    await assert.rejects(start(project, state, { runsRoot }), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.equal(error.at, `backends.fake.credentials.${VARIABLE}`);
      assert.match(error.message, /хранилище недоступно/);
      assert.match(error.message, /backends\.fake\.credentials/);
      return true;
    });
    assert.deepEqual(readdirSync(runsRoot), []);
  });

  it('возобновление разрешает учётные данные заново', async () => {
    const project = makeProject({ 'stepcast.yml': pipeline(AGENT) });
    gitInit(project.root);
    gitCommit(project.root, 'init');
    const state = await vault();
    const plain = createFakeBackend({ lines: [initLine(), resultLine({ text: 'готово' })] }).adapter;
    const runsRoot = tempDir('runs-');
    const first = await start(project, state, { runsRoot, adapter: plain });
    assert.equal(first.result.status, 'success');
    assert.equal(state.calls.length, 1);

    const config = configWith(project, runsRoot);
    const source = readSourceRun(first.result.journal.paths);
    const { expanded, plan } = planResume({ cwd: project.root, config, source, registry: state.registry });
    state.fail = true;

    await assert.rejects(
      runPipeline({
        expanded,
        config,
        projectRoot: project.root,
        cwd: project.root,
        baseEnv: testBaseEnv(),
        registry: state.registry,
        adapterFor: () => plain,
        resume: { plan, source },
      }),
      (error: unknown) => error instanceof StepcastError && /хранилище недоступно/.test(error.message),
    );
    assert.equal(state.calls.length, 2, 'возобновление вызвало провайдера ещё раз');
  });
});
