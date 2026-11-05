import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { overallStatus, schedule, type JobOutcome } from '../src/parts/pipeline/run/scheduler.js';
import { buildGraph } from '../src/parts/pipeline/domain/graph.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { makeProject } from './helpers.js';
import type { Pipeline } from '../src/parts/pipeline/document/model.js';

function pipelineOf(yaml: string, inputs?: Record<string, string>): Pipeline {
  const project = makeProject({ 'burnex.yml': yaml });
  return expandPipeline({
    pipelinePath: project.path('burnex.yml'),
    config: project.config,
    ...(inputs === undefined ? {} : { inputs }),
  }).pipeline;
}

const STEP = '{ id: c, run: [echo, ok] }';

interface Recorded {
  readonly executed: string[];
  readonly statuses: Map<string, string>;
  readonly reasons: Map<string, string | undefined>;
  readonly status: string;
}

async function drive(
  pipeline: Pipeline,
  outcomes: Readonly<Record<string, JobOutcome>> = {},
  signal?: AbortSignal,
): Promise<Recorded> {
  const executed: string[] = [];
  const result = await schedule({
    pipeline,
    ...(signal === undefined ? {} : { signal }),
    execute: async (job) => {
      executed.push(job.id);
      return outcomes[job.id] ?? { status: 'success' };
    },
  });

  return {
    executed,
    statuses: new Map(result.settled.map((job) => [job.id, job.status])),
    reasons: new Map(result.settled.map((job) => [job.id, job.reason])),
    status: result.status,
  };
}

/** Отложить исход работы до внешнего разрешения — так проверяется одновременность. */
function gate(): { readonly promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Traced {
  readonly started: string[];
  readonly finished: string[];
  readonly statuses: Map<string, string>;
  readonly status: string;
  /** Наибольшее число работ, шедших одновременно. */
  readonly peak: number;
}

/**
 * Прогнать граф, отдав исполнение под наблюдение: каждая работа сообщает о
 * начале и завершении, а её длительность задаётся вызывающим.
 */
async function trace(
  pipeline: Pipeline,
  options: {
    readonly concurrency?: number;
    readonly hold?: Readonly<Record<string, Promise<void>>>;
    readonly outcomes?: Readonly<Record<string, JobOutcome>>;
    readonly signal?: AbortSignal;
    readonly onStarted?: (id: string) => void;
  } = {},
): Promise<Traced> {
  const started: string[] = [];
  const finished: string[] = [];
  let running = 0;
  let peak = 0;

  const result = await schedule({
    pipeline,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    execute: async (job) => {
      started.push(job.id);
      running += 1;
      peak = Math.max(peak, running);
      options.onStarted?.(job.id);
      await (options.hold?.[job.id] ?? tick());
      running -= 1;
      finished.push(job.id);
      return options.outcomes?.[job.id] ?? { status: 'success' };
    },
  });

  return {
    started,
    finished,
    statuses: new Map(result.settled.map((job) => [job.id, job.status])),
    status: result.status,
    peak,
  };
}

const FOUR_INDEPENDENT = `
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  c: { steps: [${STEP}] }
  d: { steps: [${STEP}] }
`;

describe('pipeline-execution: исполнение выборки', () => {
  // Сценарий: «Независимые работы идут одновременно»
  it('вторая готовая работа начинается, не дожидаясь завершения первой', async () => {
    const first = gate();
    const pipeline = pipelineOf(`
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
`);

    const traced = trace(pipeline, { concurrency: 2, hold: { a: first.promise } });
    await tick();
    await tick();
    first.open();
    const result = await traced;

    assert.deepEqual(result.started, ['a', 'b']);
    assert.equal(result.peak, 2, 'обе работы должны идти одновременно');
    assert.deepEqual(result.finished, ['b', 'a'], 'порядок исходов — порядок завершения');
  });

  // Сценарий: «Единица даёт прежний порядок»
  it('при concurrency: 1 работы идут по одной в порядке объявления', async () => {
    const result = await trace(pipelineOf(FOUR_INDEPENDENT), { concurrency: 1 });
    assert.equal(result.peak, 1);
    assert.deepEqual(result.started, ['a', 'b', 'c', 'd']);
    assert.deepEqual(result.finished, ['a', 'b', 'c', 'd']);
  });

  // Сценарий: «Число идущих работ ограничено»
  it('одновременно идут не больше объявленного числа работ', async () => {
    const held = { a: gate(), b: gate(), c: gate(), d: gate() };
    const traced = trace(pipelineOf(FOUR_INDEPENDENT), {
      concurrency: 2,
      hold: Object.fromEntries(Object.entries(held).map(([id, item]) => [id, item.promise])),
    });

    await tick();
    await tick();
    for (const item of Object.values(held)) item.open();
    const result = await traced;

    assert.equal(result.peak, 2, 'третья работа обязана дождаться места');
    assert.deepEqual(result.started, ['a', 'b', 'c', 'd']);
  });

  // Сценарий: «Освободившееся место занимается сразу»
  it('освободившееся место занимает следующая готовая работа', async () => {
    const a = gate();
    const b = gate();
    const c = gate();
    const seen: string[] = [];
    const traced = trace(
      pipelineOf(`
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  c: { steps: [${STEP}] }
`),
      {
        concurrency: 2,
        hold: { a: a.promise, b: b.promise, c: c.promise },
        onStarted: (id) => seen.push(id),
      },
    );

    await tick();
    await tick();
    a.open();
    // Место освободилось только у одной из двух идущих работ: `b` ещё идёт.
    await tick();
    await tick();
    await tick();

    assert.deepEqual(seen, ['a', 'b', 'c'], 'третья работа начата, пока вторая ещё идёт');

    b.open();
    c.open();
    await traced;
  });

  it('предел, поданный планировщику, ограничивает прогон и без линта', async () => {
    // Сценарий «Потолок конфигурации ограничивает прогон»: пайплайн объявил
    // больше, но прогон получил сведённое значение.
    const held = { a: gate(), b: gate(), c: gate(), d: gate() };
    const traced = trace(pipelineOf(`${FOUR_INDEPENDENT}concurrency: 8\n`), {
      concurrency: 2,
      hold: Object.fromEntries(Object.entries(held).map(([id, item]) => [id, item.promise])),
    });

    await tick();
    await tick();
    for (const item of Object.values(held)) item.open();

    assert.equal((await traced).peak, 2);
  });
});

describe('pipeline-execution: остановка и отмена при идущих работах', () => {
  // Сценарий: «Идущая работа не обрывается»
  it('отказ одной работы не обрывает вторую идущую и не пускает новые', async () => {
    const failing = gate();
    const running = gate();
    const pipeline = pipelineOf(`
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  c: { needs: [a], steps: [${STEP}] }
`);

    const traced = trace(pipeline, {
      concurrency: 2,
      hold: { a: failing.promise, b: running.promise },
      outcomes: { a: { status: 'failed', reason: 'тесты' } },
    });

    await tick();
    await tick();
    failing.open();
    await tick();
    await tick();
    running.open();
    const result = await traced;

    assert.deepEqual(result.finished, ['a', 'b'], 'вторая доведена до конца');
    assert.equal(result.statuses.get('b'), 'success', 'её исход — её собственный, а не canceled');
    assert.equal(result.statuses.get('c'), 'skipped');
    assert.equal(result.started.includes('c'), false, 'новые работы не запускаются');
  });

  // Сценарий: «Отмена при нескольких идущих работах»
  it('отмена дожидается идущих работ и не запускает новых', async () => {
    const controller = new AbortController();
    const a = gate();
    const b = gate();
    const pipeline = pipelineOf(`
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  c: { needs: [a], steps: [${STEP}] }
  triage: { needs: all, on: always, steps: [${STEP}] }
`);

    const traced = trace(pipeline, {
      concurrency: 2,
      hold: { a: a.promise, b: b.promise },
      signal: controller.signal,
    });

    await tick();
    await tick();
    controller.abort();
    a.open();
    b.open();
    const result = await traced;

    assert.deepEqual(result.finished.slice(0, 2).sort(), ['a', 'b']);
    assert.equal(result.statuses.get('a'), 'success', 'начатая до отмены работа отдаёт свой исход');
    assert.equal(result.statuses.get('b'), 'success');
    assert.equal(result.statuses.get('c'), 'canceled');
    assert.equal(result.started.includes('c'), false);
    assert.equal(result.statuses.get('triage'), 'success', 'разбор нужен именно при отмене');
    assert.equal(result.status, 'canceled');
  });

  // Дефект исполнителя — не исход графа: работа, не отдавшая исхода вовсе,
  // не получает пропуска, а вторая фаза не начинается.
  it('исключение исполнителя дожидается идущих работ и не превращается в пропуск', async () => {
    const failing = gate();
    const running = gate();
    const settled: string[] = [];
    const started: string[] = [];

    const pipeline = pipelineOf(`
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  triage: { needs: all, on: always, steps: [${STEP}] }
`);

    const promise = schedule({
      pipeline,
      concurrency: 2,
      execute: async (job) => {
        started.push(job.id);
        if (job.id === 'a') {
          await failing.promise;
          throw new Error('дефект исполнителя');
        }
        await (job.id === 'b' ? running.promise : tick());
        return { status: 'success' };
      },
      onSettled: (job) => {
        settled.push(job.id);
      },
    });

    await tick();
    await tick();
    failing.open();
    await tick();
    await tick();
    running.open();

    await assert.rejects(promise, /дефект исполнителя/);
    assert.deepEqual(settled, ['b'], 'упавшая с ошибкой работа исхода не получает');
    assert.equal(started.includes('triage'), false, 'вторая фаза после дефекта не начинается');
  });

  // Сценарий: «Работы needs: all после всего»
  it('работы needs: all начинаются после завершения всех идущих', async () => {
    const a = gate();
    const startedWhileRunning: string[] = [];
    const traced = trace(
      pipelineOf(`
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  triage: { needs: all, on: always, steps: [${STEP}] }
`),
      {
        concurrency: 4,
        hold: { a: a.promise },
        onStarted: (id) => {
          if (id === 'triage') startedWhileRunning.push(id);
        },
      },
    );

    await tick();
    await tick();
    assert.deepEqual(startedWhileRunning, [], 'вторая фаза не идёт вперемешку с основным графом');
    a.open();

    const result = await traced;
    assert.equal(result.started.at(-1), 'triage');
  });
});

describe('pipeline-execution: порядок', () => {
  // Сценарий: «Порядок по зависимостям»
  it('исполняет работы в топологическом порядке', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  typecheck: { needs: [implement], steps: [${STEP}] }
  implement: { needs: [plan], steps: [${STEP}] }
  plan: { steps: [${STEP}] }
`),
    );
    assert.deepEqual(result.executed, ['plan', 'implement', 'typecheck']);
  });

  // Сценарий: «Независимые работы упорядочены объявлением»
  it('упорядочивает независимые работы по объявлению и повторяемо', async () => {
    const pipeline = pipelineOf(`
kind: pipeline
jobs:
  zebra: { steps: [${STEP}] }
  alpha: { steps: [${STEP}] }
  middle: { steps: [${STEP}] }
`);
    const first = await drive(pipeline);
    const second = await drive(pipeline);
    assert.deepEqual(first.executed, ['zebra', 'alpha', 'middle']);
    assert.deepEqual(second.executed, first.executed);
  });
});

describe('pipeline-execution: условия', () => {
  // Сценарий: «Зависимость упала»
  it('пропускает работу, если зависимость упала', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  ship: { needs: [build], steps: [${STEP}] }
`),
      { build: { status: 'failed', reason: 'тесты' } },
    );

    assert.equal(result.statuses.get('ship'), 'skipped');
    assert.match(result.reasons.get('ship') ?? '', /on: success/);
    assert.equal(result.executed.includes('ship'), false);
  });

  // Сценарий: «Разбор отказа»
  it('запускает работу с on: failure при отказе зависимости', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  triage: { needs: [build], on: failure, steps: [${STEP}] }
`),
      { build: { status: 'failed' } },
    );
    assert.equal(result.statuses.get('triage'), 'success');
  });

  it('пропускает on: failure, когда отказов не было', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  triage: { needs: [build], on: failure, steps: [${STEP}] }
`),
    );
    assert.equal(result.statuses.get('triage'), 'skipped');
  });

  // Сценарий: «Превышение бюджета считается отказом»
  it('трактует budget_exceeded как отказ для обоих условий', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  ship: { needs: [build], steps: [${STEP}] }
  triage: { needs: [build], on: failure, steps: [${STEP}] }
`),
      { build: { status: 'budget_exceeded' } },
    );
    assert.equal(result.statuses.get('ship'), 'skipped');
    assert.equal(result.statuses.get('triage'), 'success');
    assert.equal(result.status, 'budget_exceeded');
  });

  // Сценарий: «Одна из зависимостей пропущена»
  it('не блокирует работу пропущенной зависимостью', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
inputs:
  skip_review: { type: bool, default: true }
jobs:
  typecheck: { steps: [${STEP}] }
  review: { needs: [typecheck], if: "not inputs.skip_review", steps: [${STEP}] }
  archive: { needs: [review, typecheck], steps: [${STEP}] }
`),
    );

    assert.equal(result.statuses.get('review'), 'skipped');
    assert.equal(result.statuses.get('archive'), 'success', 'пропуск ревью не отменяет архивацию');
  });

  // Сценарий: «Все зависимости пропущены»
  it('пропускает работу, у которой пропущены все зависимости', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
inputs:
  skip: { type: bool, default: true }
jobs:
  review: { if: "not inputs.skip", steps: [${STEP}] }
  archive: { needs: [review], steps: [${STEP}] }
`),
    );
    assert.equal(result.statuses.get('archive'), 'skipped');
    assert.match(result.reasons.get('archive') ?? '', /все зависимости пропущены/);
  });

  // Сценарий: «Все зависимости пропущены у on: always»
  it('исполняет on: always, когда все зависимости пропущены ложным if', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
inputs:
  skip: { type: bool, default: true }
jobs:
  review: { if: "not inputs.skip", steps: [${STEP}] }
  merge: { needs: [review], on: always, steps: [${STEP}] }
`),
    );
    assert.equal(result.statuses.get('review'), 'skipped');
    assert.equal(result.statuses.get('merge'), 'success');
  });

  it('исполняет on: always, когда пропущены все зависимости при needs: all', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  a: { if: "false", steps: [${STEP}] }
  b: { if: "false", steps: [${STEP}] }
  merge: { needs: all, on: always, steps: [${STEP}] }
`),
    );
    assert.equal(result.statuses.get('a'), 'skipped');
    assert.equal(result.statuses.get('b'), 'skipped');
    assert.equal(result.statuses.get('merge'), 'success');
  });

  it('не отменяет ложное if у on: always при пропуске всех зависимостей', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  a: { if: "false", steps: [${STEP}] }
  merge: { needs: [a], on: always, if: "jobs.a.status == 'success'", steps: [${STEP}] }
`),
    );
    assert.equal(result.statuses.get('merge'), 'skipped');
    assert.match(result.reasons.get('merge') ?? '', /^if: /);
    assert.equal(result.executed.includes('merge'), false);
  });

  // Рецепт прежнего поведения: явное условие по статусам зависимостей.
  it('рецепт: if по jobs.<id>.status возвращает пропуск при пропуске обеих зависимостей', async () => {
    const yaml = (aOff: string, bOff: string): string => `
kind: pipeline
jobs:
  a: { if: "${aOff}", steps: [${STEP}] }
  b: { if: "${bOff}", steps: [${STEP}] }
  merge:
    needs: [a, b]
    on: always
    if: "jobs.a.status != 'skipped' or jobs.b.status != 'skipped'"
    steps: [${STEP}]
`;
    const both = await drive(pipelineOf(yaml('false', 'false')));
    assert.equal(both.statuses.get('merge'), 'skipped');
    assert.match(both.reasons.get('merge') ?? '', /^if: /);

    const one = await drive(pipelineOf(yaml('false', 'true')));
    assert.equal(one.statuses.get('merge'), 'success');

    // Непропущенная зависимость упала — on: always всё равно исполняется.
    const failed = await drive(pipelineOf(yaml('false', 'true')), { b: { status: 'failed' } });
    assert.equal(failed.statuses.get('b'), 'failed');
    assert.equal(failed.statuses.get('merge'), 'success');
    assert.equal(failed.executed.includes('merge'), true);
  });

  it('on: failure пропускается, когда пропущены все зависимости', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  a: { if: "false", steps: [${STEP}] }
  triage: { needs: [a], on: failure, steps: [${STEP}] }
`),
    );
    assert.equal(result.statuses.get('triage'), 'skipped');
    assert.match(result.reasons.get('triage') ?? '', /все зависимости пропущены/);
  });

  // Сценарий: «Ложное условие по входу»
  it('пропускает работу по ложному условию', async () => {
    const result = await drive(
      pipelineOf(
        `
kind: pipeline
inputs:
  skip_review: { type: bool, required: true }
jobs:
  review: { if: "not inputs.skip_review", steps: [${STEP}] }
`,
        { skip_review: 'true' },
      ),
    );
    assert.equal(result.statuses.get('review'), 'skipped');
  });

  // Сценарий: «Выражение над выходом зависимости»
  it('вычисляет условие по опубликованному выходу зависимости', async () => {
    const yaml = `
kind: pipeline
jobs:
  review: { steps: [${STEP}] }
  fix: { needs: [review], if: "jobs.review.output.findings", steps: [${STEP}] }
`;

    const withFindings = await drive(pipelineOf(yaml), {
      review: { status: 'success', output: { findings: [{ severity: 'high' }] } },
    });
    assert.equal(withFindings.statuses.get('fix'), 'success');

    const clean = await drive(pipelineOf(yaml), {
      review: { status: 'success', output: { findings: [] } },
    });
    assert.equal(clean.statuses.get('fix'), 'skipped');
  });

  // Сценарий: «Оба условия должны выполниться»
  it('требует одновременного выполнения on и if', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
inputs:
  enabled: { type: bool, default: false }
jobs:
  build: { steps: [${STEP}] }
  ship: { needs: [build], on: success, if: "inputs.enabled", steps: [${STEP}] }
`),
    );
    assert.equal(result.statuses.get('ship'), 'skipped');
  });
});

describe('pipeline-execution: needs all и fail_fast', () => {
  // Сценарий: «Разбор после отказа»
  it('выполняет работу с needs: all последней', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  plan: { steps: [${STEP}] }
  build: { needs: [plan], steps: [${STEP}] }
  triage: { needs: all, on: failure, steps: [${STEP}] }
`),
      { build: { status: 'failed' } },
    );
    assert.deepEqual(result.executed, ['plan', 'build', 'triage']);
  });

  // Сценарий: «Две работы после всего»
  it('не заставляет работы с needs: all ждать друг друга', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  notify: { needs: all, on: always, steps: [${STEP}] }
  archive: { needs: all, on: always, steps: [${STEP}] }
`),
    );
    assert.deepEqual(result.executed, ['build', 'notify', 'archive']);
  });

  // Сценарий: «Остановка графа»
  it('останавливает граф после отказа и всё равно запускает разбор', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  implement: { steps: [${STEP}] }
  typecheck: { needs: [implement], steps: [${STEP}] }
  ship: { needs: [typecheck], steps: [${STEP}] }
  triage: { needs: all, on: failure, steps: [${STEP}] }
`),
      { implement: { status: 'failed' } },
    );

    assert.equal(result.statuses.get('typecheck'), 'skipped');
    assert.equal(result.statuses.get('ship'), 'skipped');
    assert.equal(result.statuses.get('triage'), 'success');
    assert.equal(result.status, 'failed');
  });

  it('fail_fast не глушит разбор в основном графе', async () => {
    // Остановка касается продолжения работы, а не её разбора: иначе после
    // первого же отказа разбирать его будет нечем.
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  ship: { needs: [build], steps: [${STEP}] }
  explain: { needs: [build], on: failure, steps: [${STEP}] }
`),
      { build: { status: 'failed' } },
    );

    assert.equal(result.statuses.get('ship'), 'skipped');
    assert.equal(result.statuses.get('explain'), 'success');
  });

  // Сценарий: «Полный проход»
  it('доигрывает граф целиком при fail_fast: false', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
fail_fast: false
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  c: { steps: [${STEP}] }
`),
      { a: { status: 'failed' } },
    );
    assert.deepEqual(result.executed, ['a', 'b', 'c']);
  });
});

describe('pipeline-execution: пропуск, объявленный шагом (skip: declared)', () => {
  const DECLARED: JobOutcome = { status: 'skipped', reason: 'шаг объявил пропуск', skip: 'declared' };

  // Пропуск отказом не считается: `isFailure` его не включает, и этот тест
  // держит свойство, чтобы будущая правка не сломала его молча.
  it('fail_fast: true не останавливает независимую соседнюю работу', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
fail_fast: true
jobs:
  пустая: { steps: [${STEP}] }
  сосед: { needs: [], steps: [${STEP}] }
`),
      { пустая: DECLARED },
    );
    assert.deepEqual(result.executed.sort(), ['пустая', 'сосед']);
    assert.equal(result.statuses.get('сосед'), 'success');
    assert.equal(result.status, 'success');
  });

  it('зависимая с единственной пропущенной зависимостью пропускается условием', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  пустая: { steps: [${STEP}] }
  после: { needs: [пустая], steps: [${STEP}] }
`),
      { пустая: DECLARED },
    );
    assert.equal(result.statuses.get('после'), 'skipped');
    assert.deepEqual(result.executed, ['пустая']);
  });

  it('зависимая от пропущенной и успешной работ on: success исполняется', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  пустая: { steps: [${STEP}] }
  рядом: { steps: [${STEP}] }
  обе: { needs: [пустая, рядом], steps: [${STEP}] }
`),
      { пустая: DECLARED },
    );
    assert.equal(result.statuses.get('обе'), 'success');
  });

  it('on: always исполняется, когда все зависимости пропущены кодом пропуска', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  пустая: { steps: [${STEP}] }
  итог: { needs: [пустая], on: always, steps: [${STEP}] }
`),
      { пустая: DECLARED },
    );
    assert.equal(result.statuses.get('итог'), 'success');
    assert.deepEqual(result.executed, ['пустая', 'итог']);
  });

  it('on: always исполняется, когда все зависимости погашены остановкой fail_fast', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
fail_fast: true
jobs:
  упавшая: { steps: [${STEP}] }
  первая: { steps: [${STEP}] }
  итог: { needs: [первая], on: always, steps: [${STEP}] }
`),
      { упавшая: { status: 'failed' } },
    );
    // Единственная прямая зависимость итога погашена самой остановкой
    // (`skip: halted`), а не правилом пропуска всех зависимостей.
    assert.equal(result.statuses.get('первая'), 'skipped');
    assert.match(result.reasons.get('первая') ?? '', /fail_fast/);
    assert.equal(result.executed.includes('первая'), false);
    assert.equal(result.statuses.get('итог'), 'success');
    assert.equal(result.executed.includes('итог'), true);
  });

  it('итог прогона из success и declared — success', () => {
    assert.equal(
      overallStatus([
        { id: 'a', status: 'success' },
        { id: 'b', status: 'skipped' },
      ]),
      'success',
    );
  });
});

describe('pipeline-execution: исходы', () => {
  // Сценарий: «Отказ работы»
  it('прогон с отказавшей работой завершается отказом', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
`),
      { build: { status: 'failed' } },
    );
    assert.equal(result.status, 'failed');
  });

  // Сценарий: «Все работы успешны или пропущены»
  it('прогон без отказов успешен', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
inputs:
  skip: { type: bool, default: true }
jobs:
  build: { steps: [${STEP}] }
  extra: { if: "not inputs.skip", steps: [${STEP}] }
`),
    );
    assert.equal(result.status, 'success');
  });

  // Сценарий: «Прерывание по Ctrl-C»
  it('отменяет незапущенные работы и всё равно выполняет разбор', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  ship: { needs: [build], steps: [${STEP}] }
  triage: { needs: all, on: always, steps: [${STEP}] }
`),
      {},
      controller.signal,
    );

    assert.equal(result.statuses.get('build'), 'canceled');
    assert.equal(result.statuses.get('ship'), 'canceled');
    assert.equal(result.statuses.get('triage'), 'success', 'разбор нужен именно при отмене');
    assert.equal(result.status, 'canceled');
  });

  it('отмена важнее исчерпания бюджета, бюджет важнее обычного отказа', () => {
    assert.equal(
      overallStatus([
        { id: 'a', status: 'failed' },
        { id: 'b', status: 'budget_exceeded' },
        { id: 'c', status: 'canceled' },
      ]),
      'canceled',
    );
    assert.equal(
      overallStatus([
        { id: 'a', status: 'failed' },
        { id: 'b', status: 'budget_exceeded' },
      ]),
      'budget_exceeded',
    );
    assert.equal(overallStatus([{ id: 'a', status: 'skipped' }]), 'success');
  });
});

describe('dependent-job-workspace: число потомков в графе', () => {
  it('линейная цепочка — у каждой работы ровно один потомок', () => {
    const { graph } = buildGraph(
      pipelineOf(`
kind: pipeline
jobs:
  a:
    steps: [${STEP}]
  b:
    needs: [a]
    steps: [${STEP}]
  c:
    needs: [b]
    steps: [${STEP}]
`),
    );
    assert.deepEqual(graph.dependents.get('a'), ['b']);
    assert.deepEqual(graph.dependents.get('b'), ['c']);
    assert.deepEqual(graph.dependents.get('c'), []);
  });

  it('развилка — у общего предшественника два потомка', () => {
    const { graph } = buildGraph(
      pipelineOf(`
kind: pipeline
jobs:
  a:
    steps: [${STEP}]
  b:
    needs: [a]
    steps: [${STEP}]
  c:
    needs: [a]
    steps: [${STEP}]
`),
    );
    assert.deepEqual(graph.dependents.get('a'), ['b', 'c']);
  });

  it('needs: all не считается потомком — иначе цепочка неотличима от развилки', () => {
    const { graph } = buildGraph(
      pipelineOf(`
kind: pipeline
jobs:
  a:
    steps: [${STEP}]
  b:
    needs: [a]
    steps: [${STEP}]
  z:
    needs: all
    steps: [${STEP}]
`),
    );
    assert.deepEqual(graph.dependents.get('a'), ['b']);
    assert.deepEqual(graph.dependents.get('b'), []);
  });
});

describe('планировщик: циклы по группе работ', () => {
  const OK: JobOutcome = { status: 'success' };
  const FAIL: JobOutcome = { status: 'failed', cause: 'expect_failed' };

  const CHECK_FIX = (loop: string, tail = '', head = ''): string => `
kind: pipeline
${head}
loops:
  fix-loop:
    jobs: [check, fix]
    max_iterations: 3
${loop}
jobs:
  check:
    steps: [${STEP}]
  fix:
    needs: [check]
    on: failure
    steps: [${STEP}]
${tail}`;

  interface LoopRun {
    readonly calls: string[];
    readonly events: string[];
    readonly settledCalls: string[];
    readonly result: Awaited<ReturnType<typeof schedule>>;
  }

  /** Исход участника задаётся функцией от работы и номера прохода. */
  async function driveLoop(
    pipeline: Pipeline,
    script: (job: string, iteration: number) => JobOutcome,
    signal?: AbortSignal,
  ): Promise<LoopRun> {
    const calls: string[] = [];
    const events: string[] = [];
    const settledCalls: string[] = [];
    const iterationOf = new Map<string, number>();
    const result = await schedule({
      pipeline,
      ...(signal === undefined ? {} : { signal }),
      execute: async (job, _scope, pass) => {
        const iteration = pass?.iteration ?? 1;
        iterationOf.set(job.id, iteration);
        calls.push(pass === undefined ? job.id : `${job.id}#${iteration}`);
        return script(job.id, iteration);
      },
      onSettled: (job) => {
        settledCalls.push(job.id);
      },
      loopHooks: {
        onLoopStarted: (loop) => void events.push(`started ${loop.id}`),
        onPassStarted: (loop, iteration) => void events.push(`pass ${iteration} started`),
        onPassFinished: (loop, iteration, goesOn) => void events.push(`pass ${iteration} ${goesOn ? 'continue' : 'exit'}`),
        onLoopFinished: (outcome) => void events.push(`finished ${outcome.verdict} ${outcome.status}`),
      },
    });
    return { calls, events, settledCalls, result };
  }

  it('сходится на втором проходе: починка не нужна, когда проверка прошла', async () => {
    const run = await driveLoop(pipelineOf(CHECK_FIX('')), (job, iteration) =>
      job === 'check' && iteration === 1 ? FAIL : OK,
    );

    assert.deepEqual(run.calls, ['check#1', 'fix#1', 'check#2']);
    assert.deepEqual(run.events, [
      'started fix-loop',
      'pass 1 started',
      'pass 1 continue',
      'pass 2 started',
      'pass 2 exit',
      'finished done success',
    ]);
    const [loop] = run.result.loops;
    assert.equal(loop?.iterations, 2);
    assert.equal(loop?.verdict, 'done');
    assert.equal(run.result.status, 'success');
    // Снаружи виден последний проход: check — успех, fix — пропуск (on: failure).
    const byId = new Map(run.result.settled.map((job) => [job.id, job]));
    assert.equal(byId.get('check')?.status, 'success');
    assert.equal(byId.get('fix')?.status, 'skipped');
    assert.equal(run.result.settled.length, 2, 'каждая работа в итоге один раз');
    assert.equal(run.settledCalls.length, 4, 'onSettled вызывается на каждый проход');
  });

  it('исчерпание по max_iterations: loop_exhausted и отказ прогона', async () => {
    const run = await driveLoop(pipelineOf(CHECK_FIX('')), (job) => (job === 'check' ? FAIL : OK));

    assert.deepEqual(run.calls, ['check#1', 'fix#1', 'check#2', 'fix#2', 'check#3', 'fix#3']);
    const [loop] = run.result.loops;
    assert.equal(loop?.iterations, 3);
    assert.equal(loop?.verdict, 'exhausted');
    assert.equal(loop?.status, 'failed');
    assert.equal(loop?.cause, 'loop_exhausted');
    assert.equal(run.result.status, 'failed');
  });

  it('явный while заменяет умолчание: продолжение по output участника', async () => {
    const pipeline = pipelineOf(`
kind: pipeline
loops:
  l:
    jobs: [work]
    while: "jobs.work.output.verdict == 'again'"
    max_iterations: 5
jobs:
  work:
    steps: [${STEP}]
`);
    const run = await driveLoop(pipeline, (_job, iteration) => ({
      status: 'success',
      output: { verdict: iteration < 3 ? 'again' : 'stop' },
    }));

    assert.deepEqual(run.calls, ['work#1', 'work#2', 'work#3']);
    assert.equal(run.result.loops[0]?.verdict, 'done');
    assert.equal(run.result.status, 'success');
  });

  it('while видит loop.iteration', async () => {
    const pipeline = pipelineOf(CHECK_FIX('').replace('    max_iterations: 3', '    while: "loop.iteration < 2"\n    max_iterations: 5'));
    const run = await driveLoop(pipeline, () => OK);
    assert.equal(run.result.loops[0]?.iterations, 2);
  });

  it('отмена в первом проходе: вердикт canceled, итог canceled', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await driveLoop(pipelineOf(CHECK_FIX('')), () => OK, controller.signal);

    assert.deepEqual(run.calls, []);
    const [loop] = run.result.loops;
    assert.equal(loop?.verdict, 'canceled');
    assert.equal(loop?.status, 'canceled');
    assert.equal(loop?.iterations, 1);
    assert.equal(run.result.status, 'canceled');
  });

  it('внешняя работа ниже цикла ждёт вердикта и исполняется ровно один раз', async () => {
    const run = await driveLoop(
      pipelineOf(
        CHECK_FIX(
          '',
          `  merge:
    needs: [fix]
    on: always
    steps: [${STEP}]
`,
        ),
      ),
      (job) => (job === 'check' ? FAIL : OK),
    );

    assert.equal(run.calls.filter((call) => call === 'merge').length, 1);
    assert.equal(run.calls.at(-1), 'merge', 'после третьего прохода, а не между проходами');
    assert.deepEqual(run.calls.slice(0, 6), ['check#1', 'fix#1', 'check#2', 'fix#2', 'check#3', 'fix#3']);
  });

  it('on: failure после exhausted запускается, on: success пропускается — даже при одних успехах последнего прохода', async () => {
    const pipeline = pipelineOf(`
kind: pipeline
loops:
  l:
    jobs: [work]
    while: "loop.iteration < 10"
    max_iterations: 2
jobs:
  work:
    steps: [${STEP}]
  triage:
    needs: [work]
    on: failure
    steps: [${STEP}]
  ship:
    needs: [work]
    steps: [${STEP}]
`);
    const run = await driveLoop(pipeline, () => OK);

    assert.deepEqual(run.calls, ['work#1', 'work#2', 'triage']);
    const byId = new Map(run.result.settled.map((job) => [job.id, job]));
    assert.equal(byId.get('ship')?.status, 'skipped');
    assert.equal(run.result.loops[0]?.cause, 'loop_exhausted');
    assert.equal(run.result.status, 'failed');
  });

  it('on: failure после exhausted запускается, даже когда её зависимость пропущена в последнем проходе', async () => {
    // В последнем проходе check прошёл, fix пропущен своим on: failure, а
    // while по номеру прохода не сошёлся: «все зависимости пропущены» не
    // должно заслонять отказ цикла.
    const pipeline = pipelineOf(
      CHECK_FIX(
        '',
        `  triage:
    needs: [fix]
    on: failure
    steps: [${STEP}]
`,
      ).replace('    max_iterations: 3', '    while: "loop.iteration < 10"\n    max_iterations: 2'),
    );
    const run = await driveLoop(pipeline, () => OK);

    assert.deepEqual(run.calls, ['check#1', 'check#2', 'triage']);
    assert.equal(run.result.loops[0]?.cause, 'loop_exhausted');
    assert.equal(new Map(run.result.settled.map((job) => [job.id, job])).get('triage')?.status, 'success');
  });

  it('остановка fail_fast вне цикла заканчивает цикл, не выдавая её за loop_exhausted или done', async () => {
    for (const loopHead of ['    while: "loop.iteration < 10"\n    max_iterations: 3', '    max_iterations: 3']) {
      const pipeline = pipelineOf(`
kind: pipeline
fail_fast: true
loops:
  l:
    jobs: [check, fix]
${loopHead}
jobs:
  side:
    steps: [${STEP}]
  check:
    steps: [${STEP}]
  fix:
    needs: [check]
    on: always
    steps: [${STEP}]
`);
      const run = await driveLoop(pipeline, (job) => (job === 'side' ? FAIL : OK));

      // check погашен остановкой, fix (on: always) исполняется для разбора —
      // но новых проходов нет.
      assert.deepEqual(run.calls, ['side', 'fix#1'], loopHead);
      const [loop] = run.result.loops;
      assert.equal(loop?.iterations, 1);
      assert.equal(loop?.verdict, 'exhausted');
      assert.equal(loop?.status, 'failed');
      assert.equal(loop?.cause, undefined);
      assert.equal(loop?.reason, 'прогон остановлен после отказа (fail_fast)');
      assert.equal(run.result.status, 'failed');
    }
  });

  it('переиспользованный цикл выходит done с числом проходов исходного прогона, не вычисляя while', async () => {
    const pipeline = pipelineOf(CHECK_FIX(''));
    const result = await schedule({
      pipeline,
      execute: async (job) => (job.id === 'check' ? FAIL : OK),
      loopHooks: { reused: () => 3 },
    });
    assert.equal(result.loops[0]?.verdict, 'done');
    assert.equal(result.loops[0]?.iterations, 3);

    // Шаг участника всё же исполнился — переиспользования нет, судит while.
    const rerun = await schedule({
      pipeline,
      execute: async (job) => (job.id === 'check' ? FAIL : OK),
      loopHooks: { reused: () => undefined },
    });
    assert.equal(rerun.loops[0]?.verdict, 'exhausted');
    assert.equal(rerun.loops[0]?.iterations, 3);
  });

  it('fail_fast не срабатывает на отказ первого прохода', async () => {
    const run = await driveLoop(
      pipelineOf(
        CHECK_FIX(
          '',
          `  side:
    steps: [${STEP}]
`,
          'fail_fast: true',
        ),
      ),
      (job, iteration) => (job === 'check' && iteration === 1 ? FAIL : OK),
    );

    assert.deepEqual(run.calls, ['check#1', 'fix#1', 'check#2', 'side']);
    assert.equal(run.result.status, 'success');
  });

  it('fail_fast срабатывает на отказ цикла', async () => {
    const run = await driveLoop(
      pipelineOf(
        CHECK_FIX(
          '',
          `  side:
    steps: [${STEP}]
`,
          'fail_fast: true',
        ),
      ),
      (job) => (job === 'check' ? FAIL : OK),
    );

    assert.equal(run.calls.includes('side'), false, 'остановлено после отказа цикла');
    assert.equal(run.result.status, 'failed');
  });

  it('done с упавшим участником последнего прохода даёт итог failed', async () => {
    const pipeline = pipelineOf(CHECK_FIX('').replace('    max_iterations: 3', '    while: "loop.iteration < 1"\n    max_iterations: 3'));
    const run = await driveLoop(pipeline, (job) => (job === 'check' ? FAIL : OK));

    assert.equal(run.result.loops[0]?.verdict, 'done');
    assert.equal(run.result.loops[0]?.status, 'success');
    assert.equal(run.result.status, 'failed');
  });

  it('отказ бэкенда в проходе не повторяется: exhausted с этой причиной', async () => {
    const run = await driveLoop(pipelineOf(CHECK_FIX('')), (job) =>
      job === 'check' ? { status: 'failed', cause: 'backend_rate_limited' } : OK,
    );

    assert.deepEqual(run.calls, ['check#1', 'fix#1']);
    assert.equal(run.result.loops[0]?.verdict, 'exhausted');
    assert.equal(run.result.loops[0]?.cause, 'backend_rate_limited');
  });

  it('бюджет цикла, исчерпанный к границе прохода, даёт exhausted со статусом budget_exceeded', async () => {
    const result = await schedule({
      pipeline: pipelineOf(CHECK_FIX('')),
      execute: async (job) => (job.id === 'check' ? FAIL : OK),
      loopHooks: { budgetExhausted: () => true },
    });

    assert.equal(result.loops[0]?.verdict, 'exhausted');
    assert.equal(result.loops[0]?.status, 'budget_exceeded');
    assert.equal(result.loops[0]?.iterations, 1);
    assert.equal(result.status, 'budget_exceeded');
  });

  it('пайплайн без циклов: список циклов пуст, onSettled один на работу', async () => {
    const run = await driveLoop(
      pipelineOf(`
kind: pipeline
jobs:
  a:
    steps: [${STEP}]
  b:
    needs: [a]
    steps: [${STEP}]
`),
      () => OK,
    );
    assert.deepEqual(run.result.loops, []);
    assert.deepEqual(run.calls, ['a', 'b']);
    assert.deepEqual(run.settledCalls, ['a', 'b']);
  });
});
