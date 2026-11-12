import { evaluate, parseExpression } from '../domain/expr/parse.js';
import { buildGraph, loopMembersInOrder, type Graph } from '../domain/graph.js';
import { isFailure, type PredicateResult, type SkipKind, type StatusValue } from './journal/schema.js';
import type { Job, Loop, Pipeline } from '../document/model.js';
import { HaltCause, RETRYABLE_JOB_CAUSES, type HaltCauseValue } from './halt.js';

/**
 * Планировщик работ.
 *
 * На каждом обороте берётся множество готовых работ, и из него запускается
 * столько, сколько позволяет предел одновременности; освободившееся место
 * занимает следующая готовая. Выбор на запуск идёт по порядку объявления —
 * порядок завершения зависит от длительности работ, и от него не зависит
 * ничего: ни решение о запуске, ни состав контекста, ни ключ шага.
 *
 * Ввода-вывода здесь нет намеренно — это делает поведение графа проверяемым
 * без процессов, файлов и бэкендов.
 */

export interface JobOutcome {
  readonly status: StatusValue;
  readonly reason?: string;
  /** Причина неуспеха из закрытого перечня `halt.ts`. */
  readonly cause?: HaltCauseValue;
  /** Происхождение пропуска: решение графа, остановка прогона либо объявление шага. */
  readonly skip?: SkipKind;
  /** Результаты check последней итерации, когда причина — until_not_met. */
  readonly lastCheck?: readonly PredicateResult[];
  /** Опубликованный структурированный выход, если работа его произвела. */
  readonly output?: unknown;
  /**
   * Внутренний признак: отказ, который повтор воспроизвёл бы, — противоречие
   * плану возобновления и необъявленный ключ данных. Наружу (в состояние и
   * журнал) не пишется; так же названо `AttemptOutcome.terminal` у попыток шага.
   */
  readonly terminal?: boolean;
}

/**
 * Стоит ли повторить работу после этого исхода. Только `failed` с причиной из
 * белого списка и без признака `terminal`; всё прочее — пропуск, успех,
 * бюджет, отмена, отказ бэкенда — возвращается как есть.
 */
export function isRetryableJobOutcome(outcome: JobOutcome): boolean {
  return (
    outcome.status === 'failed' &&
    outcome.terminal !== true &&
    outcome.cause !== undefined &&
    RETRYABLE_JOB_CAUSES.includes(outcome.cause)
  );
}

export interface SettledJob extends JobOutcome {
  readonly id: string;
}

/** Проход цикла, в котором исполняется работа-участник. */
export interface LoopPass {
  readonly loop: Loop;
  /** Номер прохода с единицы. */
  readonly iteration: number;
}

/**
 * Вердикт цикла на границе прохода (design.md, решение 3): `done` — условие
 * продолжения ложно, `exhausted` — проходы кончились, бюджет упёрся или бэкенд
 * отказал, `canceled` — прогон отменён.
 */
export type LoopVerdict = 'done' | 'exhausted' | 'canceled';

/** Исход цикла для остального графа и для состояния прогона. */
export interface LoopOutcome {
  readonly id: string;
  readonly jobs: readonly string[];
  readonly iterations: number;
  readonly maxIterations: number;
  readonly verdict: LoopVerdict;
  readonly status: StatusValue;
  readonly reason?: string;
  readonly cause?: HaltCauseValue;
}

/**
 * Что планировщик сообщает исполнителю о границах проходов. Он не владеет ни
 * файлами, ни учётом расхода, поэтому сброс участника между проходами и
 * проверка бюджета цикла приходят снаружи.
 */
export interface LoopHooks {
  readonly onLoopStarted?: (loop: Loop) => void | Promise<void>;
  /** Вызывается и для первого прохода; перед проходом N > 1 исполнитель сбрасывает участников. */
  readonly onPassStarted?: (loop: Loop, iteration: number) => void | Promise<void>;
  readonly onPassFinished?: (loop: Loop, iteration: number, goesOn: boolean) => void | Promise<void>;
  readonly onLoopFinished?: (outcome: LoopOutcome) => void | Promise<void>;
  /** Исчерпан ли бюджет цикла (`cost`, `wallclock`) к концу прохода. */
  readonly budgetExhausted?: (loop: Loop) => boolean;
  /**
   * Цикл переиспользован из прошлого прогона: его проход прошёл на
   * переиспользованных шагах и выходит с вердиктом `done` без вычисления
   * `while` — условие говорило о проходах исходного прогона. Ответ — число
   * проходов исходного прогона; `undefined` — цикл не переиспользован, в том
   * числе когда план обещал переиспользование, а шаг участника исполнился.
   */
  readonly reused?: (loop: Loop) => number | undefined;
}

export interface ScheduleOptions {
  readonly pipeline: Pipeline;
  readonly graph?: Graph;
  /**
   * Исполнить работу. Планировщик не знает, что происходит внутри, но отдаёт
   * ту же область видимости, которой сам проверяет условия: иначе
   * `if: "jobs.plan.status == 'success'"` и `${jobs.plan.status}` начнут
   * отвечать по-разному, и объяснить это будет нечем. Третий аргумент есть у
   * участника цикла.
   */
  readonly execute: (job: Job, scope: Record<string, unknown>, pass?: LoopPass) => Promise<JobOutcome>;
  /** Дополнительные значения для условий и подстановок: `run`, `env`. */
  readonly scopeExtras?: Readonly<Record<string, unknown>>;
  /**
   * Данные, опубликованные завершившейся работой (`burnex data`). Приходят
   * запросом, а не полем исхода: их пишет посторонний процесс по ходу
   * работы, и владелец их накопления — журнал прогона, а не планировщик,
   * который файлов не касается вовсе.
   */
  readonly jobData?: (jobId: string) => Readonly<Record<string, string>> | undefined;
  /**
   * Предел числа одновременно идущих работ. Приходит уже сведённым с потолком
   * конфигурации: планировщик знает граф, а не конфигурацию, и читать её здесь
   * значило бы завести второй источник истины о том же числе. Отсутствие —
   * единица: последовательное исполнение в порядке объявления.
   */
  readonly concurrency?: number;
  /**
   * Общее дерево, в котором исполняется работа (`named-workspace-trees`,
   * решение 4): в дереве одновременно идёт не более одной работы, и готовая
   * работа ждёт, пока её дерево занято. Из ждущих первой идёт объявленная
   * раньше — выбор и так идёт по порядку объявления. `undefined` — работа
   * дерева ни с кем не делит.
   */
  readonly treeOf?: (job: Job) => string | undefined;
  readonly signal?: AbortSignal;
  /** Вызывается на каждый проход участника цикла, а не только на последний. */
  readonly onSettled?: (job: Job, outcome: JobOutcome) => void | Promise<void>;
  readonly loopHooks?: LoopHooks;
}

export interface ScheduleResult {
  readonly settled: readonly SettledJob[];
  /** Исходы циклов в порядке их завершения; без объявленных циклов пусто. */
  readonly loops: readonly LoopOutcome[];
  readonly status: StatusValue;
}

/** Цикл в ходе исполнения: проход открыт, пока не все участники отдали исход. */
interface LoopState {
  readonly loop: Loop;
  /** Участники основного графа в порядке исполнения. */
  readonly members: readonly Job[];
  iteration: number;
  started: boolean;
  finished: boolean;
  /** Исходы участников текущего прохода: остальной граф их не видит. */
  passOutcomes: Map<string, JobOutcome>;
}

export async function schedule(options: ScheduleOptions): Promise<ScheduleResult> {
  const { pipeline } = options;
  const graph = options.graph ?? buildGraph(pipeline).graph;
  const settled = new Map<string, JobOutcome>();
  const order: string[] = [];
  // Предел не меньше единицы: ноль или отрицательное означали бы прогон, в
  // котором ни одна работа не может начаться.
  const limit = Math.max(1, Math.floor(options.concurrency ?? 1));
  const hooks = options.loopHooks ?? {};

  const loopStates = new Map<string, LoopState>();
  const stateOf = new Map<string, LoopState>();
  const mainIds = new Set(graph.main.map((job) => job.id));
  for (const loop of pipeline.loops) {
    // Работа второй фазы или уже занятая другим циклом участником не станет:
    // линт отклоняет такой документ, а планировщик не должен на нём падать.
    const members = loopMembersInOrder(graph, loop).filter((job) => mainIds.has(job.id) && !stateOf.has(job.id));
    if (members.length === 0) continue;
    const state: LoopState = {
      loop,
      members,
      iteration: 1,
      started: false,
      finished: false,
      passOutcomes: new Map(),
    };
    loopStates.set(loop.id, state);
    for (const member of members) stateOf.set(member.id, state);
  }
  const loopOutcomes = new Map<string, LoopOutcome>();

  /** Работа взята в оборот: запущена или уже отдала исход в этом проходе. */
  const claimed = new Set<string>();
  let stopping = false;
  /** Ошибка исполнителя, придержанная до завершения идущих работ. */
  let failure: unknown;

  const settlePlain = async (job: Job, outcome: JobOutcome): Promise<void> => {
    settled.set(job.id, outcome);
    order.push(job.id);
    await options.onSettled?.(job, outcome);
    // Неустранимый отказ бэкенда останавливает прогон и мимо `fail_fast:
    // false` — следующая работа упёрлась бы в тот же самый упор.
    if (isFailure(outcome.status) && (pipeline.failFast || isUnrunnable(outcome.cause))) {
      stopping = true;
    }
  };

  const settle = async (job: Job, outcome: JobOutcome): Promise<void> => {
    const state = stateOf.get(job.id);
    if (state === undefined || state.finished) {
      await settlePlain(job, outcome);
      return;
    }
    // Исход участника открытого прохода промежуточный: ни `fail_fast`, ни
    // остальной граф его не видят, пока цикл не вынесет вердикт.
    state.passOutcomes.set(job.id, outcome);
    await options.onSettled?.(job, outcome);
    if (state.members.every((member) => state.passOutcomes.has(member.id))) await closePass(state);
  };

  /** Исходы, на которые смотрят условия и зависимые: участник открытого цикла — в текущем проходе. */
  const outcomeOf = (id: string): JobOutcome | undefined => {
    const state = stateOf.get(id);
    return state !== undefined && !state.finished ? state.passOutcomes.get(id) : settled.get(id);
  };

  const isReady = (job: Job): boolean => {
    const state = stateOf.get(job.id);
    return (graph.dependencies.get(job.id) ?? []).every((id) => {
      // Участнику нужны исходы текущего прохода, внешней работе — только
      // вынесенные циклом; `settled` отдаёт участника лишь после вердикта.
      const inSameLoop = state !== undefined && !state.finished && stateOf.get(id) === state;
      return inSameLoop ? state.passOutcomes.has(id) : settled.has(id);
    });
  };

  const decide = (job: Job, dependencies: readonly string[]): JobOutcome | undefined => {
    const outcomes = dependencies.map((id) => outcomeOf(id)).filter((item) => item !== undefined);

    // Пропущенная зависимость не блокирует: иначе один флаг, отключающий
    // ревью, тихо отменял бы и архивацию. Исключение — `on: always`: она
    // обещает выполниться при любом исходе зависимостей, в том числе когда
    // пропущены все (пусты все слоты, и сборка итога всё равно нужна); её
    // отсекает только собственное `if`.
    const failed = outcomes.filter((outcome) => isFailure(outcome.status));
    const skipped = outcomes.filter((outcome) => outcome.status === 'skipped');

    // Цикл, кончившийся не `done`, для внешней работы — отказавшая зависимость
    // сверх исходов участников: последний проход мог состоять из одних успехов,
    // а `while` по `output` всё равно не сойтись.
    const ownLoop = stateOf.get(job.id);
    const failedLoops = new Set(
      dependencies.flatMap((id) => {
        const state = stateOf.get(id);
        if (state === undefined || state === ownLoop) return [];
        const outcome = loopOutcomes.get(state.loop.id);
        return outcome !== undefined && isFailure(outcome.status) ? [state.loop.id] : [];
      }),
    );
    const failures = failed.length + failedLoops.size;

    // Неуспешный цикл — зависимость, которая отказала, а не пропущена: даже
    // если в его последнем проходе зависимый участник пропущен, `on: failure`
    // обязана разобрать этот отказ.
    if (
      job.on !== 'always' &&
      dependencies.length > 0 &&
      skipped.length === outcomes.length &&
      outcomes.length > 0 &&
      failedLoops.size === 0
    ) {
      return { status: 'skipped', reason: 'все зависимости пропущены', skip: 'condition' };
    }

    if (job.on === 'success' && failures > 0) {
      return { status: 'skipped', reason: `on: success, зависимость завершилась отказом`, skip: 'condition' };
    }
    if (job.on === 'failure' && failures === 0) {
      return { status: 'skipped', reason: 'on: failure, отказов не было', skip: 'condition' };
    }

    if (job.if !== undefined && !evaluate(parseExpression(job.if), conditionScope(job))) {
      return { status: 'skipped', reason: `if: ${job.if}`, skip: 'condition' };
    }

    return undefined;
  };

  const jobEntry = (id: string, outcome: JobOutcome): Record<string, unknown> => {
    // Данные публикуются по ходу работы и переживают её отказ: они
    // рассказывают, что работа успела сделать, — в том числе и о том, на
    // чём она встала. Выход упавшей работы, в отличие от них, не
    // публикуется вовсе.
    const data = options.jobData?.(id);
    return {
      status: outcome.status,
      ...(outcome.status === 'success' && outcome.output !== undefined ? { output: outcome.output } : {}),
      ...(data === undefined || Object.keys(data).length === 0 ? {} : { data }),
    };
  };

  const conditionScope = (job?: Job): Record<string, unknown> => {
    const jobs: Record<string, unknown> = {};
    for (const [id, outcome] of settled) jobs[id] = jobEntry(id, outcome);
    // Участник видит исходы своего прохода; работа вне цикла — только вынесенные.
    const state = job === undefined ? undefined : stateOf.get(job.id);
    if (state !== undefined && !state.finished) {
      for (const [id, outcome] of state.passOutcomes) jobs[id] = jobEntry(id, outcome);
    }
    return { inputs: pipeline.inputs, jobs, ...(options.scopeExtras ?? {}) };
  };

  /**
   * Продолжать ли цикл, если ничего внешнего не остановило его. Область
   * `while` — участники прохода и `loop.*`: внешняя величина за проход не
   * меняется и давала бы цикл, который выходит сразу или не выходит никогда.
   */
  const keepsGoing = (state: LoopState): boolean => {
    const { loop } = state;
    if (loop.while === undefined) {
      return [...state.passOutcomes.values()].some((outcome) => outcome.status === 'failed');
    }
    const jobs: Record<string, unknown> = {};
    for (const [id, outcome] of state.passOutcomes) jobs[id] = jobEntry(id, outcome);
    return evaluate(parseExpression(loop.while), {
      jobs,
      loop: { id: loop.id, iteration: state.iteration, max_iterations: loop.maxIterations },
    });
  };

  /** Вердикт на границе прохода, в порядке design.md (решение 3). */
  const verdictOf = (
    state: LoopState,
  ): (Omit<LoopOutcome, 'id' | 'jobs' | 'iterations' | 'maxIterations'> & { iterations?: number }) | 'continue' => {
    const { loop } = state;
    const outcomes = [...state.passOutcomes.values()];

    if (options.signal?.aborted === true || outcomes.some((outcome) => outcome.status === 'canceled')) {
      return { verdict: 'canceled', status: 'canceled', reason: 'прогон отменён', cause: HaltCause.canceled };
    }
    if (outcomes.some((outcome) => outcome.status === 'budget_exceeded') || hooks.budgetExhausted?.(loop) === true) {
      return {
        verdict: 'exhausted',
        status: 'budget_exceeded',
        reason: 'исчерпан бюджет цикла или участника',
        cause: HaltCause.budgetExceeded,
      };
    }
    const unrunnable = outcomes.find((outcome) => isUnrunnable(outcome.cause));
    if (unrunnable !== undefined) {
      return {
        verdict: 'exhausted',
        status: 'failed',
        ...(unrunnable.reason === undefined ? {} : { reason: unrunnable.reason }),
        ...(unrunnable.cause === undefined ? {} : { cause: unrunnable.cause }),
      };
    }
    const reusedIterations = hooks.reused?.(loop);
    if (reusedIterations !== undefined) {
      return {
        verdict: 'done',
        status: 'success',
        reason: 'цикл переиспользован из прошлого прогона',
        iterations: reusedIterations,
      };
    }
    // Прогон останавливается после отказа вне цикла: проход, погашенный
    // остановкой, ничего не проверил и сходимостью не считается, а новый
    // проход погасила бы та же остановка. Причина отказа — внешняя, и
    // `loop_exhausted` её не заслоняет.
    if (stopping && (outcomes.some((outcome) => outcome.skip === 'halted') || keepsGoing(state))) {
      return { verdict: 'exhausted', status: 'failed', reason: 'прогон остановлен после отказа (fail_fast)' };
    }
    if (!keepsGoing(state)) {
      return { verdict: 'done', status: 'success', reason: 'условие продолжения ложно' };
    }
    if (state.iteration < loop.maxIterations) return 'continue';
    return {
      verdict: 'exhausted',
      status: 'failed',
      reason: `предел проходов исчерпан (${loop.maxIterations}), а условие продолжения всё ещё истинно`,
      cause: HaltCause.loopExhausted,
    };
  };

  const closePass = async (state: LoopState): Promise<void> => {
    const { loop } = state;
    const verdict = verdictOf(state);
    const goesOn = verdict === 'continue';
    await hooks.onPassFinished?.(loop, state.iteration, goesOn);

    if (goesOn) {
      state.passOutcomes = new Map();
      state.iteration += 1;
      for (const member of state.members) claimed.delete(member.id);
      await hooks.onPassStarted?.(loop, state.iteration);
      return;
    }

    // С этого момента исходы последнего прохода видит остальной граф.
    const last = state.passOutcomes;
    state.finished = true;
    for (const member of state.members) {
      const outcome = last.get(member.id);
      if (outcome === undefined) continue;
      settled.set(member.id, outcome);
      order.push(member.id);
    }
    const outcome: LoopOutcome = {
      id: loop.id,
      jobs: state.members.map((member) => member.id),
      iterations: state.iteration,
      maxIterations: loop.maxIterations,
      ...verdict,
    };
    loopOutcomes.set(loop.id, outcome);
    await hooks.onLoopFinished?.(outcome);

    // Отказ цикла и отказ участника последнего прохода останавливают прогон
    // так же, как отказ обычной работы.
    const failedMember = [...last.values()].some(
      (item) => isFailure(item.status) && (pipeline.failFast || isUnrunnable(item.cause)),
    );
    if (failedMember || (isFailure(outcome.status) && (pipeline.failFast || isUnrunnable(outcome.cause)))) {
      stopping = true;
    }
  };

  /** Первый проход начинается, когда взят в оборот первый участник. */
  const ensureStarted = async (state: LoopState): Promise<void> => {
    if (state.started) return;
    state.started = true;
    await hooks.onLoopStarted?.(state.loop);
    await hooks.onPassStarted?.(state.loop, 1);
  };

  const runPhase = async (jobs: readonly Job[], phase: 'main' | 'terminal'): Promise<void> => {
    /** Идущие работы: обещание удаляет себя из множества по завершении. */
    const running = new Map<string, Promise<void>>();
    /** Занятые деревья: дерево → идущая в нём работа. */
    const busyTrees = new Map<string, string>();
    const treeFree = (job: Job): boolean => {
      const tree = options.treeOf?.(job);
      return tree === undefined || !busyTrees.has(tree);
    };

    for (;;) {
      while (running.size < limit) {
        const job = jobs.find((candidate) => !claimed.has(candidate.id) && isReady(candidate) && treeFree(candidate));
        if (job === undefined) break;

        claimed.add(job.id);
        const dependencies = graph.dependencies.get(job.id) ?? [];
        const state = stateOf.get(job.id);
        if (state !== undefined) await ensureStarted(state);
        const pass: LoopPass | undefined =
          state === undefined ? undefined : { loop: state.loop, iteration: state.iteration };

        // Отмена, условия и остановка после отказа решаются в момент запуска,
        // а не при сборе множества готовых: работа, ставшая готовой, пока шла
        // соседняя, обязана увидеть её исход — иначе решение зависело бы от
        // того, кто когда попал в выборку.
        if (options.signal?.aborted === true && phase === 'main') {
          await settle(job, {
            status: 'canceled',
            reason: 'прогон отменён',
            cause: HaltCause.canceled,
          });
          continue;
        }

        // Условия проверяются раньше fail_fast по двум причинам. Во-первых,
        // «зависимость упала» объясняет пропуск точнее, чем «остановлено после
        // отказа». Во-вторых, остановка касается продолжения работы, а не её
        // разбора: работы с on: failure и on: always должны выполниться и после
        // отказа, иначе разбирать его будет нечем. По той же причине
        // `on: always` не пропускается, даже когда погашены все её
        // зависимости (в том числе остановкой `halted`): fail_fast гасит
        // только `on: success`.
        const decision = decide(job, dependencies);
        if (decision !== undefined) {
          await settle(job, decision);
          continue;
        }

        if (stopping && phase === 'main' && job.on === 'success') {
          await settle(job, { status: 'skipped', reason: 'остановлено после отказа (fail_fast)', skip: 'halted' });
          continue;
        }

        const scope = conditionScope(job);
        const tree = options.treeOf?.(job);
        if (tree !== undefined) busyTrees.set(tree, job.id);
        const task: Promise<void> = (async () => {
          try {
            await settle(job, await options.execute(job, scope, pass));
          } catch (error) {
            // Работа, не отдавшая исхода вовсе, — дефект исполнителя. Ошибка
            // придерживается до завершения остальных идущих: оборвать их на
            // середине хуже, чем сообщить о ней мгновением позже.
            failure ??= error;
            stopping = true;
          }
        })().then(() => {
          // Вердикт, закрывший проход внутри `settle`, уже мог запустить
          // участника следующего прохода под тем же идентификатором.
          if (running.get(job.id) === task) running.delete(job.id);
          if (tree !== undefined && busyTrees.get(tree) === job.id) busyTrees.delete(tree);
        });
        running.set(job.id, task);
      }

      if (running.size === 0) break;
      // Ждём ближайшего завершения, а не всех: место освобождается по одному,
      // и следующая готовая работа занимает его сразу.
      await Promise.race(running.values());
    }

    // Дефект исполнителя — не исход графа: приписывать работе, упавшей с
    // ошибкой, пропуск «зависимости не разрешились» значило бы записать в
    // состояние прогона неправду, а её соседям по второй фазе — дать
    // основание считать граф исполненным. Ошибка уходит наверх, как только
    // идущие работы отдали исход.
    if (failure !== undefined) return;

    // Работы, до которых очередь не дошла: при неразрешимом графе линт бы уже
    // сообщил, здесь это страховка от бесконечного ожидания. Незавершённый
    // проход цикла сбрасывается в общие исходы как есть, без вердикта.
    for (const job of jobs) {
      if (settled.has(job.id)) continue;
      const state = stateOf.get(job.id);
      if (state !== undefined && !state.finished) {
        state.finished = true;
        for (const [id, outcome] of state.passOutcomes) {
          settled.set(id, outcome);
          order.push(id);
        }
      }
      if (!settled.has(job.id)) {
        await settlePlain(job, { status: 'skipped', reason: 'зависимости не разрешились', skip: 'halted' });
      }
    }
  };

  // Вторая фаза начинается только после того, как основной граф исполнился
  // весь: работа с `needs: all` зависит от всех разом, и начать её вперемешку
  // с идущими значило бы дать ей неполную картину.
  await runPhase(graph.main, 'main');
  if (failure !== undefined) throw failure;
  await runPhase(graph.terminal, 'terminal');
  if (failure !== undefined) throw failure;

  const results: SettledJob[] = order.map((id) => ({
    id,
    ...(settled.get(id) as JobOutcome),
  }));
  const loops = [...loopOutcomes.values()];

  return { settled: results, loops, status: overallStatus(results, loops) };
}

/** Причина, по которой любая следующая работа упёрлась бы в то же самое. */
function isUnrunnable(cause: HaltCauseValue | undefined): boolean {
  return cause === HaltCause.backendRateLimited || cause === HaltCause.backendUnauthenticated;
}

/**
 * Итог прогона. Отмена важнее исчерпания бюджета, а бюджет — важнее обычного
 * отказа: пользователю нужно знать самую внешнюю причину остановки. Исход
 * цикла учитывается наравне с исходами работ.
 */
export function overallStatus(
  settled: readonly SettledJob[],
  loops: readonly Pick<LoopOutcome, 'status'>[] = [],
): StatusValue {
  const statuses = [...settled.map((job) => job.status), ...loops.map((loop) => loop.status)];
  if (statuses.includes('canceled')) return 'canceled';
  if (statuses.includes('budget_exceeded')) return 'budget_exceeded';
  if (statuses.includes('failed')) return 'failed';
  return 'success';
}
