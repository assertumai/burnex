import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../src/parts/pipeline/config/resolve.js';
import { buildPipelines } from '../src/parts/ui/pipelines.js';
import { makeJournalBed, seedRun } from './helpers.js';

/**
 * Что вид пайплайна несёт доске: объявленное имя и перечень объявленных
 * входов. Диалог «Взять в работу» показывает пайплайны по имени и передаёт
 * слаг пункта только тому, кто вход объявил, — оба значения приходят отсюда,
 * из вида, а не из ядра.
 */

function bed() {
  const { runsRoot, projectRoot, home } = makeJournalBed();
  seedRun(runsRoot, projectRoot, { runId: 'a' });
  mkdirSync(join(projectRoot, '.burnex', 'pipelines'), { recursive: true });
  return { runsRoot, projectRoot, home };
}

function write(projectRoot: string, name: string, body: string): void {
  writeFileSync(join(projectRoot, '.burnex', 'pipelines', name), body);
}

const JOB = `kind: pipeline
name: %NAME%
%INPUTS%jobs:
  work:
    steps:
      - id: a
        run: [echo, ok]
`;

function document(name: string, inputs?: string): string {
  return JOB.replace('%NAME%', name).replace('%INPUTS%', inputs === undefined ? '' : inputs);
}

describe('ui-pipelines: имя и входы в виде пайплайна', () => {
  it('несёт объявленное имя документа, а не имя файла', async () => {
    const { runsRoot, projectRoot, home } = bed();
    write(projectRoot, 'loop.yml', document('self-improve'));
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });

    const view = (await buildPipelines(runsRoot, config, { home })).pipelines.find((entry) =>
      entry.file.endsWith('loop.yml'),
    );

    assert.equal(view?.name, 'self-improve');
  });

  it('перечисляет объявленные входы: по ним доска решает, кому передавать пункт', async () => {
    const { runsRoot, projectRoot, home } = bed();
    write(projectRoot, 'with-item.yml', document('takes-item', "inputs:\n  item: { type: string, default: '' }\n"));
    write(projectRoot, 'plain.yml', document('no-inputs'));
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });

    const pipelines = (await buildPipelines(runsRoot, config, { home })).pipelines;
    const withItem = pipelines.find((entry) => entry.file.endsWith('with-item.yml'));
    const plain = pipelines.find((entry) => entry.file.endsWith('plain.yml'));

    assert.deepEqual([...(withItem?.inputs ?? [])], ['item']);
    assert.deepEqual([...(plain?.inputs ?? [])], []);
  });

  it('раскрывает пайплайн с обязательным входом без умолчания: значение передаётся только при запуске', async () => {
    const { runsRoot, projectRoot, home } = bed();
    write(
      projectRoot,
      'required.yml',
      document('needs-item', 'inputs:\n  item: { type: string, required: true }\n  count: { type: int, required: true }\n  flag: { type: bool, required: true }\n'),
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });

    const view = (await buildPipelines(runsRoot, config, { home })).pipelines.find((entry) =>
      entry.file.endsWith('required.yml'),
    );

    assert.equal(view?.error, undefined);
    assert.equal(view?.name, 'needs-item');
    assert.deepEqual([...(view?.inputs ?? [])], ['item', 'count', 'flag']);
  });

  it('находит все файлы каталога пайплайнов проекта: перечня доска не ведёт', async () => {
    const { runsRoot, projectRoot, home } = bed();
    write(projectRoot, 'one.yml', document('one'));
    write(projectRoot, 'two.yml', document('two'));
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });

    const names = (await buildPipelines(runsRoot, config, { home })).pipelines.map((entry) => entry.name).sort();

    assert.deepEqual(names, ['one', 'two']);
  });
});

describe('ui-pipelines: данные формы запуска', () => {
  const WITH_ENV = (steps: string): string => `kind: pipeline
name: launchable
env:
  MODE: fast
  TOKEN: s3cret-value
jobs:
  work:
    steps:
${steps}`;

  it('envNames несёт ключи env без значений', async () => {
    const { runsRoot, projectRoot, home } = bed();
    write(projectRoot, 'env.yml', WITH_ENV('      - { id: a, run: [echo, ok] }\n'));
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });

    const view = (await buildPipelines(runsRoot, config, { home })).pipelines.find((entry) =>
      entry.file.endsWith('env.yml'),
    );

    assert.equal(view?.error, undefined);
    assert.deepEqual([...(view?.envNames ?? [])], ['MODE', 'TOKEN']);
    const serialized = JSON.stringify(view);
    assert.doesNotMatch(serialized, /fast/);
    assert.doesNotMatch(serialized, /s3cret-value/);
  });

  it('shadow: готов, когда external объявлен у каждого шага, иначе перечень адресов', async () => {
    const { runsRoot, projectRoot, home } = bed();
    write(projectRoot, 'ready.yml', WITH_ENV('      - { id: a, run: [echo, ok], external: false }\n'));
    write(
      projectRoot,
      'unready.yml',
      WITH_ENV('      - { id: a, run: [echo, ok], external: false }\n      - { id: push, run: [echo, ok] }\n'),
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });

    const pipelines = (await buildPipelines(runsRoot, config, { home })).pipelines;
    assert.deepEqual(pipelines.find((entry) => entry.file.endsWith('ready.yml'))?.shadow, { ready: true });
    assert.deepEqual(pipelines.find((entry) => entry.file.endsWith('unready.yml'))?.shadow, {
      ready: false,
      steps: ['work.push'],
    });
  });
});

describe('ui-pipelines: выбор пользователя в виде пайплайна', () => {
  const AGENT_PIPELINE = `kind: pipeline
name: p
jobs:
  work:
    steps:
      - id: a
        prompt: hi
        model: opus
      - id: b
        prompt: hi
`;

  // Бэкенд назван в конфигурации: запись с неизвестным агентом раскрытие отклоняет.
  const CODEX = 'backends:\n  codex:\n    default_model: gpt-5.6-terra\n';

  async function viewWith(globalConfig: string, projectConfig?: string) {
    const { runsRoot, projectRoot, home } = bed();
    write(projectRoot, 'p.yml', AGENT_PIPELINE);
    mkdirSync(join(home, '.burnex'), { recursive: true });
    writeFileSync(join(home, '.burnex', 'config.yml'), globalConfig);
    if (projectConfig !== undefined) writeFileSync(join(projectRoot, '.burnex', 'config.yml'), projectConfig);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const view = (await buildPipelines(runsRoot, config, { home })).pipelines.find((entry) => entry.file.endsWith('p.yml'));
    assert.equal(view?.error, undefined);
    return { view, home, projectRoot };
  }

  it('при force запись на шаг со своей моделью помечена, и модель шага прежняя', async () => {
    const { view } = await viewWith('step_agents:\n  p:\n    work:\n      a: { model: sonnet }\n');
    const step = view?.jobs[0]?.steps.find((candidate) => candidate.id === 'a');
    assert.equal(step?.model, 'opus');
    assert.deepEqual(step?.modelOrigin, { layer: 'step' });
    assert.equal(step?.agentEntry?.key, 'step_agents.p.work.a');
    assert.equal(step?.agentEntry?.mark, 'loses_to_document');
    assert.equal(step?.agentEntry?.model?.value, 'sonnet');
    assert.equal(view?.agentPolicy, 'force');
  });

  it('при fallback запись побеждает и называет файл, а политика — свой источник', async () => {
    const { view, home } = await viewWith('agent_policy: fallback\nstep_agents:\n  p:\n    work:\n      a: { model: sonnet }\n');
    const step = view?.jobs[0]?.steps.find((candidate) => candidate.id === 'a');
    const file = join(home, '.burnex', 'config.yml');
    assert.equal(step?.model, 'sonnet');
    assert.deepEqual(step?.modelOrigin, { layer: 'step_agents', file });
    assert.equal(step?.agentEntry?.mark, undefined);
    assert.equal(view?.agentPolicy, 'fallback');
    assert.equal(view?.agentPolicyFile, file);
  });

  it('запись пайплайна и источник агента шага доходят до карточки', async () => {
    const { view, home } = await viewWith(`${CODEX}pipeline_agents:\n  p: { agent: codex }\n`);
    const step = view?.jobs[0]?.steps.find((candidate) => candidate.id === 'b');
    assert.equal(step?.agent, 'codex');
    assert.deepEqual(step?.agentOrigin, { layer: 'pipeline_agents', file: join(home, '.burnex', 'config.yml') });
    assert.equal(view?.agentEntry?.key, 'pipeline_agents.p');
    assert.equal(view?.agentEntry?.agent?.value, 'codex');
    assert.equal(view?.agentEntry?.mark, undefined);
    assert.equal(view?.agentPolicyFile, 'встроенное умолчание');
  });

  it('поле, заданное проектным файлом, помечено: экран пишет только глобальный', async () => {
    const { view } = await viewWith(
      `${CODEX}pipeline_agents:\n  p: { agent: codex }\n`,
      'pipeline_agents:\n  p: { effort: high }\n',
    );
    assert.equal(view?.agentEntry?.mark, 'shadowed_by_project');
    assert.equal(view?.agentEntry?.effort?.value, 'high');
  });
});

describe('ui-pipelines: адрес записи выбора с экрана', () => {
  const LANES = `kind: pipeline
name: p
jobs:
  implement-a:
    lane: a
    steps: [{ id: code, prompt: hi }]
  implement-b:
    lane: b
    steps: [{ id: code, prompt: hi }]
`;

  async function viewOf(body: string, globalConfig?: string) {
    const { runsRoot, projectRoot, home } = bed();
    write(projectRoot, 'p.yml', body);
    if (globalConfig !== undefined) {
      mkdirSync(join(home, '.burnex'), { recursive: true });
      writeFileSync(join(home, '.burnex', 'config.yml'), globalConfig);
    }
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const view = (await buildPipelines(runsRoot, config, { home })).pipelines.find((entry) => entry.file.endsWith('p.yml'));
    assert.equal(view?.error, undefined);
    return view;
  }

  it('шаг дорожки пишется под работой до раскрытия: запись действует на все копии', async () => {
    const view = await viewOf(LANES);
    assert.deepEqual(view?.jobs.map((job) => job.agentEntryJob), ['implement', 'implement']);
  });

  it('общая запись работы видна на всех дорожках, и правка идёт в неё же', async () => {
    const view = await viewOf(LANES, 'step_agents:\n  p:\n    implement:\n      code: { model: sonnet }\n');
    for (const job of view?.jobs ?? []) {
      assert.equal(job.agentEntryJob, 'implement');
      assert.equal(job.steps[0]?.agentEntry?.key, 'step_agents.p.implement.code');
    }
  });

  it('существующая точная запись дорожки ближе общей: её дорожка правит её, другая — общую', async () => {
    const view = await viewOf(
      LANES,
      'step_agents:\n  p:\n    implement:\n      code: { model: sonnet }\n    implement-a:\n      code: { model: haiku }\n',
    );
    const [a, b] = view?.jobs ?? [];
    assert.equal(a?.agentEntryJob, 'implement-a');
    assert.equal(a?.steps[0]?.agentEntry?.key, 'step_agents.p.implement-a.code');
    assert.equal(b?.agentEntryJob, 'implement');
    assert.equal(b?.steps[0]?.agentEntry?.key, 'step_agents.p.implement.code');
  });

  it('пайплайн без name не адресует записи: имени для выбора нет, запись pipeline ему не приписана', async () => {
    const unnamed = 'kind: pipeline\njobs:\n  work:\n    steps: [{ id: a, prompt: hi }]\n';
    const view = await viewOf(unnamed, 'pipeline_agents:\n  pipeline: { effort: high }\n');
    assert.equal(view?.name, 'pipeline');
    assert.equal(view?.agentEntryName, undefined);
    assert.equal(view?.agentEntry, undefined);
    assert.notEqual(view?.jobs[0]?.steps[0]?.effort, 'high');
  });

  it('у именованного пайплайна имя записей — его name', async () => {
    const view = await viewOf(LANES);
    assert.equal(view?.agentEntryName, 'p');
  });

  it('запись пайплайна без агентских шагов помечена «шагов нет», а не «проигрывает документу»', async () => {
    const view = await viewOf(document('p'), 'pipeline_agents:\n  p: { effort: high }\n');
    assert.equal(view?.agentEntry?.mark, 'no_agent_steps');
  });

  it('запись пайплайна, которую перекрыл шаг при force, помечена как проигравшая документу', async () => {
    const view = await viewOf(
      'kind: pipeline\nname: p\njobs:\n  work:\n    steps: [{ id: a, prompt: hi, effort: low }]\n',
      'pipeline_agents:\n  p: { effort: high }\n',
    );
    assert.equal(view?.agentEntry?.mark, 'loses_to_document');
  });
});
