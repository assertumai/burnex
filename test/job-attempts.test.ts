import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  authRefusalLine,
  createFakeBackend,
  initLine,
  rateLimitRefusalLine,
  resultLine,
  type FakeBackend,
} from '../src/parts/pipeline/backend/fake.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { HaltCause, RETRYABLE_JOB_CAUSES } from '../src/parts/pipeline/run/halt.js';
import { findStepDir, readEvents, readStatus } from '../src/parts/pipeline/run/journal/reader.js';
import { jobDir } from '../src/parts/pipeline/run/journal/paths.js';
import { runPipeline, type RunResult } from '../src/parts/pipeline/run/runner.js';
import { isRetryableJobOutcome, type JobOutcome } from '../src/parts/pipeline/run/scheduler.js';
import { gitCommit, gitInit, makeProject, testBaseEnv, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/** Проект в репозитории git: откат дерева требует якоря с содержимым. */
function repo(files: Record<string, string>): Project {
  const project = makeProject(files);
  gitInit(project.root);
  gitCommit(project.root, 'init');
  return project;
}

async function run(
  project: Project,
  backends: Readonly<Record<string, FakeBackend>> = {},
  signal?: AbortSignal,
): Promise<RunResult> {
  const runsRoot = tempDir('runs-');
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
    baseEnv: testBaseEnv(),
    ...(signal === undefined ? {} : { signal }),
    adapterFor: (name) => {
      const backend = backends[name];
      assert.ok(backend !== undefined, `нет поддельного бэкенда для «${name}»`);
      return backend.adapter;
    },
  });
}

function jobOf(result: RunResult, id: string) {
  const found = readStatus(result.journal.paths).jobs.find((job) => job.id === id);
  assert.ok(found !== undefined, `работа ${id} не найдена`);
  return found;
}

function attemptEvents(result: RunResult, job: string): string[] {
  return readEvents(result.journal.paths).flatMap((event) =>
    (event.kind === 'job.attempt.started' || event.kind === 'job.attempt.finished') && event.job === job
      ? [`${event.kind}:${event.attempt}${'status' in event ? `:${event.status}` : ''}`]
      : [],
  );
}

/** Журнал вне дерева: переживает откат и копит строки по всем попыткам. */
const LOG = '"$BURNEX_RUN_DIR/attempts.log"';

const FLAKY = `
version: 1
kind: pipeline
name: повтор
jobs:
  work:
    attempts: { max: 2 }
    data: [summary]
    steps:
      - id: write
        run: [sh, -c, 'echo "$BURNEX_JOB_ATTEMPT/$BURNEX_JOB_ATTEMPT_MAX" >> ${LOG}; test ! -e dirty.txt && echo x > dirty.txt']
        expect: [{ exit_code: 0 }]
      - id: check
        run: [sh, -c, 'if [ "$BURNEX_JOB_ATTEMPT" = 1 ]; then printf %s "{\\"summary\\": \\"draft\\"}" > "$BURNEX_JOB_DIR/data.json"; exit 1; fi']
        expect: [{ exit_code: 0 }]
  notify:
    needs: [work]
    on: failure
    steps:
      - id: say
        run: [sh, -c, 'echo notified > notified.txt']
        expect: [{ exit_code: 0 }]
`;

describe('job-attempts: успех со второй попытки', () => {
  it('откатывает дерево, сбрасывает данные и показывает зависимым один исход', async () => {
    const project = repo({ 'stepcast.yml': FLAKY });
    const result = await run(project);

    assert.equal(result.status, 'success');
    const work = jobOf(result, 'work');
    assert.equal(work.status, 'success');
    assert.equal(work.attempts, 2);
    assert.equal(work.steps.length, 2);
    // Данные первой попытки не дошли до потребителей.
    assert.equal(work.data?.summary, undefined);

    // Первый шаг второй попытки увидел дерево без правок первой: иначе
    // `test ! -e dirty.txt` отказал бы, и успеха не было.
    assert.equal(readFileSync(join(result.journal.paths.dir, 'attempts.log'), 'utf8'), '1/2\n2/2\n');

    // Работа с `on: failure` видит финальный исход, а не промежуточный отказ.
    assert.equal(jobOf(result, 'notify').status, 'skipped');
    assert.equal(existsSync(project.path('notified.txt')), false);
  });

  it('раскладывает журнал по попыткам и пишет пары событий', async () => {
    const result = await run(repo({ 'stepcast.yml': FLAKY }));

    const steps = join(jobDir(result.journal.paths, 'work'), 'steps');
    assert.ok(existsSync(join(steps, 'attempt-1', '01-write')));
    assert.ok(existsSync(join(steps, 'attempt-2', '01-write')));
    assert.ok(findStepDir(result.journal.paths, 'work', 'write')?.endsWith(join('attempt-2', '01-write')));

    assert.deepEqual(attemptEvents(result, 'work'), [
      'job.attempt.started:1',
      'job.attempt.finished:1:failed',
      'job.attempt.started:2',
      'job.attempt.finished:2:success',
    ]);
    // Зависимые и `fail_fast` видят одно завершение работы.
    const finished = readEvents(result.journal.paths).filter(
      (event) => event.kind === 'job.finished' && event.job === 'work',
    );
    assert.equal(finished.length, 1);
  });

  it('между попытками состояние прогона не показывает шаги упавшей попытки', async () => {
    // Первый шаг второй попытки снимает копию состояния прогона: в ней работа
    // ещё идёт, а упавший `check` первой попытки уже не числится.
    const pipeline = FLAKY.replace(
      `>> ${LOG};`,
      `>> ${LOG}; [ "$BURNEX_JOB_ATTEMPT" = 2 ] && cp "$BURNEX_RUN_DIR/status.json" "$BURNEX_RUN_DIR/mid.json";`,
    );
    assert.notEqual(pipeline, FLAKY);
    const result = await run(repo({ 'stepcast.yml': pipeline }));
    assert.equal(result.status, 'success');

    const mid = JSON.parse(readFileSync(join(result.journal.paths.dir, 'mid.json'), 'utf8')) as {
      jobs: { id: string; status: string; steps: { id: string; status: string }[] }[];
    };
    const work = mid.jobs.find((job) => job.id === 'work');
    assert.equal(work?.status, 'running');
    assert.deepEqual(
      work?.steps.filter((step) => step.status === 'failed' || step.id === 'check'),
      [],
    );
  });

  it('ключ шага не зависит от номера попытки работы', async () => {
    const result = await run(repo({ 'stepcast.yml': FLAKY }));
    const keyIn = (attempt: number): unknown =>
      JSON.parse(
        readFileSync(
          join(jobDir(result.journal.paths, 'work'), 'steps', `attempt-${attempt}`, '01-write', 'step.json'),
          'utf8',
        ),
      ).key;

    assert.equal(keyIn(1), keyIn(2));
  });

  it('fail_fast дожидается последней попытки', async () => {
    const project = repo({
      'stepcast.yml': `
version: 1
kind: pipeline
name: быстрый-отказ
fail_fast: true
jobs:
  a:
    attempts: { max: 2 }
    steps:
      - id: flaky
        run: [sh, -c, 'test "$BURNEX_JOB_ATTEMPT" = 2']
        expect: [{ exit_code: 0 }]
  b:
    steps:
      - id: later
        run: [sh, -c, 'echo ok > b.txt']
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await run(project);

    assert.equal(result.status, 'success');
    assert.equal(existsSync(project.path('b.txt')), true);
  });
});

describe('job-attempts: исчерпание и неповторяемые исходы', () => {
  it('исчерпав попытки, работа отдаёт причину последней', async () => {
    const result = await run(
      repo({
        'stepcast.yml': `
version: 1
kind: pipeline
name: исчерпание
jobs:
  work:
    attempts: { max: 2 }
    steps:
      - id: bad
        run: [sh, -c, 'echo "$BURNEX_JOB_ATTEMPT" >> ${LOG}; exit 1']
        expect: [{ exit_code: 0 }]
`,
      }),
    );

    const work = jobOf(result, 'work');
    assert.equal(work.status, 'failed');
    assert.equal(work.cause, HaltCause.expectFailed);
    assert.equal(work.attempts, 2);
    assert.equal(readFileSync(join(result.journal.paths.dir, 'attempts.log'), 'utf8'), '1\n2\n');
    assert.deepEqual(attemptEvents(result, 'work').filter((item) => item.includes('finished')), [
      'job.attempt.finished:1:failed',
      'job.attempt.finished:2:failed',
    ]);
  });

  it('пропуск по skip_exit_code не повторяется', async () => {
    const result = await run(
      repo({
        'stepcast.yml': `
version: 1
kind: pipeline
name: пропуск
jobs:
  work:
    attempts: { max: 3 }
    steps:
      - id: nothing
        skip_exit_code: 78
        run: [sh, -c, 'echo "$BURNEX_JOB_ATTEMPT" >> ${LOG}; exit 78']
`,
      }),
    );

    assert.equal(jobOf(result, 'work').status, 'skipped');
    assert.equal(readFileSync(join(result.journal.paths.dir, 'attempts.log'), 'utf8'), '1\n');
  });

  it('until_not_met повторяется с первой итерации', async () => {
    const result = await run(
      repo({
        'stepcast.yml': `
version: 1
kind: pipeline
name: цикл-и-попытки
jobs:
  work:
    attempts: { max: 2 }
    until:
      max_iterations: 2
      check:
        - cmd: "false"
    steps:
      - id: step
        run: [sh, -c, 'echo "$BURNEX_JOB_ATTEMPT" >> ${LOG}']
        expect: [{ exit_code: 0 }]
`,
      }),
    );

    const work = jobOf(result, 'work');
    assert.equal(work.status, 'failed');
    assert.equal(work.cause, HaltCause.untilNotMet);
    assert.equal(work.attempts, 2);
    assert.equal(readFileSync(join(result.journal.paths.dir, 'attempts.log'), 'utf8'), '1\n1\n2\n2\n');
    const steps = join(jobDir(result.journal.paths, 'work'), 'steps');
    assert.ok(existsSync(join(steps, 'attempt-2', 'iter-1', '01-step')));
  });

  it('откат, которого якорь не умеет, отменяет повтор и пишет bookkeeping.failed', async () => {
    // Не репозиторий git: якорь — хеш-манифест, содержимого он не хранит.
    const result = await run(
      makeProject({
        'stepcast.yml': `
version: 1
kind: pipeline
name: без-отката
jobs:
  work:
    attempts: { max: 2 }
    steps:
      - id: bad
        run: [sh, -c, 'echo "$BURNEX_JOB_ATTEMPT" >> ${LOG}; exit 1']
        expect: [{ exit_code: 0 }]
`,
      }),
    );

    const work = jobOf(result, 'work');
    assert.equal(work.status, 'failed');
    assert.equal(work.attempts, 1);
    assert.equal(readFileSync(join(result.journal.paths.dir, 'attempts.log'), 'utf8'), '1\n');
    const failures = readEvents(result.journal.paths).filter(
      (event) => event.kind === 'bookkeeping.failed' && event.operation === 'откат дерева перед попыткой работы',
    );
    assert.equal(failures.length, 1);
    assert.deepEqual(attemptEvents(result, 'work'), ['job.attempt.started:1', 'job.attempt.finished:1:failed']);
  });
});

describe('job-attempts: агентские шаги и бюджет', () => {
  const AGENT = (extra: string): string => `
version: 1
kind: pipeline
name: агент-и-попытки
jobs:
  work:
    attempts: { max: 2 }
${extra}
    steps:
      - id: write
        agent: fake
        prompt: "сделай"
        expect: [{ file_exists: never.txt }]
`;

  it('вторая попытка начинает новую сессию, а не продолжает первую', async () => {
    const fake = createFakeBackend({ lines: [initLine(), resultLine({ text: 'готово' })] });
    const result = await run(repo({ 'stepcast.yml': AGENT('') }), { fake });

    assert.equal(fake.invocations.length, 2);
    assert.notEqual(fake.invocations[0]?.sessionId, fake.invocations[1]?.sessionId);
    assert.equal(fake.invocations[1]?.resumeSession, false);
    assert.equal(jobOf(result, 'work').attempts, 2);
  });

  it('бюджет, исчерпанный первой попыткой, не даёт начать вторую', async () => {
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'дорого', tokensIn: 80, tokensOut: 0 })],
    });
    const result = await run(repo({ 'stepcast.yml': AGENT('    budget: { tokens: 50 }') }), { fake });

    assert.equal(fake.invocations.length, 1);
    const work = jobOf(result, 'work');
    assert.equal(work.status, 'budget_exceeded');
    assert.equal(work.attempts, 1);
    assert.deepEqual(attemptEvents(result, 'work').filter((item) => item.includes('started')), [
      'job.attempt.started:1',
    ]);
  });
});

/**
 * Неповторяемые исходы — сквозь раннер. Таблица предиката ниже проверяет
 * решение, а здесь — что причина действительно доходит до исхода работы:
 * потерянная `cause` превратила бы отказ в повтор при зелёной таблице.
 */
describe('job-attempts: неповторяемые исходы сквозь раннер', () => {
  const agentJob = (stepExtra = ''): string => `
version: 1
kind: pipeline
name: неповторяемое
jobs:
  work:
    attempts: { max: 3 }
    steps:
      - id: write
        agent: fake
        prompt: "сделай"
${stepExtra}`;

  it('отмена не повторяется', async () => {
    const project = repo({
      'stepcast.yml': `
version: 1
kind: pipeline
name: отмена
jobs:
  work:
    attempts: { max: 3 }
    steps:
      - id: slow
        run: [sh, -c, 'echo "$BURNEX_JOB_ATTEMPT" >> ${LOG}; sleep 30']
        expect: [{ exit_code: 0 }]
`,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500).unref();
    const result = await run(project, {}, controller.signal);

    assert.equal(result.status, 'canceled');
    const work = jobOf(result, 'work');
    assert.equal(work.status, 'canceled');
    assert.equal(work.attempts, 1);
    assert.equal(readFileSync(join(result.journal.paths.dir, 'attempts.log'), 'utf8'), '1\n');
    assert.deepEqual(attemptEvents(result, 'work'), ['job.attempt.started:1', 'job.attempt.finished:1:canceled']);
  });

  it('превышение бюджета шага не повторяется', async () => {
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'дорого', tokensIn: 80, tokensOut: 0 })],
    });
    const result = await run(repo({ 'stepcast.yml': agentJob('        budget: { tokens: 50 }\n') }), { fake });

    assert.equal(fake.invocations.length, 1);
    const work = jobOf(result, 'work');
    assert.equal(work.status, 'budget_exceeded');
    assert.equal(work.attempts, 1);
    assert.deepEqual(attemptEvents(result, 'work'), [
      'job.attempt.started:1',
      'job.attempt.finished:1:budget_exceeded',
    ]);
  });

  it('упор в лимит подписки не повторяется', async () => {
    const fake = createFakeBackend({ lines: [initLine(), rateLimitRefusalLine({ resetText: 'подождите' })] });
    const result = await run(repo({ 'stepcast.yml': agentJob() }), { fake });

    assert.equal(fake.invocations.length, 1);
    const work = jobOf(result, 'work');
    assert.equal(work.cause, HaltCause.backendRateLimited);
    assert.equal(work.attempts, 1);
    assert.equal(attemptEvents(result, 'work').filter((item) => item.includes('started')).length, 1);
  });

  it('отказ аутентификации не повторяется', async () => {
    const fake = createFakeBackend({ lines: [initLine(), authRefusalLine()], exitCode: 1 });
    const result = await run(repo({ 'stepcast.yml': agentJob() }), { fake });

    assert.equal(fake.invocations.length, 1);
    const work = jobOf(result, 'work');
    assert.equal(work.status, 'failed');
    assert.equal(work.cause, HaltCause.backendUnauthenticated);
    assert.equal(work.attempts, 1);
    assert.equal(attemptEvents(result, 'work').filter((item) => item.includes('started')).length, 1);
  });

  it('исключение во второй попытке закрывает её и называет число попыток', async () => {
    // Шаг `think` во второй попытке ссылается на несуществующий контекст —
    // путь с подстановкой статически не проверяется, и отказ приходит
    // исключением изнутри попытки.
    const fake = createFakeBackend({ lines: [initLine(), resultLine({ text: 'готово' })] });
    const result = await run(
      repo({
        'stepcast.yml': `
version: 1
kind: pipeline
name: исключение
jobs:
  work:
    attempts: { max: 3 }
    steps:
      - id: gate
        run: [sh, -c, 'test "$BURNEX_JOB_ATTEMPT" = 2']
        expect: [{ exit_code: 0 }]
      - id: think
        agent: fake
        prompt: "сделай"
        context:
          - \${run.id}/missing.md
`,
      }),
      { fake },
    );

    const work = jobOf(result, 'work');
    assert.equal(work.status, 'failed');
    assert.equal(work.cause, HaltCause.spawnFailed);
    assert.equal(work.attempts, 2);
    assert.deepEqual(attemptEvents(result, 'work'), [
      'job.attempt.started:1',
      'job.attempt.finished:1:failed',
      'job.attempt.started:2',
      'job.attempt.finished:2:failed',
    ]);
    assert.ok(readEvents(result.journal.paths).some((event) => event.kind === 'job.errored'));
  });
});

describe('job-attempts: повторяемость исхода', () => {
  const failed = (cause: JobOutcome['cause'], extra: Partial<JobOutcome> = {}): JobOutcome => ({
    status: 'failed',
    ...(cause === undefined ? {} : { cause }),
    ...extra,
  });

  it('повторяются только отказы из белого списка', () => {
    for (const cause of RETRYABLE_JOB_CAUSES) assert.equal(isRetryableJobOutcome(failed(cause)), true, cause);
    assert.deepEqual([...RETRYABLE_JOB_CAUSES].sort(), [
      HaltCause.expectFailed,
      HaltCause.spawnFailed,
      HaltCause.timeout,
      HaltCause.untilNotMet,
    ].sort());
  });

  it('прочие исходы и причины возвращаются сразу', () => {
    assert.equal(isRetryableJobOutcome({ status: 'success' }), false);
    assert.equal(isRetryableJobOutcome({ status: 'skipped', skip: 'declared' }), false);
    assert.equal(isRetryableJobOutcome({ status: 'budget_exceeded', cause: HaltCause.budgetExceeded }), false);
    assert.equal(isRetryableJobOutcome({ status: 'canceled', cause: HaltCause.canceled }), false);
    assert.equal(isRetryableJobOutcome(failed(HaltCause.backendRateLimited)), false);
    assert.equal(isRetryableJobOutcome(failed(HaltCause.backendUnauthenticated)), false);
    assert.equal(isRetryableJobOutcome(failed(HaltCause.budgetExceeded)), false);
    assert.equal(isRetryableJobOutcome(failed(HaltCause.loopExhausted)), false);
    assert.equal(isRetryableJobOutcome(failed(undefined)), false);
  });

  it('признак terminal снимает повторяемость даже у разрешённой причины', () => {
    assert.equal(isRetryableJobOutcome(failed(HaltCause.expectFailed, { terminal: true })), false);
  });
});
