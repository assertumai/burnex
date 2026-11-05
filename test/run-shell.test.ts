import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import type { Attempts, RunStep } from '../src/parts/pipeline/document/model.js';
import { lintPipeline } from '../src/parts/pipeline/domain/lint.js';
import { executeRunStep } from '../src/parts/pipeline/run/exec/runStep.js';
import { makeProject, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Ключ `shell`: оболочка строкового `run`. Разбор сводит три уровня в поле шага,
 * исполнитель собирает `[...shell, command]`, линт отклоняет пустой список.
 */

const expand = (project: Project) =>
  expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config });

type RunLike = { readonly kind: string; readonly shell?: readonly string[] };
const shells = (project: Project, jobIndex = 0): Array<readonly string[] | undefined> =>
  expand(project).pipeline.jobs[jobIndex]!.steps.map((step) => (step as RunLike).shell);

describe('pipeline-definition: shell', () => {
  it('без объявления поля нет нигде', () => {
    const project = makeProject({
      'burnex.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - { id: a, run: echo ok }
`,
    });
    assert.equal('shell' in expand(project).pipeline.jobs[0]!.steps[0]!, false);
  });

  it('пайплайн, тело работы, место подключения и шаг — каждый уровень по отдельности', () => {
    const pipelineLevel = makeProject({
      'burnex.yml': `
kind: pipeline
shell: [bash, -lc]
jobs:
  build:
    steps:
      - { id: a, run: echo ok }
`,
    });
    assert.deepEqual(shells(pipelineLevel), [['bash', '-lc']]);

    const bodyLevel = makeProject({
      'burnex.yml': `
kind: pipeline
jobs:
  build:
    shell: [zsh, -c]
    steps:
      - { id: a, run: echo ok }
`,
    });
    assert.deepEqual(shells(bodyLevel), [['zsh', '-c']]);

    const siteLevel = makeProject({
      'burnex.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    shell: [dash, -c]
`,
      'jobs/build.yml': `
kind: job
steps:
  - { id: a, run: echo ok }
`,
    });
    assert.deepEqual(shells(siteLevel), [['dash', '-c']]);

    const stepLevel = makeProject({
      'burnex.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - { id: a, run: echo ok, shell: [pwsh, -Command] }
      - { id: b, run: echo ok }
`,
    });
    assert.deepEqual(shells(stepLevel), [['pwsh', '-Command'], undefined]);
  });

  it('ближайший уровень перекрывает дальние: шаг, место подключения, тело работы, пайплайн', () => {
    const project = makeProject({
      'burnex.yml': `
kind: pipeline
shell: [p, -c]
jobs:
  site:
    uses: ./jobs/body.yml
    shell: [site, -c]
  body:
    uses: ./jobs/body.yml
  inline:
    shell: [job, -c]
    steps:
      - { id: a, run: echo ok }
      - { id: b, run: echo ok, shell: [step, -c] }
`,
      'jobs/body.yml': `
kind: job
shell: [body, -c]
steps:
  - { id: a, run: echo ok }
`,
    });
    const jobs = expand(project).pipeline.jobs;
    const of = (id: string) => jobs.find((job) => job.id === id)!.steps.map((step) => (step as RunLike).shell);
    assert.deepEqual(of('site'), [['site', '-c']]);
    assert.deepEqual(of('body'), [['body', '-c']]);
    assert.deepEqual(of('inline'), [['job', '-c'], ['step', '-c']]);
  });

  it('на agent и script ключ — ошибка, объявление выше на них не действует', () => {
    for (const step of [
      "{ id: a, script: probe.sh, shell: [bash, -c] }",
      "{ id: a, agent: claude, prompt: hi, shell: [bash, -c] }",
    ]) {
      const project = makeProject({
        'burnex.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - ${step}
`,
        '.burnex/scripts/probe.sh': '#!/bin/sh\nexit 0\n',
      });
      assert.throws(() => expand(project), /shell/);
    }

    const project = makeProject({
      'burnex.yml': `
kind: pipeline
shell: [bash, -lc]
jobs:
  build:
    steps:
      - { id: a, agent: claude, prompt: hi }
      - { id: b, run: echo ok }
`,
    });
    const steps = expand(project).pipeline.jobs[0]!.steps;
    assert.equal('shell' in steps[0]!, false);
    assert.deepEqual((steps[1] as RunLike).shell, ['bash', '-lc']);
  });
});

describe('step-execution: shell', () => {
  const ONE: Attempts = { max: 1, escalation: [] };
  const makeStep = (overrides: Partial<RunStep>): RunStep =>
    ({
      kind: 'run',
      id: 'c',
      index: 1,
      env: {},
      context: [],
      contextInherit: true,
      contextExclude: [],
      timeoutMs: 5_000,
      expect: [],
      attempts: ONE,
      command: 'true',
      ...overrides,
    }) as RunStep;
  const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? '' });

  const runIn = async (step: RunStep): Promise<string> => {
    const dir = tempDir('shell-');
    await executeRunStep({ step, cwd: dir, stepDir: dir, env });
    return readFileSync(join(dir, 'stdout.log'), 'utf8');
  };

  it('строка идёт как [...shell, command]: команда — последний аргумент', async () => {
    const out = await runIn(
      makeStep({ shell: ['sh', '-c', 'printf "%s|%s" "$0" "$1"', 'name'], command: 'второй' }),
    );
    // `$0` — следующий за -c-скриптом аргумент, `$1` — сама строка команды.
    assert.equal(out, 'name|второй');
  });

  it('оболочка исполняет саму строку команды', async () => {
    const out = await runIn(makeStep({ shell: ['bash', '-c'], command: 'echo $((1+2))' }));
    assert.equal(out.trim(), '3');
  });

  it('без shell строка идёт через sh -c, как прежде', async () => {
    const out = await runIn(makeStep({ command: 'echo $((2+2))' }));
    assert.equal(out.trim(), '4');
  });

  it('списочная форма shell не затрагивает', async () => {
    const out = await runIn(makeStep({ shell: ['false'], command: ['echo', 'hi'] }));
    assert.equal(out.trim(), 'hi');
  });
});

describe('pipeline-definition: shell и lint', () => {
  const lint = (shell: string, stepShell = '') => {
    const project = makeProject({
      'burnex.yml': `kind: pipeline
${shell}jobs:
  build:
    steps:
      - { id: a, run: echo ok${stepShell} }
`,
    });
    return lintPipeline(expand(project), { config: project.config }).filter((item) => item.severity === 'error');
  };

  it('пустой список на шаге — ошибка с путём ключа', () => {
    const found = lint('', ', shell: []');
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.match(found[0]!.message, /build\/a/);
    assert.equal(found[0]!.at, 'jobs.build.steps.0.shell');
  });

  it('пустой список с пайплайна отклоняется на шаге, которому достался', () => {
    const found = lint('shell: []\n');
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.match(found[0]!.message, /shell/);
  });

  it('непустой список — тишина', () => {
    assert.deepEqual(lint('shell: [bash, -lc]\n'), []);
  });
});
