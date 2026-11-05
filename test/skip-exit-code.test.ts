import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { evaluateLane } from '../src/parts/pipeline/domain/lanes/lanes.js';
import { readEvents, readStatus } from '../src/parts/pipeline/run/journal/reader.js';
import { runPipeline, type RunResult } from '../src/parts/pipeline/run/runner.js';
import { makeProject, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Код пропуска шага (`skip_exit_code`) на настоящем прогоне: шаг выходит
 * заявленным кодом, работа становится `skipped` с `skip: declared`, а граф,
 * итог прогона и годность дорожки читают это как «делать нечего», а не отказ.
 * Шаги командные — бэкенд не нужен.
 */

async function run(project: Project): Promise<RunResult> {
  const runsRoot = tempDir('runs-');
  return runPipeline({
    expanded: expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
      scriptRoots: { project: project.root, home: tempDir('script-home-'), builtin: tempDir('script-builtin-') },
    }),
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
}

function jobOf(result: RunResult, id: string) {
  return readStatus(result.journal.paths).jobs.find((job) => job.id === id);
}

/** Пайплайн из одной работы: первый шаг выходит кодом пропуска, остальные пишут след. */
const THREE_STEPS = `
version: 1
kind: pipeline
name: пропуск
skip_exit_code: 78
jobs:
  работа:
    steps:
      - id: первый
        run: [sh, -c, 'echo первый >> след.txt; exit 78']
      - id: второй
        run: [sh, -c, 'echo второй >> след.txt']
      - id: третий
        run: [sh, -c, 'echo третий >> след.txt']
`;

describe('skip-exit-code: работа', () => {
  it('первый шаг выходит кодом пропуска — остальные не идут, работа skipped/declared', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS });
    const result = await run(project);

    assert.equal(result.status, 'success');
    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(project.path('след.txt'), 'utf8'), 'первый\n');

    const job = jobOf(result, 'работа');
    assert.equal(job?.status, 'skipped');
    assert.equal(job?.skip, 'declared');
    assert.equal(job?.cause, undefined, 'пропуск не имеет причины остановки');
    assert.match(job?.reason ?? '', /шаг первый: шаг объявил пропуск: код 78/);
    assert.deepEqual(job?.steps.map((step) => [step.id, step.status]), [['первый', 'skipped']]);
    const attempt = job?.steps[0]?.attempts[0];
    assert.equal(attempt?.status, 'skipped');
    assert.equal(attempt?.exit_code, 78);
    assert.equal(job?.output, undefined);
  });

  it('run с output_schema, судьёй и пустым stdout: судья не зван, промаха output_schema нет', async () => {
    const project = makeProject({
      'out.json': '{"type":"object"}',
      'stepcast.yml': `
version: 1
kind: pipeline
name: пропуск-схема
jobs:
  работа:
    output: { from: шаг }
    steps:
      - id: шаг
        skip_exit_code: 78
        run: [sh, -c, 'exit 78']
        output_schema: ./out.json
        expect:
          - judge: "stdout осмыслен"
`,
    });
    const result = await run(project);

    const job = jobOf(result, 'работа');
    assert.equal(job?.status, 'skipped');
    assert.equal(job?.skip, 'declared');
    const step = job?.steps[0];
    assert.equal(step?.status, 'skipped');
    assert.equal(step?.attempts.length, 1);
    assert.equal(step?.attempts[0]?.usage, undefined, 'расхода нет');
    assert.equal(step?.cause, undefined);
    const events = readEvents(result.journal.paths);
    assert.equal(events.some((event) => event.kind === 'expect.failed'), false);
  });

  it('script без файла выхода — skipped, а не отказ контракта', async () => {
    const project = makeProject({
      'out.json': '{"type":"object"}',
      '.stepcast/scripts/probe.sh': '#!/bin/sh\nexit "$BURNEX_SKIP_EXIT_CODE"\n',
      'stepcast.yml': `
version: 1
kind: pipeline
name: пропуск-скрипт
skip_exit_code: 77
jobs:
  работа:
    steps:
      - id: проба
        script: probe.sh
        output_schema: ./out.json
`,
    });
    const result = await run(project);

    const job = jobOf(result, 'работа');
    assert.equal(job?.status, 'skipped');
    assert.equal(job?.skip, 'declared');
    assert.equal(job?.steps[0]?.attempts[0]?.exit_code, 77, 'код взят из BURNEX_SKIP_EXIT_CODE');
  });

  it('другой ненулевой код при объявленном коде пропуска — отказ как прежде', async () => {
    const project = makeProject({
      'stepcast.yml': THREE_STEPS.replace('exit 78', 'exit 3'),
    });
    const result = await run(project);
    assert.equal(result.status, 'failed');
    assert.equal(jobOf(result, 'работа')?.status, 'failed');
  });

  it('attempts.max: 3 — одна попытка', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: пропуск-попытки
jobs:
  работа:
    steps:
      - id: шаг
        skip_exit_code: 78
        attempts: { max: 3 }
        run: [sh, -c, 'echo заход >> след.txt; exit 78']
`,
    });
    const result = await run(project);
    assert.equal(jobOf(result, 'работа')?.steps[0]?.attempts.length, 1);
    assert.equal(readFileSync(project.path('след.txt'), 'utf8'), 'заход\n');
  });
});

describe('skip-exit-code: окружение', () => {
  it('BURNEX_SKIP_EXIT_CODE есть у шага и в окружении check, когда код унаследован', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: окружение
skip_exit_code: 78
jobs:
  работа:
    steps:
      - id: шаг
        run: [sh, -c, 'echo "шаг=$BURNEX_SKIP_EXIT_CODE" > env.txt']
        expect:
          - cmd: 'echo "проверка=$BURNEX_SKIP_EXIT_CODE" >> env.txt'
`,
    });
    const result = await run(project);
    assert.equal(result.status, 'success');
    assert.equal(readFileSync(project.path('env.txt'), 'utf8'), 'шаг=78\nпроверка=78\n');
  });

  it('без объявленного кода переменной нет', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: окружение-пусто
jobs:
  работа:
    steps:
      - id: шаг
        run: [sh, -c, 'if [ -z "$BURNEX_SKIP_EXIT_CODE" ]; then echo нет > env.txt; else echo есть > env.txt; fi']
`,
    });
    await run(project);
    assert.equal(readFileSync(project.path('env.txt'), 'utf8'), 'нет\n');
  });
});

describe('skip-exit-code: граф и прогон', () => {
  const GRAPH = (failFast: boolean): string => `
version: 1
kind: pipeline
name: граф
fail_fast: ${failFast}
skip_exit_code: 78
jobs:
  пустая:
    steps:
      - id: шаг
        run: [sh, -c, 'exit 78']
  сосед:
    steps:
      - id: шаг
        run: [sh, -c, 'echo сосед > сосед.txt']
  единственная:
    needs: [пустая]
    steps:
      - id: шаг
        run: [sh, -c, 'echo единственная > единственная.txt']
  обе:
    needs: [пустая, сосед]
    steps:
      - id: шаг
        run: [sh, -c, 'echo обе > обе.txt']
`;

  for (const failFast of [true, false]) {
    it(`fail_fast: ${failFast} — пропуск не отказ: сосед идёт, прогон success, код 0`, async () => {
      const project = makeProject({ 'stepcast.yml': GRAPH(failFast) });
      const result = await run(project);

      assert.equal(result.status, 'success');
      assert.equal(result.exitCode, 0);
      assert.equal(jobOf(result, 'пустая')?.skip, 'declared');
      assert.equal(jobOf(result, 'сосед')?.status, 'success');
      assert.equal(existsSync(project.path('сосед.txt')), true);
    });
  }

  it('зависимая с единственной пропущенной зависимостью пропускается условием', async () => {
    const project = makeProject({ 'stepcast.yml': GRAPH(true) });
    const result = await run(project);
    const job = jobOf(result, 'единственная');
    assert.equal(job?.status, 'skipped');
    assert.equal(job?.skip, 'condition');
    assert.equal(existsSync(project.path('единственная.txt')), false);
  });

  it('зависимая от пропущенной и успешной работ on: success исполняется', async () => {
    const project = makeProject({ 'stepcast.yml': GRAPH(true) });
    const result = await run(project);
    assert.equal(jobOf(result, 'обе')?.status, 'success');
    assert.equal(existsSync(project.path('обе.txt')), true);
  });
});

describe('skip-exit-code: годность дорожки', () => {
  it('смесь success и declared на одной дорожке — годная дорожка', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: дорожка
skip_exit_code: 78
jobs:
  первая:
    lane: a
    steps:
      - id: шаг
        run: [sh, -c, 'echo ok']
  вторая:
    lane: a
    needs: [первая]
    steps:
      - id: шаг
        run: [sh, -c, 'exit 78']
`,
    });
    const result = await run(project);
    const jobs = readStatus(result.journal.paths).jobs;
    assert.equal(jobs.find((job) => job.id === 'вторая')?.skip, 'declared');
    assert.deepEqual(evaluateLane(jobs, 'a'), { kind: 'ready' });
  });
});

describe('skip-exit-code: цикл until', () => {
  it('пропуск на второй итерации кончает цикл: третьей нет, check не зовётся', async () => {
    const project = makeProject({
      'счётчик.txt': '0\n',
      'stepcast.yml': `
version: 1
kind: pipeline
name: цикл-пропуск
skip_exit_code: 78
jobs:
  работа:
    until:
      max_iterations: 5
      check:
        - cmd: 'echo проверка >> проверки.txt; false'
    steps:
      - id: шаг
        run: [sh, -c, 'n=$(( $(cat счётчик.txt) + 1 )); echo $n > счётчик.txt; test $n -lt 2 || exit 78']
`,
    });
    const result = await run(project);

    const job = jobOf(result, 'работа');
    assert.equal(job?.status, 'skipped');
    assert.equal(job?.skip, 'declared');
    assert.equal(readFileSync(project.path('счётчик.txt'), 'utf8').trim(), '2');
    assert.equal(
      readFileSync(project.path('проверки.txt'), 'utf8'),
      'проверка\n',
      'check считался только после первой итерации',
    );
    const finished = readEvents(result.journal.paths).filter((event) => event.kind === 'iteration.finished');
    assert.deepEqual(
      finished.map((event) => event.passed),
      [false, false],
    );
  });
});
