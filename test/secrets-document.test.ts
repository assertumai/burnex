import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/kernel/errors.js';
import { applyDeclarativePlugin } from '../src/kernel/load.js';
import { registryFromKernel } from '../src/kernel/registry.js';
import { createBuiltinKernel } from '../src/parts/builtin.js';
import { DECLARATIVE_CONTRIBUTION_FIELDS } from '../src/parts/pipeline/contract.js';
import { expandPipeline, type ScriptRoots } from '../src/parts/pipeline/document/expand.js';
import { readLock } from '../src/parts/pipeline/document/lockRead.js';
import { jobLockHash, serializeLock } from '../src/parts/pipeline/document/lock.js';
import { computeStepKey } from '../src/parts/pipeline/run/stepKey.js';
import { asRun, asScript, makeProject, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

function isolatedRoots(project: Project): ScriptRoots {
  return { project: project.root, home: tempDir('secrets-home-'), builtin: tempDir('secrets-builtin-') };
}

function expand(project: Project, registry = registryFromKernel(createBuiltinKernel())) {
  const roots = isolatedRoots(project);
  return expandPipeline({
    pipelinePath: project.path('stepcast.yml'),
    config: project.config,
    scriptRoots: roots,
    stepRoots: roots,
    registry,
  });
}

function thrown(fn: () => unknown): StepcastError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof StepcastError, `ожидался StepcastError, пришло ${String(error)}`);
    return error;
  }
  assert.fail('ожидался отказ разбора');
}

/** Пайплайн с одним объявленным секретом и телом шагов, переданным вызывающим. */
function pipelineWith(secrets: string, steps: string): string {
  return `
kind: pipeline
name: p
secrets:
${secrets}
jobs:
  build:
    steps:
${steps}
`;
}

const GH_TOKEN = '  gh-token:\n    provider: env-file\n    file: .env.local\n';

describe('pipeline-secrets: объявление в документе пайплайна', () => {
  it('умолчание env — имя в верхнем регистре с заменой дефиса, параметры идут соседними ключами', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(GH_TOKEN, '      - id: a\n        run: [echo, ok]\n'),
    });
    const { pipeline } = expand(project);
    assert.deepEqual(pipeline.secrets, [
      { name: 'gh-token', provider: 'env-file', env: 'GH_TOKEN', params: { file: '.env.local' } },
    ]);
  });

  it('явный env побеждает умолчание', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(
        '  gh-token:\n    provider: env-file\n    file: .env\n    key: GITHUB_TOKEN\n    env: GITHUB_TOKEN\n',
        '      - id: a\n        run: [echo, ok]\n',
      ),
    });
    const { pipeline } = expand(project);
    assert.equal(pipeline.secrets[0]?.env, 'GITHUB_TOKEN');
    assert.deepEqual(pipeline.secrets[0]?.params, { file: '.env', key: 'GITHUB_TOKEN' });
  });

  it('без secrets: модель несёт пустой список', () => {
    const project = makeProject({ 'stepcast.yml': 'kind: pipeline\njobs:\n  b:\n    steps:\n      - { id: a, run: [echo, ok] }\n' });
    assert.deepEqual(expand(project).pipeline.secrets, []);
  });

  it('отклоняет недопустимое имя, называя имя и шаблон', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith('  GH_Token:\n    provider: env-file\n    file: .env\n', '      - { id: a, run: [echo, ok] }\n'),
    });
    const error = thrown(() => expand(project));
    assert.match(error.message, /GH_Token/);
    assert.match(error.message, /\^\[a-z\]\[a-z0-9_-\]\{0,63\}\$/);
  });

  it('отклоняет env с префиксом STEPCAST_', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(
        '  tok:\n    provider: env-file\n    file: .env\n    env: STEPCAST_TOKEN\n',
        '      - { id: a, run: [echo, ok] }\n',
      ),
    });
    assert.match(thrown(() => expand(project)).message, /STEPCAST_/);
  });

  it('отклоняет секрет без провайдера', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith('  tok:\n    file: .env\n', '      - { id: a, run: [echo, ok] }\n'),
    });
    assert.match(thrown(() => expand(project)).message, /не называет провайдера/);
  });

  it('файл работы с ключом secrets отклоняется с объяснением', () => {
    const project = makeProject({
      'stepcast.yml': 'kind: pipeline\njobs:\n  build:\n    uses: ./jobs/build.yml\n',
      'jobs/build.yml': 'kind: job\nsecrets:\n  tok: { provider: env-file }\nsteps:\n  - { id: a, run: [echo, ok] }\n',
    });
    assert.match(thrown(() => expand(project)).message, /объявляются только пайплайном/);
  });

  it('работа, описанная на месте, секретов тоже не объявляет', () => {
    const project = makeProject({
      'stepcast.yml': 'kind: pipeline\njobs:\n  build:\n    secrets:\n      tok: { provider: env-file }\n    steps:\n      - { id: a, run: [echo, ok] }\n',
    });
    assert.match(thrown(() => expand(project)).message, /объявляются только пайплайном/);
  });

  it('манифест переиспользуемого шага ключа secrets не принимает', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(GH_TOKEN, '      - { id: a, uses: with-secret }\n'),
      '.stepcast/steps/with-secret/step.yml':
        'version: 1\nkind: step\nname: with-secret\ndescription: Шаг.\nfile: ./main.cjs\nsecrets: [gh-token]\n',
      '.stepcast/steps/with-secret/main.cjs': 'process.exit(0)\n',
    });
    const { pipeline } = expand(project);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved?.reason, 'manifest_invalid');
    assert.match(JSON.stringify(step.unresolved), /ключ secrets недопустим в манифесте/);
  });
});

describe('pipeline-secrets: ключ secrets на шаге', () => {
  it('шаги run и script получают отсортированный уникальный список имён', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(
        `${GH_TOKEN}  npm-token:\n    provider: env-file\n    file: .env.local\n`,
        '      - { id: a, run: [echo, ok], secrets: [npm-token, gh-token, npm-token] }\n' +
          '      - { id: b, script: ./run.sh, secrets: [gh-token] }\n' +
          '      - { id: c, run: [echo, ok] }\n',
      ),
    });
    const steps = expand(project).pipeline.jobs[0]!.steps;
    assert.deepEqual(asRun(steps[0]!).secrets, ['gh-token', 'npm-token']);
    assert.deepEqual(asScript(steps[1]!).secrets, ['gh-token']);
    assert.equal('secrets' in steps[2]!, false, 'у шага без секретов поля нет: ключ шага прежних прогонов не меняется');
  });

  it('uses переносит список на раскрытый шаг', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(GH_TOKEN, '      - { id: a, uses: echo-input, secrets: [gh-token] }\n'),
      '.stepcast/steps/echo-input/step.yml':
        'version: 1\nkind: step\nname: echo-input\ndescription: Эхо.\nfile: ./main.cjs\n',
      '.stepcast/steps/echo-input/main.cjs': 'process.exit(0)\n',
    });
    const step = asScript(expand(project).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.uses?.name, 'echo-input');
    assert.deepEqual(step.secrets, ['gh-token']);
  });

  it('шаг плагинного вида принимает secrets, вид с ключом secrets среди занятых отклоняется при загрузке', async () => {
    const kernel = createBuiltinKernel();
    await applyDeclarativePlugin(
      kernel,
      { name: 'p', steps: [{ name: 'notify', title: 'Уведомление', fields: { type: 'string' }, execute: () => ({}) }] },
      '/модуль/p.js',
      DECLARATIVE_CONTRIBUTION_FIELDS,
    );
    const project = makeProject({
      'stepcast.yml': pipelineWith(GH_TOKEN, '      - { id: a, notify: hello, secrets: [gh-token] }\n'),
    });
    const step = expand(project, registryFromKernel(kernel)).pipeline.jobs[0]!.steps[0]!;
    assert.equal(step.kind, 'plugin');
    assert.deepEqual(step.secrets, ['gh-token']);

    await assert.rejects(
      () =>
        applyDeclarativePlugin(
          createBuiltinKernel(),
          {
            name: 'захватчик',
            steps: [
              {
                name: 'grab',
                title: 'Захват',
                fields: {},
                document: { test: () => false, keys: ['grab', 'secrets'], schema: {}, parse: () => ({}) },
                execute: () => ({}),
              },
            ],
          },
          '/модуль/g.js',
          DECLARATIVE_CONTRIBUTION_FIELDS,
        ),
      (error: unknown) => error instanceof StepcastError && /secrets/.test(error.message),
    );
  });

  it('агентский шаг с secrets отклоняется: агенту секрет не передаётся', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(GH_TOKEN, '      - { id: a, prompt: сделай, secrets: [gh-token] }\n'),
    });
    const error = thrown(() => expand(project));
    assert.match(error.message, /Агенту секрет не передаётся/);
    assert.equal(error.at, 'jobs.build.steps.0.secrets');
  });

  it('судья judge ключа secrets не принимает', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(
        GH_TOKEN,
        '      - id: a\n        run: [echo, ok]\n        expect: [{ judge: хорошо, secrets: [gh-token] }]\n',
      ),
    });
    assert.match(thrown(() => expand(project)).message, /Агенту секрет не передаётся/);
  });

  it('ссылка на необъявленный секрет отклоняется с именем и адресом шага', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(GH_TOKEN, '      - { id: deploy, run: [echo, ok], secrets: [missing] }\n'),
    });
    const error = thrown(() => expand(project));
    assert.match(error.message, /missing/);
    assert.match(error.message, /deploy/);
    assert.equal(error.at, 'jobs.build.steps.0.secrets');
  });

  it('ссылка при отсутствии верхнего secrets подсказывает, где секреты объявляются', () => {
    const project = makeProject({
      'stepcast.yml': 'kind: pipeline\njobs:\n  b:\n    steps:\n      - { id: a, run: [echo, ok], secrets: [x] }\n',
    });
    assert.match(thrown(() => expand(project)).hint ?? '', /верхним ключом secrets/);
  });

  it('недопустимое имя в списке шага отклоняется схемой', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(GH_TOKEN, '      - { id: a, run: [echo, ok], secrets: [GH_TOKEN] }\n'),
    });
    assert.throws(() => expand(project), StepcastError);
  });
});

describe('ключ шага: секреты', () => {
  function keyOf(project: Project, stepIndex = 0): string {
    const { pipeline } = expand(project);
    const job = pipeline.jobs[0]!;
    return computeStepKey({
      lockHash: jobLockHash(pipeline, job),
      jobId: job.id,
      step: job.steps[stepIndex]!,
      inputsFingerprint: undefined,
      backendCommand: undefined,
      upstream: [],
    });
  }

  const WITHOUT = pipelineWith(GH_TOKEN, '      - { id: a, run: [echo, ok] }\n');
  const WITH = pipelineWith(GH_TOKEN, '      - { id: a, run: [echo, ok], secrets: [gh-token] }\n');

  it('новый секрет у шага меняет ключ', () => {
    const without = keyOf(makeProject({ 'stepcast.yml': WITHOUT }));
    const withSecret = keyOf(makeProject({ 'stepcast.yml': WITH }));
    assert.notEqual(without, withSecret);
  });

  it('порядок имён в документе ключ не меняет', () => {
    const decls = `${GH_TOKEN}  b-token:\n    provider: env-file\n    file: .env.local\n`;
    // Один проект, два текста: путь пайплайна входит в замок, и в двух
    // проектах ключи разошлись бы по этой причине, а не по порядку имён.
    const project = makeProject({
      'stepcast.yml': pipelineWith(decls, '      - { id: a, run: [echo, ok], secrets: [gh-token, b-token] }\n'),
    });
    const one = keyOf(project);
    project.write('stepcast.yml', pipelineWith(decls, '      - { id: a, run: [echo, ok], secrets: [b-token, gh-token] }\n'));
    assert.equal(keyOf(project), one);
  });

  it('смена значения секрета в файле ключ не меняет: значение в ключ не входит', () => {
    const project = makeProject({ '.env.local': 'GH_TOKEN=первое-значение-1\n', 'stepcast.yml': WITH });
    const before = keyOf(project);
    project.write('.env.local', 'GH_TOKEN=второе-значение-2\n');
    assert.equal(keyOf(project), before);
  });

  it('шаг без секретов не несёт поля secrets, а значит хешируется как до этого изменения', () => {
    const plain = makeProject({ 'stepcast.yml': WITHOUT });
    const step = expand(plain).pipeline.jobs[0]!.steps[0]!;
    assert.equal('secrets' in step, false);
  });
});

describe('pipeline.lock.yml: секреты', () => {
  it('замок несёт имя, провайдер, параметры и env без значения; lockRead читает имена секретов шага', () => {
    const project = makeProject({
      '.env.local': 'GH_TOKEN=значение-из-файла-12345\n',
      'stepcast.yml': pipelineWith(
        GH_TOKEN,
        '      - { id: a, run: [echo, ok], secrets: [gh-token] }\n      - { id: b, run: [echo, ok] }\n',
      ),
    });
    const { pipeline } = expand(project);
    const lock = serializeLock(pipeline);
    assert.match(lock, /secrets:\n {2}gh-token:\n {4}provider: env-file\n {4}env: GH_TOKEN\n {4}file: \.env\.local/);
    assert.doesNotMatch(lock, /значение-из-файла/);

    const path = project.write('pipeline.lock.yml', lock);
    const read = readLock(path);
    assert.deepEqual(read.jobs[0]?.steps[0]?.secrets, ['gh-token']);
    assert.equal(read.jobs[0]?.steps[0]?.kind, 'run');
    assert.equal(read.jobs[0]?.steps[1]?.secrets, undefined);
  });

  it('замок без секретов не меняется: ключа secrets нет', () => {
    const project = makeProject({ 'stepcast.yml': 'kind: pipeline\njobs:\n  b:\n    steps:\n      - { id: a, run: [echo, ok] }\n' });
    assert.doesNotMatch(serializeLock(expand(project).pipeline), /secrets/);
  });

  it('lockRead не принимает ключ secrets шага плагинного вида за имя вида', async () => {
    const kernel = createBuiltinKernel();
    await applyDeclarativePlugin(
      kernel,
      { name: 'p', steps: [{ name: 'notify', title: 'Уведомление', fields: { type: 'string' }, execute: () => ({}) }] },
      '/модуль/p.js',
      DECLARATIVE_CONTRIBUTION_FIELDS,
    );
    const project = makeProject({
      'stepcast.yml': pipelineWith(GH_TOKEN, '      - { id: a, notify: hello, secrets: [gh-token] }\n'),
    });
    const { pipeline } = expand(project, registryFromKernel(kernel));
    const read = readLock(project.write('pipeline.lock.yml', serializeLock(pipeline)));
    assert.equal(read.jobs[0]?.steps[0]?.pluginKindName, 'notify');
  });
});
