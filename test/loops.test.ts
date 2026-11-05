import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeBackend, initLine, resultLine } from '../src/parts/pipeline/backend/fake.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { findStepDir, readEvents, readStatus } from '../src/parts/pipeline/run/journal/reader.js';
import { jobDir } from '../src/parts/pipeline/run/journal/paths.js';
import { runPipeline, type RunResult } from '../src/parts/pipeline/run/runner.js';
import { runStatusCommand } from '../src/parts/pipeline/commands/status.js';
import { runUsageCommand } from '../src/parts/pipeline/commands/usage.js';
import { gitCommit, gitInit, makeProject, withHome, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Интеграция цикла по группе работ: настоящие процессы шагов, настоящий
 * журнал. Планировщик без процессов проверен в `scheduler.test.ts`.
 */

async function run(project: Project, adapter?: ReturnType<typeof createFakeBackend>['adapter']): Promise<RunResult> {
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
    config: { ...project.config, runs: { ...project.config.runs, root: tempDir('runs-') } },
    projectRoot: project.root,
    cwd: project.root,
    ...(adapter === undefined ? {} : { adapterFor: () => adapter }),
  });
}

const read = (project: Project, file: string): string => readFileSync(project.path(file), 'utf8');

/** Проверка и починка: `check` падает, пока счётчик меньше порога, `fix` его увеличивает. */
function checkFix(options: { readonly threshold: number; readonly max: number; readonly extra?: string; readonly head?: string }): string {
  return `
kind: pipeline
${options.head ?? ''}
loops:
  fix-loop:
    jobs: [check, fix]
    max_iterations: ${options.max}
    cost: 5
jobs:
  check:
    steps:
      - id: verify
        run: [sh, -c, 'echo "$BURNEX_LOOP:$BURNEX_LOOP_ITERATION:$BURNEX_LOOP_ITERATION_MAX" >> trace.txt; test "$(cat counter.txt)" -ge ${options.threshold}']
        expect: [{ exit_code: 0 }]
  fix:
    needs: [check]
    on: failure
    steps:
      - id: bump
        run: [sh, -c, 'echo $(( $(cat counter.txt) + 1 )) > counter.txt']
        expect: [{ exit_code: 0 }]
${options.extra ?? ''}`;
}

describe('job-group-loops: проходы в рабочем дереве cwd', () => {
  it('повторяет проход, пока проверка не пройдёт; дерево переходит между проходами', async () => {
    const project = makeProject({
      'counter.txt': '0\n',
      'stepcast.yml': checkFix({
        threshold: 2,
        max: 4,
        extra: `  after:
    needs: [fix]
    on: always
    steps:
      - id: done
        run: [sh, -c, 'echo after >> trace.txt']
        expect: [{ exit_code: 0 }]
`,
      }),
    });
    const result = await run(project);

    assert.equal(result.status, 'success');
    assert.equal(read(project, 'counter.txt').trim(), '2');
    // Переменные цикла видны шагу в каждом проходе; внешняя работа исполнена
    // один раз и после последнего прохода.
    assert.deepEqual(read(project, 'trace.txt').trim().split('\n'), [
      'fix-loop:1:4',
      'fix-loop:2:4',
      'fix-loop:3:4',
      'after',
    ]);

    const status = readStatus(result.journal.paths);
    assert.deepEqual(status.loops, [
      {
        id: 'fix-loop',
        jobs: ['check', 'fix'],
        iterations: 3,
        max_iterations: 4,
        verdict: 'done',
        status: 'success',
        reason: 'условие продолжения ложно',
      },
    ]);
    assert.equal(status.jobs.find((job) => job.id === 'check')?.status, 'success');
    assert.equal(status.jobs.find((job) => job.id === 'fix')?.status, 'skipped');

    // Раскладка: уровень прохода у участников, и только у них.
    const paths = result.journal.paths;
    for (const pass of [1, 2, 3]) {
      assert.ok(existsSync(join(jobDir(paths, 'check'), 'steps', `pass-${pass}`, '01-verify', 'step.json')), `pass-${pass}`);
    }
    assert.ok(findStepDir(paths, 'check', 'verify')?.includes(join('steps', 'pass-3')));
    assert.ok(findStepDir(paths, 'fix', 'bump')?.includes(join('steps', 'pass-2')), 'в последнем проходе fix пропущен');
    assert.ok(findStepDir(paths, 'after', 'done')?.endsWith(join('after', 'steps', '01-done')));

    const kinds = readEvents(paths)
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith('loop.'));
    assert.deepEqual(kinds, [
      'loop.started',
      'loop.pass.started',
      'loop.pass.finished',
      'loop.pass.started',
      'loop.pass.finished',
      'loop.pass.started',
      'loop.pass.finished',
      'loop.finished',
    ]);
  });

  it('ключ шага не меняется от прохода: номер прохода в него не входит', async () => {
    // Дерево между проходами не меняется, иначе ключ различил бы проходы по
    // отпечатку входов, как различает итерации until.
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
loops:
  l:
    jobs: [work]
    while: "loop.iteration < 2"
    max_iterations: 3
    cost: 1
jobs:
  work:
    steps:
      - id: s
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await run(project);

    const keyOf = (pass: number): unknown =>
      JSON.parse(
        readFileSync(join(jobDir(result.journal.paths, 'work'), 'steps', `pass-${pass}`, '01-s', 'step.json'), 'utf8'),
      ).key;
    assert.ok(keyOf(1) !== undefined);
    assert.equal(keyOf(1), keyOf(2));
  });

  it('исчерпание предела: loop_exhausted, итог failed, разбор по on: failure исполняется', async () => {
    const project = makeProject({
      'counter.txt': '0\n',
      'stepcast.yml': checkFix({
        threshold: 100,
        max: 2,
        extra: `  triage:
    needs: [fix]
    on: failure
    steps:
      - id: note
        run: [sh, -c, 'echo triage > triage.txt']
        expect: [{ exit_code: 0 }]
`,
      }),
    });
    const result = await run(project);

    assert.equal(result.status, 'failed');
    const [loop] = readStatus(result.journal.paths).loops ?? [];
    assert.equal(loop?.verdict, 'exhausted');
    assert.equal(loop?.cause, 'loop_exhausted');
    assert.equal(loop?.iterations, 2);
    assert.equal(read(project, 'counter.txt').trim(), '2');
    assert.equal(read(project, 'triage.txt').trim(), 'triage');
  });

  it('исчерпание при одних успехах последнего прохода: подсказка resume ведёт на точку входа', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
loops:
  l:
    jobs: [check, fix]
    while: "loop.iteration < 10"
    max_iterations: 2
    cost: 1
jobs:
  check:
    steps:
      - { id: s, run: [echo, ok], expect: [{ exit_code: 0 }] }
  fix:
    needs: [check]
    steps:
      - { id: s, run: [echo, ok], expect: [{ exit_code: 0 }] }
`,
    });
    const result = await run(project);

    assert.equal(result.status, 'failed');
    const status = readStatus(result.journal.paths);
    assert.equal(status.loops?.[0]?.cause, 'loop_exhausted');
    assert.ok(status.jobs.every((job) => job.status === 'success'));
    assert.equal(status.resume?.blocked_by, 'check');
    assert.match(status.resume?.command ?? '', / --from check$/);
  });

  it('данные первого прохода не видны во втором', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
loops:
  l:
    jobs: [work]
    while: "jobs.work.data.flag == 'x'"
    max_iterations: 5
    cost: 1
jobs:
  work:
    data: [flag]
    steps:
      - id: publish
        run: [sh, -c, 'if [ ! -f seen ]; then touch seen; printf %s "{\\"flag\\": \\"x\\"}" > "$BURNEX_JOB_DIR/data.json"; fi']
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await run(project);

    // Протекли бы данные — условие осталось бы истинным до предела, и цикл
    // кончился бы исчерпанием.
    assert.equal(result.status, 'success');
    const [loop] = readStatus(result.journal.paths).loops ?? [];
    assert.equal(loop?.iterations, 2);
    assert.equal(loop?.verdict, 'done');
    assert.equal(readStatus(result.journal.paths).jobs.find((job) => job.id === 'work')?.data, undefined);
  });

  it('переменные цикла есть только у участников', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
loops:
  l: { jobs: [inside], max_iterations: 2, cost: 1 }
jobs:
  inside:
    steps:
      - id: s
        run: [sh, -c, 'echo "in=$BURNEX_LOOP" > inside.txt']
        expect: [{ exit_code: 0 }]
  outside:
    steps:
      - id: s
        run: [sh, -c, 'env | grep -c "^BURNEX_LOOP" > outside.txt; true']
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await run(project);

    assert.equal(result.status, 'success');
    assert.equal(read(project, 'inside.txt').trim(), 'in=l');
    assert.equal(read(project, 'outside.txt').trim(), '0');
  });
});

describe('job-group-loops: сессии и бюджет', () => {
  const agentLoop = `
kind: pipeline
loops:
  l:
    jobs: [check, fix]
    max_iterations: 3
    cost: 5
jobs:
  check:
    steps:
      - id: verify
        run: [sh, -c, 'test "$(cat counter.txt)" -ge 2']
        expect: [{ exit_code: 0 }]
  fix:
    needs: [check]
    on: failure
    steps:
      - id: bump
        run: [sh, -c, 'echo $(( $(cat counter.txt) + 1 )) > counter.txt']
        expect: [{ exit_code: 0 }]
      - id: ask
        agent: claude
        prompt: почини
`;

  it('новый проход начинает сессию агента заново', async () => {
    const project = makeProject({ 'counter.txt': '0\n', 'stepcast.yml': agentLoop });
    const backend = createFakeBackend({ lines: () => [initLine(), resultLine({ text: 'ок' })] });
    const result = await run(project, backend.adapter);

    assert.equal(result.status, 'success');
    assert.equal(backend.invocations.length, 2);
    const [first, second] = backend.invocations;
    assert.equal(first?.resumeSession, false);
    assert.equal(second?.resumeSession, false);
    assert.notEqual(first?.sessionId, second?.sessionId);
  });

  it('cost цикла останавливает шаг посреди прохода', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
loops:
  l:
    jobs: [work]
    while: "loop.iteration < 3"
    max_iterations: 3
    cost: 1
jobs:
  work:
    steps:
      - id: a
        agent: claude
        prompt: первый
      - id: b
        agent: claude
        prompt: второй
`,
    });
    const backend = createFakeBackend({
      lines: () => [initLine(), resultLine({ text: 'ок', tokensIn: 10, tokensOut: 0, costUsd: 0.4 })],
    });
    const result = await run(project, backend.adapter);

    // Проход 1 тратит 0.8 из 1; во втором шаг a стартует (0.8 не выше
    // потолка) и переводит расход за него, шаг b уже не запускается.
    assert.equal(backend.invocations.length, 3);
    assert.equal(result.status, 'budget_exceeded');
    const [loop] = readStatus(result.journal.paths).loops ?? [];
    assert.equal(loop?.verdict, 'exhausted');
    assert.equal(loop?.status, 'budget_exceeded');
    assert.equal(loop?.iterations, 2);
  });
});

describe('job-group-loops: изолированные деревья', () => {
  function repoProject(pipeline: string): Project {
    const project = makeProject({ 'counter.txt': '0\n', '.gitignore': 'trace.txt\n', 'stepcast.yml': pipeline });
    gitInit(project.root);
    gitCommit(project.root, 'начало');
    return project;
  }

  it('worktree: проверка второго прохода видит правки починки первого', async () => {
    const project = repoProject(checkFix({ threshold: 2, max: 4, head: 'workspace: { mode: worktree }' }));
    const result = await run(project);

    assert.equal(result.status, 'success');
    // Правки сделаны в рабочем дереве прогона, а не в каталоге запуска.
    assert.equal(read(project, 'counter.txt').trim(), '0');
    const record = readStatus(result.journal.paths).jobs.find((job) => job.id === 'check');
    assert.ok(record?.workspace !== undefined);
    assert.equal(readFileSync(join(record.workspace.path, 'counter.txt'), 'utf8').trim(), '2');
  });

  it('worktree: точка входа продолжает дерево выхода, когда у починки своё', async () => {
    // `fix` в режиме copy — другой режим, поэтому цепочки нет и у неё свой каталог,
    // засеянный деревом проверки.
    const pipeline = checkFix({ threshold: 2, max: 4, head: 'workspace: { mode: worktree }' }).replace(
      '  fix:\n    needs: [check]\n    on: failure\n',
      '  fix:\n    needs: [check]\n    on: failure\n    workspace: { mode: copy }\n',
    );
    const project = repoProject(pipeline);
    const result = await run(project);

    assert.equal(result.status, 'success');
    const records = readStatus(result.journal.paths).jobs;
    const check = records.find((job) => job.id === 'check');
    const fix = records.find((job) => job.id === 'fix');
    assert.ok(check?.workspace !== undefined && fix?.workspace !== undefined);
    // Проверка последнего прохода идёт в каталоге починки: счётчик там и вырос.
    assert.equal(check.workspace.path, fix.workspace.path);
    assert.equal(readFileSync(join(check.workspace.path, 'counter.txt'), 'utf8').trim(), '2');
  });

  it('worktree: засеянный участник второго прохода получает дерево своего источника, а не своё прошлое', async () => {
    // У `a` два последователя, цепочки нет: `b` и `c` засеваются деревом `a`.
    // Выход прохода — `c`, и во втором проходе `a` продолжает его каталог.
    const append = (name: string): string =>
      `[sh, -c, 'echo ${name}$BURNEX_LOOP_ITERATION >> log.txt']`;
    const project = repoProject(`
kind: pipeline
workspace: { mode: worktree }
loops:
  l:
    jobs: [a, b, c]
    while: "loop.iteration < 2"
    max_iterations: 2
    cost: 1
jobs:
  a:
    steps:
      - { id: s, run: ${append('a')}, expect: [{ exit_code: 0 }] }
  b:
    needs: [a]
    steps:
      - { id: s, run: [sh, -c, 'cp log.txt b-saw.txt'], expect: [{ exit_code: 0 }] }
  c:
    needs: [a]
    steps:
      - { id: s, run: ${append('c')}, expect: [{ exit_code: 0 }] }
`);
    const result = await run(project);

    assert.equal(result.status, 'success');
    const b = readStatus(result.journal.paths).jobs.find((job) => job.id === 'b');
    assert.ok(b?.workspace !== undefined);
    assert.deepEqual(readFileSync(join(b.workspace.path, 'b-saw.txt'), 'utf8').trim().split('\n'), ['a1', 'c1', 'a2']);
  });
});

describe('job-group-loops: читатели журнала', () => {
  it('burnex status и usage читают прогон с проходами', async () => {
    const project = makeProject({ 'counter.txt': '0\n', 'stepcast.yml': checkFix({ threshold: 1, max: 3 }) });
    // Корень прогонов остаётся умолчанием конфигурации проекта: команды ищут прогон по нему.
    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: project.config,
      projectRoot: project.root,
      cwd: project.root,
    });
    assert.equal(result.status, 'success');
    const runId = result.journal.paths.runId;

    const status: string[] = [];
    const statusExit = withHome(project.home, () =>
      runStatusCommand({ command: 'status', positional: [], flags: { run: runId } }, (line) => status.push(line), project.root),
    );
    assert.equal(await statusExit, 0);
    assert.match(status.join('\n'), /цикл fix-loop: done, проход 2 из 3, .*условие продолжения ложно/);
    assert.ok(status.some((line) => /^\s+check\s/.test(line)), 'работа-участник в таблице работ');

    const usage: string[] = [];
    const usageExit = withHome(project.home, () =>
      runUsageCommand({ command: 'usage', positional: [runId], flags: {} }, (line) => usage.push(line), project.root),
    );
    assert.equal(await usageExit, 0);
    assert.match(usage.join('\n'), /check/);
  });
});
