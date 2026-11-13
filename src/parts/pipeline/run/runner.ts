import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  createAnchorer,
  detectAnchorKind,
  type Anchor,
  type AnchorKind,
  type TreeAnchorer,
} from '../domain/anchor/index.js';
import { fingerprintInputs } from '../domain/anchor/fingerprint.js';
import { effectivePermissions } from '../backend/permissions.js';
import { resolveAdapter } from '../backend/registry.js';
import { createBackendSlots, type BackendSlots } from '../backend/slots.js';
import {
  BACKEND_REFUSAL_PREDICATE,
  describeRefusal,
  extractRefusal,
  structuredOutputMode,
  sumUsage,
  type BackendAdapter,
  type BackendRefusal,
} from '../backend/types.js';
import {
  UsageAccumulator,
  ZERO_USAGE_SNAPSHOT,
  describeExceeded,
  type BudgetScope,
  type Exceeded,
  type UsageSnapshot,
} from './budget/accumulator.js';
import type { Config } from '../config/resolve.js';
import { inline } from '../domain/text.js';
import { formatDuration } from '../../../kernel/units.js';
import { assembleContext, type UpstreamOutput } from '../domain/context/assemble.js';
import { resolveLate, type JobScopeEntry, type LateWithheld } from '../document/late.js';
import { ExitCode, BurnexError, isBurnexError, type ExitCodeValue } from '../../../kernel/errors.js';
import { createSessionRegistry, executeAgentStep } from './exec/agentStep.js';
import { executeReviewStep, type DefenderChoice } from './exec/reviewStep.js';
import { executeDiscussStep } from './exec/discussStep.js';
import { defenderSession, type ForkReason, type FreshReason } from '../steps/review/defend.js';
import { agentCallsOf } from '../steps/review/participants.js';
import { describeStrategyUnresolved } from '../document/reviewStrategy.js';
import { buildStepEnv, injectedVariables, type EnvLayers } from './exec/env.js';
import { validateEnvOverrides } from './envOverrides.js';
import { assertShadowDeclarations, describeBuiltinAction, recordShadowAction } from './shadow.js';
import { backendsInUse } from '../secrets/declaration.js';
import { namedSecrets, resolveBackendCredentials, resolveSecrets } from './secrets.js';
import { executeRunStep } from './exec/runStep.js';
import { runJudgePass } from './exec/judgePass.js';
import { planAttempt } from './exec/attempts.js';
import { isUnpricedCall, loadPriceCatalog, type PriceCatalog } from './budget/priceCatalog.js';
import { runPluginStep } from './exec/pluginStep.js';
import { evaluatePredicates, validateAgainstSchema, validateAgainstSchemaFile } from '../expect/evaluate.js';
import { createKnowledgeSource } from '../domain/knowledge/source.js';
import type { KnowledgeSource } from '../domain/knowledge/types.js';
import { buildGraph, loopEntryPoints, loopExit, upstreamOutputs, type Graph } from '../domain/graph.js';
import { bookkeep } from './bookkeeping.js';
import { buildIterationNote, type IterationNoteTruncation } from './iterationNote.js';
import { locateEngine, isEditableEngine, pinEngine, type EngineInfo, type EngineLocation } from './engine.js';
import { HaltCause, type HaltCauseValue } from './halt.js';
import { type CompletedJob as TreeCompletion } from './trees.js';

/** Каталог и последний якорь завершившейся работы. */
type CompletedJob = Omit<TreeCompletion, 'frozen'>;
import { RunTrees } from './runTrees.js';
import { builtinRegistry } from '../../builtin.js';
import { DecisionHalt, hasStepExecutor, type StepKindDecisionRequest, type StepKindDecisionResult } from '../contract.js';
import { contributionOwner, formerStepKindOwner, stepKindNames, type Registry } from '../../../kernel/registry.js';
import { preflight } from './preflight.js';
import { createScope, type ResourceScope } from './scope.js';
import { buildInterruptedNote, buildPreviousFailure } from './previousFailure.js';
import { createAwaitingState } from './awaitingState.js';
import { computeWaitId, pipelineStepAddresses, toDecisionRecord } from './decision.js';
import { carriedKey, collectPendingDecisions, type CarriedDecision } from './decisionCarry.js';
import { waitForDecision } from './decisionWait.js';
import type { ResumePlan, SourceRun, StepPlan } from './resumePlan.js';
import { computeStepKey, stepBackendCommands, upstreamForKey } from './stepKey.js';

import { syncLiveFiles, writebackLiveFiles } from './liveFiles.js';
import { createWaitState } from './waitState.js';
import {
  jobDataPath,
  readJobData,
  readJobOutputsText,
  resetJobData,
  resetJobOutputs,
  writeJobDataUnchecked,
} from './journal/data.js';
import { jobDir, jobOutputsPath, jobScratchDir, shortRunId } from './journal/paths.js';
import { MAX_OUTPUT_KEYS, needsVarName, parseJobOutputs, type OutputPolicy } from './jobOutputs.js';
import { findStepDir } from './journal/reader.js';
import { appendUsageRecord, usageRecord } from './journal/usageStore.js';
import { RunJournal } from './journal/writer.js';
import { jobLockHash, serializeLock } from '../document/lock.js';
import { describeScriptUnresolved } from '../document/expand.js';
import type {
  AgentStep,
  ReviewStep,
  DiscussStep,
  ReviewParticipant,
  ImplementerRef,
  ContextEntry,
  EffortOrigin,
  ExpandedPipeline,
  Job,
  Loop,
  Pipeline,
  ScriptUnresolved,
  Step,
} from '../document/model.js';
import { DEFENDER_ID, isPanelStep } from '../document/model.js';
import type {
  AwaitingDecision,
  BudgetExceededState,
  DecisionRecord,
  Event,
  JobRecord,
  LoopRecord,
  PredicateResult,
  RunManifest,
  RunStatus,
  StatusValue,
  StepRecord,
  Usage,
} from './journal/schema.js';
import { sharedTreeOf, treeKey } from './trees.js';
import { isRetryableJobOutcome, schedule, type JobOutcome, type LoopOutcome, type LoopPass } from './scheduler.js';

/** Адрес запущенного в решении шага — с идентичностью попытки и итерации цикла. */
export interface DecisionIdentity {
  readonly job: string;
  readonly step: string;
  readonly attempt: number;
  /** Итерация цикла until, если работа его объявляет. */
  readonly iteration?: number;
}

/** Запись состоявшегося отказа обещания решения — «кто и чем» для защёлки прогона. */
export interface DecisionLatchValue {
  readonly job: string;
  readonly step: string;
  readonly record: DecisionRecord;
}


export interface RunOptions {
  readonly expanded: ExpandedPipeline;
  readonly config: Config;
  readonly projectRoot: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Переопределения объявленного верхнеуровневого `env:` на этот прогон
   * (`run --env`). Возобновление без собственного значения берёт их из
   * манифеста исходного прогона: у `resume` флага нет, а прогон, начатый с
   * переопределением, обязан продолжиться с ним же.
   */
  readonly envOverrides?: Readonly<Record<string, string>>;
  /**
   * Агент, выбранный `run --agent`: runner его только записывает в манифест —
   * конфигурацию с этим слоем вызывающий разрешает до раскрытия пайплайна.
   * Возобновление без собственного значения берёт имя из исходного манифеста.
   */
  readonly agentOverride?: string;
  /**
   * Адрес `<пакет>:<имя>`, которым пайплайн был назван при запуске. Возобновление
   * берёт его из манифеста исходного прогона: пайплайн разрешается по сохранённому
   * пути, но адрес остаётся в записи.
   */
  readonly pipelineAddress?: string;
  /**
   * Режим прогона (`run --shadow`): внешние действия объявленных шагов
   * записываются, а не совершаются. Возобновление без собственного значения
   * берёт режим из манифеста исходного прогона — флага у `resume` нет.
   */
  readonly mode?: 'shadow';
  /**
   * Происхождение прогона по расписанию (`run --scheduled`). В отличие от
   * `mode`, возобновление его не наследует: возобновление — действие человека,
   * и `resumed_from` уже говорит, откуда прогон взялся.
   */
  readonly trigger?: RunManifest['trigger'];
  /** Подмена адаптера бэкенда: тесты подставляют поддельный. */
  readonly adapterFor?: (name: string) => BackendAdapter;
  /**
   * Реестр вкладов: им разрешаются адаптеры бэкендов и вычисляются предикаты
   * плагинов. Без значения — только встроенные вклады: внешний потребитель
   * `stepcast` как библиотеки о плагинах знать не обязан.
   */
  readonly registry?: Registry;
  /**
   * Подмена якоря состояния дерева. Нужна, чтобы проверить главное свойство
   * учёта: отказ фиксации не меняет исход прогона.
   */
  /** План переиспользования: исполнитель не знает, что это возобновление. */
  readonly resume?: ResumeContext;
  readonly anchorerFor?: (options: {
    readonly dir: string;
    readonly stateDir: string;
    readonly kind: AnchorKind;
    readonly scope: string;
    readonly repoDir?: string;
    readonly nested?: readonly string[];
  }) => TreeAnchorer;
  /**
   * Подмена расположения движка. Тот же приём, что у `anchorerFor`: настоящий
   * `locateEngine()` всегда укажет на пакет, которым гоняются тесты, — а
   * сценариям снимка нужен движок то внутри временного дерева проекта, то
   * снаружи него, то в его `node_modules`.
   */
  readonly engineLocator?: () => EngineLocation;
  /**
   * Подмена каталога цен: тесты оценивают по своим ценам, а не по поставляемым,
   * которые правятся по тарифам провайдеров.
   */
  readonly priceCatalog?: PriceCatalog;
  /**
   * Наблюдение за потоком событий: вызывается синхронно с записью каждого
   * события в журнал, рядом со снимком накопленного расхода прогона.
   * Событие `run.started` доставляется раньше, чем накопитель расхода
   * создан, — со снимком `ZERO_USAGE_SNAPSHOT`, а не падением.
   */
  readonly onEvent?: (event: Event, usage: UsageSnapshot) => void;
  /**
   * Интервал опроса каталога решений — константа `DEFAULT_DECISION_POLL_MS`,
   * подменяемая изнутри ради проверок (design.md изменения
   * `user-decision-steps`, решение 9), тем же приёмом, каким проверки демона
   * подменяют порождение процесса.
   */
  readonly decisionPollIntervalMs?: number;
}

export interface ResumeContext {
  readonly plan: ResumePlan;
  readonly source: SourceRun;
}

export interface RunResult {
  readonly journal: RunJournal;
  readonly status: StatusValue;
  readonly exitCode: ExitCodeValue;
  /**
   * Денежный потолок объявлен, но ни одна попытка за прогон не сообщила
   * цены: потолок фактически не применялся. Код возврата от этого не меняется.
   */
  readonly costLimitUnapplied: boolean;
  /**
   * Просьба о перезапуске — эффект `restart` решения человека (design.md
   * изменения `user-decision-steps`, решение 4). Цепочку ведёт вызывающая
   * команда (`burnex run`/`burnex resume`), а не сам `runPipeline`: она
   * планирует возобновление с этого места и исполняет его тем же процессом.
   */
  readonly restart?: { readonly from: string };
}

const EXIT_BY_STATUS: Record<string, ExitCodeValue> = {
  success: ExitCode.ok,
  skipped: ExitCode.ok,
  failed: ExitCode.jobFailed,
  budget_exceeded: ExitCode.budgetExceeded,
  canceled: ExitCode.canceled,
};

/**
 * Код возврата прогона. Отказ аутентификации отличает неисполнимость
 * окружения от отказа самого пайплайна: он переопределяет код по причине, а
 * не по статусу работы, который у обоих одинаково `failed`. Отмена
 * пользователем остаётся самой внешней причиной — `overallStatus` ставит её
 * выше отказа, и код возврата не должен с ним расходиться.
 */
export function resolveExitCode(
  status: string,
  settled: readonly { readonly cause?: string }[],
): ExitCodeValue {
  const authRefused =
    status !== 'canceled' &&
    settled.some((job) => job.cause === HaltCause.backendUnauthenticated);
  return authRefused ? ExitCode.backendUnavailable : (EXIT_BY_STATUS[status] ?? ExitCode.jobFailed);
}

export async function runPipeline(options: RunOptions): Promise<RunResult> {
  const { pipeline } = options.expanded;
  const { config } = options;

  const envOverrides = options.envOverrides ?? options.resume?.source.manifest.env_overrides ?? {};
  // Библиотечный вызов обходит `burnex run`, а молча проигнорированное
  // переопределение хуже отказа.
  validateEnvOverrides(envOverrides, pipeline.env);

  const mode = options.mode ?? options.resume?.source.manifest.mode;
  const agentOverride = options.agentOverride ?? options.resume?.source.manifest.agent_override;
  const pipelineAddress = options.pipelineAddress ?? options.resume?.source.manifest.pipeline_address;
  // Та же проверка стоит в `run.ts` до `--dry-run`; здесь её проходят
  // возобновление и библиотечный вызов, у которых `run.ts` нет.
  if (mode === 'shadow') assertShadowDeclarations(pipeline);

  // До создания журнала: отказ на этом этапе не оставляет за собой директории
  // прогона, потому что прогона ещё нет.
  preflight({
    expanded: options.expanded,
    projectRoot: options.projectRoot,
    cwd: options.cwd,
    runsRoot: config.runs.root,
    ...(config.project.nestedRepos === undefined ? {} : { nestedRepos: config.project.nestedRepos }),
  });

  // Каталог цен читается один раз и до журнала: повреждённый файл поставки
  // останавливает старт названной ошибкой, не оставляя каталога прогона.
  const priceCatalog = options.priceCatalog ?? loadPriceCatalog();

  // Умолчание реестра раскрывается один раз на прогон: каждый вызов
  // `builtinRegistry()` поднимает корневой контекст, а спрашивают его и
  // разрешение секретов, и адаптер бэкенда, и вычисление предикатов каждого
  // шага (design.md изменения `cordis-kernel-daemon`, Решение 13).
  const registry = options.registry ?? builtinRegistry();

  // Секреты разрешаются до `RunJournal.create`, как и предстартовая проверка:
  // прогон без секрета не начинается и не оставляет за собой каталога. Путь
  // возобновления — этот же: `burnex resume` приходит сюда с планом, а
  // значения берутся заново, поэтому ротация токена ключ шага не меняет.
  //
  // Без названных секретов ожидания нет вовсе: журнал по-прежнему создаётся
  // в том же синхронном отрезке, что и до этого изменения — вызывающие
  // (тесты, демон) читают каталог прогона сразу после вызова `runPipeline`.
  const secretValues: ReadonlyMap<string, string> =
    namedSecrets(pipeline).length === 0
      ? new Map<string, string>()
      : await resolveSecrets({
          pipeline,
          registry,
          projectRoot: options.projectRoot,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });

  // Учётные данные бэкендов — тот же этап и те же правила отказа
  // (`secrets-keychain-provider`, design.md, решение 3). Без объявленных
  // записей у используемых бэкендов ожидания нет, как и у секретов.
  const usesCredentials = [...backendsInUse(pipeline, config.defaults.agent)].some(
    (name) => Object.keys(config.backends[name]?.credentials ?? {}).length > 0,
  );
  const backendCredentials: ReadonlyMap<string, Readonly<Record<string, string>>> = usesCredentials
    ? await resolveBackendCredentials({
        pipeline,
        config,
        registry,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    : new Map();

  // Способ фиксации выбирается один раз на прогон: якоря разных способов
  // несравнимы, и смешивать их в пределах прогона нельзя.
  const anchorKind = detectAnchorKind(options.cwd, config.project.nestedRepos);
  const sourceCommits: Readonly<Record<string, string>> =
    anchorKind === 'manifest'
      ? {}
      : Object.fromEntries(
          ['.', ...(config.project.nestedRepos ?? [])].flatMap((relativePath) => {
            const dir = relativePath === '.' ? options.cwd : join(options.cwd, relativePath);
            try {
              const commit = execFileSync('git', ['-C', dir, 'rev-parse', '--verify', 'HEAD'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
              }).trim();
              return [[relativePath, commit]];
            } catch {
              // Репозиторий без первого коммита допустим для cwd/copy. Если
              // работа запросит worktree, прежняя предстартовая проверка
              // назовёт невозможность точнее, чем запись манифеста.
              return [];
            }
          }),
        );

  const lock = serializeLock(pipeline);
  const lockHash = createHash('sha256').update(lock).digest('hex').slice(0, 16);

  // Накопитель расхода создаётся ниже, после первых событий манифеста —
  // `run.started` доставляется наблюдателю раньше, чем он существует.
  // Ссылка через объект, а не порядком создания: событие не должно ждать
  // накопитель, а накопитель не должен создаваться раньше журнала.
  const usageForEvents: { current: UsageAccumulator | undefined } = { current: undefined };
  const journal = RunJournal.create({
    runsRoot: config.runs.root,
    projectRoot: options.projectRoot,
    secrets: [...secretValues.values(), ...[...backendCredentials.values()].flatMap((vars) => Object.values(vars))],
    ...(options.onEvent === undefined
      ? {}
      : {
          onEvent: (event) =>
            options.onEvent?.(event, usageForEvents.current?.snapshot() ?? ZERO_USAGE_SNAPSHOT),
        }),
  });
  journal.writeLock(lock);

  let manifest: RunManifest = {
    run_id: journal.paths.runId,
    pipeline: pipeline.name,
    pipeline_file: pipeline.file,
    ...(pipelineAddress === undefined ? {} : { pipeline_address: pipelineAddress }),
    lock_hash: lockHash,
    project_root: options.projectRoot,
    workspace: workspaceRecord(pipeline.workspace),
    anchor_kind: anchorKind,
    // Список пишется всегда, включая пустой: «плагинов не было» и «версия
    // движка о них не знала» — разные утверждения, и различать их читателю
    // журнала нужно.
    plugins: (options.registry?.plugins ?? []).map((plugin) => ({ ...plugin })),
    ...(config.project.nestedRepos === undefined ? {} : { nested_repos: [...config.project.nestedRepos] }),
    ...(Object.keys(sourceCommits).length === 0 ? {} : { source_commits: sourceCommits }),
    ...(options.resume === undefined ? {} : { resumed_from: options.resume.source.manifest.run_id }),
    inputs: pipeline.inputs,
    ...(Object.keys(envOverrides).length === 0 ? {} : { env_overrides: envOverrides }),
    ...(mode === undefined ? {} : { mode }),
    ...(agentOverride === undefined ? {} : { agent_override: agentOverride }),
    ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
    git: {},
    backends: Object.fromEntries(
      Object.entries(config.backends).map(([name, backend]) => [name, { command: backend.command }]),
    ),
    started_at: new Date().toISOString(),
    // До запуска первой работы: планировщик расписания отличает идущий
    // прогон от брошенного по факту существования этого процесса, а не по
    // свежести записи в журнале (шаг агента легко молчит час).
    pid: process.pid,
  };
  journal.writeManifest(manifest);
  journal.event({ kind: 'run.started', pipeline: pipeline.name, run_id: journal.paths.runId });

  // Движок фиксируется здесь: каталог прогона и журнал уже на диске (снимку
  // есть куда лечь), а первая работа ещё не создана — снимок обязан
  // существовать до первого рекурсивного вызова $BURNEX_BIN (design.md,
  // решение 5). Отказ снятия останавливает прогон конфигурационной ошибкой:
  // молчаливый откат к незафиксированному движку — ровно то поведение,
  // против которого изменение и делается.
  const engineLocation = options.engineLocator?.() ?? locateEngine();
  const engineEditable = isEditableEngine({
    engineRoot: engineLocation.root,
    projectRoot: options.projectRoot,
  });
  const engine: EngineInfo = engineEditable
    ? {
        root: engineLocation.root,
        entry: pinEngine({ engine: engineLocation, snapshotDir: journal.paths.engine }),
        pinned: true,
      }
    : { root: engineLocation.root, entry: engineLocation.entry, pinned: false };

  // Второй манифест несёт то же, что первый, плюс движок: поле пишется у
  // всякого прогона, включая обычную установку (`pinned: false`) — «движок
  // лежал вне дерева» и «версия движка не умела писать это поле» разные
  // утверждения (run-journal, «Манифест прогона записывает движок»).
  manifest = { ...manifest, engine };
  journal.writeManifest(manifest);
  if (engine.pinned) {
    journal.event({ kind: 'engine.pinned', root: engine.root, path: journal.paths.engine });
  }

  const usage = new UsageAccumulator(
    (backend) => config.backends[backend]?.cacheReadWeight ?? 1,
    priceCatalog.asOf,
  );
  usageForEvents.current = usage;
  const records = new Map<string, JobRecord>(
    pipeline.jobs.map((job) => [
      job.id,
      { id: job.id, status: 'pending', ...(job.lane === undefined ? {} : { lane: job.lane }), steps: [] },
    ]),
  );
  const outputs: UpstreamOutput[] = [];
  const adapters = new Map<string, BackendAdapter>();
  const reportedDenials = new Set<string>();
  const graph = buildGraph(pipeline).graph;
  // Каталог и последний якорь каждой завершившейся работы: источник, из
  // которого наследование выбирает и разрешает дерево зависимой работы.
  // Читается по зависимостям работы, а они к её началу уже отдали исход, —
  // одновременность соседей записи в карте не касается.
  const completedWorkspaces = new Map<string, CompletedJob>();
  const trees = new RunTrees({
    pipeline,
    graph,
    cwd: options.cwd,
    journal,
    anchorKind,
    ...(config.project.nestedRepos === undefined ? {} : { nestedRepos: config.project.nestedRepos }),
    sourceCommits,
    completed: completedWorkspaces,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.anchorerFor === undefined ? {} : { anchorerFor: options.anchorerFor }),
  });
  // Цикл в ходе прогона: то, что планировщик не хранит, а исполнению и
  // состоянию нужно — начало первого прохода, дерево прошлого прохода, исход.
  const loops = new Map<string, LoopRuntime>(
    pipeline.loops.map((loop) => [
      loop.id,
      { loop, startedAt: undefined, iterations: 0, previous: new Map(), outcome: undefined, executed: false },
    ]),
  );

  // Момент пробуждения: дописывается на диск до начала сна и снимается после
  // продолжения — состояние спящего прогона доступно снаружи, пока он спит.
  const waitState = createWaitState();

  // Ожидания решения человека, идущие прямо сейчас (user-decision-steps,
  // design.md решение 2) — тем же приёмом, что и `waitState` у `wake_at`.
  const awaitingDecisions = createAwaitingState();
  // Решения, записанные исходному прогону и не применённые им: возобновление
  // переносит их сюда и применяет ожиданию того же шага (дельта `run-resume`).
  // Наполняется ниже, вместе с прочим переносом из исходного прогона; ключ —
  // `работа/шаг`, потому что попытка и итерация у нового прогона свои.
  const carriedDecisions = new Map<string, CarriedDecision>();
  // Защёлка эффекта решения (design.md, решение 5): первый отказ обещания
  // `reject`/`restart` останавливает прогон, и второй такой же не переписывает
  // его — так же, как `budgetExceededLatch` держит первое превышение.
  const decisionLatch: { value: DecisionLatchValue | undefined } = { value: undefined };
  // Внутренний контроллер отмены: внешний сигнал (Ctrl-C) взводит его, и
  // отказ решения — тоже, так что оба повода останавливают прогон одним и тем
  // же `context.signal`, не заводя второго пути отмены.
  const runController = new AbortController();
  const onExternalAbort = (): void => runController.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) runController.abort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const knownStepAddresses = pipelineStepAddresses(pipeline);

  // Общий на прогон счёт мест по имени бэкенда: один агентский шаг и вызов
  // судьи того же бэкенда делят предел, а не удваивают его.
  const backendSlots = createBackendSlots((name) => config.backends[name]?.concurrency ?? 1);

  const context: RunContext = {
    ...options,
    ...(mode === undefined ? {} : { mode }),
    envOverrides,
    registry,
    secretValues,
    backendCredentials,
    journal,
    records,
    usage,
    outputs,
    adapters,
    backendSlots,
    reportedDenials,
    reportedWithheld: new Set<string>(),
    sessions: createSessionRegistry(),
    pipelineContextSent: new Set<string>(),
    lockHash,
    anchorKind,
    sourceCommits,
    engine,
    priceCatalog,
    runCwd: options.cwd,
    graph,
    completedWorkspaces,
    trees,
    loops,
    failureNote: { pending: options.resume === undefined ? undefined : previousFailureText(options.resume) },
    budgetExceededLatch: { value: undefined },
    decisionLatch,
    ...(options.resume === undefined
      ? {}
      : { observedInputs: options.resume.plan.observedInputs }),
    // Сигнал прогона — внутренний контроллер, а не сигнал вызывающего
    // напрямую: отказ решения взводит его так же, как Ctrl-C.
    signal: runController.signal,
    beginWait: (wakeAt) => {
      const release = waitState.begin(wakeAt);
      writeStatus('running', true);
      return () => {
        release();
        writeStatus('running', true);
      };
    },
    awaitDecision: async (identity, request) => {
      const since = new Date().toISOString();
      const waitId = computeWaitId({
        job: identity.job,
        step: identity.step,
        attempt: identity.attempt,
        ...(identity.iteration === undefined ? {} : { iteration: identity.iteration }),
        since,
      });
      const outcomes = Object.fromEntries(
        Object.entries(request.outcomes).map(([name, spec]) => [
          name,
          { effect: spec.effect, ...(spec.label === undefined ? {} : { label: spec.label }) },
        ]),
      );
      const deadline =
        request.deadlineMs === undefined ? undefined : new Date(Date.now() + request.deadlineMs).toISOString();
      const awaitingEntry: AwaitingDecision = {
        wait_id: waitId,
        job: identity.job,
        step: identity.step,
        outcomes,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        since,
        ...(deadline === undefined ? {} : { deadline }),
        ...(request.onExpire === undefined ? {} : { on_expire: request.onExpire }),
      };

      const endWait = awaitingDecisions.begin(awaitingEntry);
      // На диск до блокировки — тем же приёмом, что `beginWait`: ожидание
      // видно снаружи с первого такта, а не после того, как оно завершится.
      writeStatus('running', true);
      journal.event({
        kind: 'decision.awaiting',
        wait_id: waitId,
        job: identity.job,
        step: identity.step,
        outcomes,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        ...(deadline === undefined ? {} : { deadline }),
        ...(request.onExpire === undefined ? {} : { on_expire: request.onExpire }),
      });

      // Решение, перенесённое возобновлением: адресовано ожиданию прошлого
      // прогона, и потому передаётся ожиданию отдельно от каталога. Снимается
      // первым же применением — следующая итерация цикла `until` спрашивает
      // человека заново (дельта `run-decisions`).
      const key = carriedKey(identity.job, identity.step);
      const carried = carriedDecisions.get(key);

      const outcome = await waitForDecision({
        paths: journal.paths,
        waitId,
        awaiting: awaitingEntry,
        knownSteps: knownStepAddresses,
        signal: runController.signal,
        onRefused: (detail) => {
          journal.event({ kind: 'decision.refused', wait_id: waitId, job: identity.job, step: identity.step, detail });
        },
        ...(carried === undefined
          ? {}
          : {
              carried: {
                record: carried.record,
                source: shortRunId(carried.source),
                onApplied: () => carriedDecisions.delete(key),
              },
            }),
        ...(options.decisionPollIntervalMs === undefined ? {} : { pollIntervalMs: options.decisionPollIntervalMs }),
      });

      endWait();
      writeStatus('running', true);
      // Интервал ожидания не тратит бюджет прогона (design.md, решение 8):
      // записывается тем же вызовом, что и сон до сброса окна лимита, и потому
      // вычитается из `elapsedMs()`. Повод при этом называется отдельно:
      // против предела ожидания окна лимита подписки (`max_wait`) решение не
      // проверяется и его не исчерпывает — у него свой срок, объявленный на
      // шаге, а `max_wait` мерит собственные ожидания движка.
      usage.recordWait(Date.parse(since), Date.now(), 'decision');

      if (outcome.kind === 'canceled') {
        // Отмена прогона (Ctrl-C или отказ решения, объявленного другим
        // шагом) — не отказ этого решения: попытка завершится обычным путём
        // отмены, `context.signal.aborted` уже true к этому моменту.
        throw new Error('прогон отменён');
      }

      const { decision, by } = outcome;
      journal.event({
        kind: 'decision.applied',
        wait_id: waitId,
        job: identity.job,
        step: identity.step,
        outcome: decision.outcome,
        effect: decision.effect,
        by,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        ...(decision.restartFrom === undefined ? {} : { restart_from: decision.restartFrom }),
      });
      if (by === 'deadline') {
        journal.event({
          kind: 'decision.expired',
          wait_id: waitId,
          job: identity.job,
          step: identity.step,
          outcome: decision.outcome,
        });
      }

      const result: StepKindDecisionResult = {
        outcome: decision.outcome,
        effect: decision.effect,
        by,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        ...(decision.restartFrom === undefined ? {} : { restartFrom: decision.restartFrom }),
      };

      if (decision.effect === 'continue') return result;

      // Защёлка эффекта — до возврата управления исполнителю (design.md,
      // решение 5): вклад, поймавший и проглотивший отказ ниже, судьбу прогона
      // уже не меняет.
      if (decisionLatch.value === undefined) {
        decisionLatch.value = { job: identity.job, step: identity.step, record: toDecisionRecord(result) };
        runController.abort();
      }
      throw new DecisionHalt(result);
    },
    // Состояние переписывается после каждого шага: это единственный файл, по
    // изменению которого витрина узнаёт о ходе прогона, и данные, записанные
    // работой, доезжают до подписи узла только вместе с ним.
    refreshStatus: () => writeStatus('running', true),
  };

  requireAdapters(context);
  warnAboutDegradedBackends(context);
  warnAboutUnpricedCalls(context);
  requireStrictPermissionsSupport(context);
  requireMcpSupport(context);
  requireStructuredOutputSupport(context);
  requireUserMcpIsolation(context);
  requireEffortSupport(context);

  /**
   * Единственное место, где картина прогона попадает на диск: сводка
   * расхода, затем состояние. Пятого повода не бывает без обоих файлов —
   * отдельный вызов на каждом поводе однажды забыли бы (design.md,
   * Решение 1). `partial` снимается только терминальной записью: сводка
   * подводится ровно тогда, когда прогон действительно завершён.
   *
   * Обе величины читаются из одного `usage` синхронно, без `await` между
   * ними: писать расход в этом окне некому, поэтому итог прогона в сводке и
   * в `budget` состояния не расходится (design.md, Решение 8).
   */
  const writeStatus = (status: StatusValue, partial: boolean): void => {
    // Перерасход бюджета останавливает прогон так же, как отказ, и точка
    // возобновления нужна ровно так же: без неё прогон, упёршийся в потолок,
    // остался бы единственным законченным исходом без подсказки, как его
    // продолжить.
    const isBlocking = (status: StatusValue | undefined): boolean =>
      status === 'failed' || status === 'budget_exceeded';
    // Цикл, исчерпавший проходы, — отказ и тогда, когда все участники его
    // последнего прохода успешны: точка возобновления — его точка входа.
    const blockedLoop = [...loops.values()].find((runtime) => isBlocking(runtime.outcome?.status));
    const blocked =
      [...records.values()].find((record) => isBlocking(record.status)) ??
      (blockedLoop === undefined
        ? undefined
        : { id: resumeTarget(pipeline, graph, blockedLoop.loop.jobs[0] as string) });
    // Сводка пишется раньше состояния: витрина замечает изменение прогона по
    // mtime status.json, и к этому моменту лежащая рядом сводка не должна
    // быть старше него (design.md, Решение 2).
    const report = usage.report(journal.paths.runId, partial);
    journal.writeUsage(report);
    const runStatus: RunStatus = {
      run_id: journal.paths.runId,
      pipeline: pipeline.name,
      lock_hash: lockHash,
      status,
      workspace: workspaceRecord(pipeline.workspace),
      ...(options.resume === undefined
        ? {}
        : { resumed_from: options.resume.source.manifest.run_id }),
      inputs: pipeline.inputs,
      jobs: [...records.values()],
      ...(loops.size === 0 ? {} : { loops: [...loops.values()].map(loopRecord) }),
      budget: {
        tokens_used: usage.runTokens(),
        ...(pipeline.budget?.tokens === undefined ? {} : { tokens_limit: pipeline.budget.tokens }),
        cost_used_usd: usage.runCostMicroUsd() / 1_000_000,
        ...(pipeline.budget?.costMicroUsd === undefined
          ? {}
          : { cost_limit_usd: pipeline.budget.costMicroUsd / 1_000_000 }),
        ...(usage.costUnreportedAttemptCount() === 0
          ? {}
          : { cost_unreported_attempts: usage.costUnreportedAttemptCount() }),
        ...(usage.runCostSource() === undefined ? {} : { cost_source: usage.runCostSource() }),
        ...(usage.runCostCatalogAsOf() === undefined
          ? {}
          : { cost_catalog_as_of: usage.runCostCatalogAsOf() }),
        wallclock_ms: usage.elapsedMs(),
        ...(pipeline.budget?.wallclockMs === undefined
          ? {}
          : { wallclock_limit_ms: pipeline.budget.wallclockMs }),
        ...(context.budgetExceededLatch.value === undefined
          ? {}
          : { exceeded: context.budgetExceededLatch.value }),
      },
      ...(blocked === undefined
        ? decisionLatch.value?.record.effect === 'restart' &&
          decisionLatch.value.record.restart_from !== undefined
          ? {
              resume: {
                command: `burnex resume ${shortRunId(journal.paths.runId)} --from ${decisionLatch.value.record.restart_from}`,
              },
            }
          : {}
        : {
            resume: {
              command: `burnex resume ${shortRunId(journal.paths.runId)} --from ${resumeTarget(pipeline, graph, blocked.id)}`,
              blocked_by: blocked.id,
            },
          }),
      ...(waitState.earliest() === undefined ? {} : { wake_at: waitState.earliest() as string }),
      ...(awaitingDecisions.list().length === 0 ? {} : { awaiting: [...awaitingDecisions.list()] }),
      ...(decisionLatch.value?.record.effect === 'restart' && decisionLatch.value.record.restart_from !== undefined
        ? { restart_from: decisionLatch.value.record.restart_from }
        : {}),
      updated_at: new Date().toISOString(),
    };
    journal.writeStatus(runStatus);

    // Дозапись хранилища расхода: только терминальной записью, рядом с
    // подведением сводки (design.md, Решение 3) — идущий прогон в хранилище
    // не попадает вовсе. Отказ дозаписи не должен ронять уже завершившийся
    // прогон: он сообщается тем же путём, что и прочий внутренний учёт.
    if (!partial) {
      try {
        const key = basename(journal.paths.projectDir);
        appendUsageRecord(dirname(journal.paths.projectDir), usageRecord(key, manifest, runStatus, report));
      } catch (error) {
        journal.event({
          kind: 'bookkeeping.failed',
          operation: 'дозапись хранилища расхода',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // Выходы переиспользованных работ публикуются не здесь, а по ходу
  // исполнения: каждая работа проходит через `executeJob` в обычном порядке
  // графа, даже если все её шаги переиспользованы, и публикует выход в
  // `runJobSteps` — так же, как исполненная. Предзаполнение записи об
  // артефакте путём, по которому файл ещё не записан, было бы ложью.
  if (options.resume !== undefined) {
    restoreForResume(options.resume, journal, options.cwd, anchorKind, config.project.nestedRepos);
    carryOverRunDir(options.resume, journal);
    carryOverDecisions(options.resume, journal, carriedDecisions);
  }
  writeStatus('running', true);
  // Дерево по умолчанию — до первой работы, от исходного состояния. После
  // первой записи состояния: снаружи прогон виден с первой же уступки цикла.
  await trees.openDefault();

  /**
   * Область прогона: ресурсы, живущие столько же, сколько сам прогон.
   * Снимается до финального состояния и до `run.finished` — состояние
   * закончившегося прогона не должно утверждать, что он спит.
   */
  const runResources = createScope({ journal });
  runResources.defer('снятие состояния ожидания прогона', () => {
    waitState.clear();
  });
  runResources.defer('снятие незакрытых ожиданий решения', () => {
    awaitingDecisions.clear();
  });
  // Слушатель внешнего сигнала на внутренний контроллер — `{ once: true }`
  // снимает его сам, но только если сигнал успел взвестись; прогон, дошедший
  // до конца без отмены, обязан снять его сам же, а не оставлять висеть на
  // сигнале вызывающего до конца процесса.
  runResources.defer('снятие слушателя внешнего сигнала отмены', () => {
    options.signal?.removeEventListener('abort', onExternalAbort);
  });

  let result: Awaited<ReturnType<typeof schedule>>;
  try {
    result = await schedule({
      pipeline,
      graph,
      // Потолок конфигурации применяет сам прогон: линт отклоняет превышение,
      // но прогон не обязан полагаться на то, что линт был.
      concurrency: Math.min(pipeline.concurrency, config.limits.concurrency),
      // Дерево — ресурс: в общем дереве одновременно идёт одна работа
      // (`named-workspace-trees`, решение 4).
      treeOf: sharedTreeOf,
      signal: runController.signal,
      scopeExtras: { run: { id: journal.paths.runId, dir: journal.paths.dir }, env: {} },
      // Данные берутся из записи работы, а не читаются с диска заново: движок
      // складывает их туда после каждого шага, и второй путь к тому же
      // значению разошёлся бы с первым при первой же уборке прогона.
      jobData: (jobId) => records.get(jobId)?.data,
      execute: async (job, scope, pass) => executeJob(job, scope, context, pass),
      loopHooks: {
        onLoopStarted: (loop) => {
          const runtime = loops.get(loop.id) as LoopRuntime;
          runtime.startedAt = Date.now();
          journal.event({ kind: 'loop.started', loop: loop.id, jobs: [...loop.jobs], max_iterations: loop.maxIterations });
        },
        onPassStarted: (loop, iteration) => {
          const runtime = loops.get(loop.id) as LoopRuntime;
          runtime.iterations = iteration;
          if (iteration > 1) resetLoopParticipants(context, runtime);
          journal.event({ kind: 'loop.pass.started', loop: loop.id, iteration });
          writeStatus('running', true);
        },
        onPassFinished: (loop, iteration, goesOn) => {
          journal.event({ kind: 'loop.pass.finished', loop: loop.id, iteration, continue: goesOn });
          writeStatus('running', true);
        },
        onLoopFinished: (outcome) => {
          (loops.get(outcome.id) as LoopRuntime).outcome = outcome;
          journal.event({
            kind: 'loop.finished',
            loop: outcome.id,
            iterations: outcome.iterations,
            verdict: outcome.verdict,
            status: outcome.status,
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          });
          writeStatus('running', true);
        },
        reused: (loop) => {
          if (options.resume?.plan.reusedLoops?.includes(loop.id) !== true) return undefined;
          if ((loops.get(loop.id) as LoopRuntime).executed) return undefined;
          return options.resume.source.status.loops?.find((item) => item.id === loop.id)?.iterations;
        },
        // Бюджет цикла проверяется и на границе прохода: шаг его останавливает
        // посреди прохода, но последний проход мог закончиться ровно на пределе.
        budgetExhausted: (loop) => {
          const scope = loopScope(context, loop);
          return scope !== undefined && usage.check([scope]) !== undefined;
        },
      },
      onSettled: async (job, outcome) => {
        trees.settledWithoutRun(job.id);
        const record = records.get(job.id) as JobRecord;
        records.set(job.id, {
          ...record,
          status: outcome.status,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
          ...(outcome.skip === undefined ? {} : { skip: outcome.skip }),
          ...(outcome.lastCheck === undefined ? {} : { last_check: [...outcome.lastCheck] }),
          finished_at: new Date().toISOString(),
        });
        journal.event({
          kind: 'job.finished',
          job: job.id,
          status: outcome.status,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        });
        writeStatus('running', true);
      },
      });
  } finally {
    trees.disposeUnused();
    await runResources.dispose();
  }

  if (context.failureNote.pending !== undefined) {
    const addressee = options.resume?.plan.failureNoteJob;
    journal.event({
      kind: 'resume.note_undelivered',
      ...(addressee === undefined ? {} : { job: addressee }),
      detail:
        addressee === undefined
          ? 'в плане возобновления нет переисполняемых агентских шагов'
          : `агентский шаг работы ${addressee} не исполнялся`,
    });
  }

  // Защёлка перейдённого потолка поднимает исход прогона поверх вычисленного
  // по работам: работа, до которой потолок остановил дело, могла успеть
  // отчитаться успехом сама, а освобождённые завершающие — тем более
  // (design.md, решение 3). Отмена остаётся важнее.
  const finalStatus: StatusValue =
    context.budgetExceededLatch.value !== undefined && result.status !== 'canceled'
      ? 'budget_exceeded'
      : result.status;

  // Манифест обновляется раньше терминальной записи состояния: запись
  // хранилища расхода, дописываемая изнутри `writeStatus`, читает `finished_at`
  // и `status` из того же объекта `manifest` (`usageRecord`) — без этого
  // порядка она увидела бы прогон ещё не завершённым.
  const exitCode = resolveExitCode(finalStatus, result.settled);
  manifest = { ...manifest, finished_at: new Date().toISOString(), status: finalStatus, exit_code: exitCode };

  writeStatus(finalStatus, false);

  journal.writeManifest(manifest);
  journal.event({ kind: 'run.finished', status: finalStatus, exit_code: exitCode });

  const costLimitUnapplied = anyCostBudgetDeclared(pipeline) && usage.runCostNeverReported();

  const restart =
    decisionLatch.value?.record.effect === 'restart' && decisionLatch.value.record.restart_from !== undefined
      ? { from: decisionLatch.value.record.restart_from }
      : undefined;

  return { journal, status: finalStatus, exitCode, costLimitUnapplied, ...(restart === undefined ? {} : { restart }) };
}

// Экспортирован для `exec/pluginStep.ts`: исполнитель вида шага собирается тем
// же путём, что и `runCommandStep`, и ему нужна та же форма контекста прогона
// и тот же исход шага (`StepOutcome` ниже). Импорт в обе стороны безопасен:
// оба места используют друг друга только внутри тел функций, вызываемых уже
// после того, как загрузчик модулей ES связал оба файла (см. комментарий у
// `registerBuiltinStepKinds` в `src/parts/builtin.ts` — тот же приём).
/** Цикл по группе работ в ходе прогона. */
interface LoopRuntime {
  readonly loop: Loop;
  /** Начало первого прохода: от него отсчитывается `wallclock` цикла. */
  startedAt: number | undefined;
  /** Проходов начато. */
  iterations: number;
  /** Каталоги и якоря участников, исполнявшихся в прошлом проходе: из них берётся дерево точки входа. */
  previous: ReadonlyMap<string, CompletedJob>;
  outcome: LoopOutcome | undefined;
  /**
   * В проходе исполнился хотя бы один шаг участника, а не переиспользовался:
   * тогда цикл, переиспользованный по плану, на деле прошёл заново и о
   * сходимости судит `while`, а не исход исходного прогона.
   */
  executed: boolean;
}

export interface RunContext extends RunOptions {
  /** Действующие переопределения env: свои, а у возобновления — из манифеста исходного прогона. */
  readonly envOverrides: Readonly<Record<string, string>>;
  /**
   * Реестр вкладов прогона — в отличие от `RunOptions.registry`, здесь он есть
   * всегда: умолчание встроенного ядра раскрыто при заведении контекста (см.
   * `startRun`), и ни одно место исполнения не поднимает его себе само.
   */
  readonly registry: Registry;
  /**
   * Значения секретов, названных шагами: имя секрета → значение. Только в
   * памяти прогона — ни замок, ни манифест, ни ключ шага их не несут.
   */
  readonly secretValues: ReadonlyMap<string, string>;
  /**
   * Учётные данные бэкендов, которыми идёт прогон: бэкенд → { переменная →
   * значение }. Только в памяти и только для процесса CLI своего бэкенда;
   * маскируются журналом наравне с секретами.
   */
  readonly backendCredentials: ReadonlyMap<string, Readonly<Record<string, string>>>;
  readonly journal: RunJournal;
  readonly records: Map<string, JobRecord>;
  readonly usage: UsageAccumulator;
  /**
   * Каталог цен, прочитанный один раз на старте: оценка расхода для бэкенда,
   * который цену не сообщает. Необязателен ради вызывающих, что собирают
   * контекст исполнения напрямую, — без него оценки просто нет.
   */
  readonly priceCatalog?: PriceCatalog;
  readonly outputs: UpstreamOutput[];
  readonly adapters: Map<string, BackendAdapter>;
  /** Предел одновременных вызовов бэкенда, общий на прогон. */
  readonly backendSlots: BackendSlots;
  /** Одна и та же переменная вычёркивается на каждом шаге — сообщаем однажды. */
  readonly reportedDenials: Set<string>;
  /** То же для `env.withheld`: пара «переменная|адрес шага» сообщается однажды. */
  readonly reportedWithheld: Set<string>;
  /**
   * Реестр сессий прогона. Здесь, а не в исполнении работы, ровно ради
   * `session_group`: работы одной группы обязаны продолжать один диалог, а
   * реестр, живущий работу, обрывал бы его на её границе. Пространство имён
   * псевдонимов замыкается ключом (см. `sessionKey`), поэтому работа без
   * объявленной группы ведёт себя в точности как прежде.
   */
  readonly sessions: ReturnType<typeof createSessionRegistry>;
  /**
   * Сессии, в которые уже отправлен контекст пайплайна. Отслеживание живёт в
   * прогоне вместе с реестром: свод правил пайплайна агент читает один раз на
   * диалог, а не заново на каждой его работе.
   */
  readonly pipelineContextSent: Set<string>;
  /**
   * Источник знания **работы**, если практика памяти объявлена. Заводится по
   * её рабочей директории (`runJob`), а не по каталогу запуска: иначе в режиме
   * `worktree` и отбор, и предикат `knowledge_valid` смотрели бы мимо дерева,
   * которое шаг правит. На контексте прогона поля нет вовсе — значение,
   * верное только для режима `cwd`, хуже отсутствующего.
   */
  readonly knowledgeSource?: KnowledgeSource | undefined;
  readonly lockHash: string;
  /** Способ фиксации состояния: определён один раз на прогон. */
  readonly anchorKind: AnchorKind;
  /** Неизменные коммиты, от которых заводятся все worktree этого прогона. */
  readonly sourceCommits: Readonly<Record<string, string>>;
  /**
   * Движок, которым прогон исполняется, — корень, точка входа и признак
   * снимка (`run/engine.ts`). Определяется один раз на прогон, до первой
   * работы: `BURNEX_BIN` шагов и проверок цикла берёт точку входа отсюда,
   * а не из `process.argv[1]` напрямую, чтобы пересборка `dist/` в рабочем
   * дереве не подменяла код, которым прогон уже идёт.
   */
  readonly engine: EngineInfo;
  /**
   * Каталог запуска. В отличие от `cwd`, который ниже по коду означает рабочую
   * директорию текущей работы, этот остаётся каталогом прогона: якорю рабочей
   * копии он нужен как репозиторий, чью базу объектов брать.
   */
  readonly runCwd: string;
  /** Граф работ: наследованию нужны зависимости и число потомков. */
  readonly graph: Graph;
  /** Каталог и последний якорь уже завершившихся работ — источник засева. */
  readonly completedWorkspaces: Map<string, CompletedJob>;
  /** Деревья прогона: каталог каждого дерева, его засев и перенимание (`run/runTrees.ts`). */
  readonly trees: RunTrees;
  /** Циклы прогона по идентификатору; без объявленных циклов пусто. */
  readonly loops: ReadonlyMap<string, LoopRuntime>;
  /**
   * Проход цикла, в котором исполняется работа. Заполнен на контексте
   * участника; у работ вне цикла отсутствует, и читатели берут «не в цикле».
   */
  readonly loopPass?: LoopPass;
  /** Наблюдённые входы шагов прошлого прогона: `<работа>/<шаг>` → пути. */
  readonly observedInputs?: ReadonlyMap<string, readonly string[]>;
  /**
   * Выдержка о прошлом отказе. Достаётся первому агентскому шагу работы,
   * названной планом возобновления (`plan.failureNoteJob`), и на этом исчезает:
   * повторять её остальным — значит навязывать всему прогону разбор одной
   * чужой неудачи, а отдавать «первому, кто успел» при параллельном
   * исполнении значит не отдавать никому определённому.
   */
  readonly failureNote: { pending: string | undefined };
  /**
   * Защёлка первого превышения, остановившего исполнение. Заполняется один
   * раз — вторая и последующие остановки его не переписывают, иначе
   * состояние прогона называло бы не первую причину, а последнюю подвернувшуюся.
   * Исход прогона (`scheduler.ts`) читает её поверх статусов работ: работа,
   * до которой потолок остановил дело, могла успеть отчитаться успехом
   * (design.md, решение 3).
   */
  readonly budgetExceededLatch: { value: BudgetExceededState | undefined };
  /**
   * Защёлка эффекта решения (design.md изменения `user-decision-steps`,
   * решение 5): первый отказ обещания `reject`/`restart`, остановивший
   * прогон, — заполняется один раз, рядом с `budgetExceededLatch`.
   */
  readonly decisionLatch: { value: DecisionLatchValue | undefined };
  /** Результаты непрошедшего `check` предыдущей итерации текущей работы. */
  readonly iterationCheck?: readonly PredicateResult[];
  /**
   * Номер действующей попытки работы. Заполнен на контексте работы с
   * `attempts.max > 1`; у прочих отсутствует, и читатели берут `1`.
   */
  readonly jobAttempt?: number;
  /**
   * Уход в ожидание: состояние прогона должно быть на диске до начала сна, а
   * не после — иначе спящий прогон неотличим от зависшего. Возвращённое
   * снятие убирает ровно это ожидание, не трогая чужих: ожидающих работ может
   * быть несколько.
   */
  readonly beginWait: (wakeAt: string) => () => void;
  /**
   * Объявить ожидание решения и дождаться его (design.md изменения
   * `user-decision-steps`, решение 1, решение 5) — рядом с `beginWait`, тем же
   * приёмом записи `awaiting` на диск до блокировки. Разрешается результатом
   * только для эффекта `continue`; `reject` и `restart` отдаются отказом
   * `DecisionHalt`, взводя `decisionLatch` до возврата управления исполнителю.
   */
  readonly awaitDecision: (
    identity: DecisionIdentity,
    request: StepKindDecisionRequest,
  ) => Promise<StepKindDecisionResult>;
  /**
   * Переписать `status.json` по текущим записям работ. Файлом владеет движок и
   * только он: подпроцесс `burnex data` пишет свой `data.json`, а состояние
   * прогона переписывается здесь — конкурентная запись двух процессов в один
   * файл была бы гонкой.
   */
  readonly refreshStatus: () => void;
}

/** Отсутствие поддержки сессий не отказ, а деградация с предупреждением. */
/**
 * Все бэкенды, которые понадобятся прогону, разрешаются до первой работы.
 *
 * Настроенный, но не предоставленный ни встроенно, ни плагином бэкенд иначе
 * обнаружился бы на первом агентском шаге — то есть после подготовки рабочих
 * деревьев и, возможно, после сорока минут чужой работы. Проверка стоит
 * ничего и делается там же, где остальные предстартовые.
 */
/**
 * Агентские вызовы прогона: агентские шаги и участники шагов `review`. Адрес
 * — `<работа>/<шаг>`, у участника — `<работа>/<шаг>/<участник>`: им же
 * названы происхождения выбора в раскрытом пайплайне.
 */
function agentCallsIn(pipeline: Pipeline): { job: Job; step: Step; call: AgentStep; address: string }[] {
  return pipeline.jobs.flatMap((job) =>
    job.steps.flatMap((step) =>
      agentCallsOf(step).map(({ id, call }) => ({
        job,
        step,
        call,
        address: isPanelStep(step) ? `${job.id}/${step.id}/${id}` : `${job.id}/${step.id}`,
      })),
    ),
  );
}

function requireAdapters(context: RunContext): void {
  const needed = backendsInUse(context.expanded.pipeline, context.config.defaults.agent);

  for (const name of needed) adapterOf(name, context);
}

function warnAboutDegradedBackends(context: RunContext): void {
  const { pipeline } = context.expanded;
  const needed = new Set(
    pipeline.jobs
      .filter((job) => job.session === 'shared')
      .flatMap((job) => job.steps.flatMap((step) => agentCallsOf(step).map(({ call }) => call.agent))),
  );

  for (const name of needed) {
    const adapter = adapterOf(name, context);
    if (adapter.capabilities.sessions) continue;
    context.journal.event({
      kind: 'backend.degraded',
      backend: name,
      capability: 'sessions',
      detail: 'session: shared исполняется как per_step',
    });
  }
}

/**
 * Прогноз до первой траты: какие вызовы модели денежный потолок не увидит.
 * Вызов «без цены» — бэкенд цены не сообщает (`reportsCost !== true`: отсутствие
 * признака значит «неизвестно»), а модель не объявлена либо её нет в каталоге.
 * Объявленная и найденная в каталоге модель оценивается движком, поэтому
 * предупреждения не требует. Модель попытки — та же, что выберет исполнение
 * (`plan.model ?? step.model`), поэтому проверяется каждая достижимая ступень
 * эскалации, а не только модель шага: попытки 2+ на другой модели иначе прошли
 * бы мимо потолка без предупреждения. Прогон из-за этого не останавливается; факт —
 * `budget.cost_unreported` и `costLimitUnapplied` — по-прежнему ловит тех,
 * кто цену обещал и не сообщил.
 */
function warnAboutUnpricedCalls(context: RunContext): void {
  const { pipeline } = context.expanded;
  if (!anyCostBudgetDeclared(pipeline)) return;

  const seen = new Set<string>();
  const check = (job: Job, step: Step, backend: string, model: string | undefined, judge: boolean): void => {
    const adapter = adapterOf(backend, context);
    if (!isUnpricedCall(adapter, model, context.priceCatalog)) return;
    const key = [job.id, step.id, judge ? 'judge' : 'step', backend, model ?? ''].join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    context.journal.event({
      kind: 'budget.cost_unpriced',
      job: job.id,
      step: step.id,
      backend,
      ...(model === undefined ? {} : { model }),
      ...(judge ? { judge: true } : {}),
    });
  };

  for (const { job, step, call } of agentCallsIn(pipeline)) {
    for (let attempt = 1; attempt <= call.attempts.max; attempt += 1) {
      check(job, step, call.agent, planAttempt(attempt, call.attempts).model ?? call.model, false);
    }
  }
  for (const job of pipeline.jobs) {
    for (const step of job.steps) {
      for (const predicate of step.expect ?? []) {
        if (predicate.kind !== 'judge') continue;
        check(job, step, predicate.agent ?? context.config.defaults.agent, predicate.model, true);
      }
    }
  }
}

/**
 * Отсутствие поддержки жёсткого режима не деградирует, а останавливает прогон
 * до первого шага: молча исполнить `enforce: strict` бэкендом, который его не
 * умеет, значило бы оставить пайплайн с границей, которой нет. Спрашивается
 * возможность самого адаптера, а не флаг в конфигурации: флаг — то, что о
 * бэкенде объявили, возможность — то, что он умеет, и расходиться они могут.
 */
function requireStrictPermissionsSupport(context: RunContext): void {
  for (const { job, call: step, address } of agentCallsIn(context.expanded.pipeline)) {
    const permissions = effectivePermissions(
      step.permissions,
      context.config.backends[step.agent]?.permissions,
    );
    if (permissions?.enforce !== 'strict') continue;
    // Codex временно принимает, но не применяет allow/deny/enforce, чтобы
    // переносимые pipeline могли выбирать его через конфигурацию.
    if (step.agent === 'codex') continue;
    if (adapterOf(step.agent, context).capabilities.strictPermissions) continue;
    throw new BurnexError(
      `Бэкенд ${step.agent} не умеет применять enforce: strict, объявленный у шага ${address}`,
      {
        file: job.source,
        hint: 'Снимите enforce: strict либо переведите шаг на бэкенд, объявляющий эту возможность',
      },
    );
  }
}

/**
 * Отсутствие поддержки MCP не деградирует, а останавливает прогон до первого
 * шага, тем же приёмом, что и `requireStrictPermissionsSupport`: молча
 * исполнить объявление бэкендом, который его не умеет, значило бы оставить
 * пайплайн с инструментами, которых нет.
 */
function requireMcpSupport(context: RunContext): void {
  for (const job of context.expanded.pipeline.jobs) {
    for (const step of job.steps) {
      // Пустое объявление (`mcp: {}`) — снятие унаследованного: серверов у
      // шага не будет ни при какой возможности бэкенда, и требовать её от него
      // не за что.
      if (step.kind !== 'agent' || step.mcp === undefined || Object.keys(step.mcp).length === 0) continue;
      if (adapterOf(step.agent, context).capabilities.mcp) continue;
      throw new BurnexError(
        `Бэкенд ${step.agent} не объявляет возможность работать с MCP-серверами, объявленными у шага ${job.id}/${step.id}`,
        {
          file: job.source,
          hint: `Включите backends.${step.agent}.mcp в конфигурации либо снимите объявление mcp`,
        },
      );
    }
  }
}

/**
 * Схема выхода агентского шага на бэкенде без структурированного вывода не
 * деградирует, а останавливает прогон до первого шага, тем же приёмом, что и
 * `requireMcpSupport`: шаг прошёл бы без `output.json`, и отказ проявился бы
 * лишь у потребителя вывода дальше по графу.
 */
function requireStructuredOutputSupport(context: RunContext): void {
  for (const { job, call: step, address } of agentCallsIn(context.expanded.pipeline)) {
    if (step.outputSchemaPath === undefined) continue;
    // Любой путь годится: нативная схема CLI либо схема движка по итоговому
    // тексту (`backend-structured-output`, решение 5). Участники `review`
    // приходят сюда же — ревьюеры, агрегатор и свежий защитник.
    if (structuredOutputMode(adapterOf(step.agent, context).capabilities) !== undefined) continue;
    throw new BurnexError(
      `Бэкенд ${step.agent} не поддерживает структурированный вывод, нужный для output_schema шага ${address}`,
      {
        file: job.source,
        hint: `Включите backends.${step.agent}.structured_output в конфигурации, если бэкенд это умеет, либо назначьте шагу бэкенд со структурированным выводом`,
      },
    );
  }
  // Судья по той же причине: вердикт принимается только структурой
  // { pass, reason }, и без возможности он провалился бы уже после того, как
  // шаг отработал и потратил токены. Флаг конфигурации тут не довод — адаптер
  // может его не читать (cursor-agent).
  for (const job of context.expanded.pipeline.jobs) {
    for (const step of job.steps) {
      for (const predicate of step.expect ?? []) {
        if (predicate.kind !== 'judge') continue;
        const backend = predicate.agent ?? context.config.defaults.agent;
        if (structuredOutputMode(adapterOf(backend, context).capabilities) !== undefined) continue;
        throw new BurnexError(
          `Бэкенд судьи ${backend} не поддерживает структурированный вывод, нужный для вердикта у шага ${job.id}/${step.id}`,
          {
            file: job.source,
            hint: 'Вердикт судьи принимается только структурой { pass, reason } — назначьте судье бэкенд со структурированным выводом',
          },
        );
      }
    }
  }
}

/**
 * `user_mcp: false` — явная просьба запускать агента без MCP-серверов и
 * коннекторов пользователя. Адаптер, который её не исполняет, дал бы ложное
 * ощущение изоляции: прогон останавливается до первой работы, тем же
 * приёмом, что `requireMcpSupport` (`session-cache-stable-prefix`, решение 3).
 * Проверяются бэкенды агентских вызовов и судей пайплайна.
 */
function requireUserMcpIsolation(context: RunContext): void {
  const used = new Map<string, string>();
  for (const { job, call } of agentCallsIn(context.expanded.pipeline)) {
    if (!used.has(call.agent)) used.set(call.agent, job.source);
  }
  for (const job of context.expanded.pipeline.jobs) {
    for (const step of job.steps) {
      for (const predicate of step.expect ?? []) {
        if (predicate.kind !== 'judge') continue;
        const backend = predicate.agent ?? context.config.defaults.agent;
        if (!used.has(backend)) used.set(backend, job.source);
      }
    }
  }
  for (const [backend, file] of used) {
    if (context.config.backends[backend]?.userMcp !== false) continue;
    if (adapterOf(backend, context).capabilities.isolateUserMcp === true) continue;
    throw new BurnexError(
      `Бэкенд ${backend} не умеет запускать агента без MCP-серверов пользователя, а конфигурация задаёт backends.${backend}.user_mcp: false`,
      {
        file,
        hint: `Снимите backends.${backend}.user_mcp либо назначьте шагам бэкенд, который умеет изоляцию`,
      },
    );
  }
}

/**
 * Явный effort документа нельзя молча потерять при передаче чужому
 * backend-плагину: автор просил именно это. Effort из настроек пользователя
 * (`defaults.effort`, записи агентов, tier) — не просьба документа, а общая
 * установка; пользователь, выставивший её для всех шагов, не может знать, что
 * один из бэкендов уровня рассуждений не умеет. Такой effort отбрасывается,
 * а факт остаётся в журнале. Шаг без записи об источнике (собран не
 * раскрытием) считается документом: громкий отказ лучше тихой потери.
 */
function requireEffortSupport(context: RunContext): void {
  for (const { job, call: step, address } of agentCallsIn(context.expanded.pipeline)) {
    if (step.effort === undefined) continue;
    if (adapterOf(step.agent, context).capabilities.effort === true) continue;
    const origin = context.expanded.effortOrigins.get(address);
    const source = origin === undefined ? undefined : settingsSourceOf(origin);
    if (source !== undefined) {
      context.journal.event({
        kind: 'backend.degraded',
        backend: step.agent,
        capability: 'effort',
        detail: `${address}: effort ${step.effort} из ${source} не передаётся`,
      });
      continue;
    }
    throw new BurnexError(
      `Бэкенд ${step.agent} не умеет применять effort, объявленный у шага ${address}`,
      {
        file: job.source,
        hint: 'Снимите effort либо переведите шаг на бэкенд, объявляющий эту возможность',
      },
    );
  }
}

/** Источник effort в настройках пользователя; `undefined` — effort написал документ. */
function settingsSourceOf(origin: EffortOrigin): string | undefined {
  switch (origin.layer) {
    case 'config':
      return 'defaults.effort';
    case 'pipeline_agents':
    case 'step_agents':
      return origin.layer;
    case 'tier':
      // Даже tier, названный документом, приносит effort из `model_tiers`
      // конфигурации: документ просил уровень модели, а не effort.
      return `model_tiers (tier ${origin.tier})`;
    default:
      return undefined;
  }
}

/**
 * Экспортируется ради `exec/pluginStep.ts`: судью на шаге плагинного вида
 * зовёт тот же проход и тем же адаптером, что и на командном (см. там же
 * `describeStepTask`).
 */
export function adapterOf(name: string, context: RunContext): BackendAdapter {
  const existing = context.adapters.get(name);
  if (existing !== undefined) return existing;
  const created = (
    context.adapterFor ?? ((backend) => resolveAdapter(backend, context.config, context.registry))
  )(name);
  context.adapters.set(name, created);
  return created;
}

/**
 * Работа целиком: заведение каталогов работы, её исполнение и снятие пустого
 * каталога черновиков.
 *
 * Каталог черновиков заводится в `prepareJob` — до подготовки рабочей
 * директории и до раскрытия подстановок, каждое из которых может отказать.
 * Поэтому его снятие висит здесь, на общем `finally` вокруг всей работы, а не
 * внутри `runJob`: иначе работа, отказавшая на подготовке, оставляла бы в
 * раскладке пустой каталог, а правило «пустого нет — значит не писал»
 * держалось бы только на удачных путях.
 */
async function executeJob(
  declared: Job,
  scope: Record<string, unknown>,
  runContext: RunContext,
  pass?: LoopPass,
): Promise<JobOutcome> {
  const context: RunContext = pass === undefined ? runContext : { ...runContext, loopPass: pass };
  const { journal } = context;

  /**
   * Область работы: ресурсы, живущие ровно столько, сколько сама работа, —
   * каталог черновиков и служебные файлы её якоря. Заводится до `prepareJob`
   * и снимается единственным `finally` ниже: работа, отказавшая на подготовке
   * рабочей директории или на раскрытии подстановок, обязана убрать за собой
   * так же полно, как дошедшая до конца.
   */
  const resources = createScope({ journal, job: declared.id });

  journal.prepareJob(declared.id);
  // Регистрируется первым — снимется последним: каталог черновиков переживает
  // всё прочее содержимое области.
  resources.defer('снятие каталога черновиков', () => {
    const dir = jobScratchDir(journal.paths, declared.id);
    // Убрать каталог за собой шагу никто не запрещал, и сделанное им — не
    // отказ учёта: жаловаться в журнал на достигнутый результат незачем.
    if (!existsSync(dir)) return;
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  });
  journal.event({ kind: 'job.started', job: declared.id });
  context.records.set(declared.id, {
    ...(context.records.get(declared.id) as JobRecord),
    status: 'running',
    started_at: new Date().toISOString(),
  });
  // Начало работы сбрасывается на диск сразу, а не вместе с исходом первого
  // шага: у работы с одним долгим агентским шагом между этими моментами
  // проходят десятки минут, и всё это время состояние утверждало бы, что
  // работа ещё не начиналась.
  context.refreshStatus();

  context.trees.begin(declared.id);
  try {
    return await runJob(declared, scope, context, resources);
  } finally {
    context.trees.end(declared.id);
    // Пустой каталог черновиков не несёт материала для разбора и не должен
    // копиться в раскладке прогона годами; непустой остаётся — в нём мог лечь
    // след отказа. Отказ любой обратной операции области — учётная операция,
    // не исход работы: агент, которому запрещено трогать что-либо за
    // пределами дерева, права на уборку здесь и не давалось.
    await resources.dispose();
  }
}

/**
 * Исполнение работы: подготовка рабочей директории и внешний цикл `until`.
 *
 * Работа без цикла — вырожденный случай с одной итерацией и без уровня
 * итерации в раскладке журнала.
 */
async function runJob(
  declared: Job,
  scope: Record<string, unknown>,
  context: RunContext,
  resources: ResourceScope,
): Promise<JobOutcome> {
  const { journal } = context;

  // Отложенные подстановки раскрываются ниже, после подготовки рабочей
  // директории: её путь входит в область видимости как `run.workspace`, и
  // раньше он неизвестен. До этого момента работа адресуется объявленной —
  // подстановок в идентификаторе и топологии не бывает по устройству формата.
  let job = declared;

  // Рабочая директория готовится до первого шага. Её отказ означает, что шаги
  // запустить негде, — это `spawn_failed` из закрытого перечня, а не новая
  // причина остановки.
  const loopPass = context.loopPass;
  // Перенос данных по плану возобновления относится к первому проходу:
  // проход N > 1 строится на дереве прошлого, а не на сохранённом исходным прогоном.
  const firstPass = (loopPass?.iteration ?? 1) === 1;
  let placement;
  try {
    placement = await context.trees.place(job, loopPass === undefined || firstPass ? undefined : loopReseed(context, job, loopPass));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      reason: `рабочую директорию в режиме ${job.workspace.mode} подготовить не удалось: ${detail}`,
      cause: HaltCause.spawnFailed,
    };
  }
  const prepared = placement.prepared;

  context.records.set(job.id, {
    ...(context.records.get(job.id) as JobRecord),
    workspace: placement.record,
  });
  // И на диск — сразу, а не вместе с исходом первого шага: перечень читает
  // уборка (`collectRunWorktrees` в `run/cleanup.ts`), и прогон, убитый между
  // подготовкой дерева и концом первого шага, оставил бы учётные записи
  // частей в чужих репозиториях — ровно ту утечку, ради которой заведён учёт.
  context.refreshStatus();

  try {
    const lateEnv = substitutableEnv(declared.env, context);
    job = resolveLate(declared, {
      jobs: (scope.jobs ?? {}) as Readonly<Record<string, JobScopeEntry>>,
      run: {
        id: journal.paths.runId,
        dir: journal.paths.dir,
        workspace: prepared.dir,
        scratch: jobScratchDir(journal.paths, job.id),
      },
      env: lateEnv.env,
      withheld: lateEnv.withheld,
    }, context.registry);
  } catch (error) {
    // Подсказка входит в причину: именно в ней отказ секретной подстановки
    // называет секрет и говорит, что делать.
    const detail =
      error instanceof BurnexError && error.hint !== undefined
        ? `${error.message} (${error.hint})`
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      status: 'failed',
      reason: `подстановку раскрыть не удалось: ${detail}`,
      cause: HaltCause.spawnFailed,
    };
  }

  const liveFiles = context.expanded.pipeline.publication?.liveFiles ?? [];
  let liveSnapshot;
  try {
    liveSnapshot = syncLiveFiles(context.runCwd, prepared.dir, liveFiles);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      reason: `живые файлы в рабочую директорию перенести не удалось: ${detail}`,
      cause: HaltCause.spawnFailed,
    };
  }

  // Раскрытое определение кладётся рядом с записью работы: иначе ответ на
  // вопрос, с каким путём шаг на самом деле пошёл в файловую систему,
  // восстанавливается только из логов.
  journal.writeJobJson(job.id, 'resolved.json', job);

  // Данные переиспользованных шагов переносятся до первого шага: работа ниже
  // по графу читает их подстановкой, и пустота здесь ломала бы её ровно при
  // возобновлении.
  if (firstPass) transferJobData(context, job);

  // Файл выходов заводится пустым в начале каждого исполнения работы (первая
  // попытка и проход цикла; перезапуск `attempts` делает то же в
  // `prepareJobRetry`), а выходы переиспользованных шагов приходят из их
  // записей (`foldJobOutputs`).
  bookkeep({ journal, job: job.id }, 'сброс файла выходов работы', () => {
    resetJobOutputs(jobOutputsPath(journal.paths, job.id));
  });

  // Ниже по коду `context` — контекст работы: у него своя рабочая директория.
  //
  // Источник знания заводится здесь же, по этой самой директории, а не один
  // раз на прогон по каталогу запуска. Причина в предикате `knowledge_valid`:
  // в режиме `worktree` шаг правит копию дерева, и источник, привязанный к
  // каталогу запуска, проверял бы не то, что шаг только что написал, —
  // предикат зеленел бы на сломанной памяти дорожки и краснел бы на чужой,
  // ещё не сведённой. По той же причине и отбор идёт по дереву работы: знание
  // дорожки — это знание её копии, а не главного дерева.
  const jobContext: RunContext = {
    ...context,
    cwd: prepared.dir,
    knowledgeSource: createKnowledgeSource({
      knowledge: context.expanded.pipeline.knowledge,
      root: prepared.dir,
      specDir: context.config.project.spec.dir,
    }),
  };
  const anchorState: AnchorState = {
    anchorer: undefined,
    lastAnchor: undefined,
    startAnchor: undefined,
  };
  // Индексный файл живёт ровно столько, сколько работа. Регистрируется здесь,
  // а не рядом с созданием якоря: якорь заводится заново на каждой итерации
  // цикла `until` под одним и тем же именем файла, и снять его достаточно
  // однажды — тот, что остался последним.
  resources.defer('снятие служебных файлов якоря работы', () => {
    anchorState.anchorer?.dispose();
  });
  const jobStartedAt = Date.now();
  const maxIterations = job.until?.maxIterations ?? 1;
  const maxAttempts = job.attempts.max;
  /** Число использованных попыток пишется в запись работы вместе с финальным исходом. */
  const finishAttempts = (outcome: JobOutcome, used: number): JobOutcome => {
    context.records.set(job.id, {
      ...(context.records.get(job.id) as JobRecord),
      attempts: used,
    });
    return outcome;
  };
  let previousCheck: readonly PredicateResult[] | undefined;
  // Сквозная нумерация вызовов предиката script в until.check — растёт через
  // итерации цикла, тем же образом, что и у предиката script в expect шага.
  let checkScriptCallCount = 0;
  const nextCheckScriptCallIndex = (): number => {
    checkScriptCallCount += 1;
    return checkScriptCallCount;
  };

  /**
   * Одна попытка работы: итерации цикла `until` (или единственная итерация
   * работы без цикла). Номера итераций и счётчики попыток шагов в каждой
   * попытке работы начинаются заново, а `previousCheck` не переходит границу:
   * он описывает дерево, которого после отката уже нет.
   */
  const runIterations = async (attemptContext: RunContext, jobAttempt: number | undefined): Promise<JobOutcome> => {
    previousCheck = undefined;
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (job.until !== undefined) {
        journal.event({ kind: 'iteration.started', job: job.id, iteration });
      }

      const outcome = await runJobSteps(job, declared, attemptContext, anchorState, {
        jobStartedAt,
        ...(job.until === undefined ? {} : { iteration }),
        ...(jobAttempt === undefined ? {} : { jobAttempt }),
        ...(previousCheck === undefined ? {} : { previousCheck }),
      });

      // Отказ шага прекращает цикл немедленно: новой итерации нет, `check` не
      // вычисляется. Повторять то, что уже исчерпало попытки, незачем.
      if (outcome.status !== 'success' || job.until === undefined) {
        if (job.until !== undefined) {
          journal.event({
            kind: 'iteration.finished',
            job: job.id,
            iteration,
            passed: false,
            reason: outcome.reason ?? outcome.status,
          });
        }
        return outcome;
      }

      const results = await evaluateCheck(job, attemptContext, nextCheckScriptCallIndex);
      const passed = results.every((item) => item.passed || !item.hard);
      journal.event({ kind: 'iteration.finished', job: job.id, iteration, passed });

      context.records.set(job.id, {
        ...(context.records.get(job.id) as JobRecord),
        iterations: iteration,
      });

      if (passed) return unpublishedOutputs(context, job) ?? outcome;
      previousCheck = results;

      if (context.usage.check(jobScopes(job, context)) !== undefined) {
        return {
          status: 'budget_exceeded',
          reason: `цикл прекращён: бюджет работы ${job.id} исчерпан`,
          cause: HaltCause.budgetExceeded,
        };
      }
    }

    return {
      status: 'failed',
      reason: `предикаты until не прошли за ${maxIterations} итераций`,
      cause: HaltCause.untilNotMet,
      ...(previousCheck === undefined ? {} : { lastCheck: previousCheck }),
    };
  };

  /** Начатая и ещё не закрытая событием попытка — её закрывает и исключение. */
  let openAttempt: number | undefined;
  let startedAttempts = 0;
  const closeAttempt = (attempt: number, attemptOutcome: JobOutcome): void => {
    openAttempt = undefined;
    journal.event({
      kind: 'job.attempt.finished',
      job: job.id,
      attempt,
      status: attemptOutcome.status,
      ...(attemptOutcome.reason === undefined ? {} : { reason: attemptOutcome.reason }),
    });
  };

  const outcome = await (async (): Promise<JobOutcome> => {
    try {
      // Работа без `attempts` проходит цикл ровно один раз и ничем не отличается
      // от прежней: ни уровня попытки в раскладке, ни событий, ни номера в
      // ключе сессии.
      if (maxAttempts === 1) return await runIterations(jobContext, undefined);

      let last: JobOutcome | undefined;
      for (let jobAttempt = 1; jobAttempt <= maxAttempts; jobAttempt += 1) {
        if (last !== undefined) {
          const stop = prepareJobRetry(job, jobContext, anchorState, last);
          if (stop !== undefined) return finishAttempts(stop, jobAttempt - 1);
        }
        context.usage.beginJobAttempt(job.id, jobAttempt);
        journal.event({ kind: 'job.attempt.started', job: job.id, attempt: jobAttempt });
        openAttempt = jobAttempt;
        startedAttempts = jobAttempt;
        const attemptOutcome = await runIterations({ ...jobContext, jobAttempt }, jobAttempt);
        closeAttempt(jobAttempt, attemptOutcome);
        if (!isRetryableJobOutcome(attemptOutcome) || jobAttempt === maxAttempts) {
          return finishAttempts(attemptOutcome, jobAttempt);
        }
        last = attemptOutcome;
      }
      // Недостижимо: последняя попытка возвращает исход из цикла.
      return finishAttempts(last as JobOutcome, maxAttempts);
    } catch (error) {
    // Ошибка внутри работы — её отказ, а не крушение прогона. Иначе состояние
    // остаётся в `running`, статусы отработавших работ теряются, а работы с
    // `needs: all` не выполняются — то есть разбирать случившееся нечем ровно
    // тогда, когда разбор нужнее всего.
    //
    // Ловится любое исключение: ошибки учёта сюда не доходят, их отделяет
    // `bookkeep`. Значит это либо объявленная ошибка конфигурации, которую
    // нельзя было выявить заранее (путь с подстановкой статически не
    // проверяется), либо дефект движка — и во втором случае унести с собой
    // бухгалтерию прогона хуже, чем отказать одной работой.
    const detail = error instanceof Error ? error.message : String(error);
    journal.event({ kind: 'job.errored', job: job.id, detail });
    const errored: JobOutcome = {
      status: 'failed',
      reason: `работа прервана ошибкой: ${detail}`,
      cause: HaltCause.spawnFailed,
    };
    // Исключение — не повод повторять: дефект движка повторился бы и во второй
    // попытке. Но начатая попытка закрывается, и запись работы называет,
    // сколько попыток использовано, — как при любом другом финальном исходе.
    if (openAttempt !== undefined) closeAttempt(openAttempt, errored);
    return startedAttempts === 0 ? errored : finishAttempts(errored, startedAttempts);
    } finally {
    // Каталог и последний якорь записываются независимо от исхода: голова
    // может продолжить дерево даже упавшей работы, а работа без единого
    // снятого якоря пропускается по цепочке (`resolveSeedSource`). Каталоги
    // голов, ждущих эту работу, заводятся здесь же — до того, как её дерево
    // получит следующая работа: планировщик держит дерево занятым, пока
    // исполнение не вернуло исход.
    context.completedWorkspaces.set(job.id, {
      dir: prepared.dir,
      ...(anchorState.lastAnchor === undefined ? {} : { anchor: anchorState.lastAnchor }),
    });
    await context.trees.completed(job);
    }
  })();

  try {
    writebackLiveFiles({
      sourceRoot: context.runCwd,
      workspaceRoot: prepared.dir,
      liveFiles,
      snapshot: liveSnapshot,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    journal.event({ kind: 'job.errored', job: job.id, detail });
    return {
      status: 'failed',
      reason: `живые файлы вернуть в исходное дерево не удалось: ${detail}`,
      cause: HaltCause.spawnFailed,
    };
  }
  return outcome;
}

/** Цикл участника для переменных окружения шага и его проверок; у работы вне цикла пусто. */
function loopEnv(context: RunContext): { loop?: { id: string; iteration: number; maxIterations: number } } {
  const pass = context.loopPass;
  return pass === undefined
    ? {}
    : { loop: { id: pass.loop.id, iteration: pass.iteration, maxIterations: pass.loop.maxIterations } };
}

/** Запись цикла для `status.json`. */
function loopRecord(runtime: LoopRuntime): LoopRecord {
  const { loop, outcome } = runtime;
  return {
    id: loop.id,
    jobs: [...loop.jobs],
    iterations: outcome?.iterations ?? runtime.iterations,
    max_iterations: loop.maxIterations,
    ...(outcome === undefined ? {} : { verdict: outcome.verdict }),
    status: outcome?.status ?? (runtime.iterations === 0 ? 'pending' : 'running'),
    ...(outcome?.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome?.cause === undefined ? {} : { cause: outcome.cause }),
  };
}

/**
 * Работа, с которой предлагается возобновить прогон, остановившийся на этой.
 * Участник цикла возобновляется с точки входа: цикл — единица повтора, и
 * `--from` на другом участнике отклоняется (design.md, решение 9).
 */
function resumeTarget(pipeline: Pipeline, graph: Graph, jobId: string): string {
  const loop = pipeline.loops.find((candidate) => candidate.jobs.includes(jobId));
  return loop === undefined ? jobId : (loopEntryPoints(graph, loop)[0]?.id ?? jobId);
}

/**
 * Источник дерева точки входа цикла в проходе N > 1: дерево выхода прошлого
 * прохода — последнего участника, у которого оно есть, — а не её внешний
 * источник: починка правит то, что проверка найдёт в следующем проходе.
 * Точка входа в дереве выхода его и так продолжает; дерево иной точки входа
 * засевается каталогом выхода заново (`RunTrees.place`).
 */
function loopReseed(context: RunContext, job: Job, pass: LoopPass): { job: string; dir: string } | undefined {
  const runtime = context.loops.get(pass.loop.id);
  if (runtime === undefined || job.workspace.mode === 'cwd') return undefined;
  if (!loopEntryPoints(context.graph, pass.loop).some((entry) => entry.id === job.id)) return undefined;
  const exit = loopExit(context.graph, pass.loop, (id) => runtime.previous.has(id));
  const tree = exit === undefined ? undefined : runtime.previous.get(exit.id);
  return exit === undefined || tree === undefined ? undefined : { job: exit.id, dir: tree.dir };
}

/**
 * Начало прохода N > 1: у каждого участника сбрасывается то, что иначе
 * просочилось бы из прошлого прохода, — записи шагов, данные, опубликованный
 * выход, — и расход шагов запечатывается. Дерево остаётся: в этом смысл цикла.
 * Сброс — по образцу `prepareJobRetry`.
 */
function resetLoopParticipants(context: RunContext, runtime: LoopRuntime): void {
  const { journal } = context;
  const members = runtime.loop.jobs.filter((id) => context.graph.byId.has(id));

  // Дерево прошлого прохода запоминается и снимается из общих завершённых:
  // иначе участник, пропущенный в этом проходе, отдавал бы дерево позапрошлого.
  const previous = new Map<string, CompletedJob>();
  for (const id of members) {
    const completed = context.completedWorkspaces.get(id);
    if (completed === undefined) continue;
    previous.set(id, completed);
    context.completedWorkspaces.delete(id);
  }
  runtime.previous = previous;

  for (const id of members) {
    const scope = { journal, job: id };
    bookkeep(scope, 'сброс данных участника перед проходом', () => {
      resetJobData(jobDir(journal.paths, id));
      resetJobOutputs(jobOutputsPath(journal.paths, id));
      rmSync(join(journal.paths.artifacts, `${id}.json`), { force: true });
    });
    const index = context.outputs.findIndex((output) => output.job === id);
    if (index !== -1) context.outputs.splice(index, 1);

    const record = context.records.get(id);
    if (record !== undefined) {
      // Исход прошлого прохода уходит целиком: onSettled дописывает только
      // заданные поля, и оставшиеся от него причина или пропуск описывали бы чужой проход.
      const {
        data: _data,
        outputs: _outputs,
        iterations: _iterations,
        output: _output,
        reason: _reason,
        cause: _cause,
        skip: _skip,
        last_check: _lastCheck,
        finished_at: _finishedAt,
        attempts: _attempts,
        ...fresh
      } = record;
      context.records.set(id, { ...fresh, steps: [] });
    }
    context.usage.beginLoopPass(id);
  }
  context.refreshStatus();
}

/**
 * Подготовка новой попытки работы: бюджет, откат дерева, сброс данных, учёт
 * расхода. Возвращает исход, которым работа заканчивается без новой попытки,
 * либо `undefined`, если попытку можно начинать.
 *
 * Откатываются только пути, изменённые работой с её начала (`changedPaths` от
 * якоря начала до текущего состояния), — так же, как возобновление
 * восстанавливает дерево в режиме `cwd`: полный сброс стёр бы файлы
 * пользователя, не принадлежащие работе. Не удавшийся откат повтор отменяет:
 * на неоткаченном дереве он потерял бы смысл, и ради отката ключ и заводится.
 */
function prepareJobRetry(
  job: Job,
  context: RunContext,
  anchorState: AnchorState,
  last: JobOutcome,
): JobOutcome | undefined {
  const { journal } = context;

  if (context.usage.check(jobScopes(job, context)) !== undefined) {
    return {
      status: 'budget_exceeded',
      reason: `попытки прекращены: бюджет работы ${job.id} исчерпан`,
      cause: HaltCause.budgetExceeded,
    };
  }

  const scope = { journal, job: job.id };
  const restored = bookkeep(scope, 'откат дерева перед попыткой работы', () => {
    const { anchorer, startAnchor } = anchorState;
    if (anchorer === undefined || startAnchor === undefined) {
      throw new Error('якорь начала работы не снят');
    }
    const comparison = anchorer.changedPaths(startAnchor, anchorer.capture());
    if (!comparison.comparable) throw new Error(comparison.reason);
    anchorer.restorePaths(startAnchor, comparison.paths);
    journal.event({ kind: 'tree.restored', anchor: startAnchor.id, path: context.cwd });
    return true;
  });
  if (restored !== true) return last;

  // Данные упавшей попытки до потребителей `${jobs.<id>.data.*}` не доходят.
  bookkeep(scope, 'сброс данных работы перед попыткой', () => {
    resetJobData(jobDir(journal.paths, job.id));
    // Выходы упавшей попытки тоже: перезапуск с первого шага не должен их видеть.
    resetJobOutputs(jobOutputsPath(journal.paths, job.id));
  });
  // Шаги упавшей попытки из записи уходят тоже: между попытками состояние
  // прогона иначе показывало бы упавший шаг при работе в `running`, а записи
  // шагов — по требованию — записи последней попытки, которая ещё не начала.
  const {
    data: _published,
    outputs: _publishedOutputs,
    iterations: _iterations,
    ...fresh
  } = context.records.get(job.id) as JobRecord;
  context.records.set(job.id, { ...fresh, steps: [] });

  // Расход шагов уходящей попытки запечатывается: ключ `${job}/${step}#${attempt}`
  // у шага во второй попытке иначе совпал бы с первой.
  context.usage.sealJob(job.id);
  context.refreshStatus();
  return undefined;
}

/**
 * Проверки цикла. Вычисляются после всех шагов итерации, в рабочей директории
 * работы. Время идёт в бюджет работы, токены — только если проверка обращается
 * к агентскому бэкенду.
 */
async function evaluateCheck(
  job: Job,
  context: RunContext,
  nextScriptCallIndex: () => number,
): Promise<PredicateResult[]> {
  const until = job.until;
  if (until === undefined) return [];

  return evaluatePredicates(
    until.check,
    {
      exitCode: 0,
      text: '',
      structured: undefined,
      cwd: context.cwd,
      // Проверка цикла запускает настоящую команду сборки или тестов, и без
      // окружения она не найдёт ни одного инструмента: `execaSync` зовётся с
      // `extendEnv: false`, поэтому пустой набор означает буквально пустой —
      // ни PATH, ни HOME.
      env: jobEnv(job, context),
      knowledge: context.knowledgeSource,
      // Проверка цикла — не попытка шага: подкаталог script-<n> ложится в
      // каталог работы, а не шага, и `exit_code`/пути в input.json несут
      // умолчания «попытки не было» — предикат цикла проверяет состояние
      // рабочего дерева, а не чей-то процесс.
      script: {
        stepDir: context.journal.prepareJob(job.id),
        attempt: 1,
        journal: context.journal,
        nextCallIndex: nextScriptCallIndex,
        timeoutMs: context.config.defaults.stepTimeoutMs,
      },
    },
    context.registry,
  );
}

/**
 * Окружение работы: то же, что у её шагов, но без переменных уровня шага.
 * Проверка цикла шагом не является, и объявлять `BURNEX_STEP` для неё было
 * бы неправдой.
 */
/**
 * Верхнеуровневый `env:` с переопределениями прогона. Накладывается здесь,
 * а не правкой пайплайна: замок и ключи шагов остаются прежними, а значение
 * ложится буквально — раскрытие `${...}` в `env:` документа уже случилось.
 */
function pipelineEnv(pipeline: Pipeline, context: RunContext): Readonly<Record<string, string>> {
  return Object.keys(context.envOverrides).length === 0 ? pipeline.env : { ...pipeline.env, ...context.envOverrides };
}

function jobEnv(job: Job, context: RunContext): Record<string, string> {
  const { pipeline } = context.expanded;
  const { env } = buildStepEnv({
    // Проверка цикла не шаг и секретов не называет: переменные всех
    // объявленных секретов вычеркнуты и из неё (design.md, открытый вопрос).
    ...secretLayers(pipeline, context.secretValues, []),
    base: context.baseEnv ?? process.env,
    envFiles: pipeline.envFiles,
    pipeline: pipelineEnv(pipeline, context),
    job: job.env,
    step: {},
    injected: injectedVariables({
      runId: context.journal.paths.runId,
      runDir: context.journal.paths.dir,
      binPath: context.engine.entry,
      jobId: job.id,
      jobDir: context.journal.prepareJob(job.id),
      attempt: 1,
      jobAttempt: context.jobAttempt ?? 1,
      jobAttemptMax: job.attempts.max,
      ...loopEnv(context),
      workspace: context.cwd,
      artifacts: context.journal.paths.artifacts,
      scratch: jobScratchDir(context.journal.paths, job.id),
      needs: needsVariables(context, job).variables,
    }),
    deny: pipeline.envDeny,
    cwd: context.projectRoot,
  });
  return env;
}

/**
 * Область прогона в перечне потолков работы.
 *
 * У освобождённой работы (`budget_exempt`) потолки расхода и времени прогона
 * из проверки выпадают — в этом освобождение и состоит. Но `rate_limit_pct`
 * не потолок расхода: это доля чужого окна лимита подписки, и упор в него
 * означает не «прогон потратил своё», а «бэкенду сейчас нельзя». Снять его
 * вместе с потолком значило бы, что освобождённая работа с агентскими шагами
 * долбит бэкенд ровно тогда, когда окно уже выбрано, — поэтому у
 * освобождённой работы от области прогона остаётся один этот сторож
 * (pipeline-execution, «Работа, освобождённая от потолка прогона»).
 */
function runScopeOf(job: Job, context: RunContext): BudgetScope | undefined {
  const budget = context.expanded.pipeline.budget;
  if (job.budgetExempt !== true) return { kind: 'run', name: 'пайплайн', budget };
  if (budget?.rateLimitPct === undefined) return undefined;
  return {
    kind: 'run',
    name: 'пайплайн',
    budget: {
      rateLimitPct: budget.rateLimitPct,
      onExceed: budget.onExceed,
      ...(budget.declaredOnExceed === undefined ? {} : { declaredOnExceed: budget.declaredOnExceed }),
    },
  };
}

/** Области бюджета работы и прогона: цикл ограничен ими обеими. */
function jobScopes(job: Job, context: RunContext): BudgetScope[] {
  const scopes: BudgetScope[] = [
    { kind: 'job', name: `работа ${job.id}`, jobId: job.id, budget: job.budget },
  ];
  const loop = context.loopPass === undefined ? undefined : loopScope(context, context.loopPass.loop);
  if (loop !== undefined) scopes.push(loop);
  const run = runScopeOf(job, context);
  if (run !== undefined) scopes.push(run);
  return scopes;
}

/**
 * Область бюджета цикла: расход всех его участников за все проходы, время —
 * от начала первого. `undefined`, если цикл бюджета не объявил.
 */
function loopScope(context: RunContext, loop: Loop): BudgetScope | undefined {
  if (loop.costMicroUsd === undefined && loop.wallclockMs === undefined) return undefined;
  const runtime = context.loops.get(loop.id);
  return {
    kind: 'loop',
    name: `цикл ${loop.id}`,
    jobs: loop.jobs,
    ...(runtime?.startedAt === undefined ? {} : { startedAt: runtime.startedAt }),
    budget: {
      ...(loop.costMicroUsd === undefined ? {} : { costMicroUsd: loop.costMicroUsd }),
      ...(loop.wallclockMs === undefined ? {} : { wallclockMs: loop.wallclockMs }),
      onExceed: 'stop',
    },
  };
}

/**
 * Работа и шаг, от имени которых пишется запись журнала. При чередующихся
 * работах запись без них разбирается только догадкой.
 */
interface StepAddress {
  readonly job: string;
  readonly step: string;
}

/** Исход ожидания сброса окна лимита. */
type WaitOutcome =
  | { readonly kind: 'resumed' }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'stopped'; readonly exceeded: Exceeded };

/**
 * Ждать сброса окна лимита, упёршегося в потолок с `on_exceed: wait`.
 *
 * Вырождается в остановку, если ждать нечего — момент сброса не сообщён,
 * отстоит дальше предела ожидания, или суммарное ожидание за прогон уже
 * исчерпало предел. Сон прерывается сигналом прогона немедленно.
 */
async function waitForReset(
  exceeded: Exceeded,
  context: RunContext,
  where?: StepAddress,
): Promise<WaitOutcome> {
  if (exceeded.resetsAt === undefined) {
    return {
      kind: 'stopped',
      exceeded: {
        ...exceeded,
        onExceed: 'stop',
        waitDegeneration: 'бэкенд не сообщил момент сброса окна лимита',
      },
    };
  }

  const now = Date.now();
  const waitMs = exceeded.resetsAt - now;
  // Момент сброса в прошлом сном не считается: следующая попытка либо
  // покажет упавший процент, либо упрётся снова — в пределах общего предела.
  if (waitMs <= 0) return { kind: 'resumed' };

  const maxWaitMs = context.config.defaults.maxWaitMs;
  if (context.usage.wouldExceedMaxWait(waitMs, maxWaitMs)) {
    return {
      kind: 'stopped',
      exceeded: {
        ...exceeded,
        onExceed: 'stop',
        waitDegeneration: `предел ожидания ${formatDuration(maxWaitMs)} исчерпан; сброс сообщён на ${new Date(exceeded.resetsAt).toISOString()}`,
      },
    };
  }

  const wakeAt = new Date(exceeded.resetsAt).toISOString();
  const endWait = context.beginWait(wakeAt);
  context.journal.event({
    kind: 'budget.waiting',
    scope: exceeded.scope,
    ...(where === undefined ? {} : { job: where.job, step: where.step }),
    dimension: 'rate_limit',
    threshold: exceeded.limit,
    resets_at: exceeded.resetsAt,
    wait_ms: waitMs,
  });

  const started = Date.now();
  const canceled = await sleepInterruptibly(waitMs, context.signal);
  const actualMs = Date.now() - started;

  context.usage.recordWait(started, started + actualMs);
  endWait();
  if (canceled) return { kind: 'canceled' };

  context.journal.event({
    kind: 'budget.resumed',
    ...(where === undefined ? {} : { job: where.job, step: where.step }),
    actual_ms: actualMs,
  });
  return { kind: 'resumed' };
}

/** Исход попытки, упёршейся в неустранимый отказ бэкенда — шага или судьи. */
type RefusalOutcome = { readonly kind: 'retry' } | { readonly kind: 'final'; readonly outcome: StepOutcome };

/**
 * Режим для отказа по лимиту: у ближайшей *объявившей* его области — шаг →
 * работа → пайплайн. Берётся написанное в документе, а не действующее
 * значение бюджета: умолчание `stop` стоит в каждом объявленном бюджете, и по
 * действующему значению шаг с одним лишь `tokens` молча отменял бы
 * пайплайновый `on_exceed: wait`.
 */
function resolveOnExceedForRateLimit(job: Job, step: Step, context: RunContext): 'wait' | 'stop' {
  return (
    step.budget?.declaredOnExceed ??
    job.budget?.declaredOnExceed ??
    context.expanded.pipeline.budget?.declaredOnExceed ??
    'stop'
  );
}

/**
 * Ждать сброса окна лимита, когда бэкенд отказал упором в лимит подписки, а
 * не когда прогон сам измерил превышение `rate_limit_pct`. Механика та же,
 * что у `waitForReset` (предел `defaults.max_wait`, немедленное прерывание
 * сигналом отмены, невычитание сна из `wallclock`), но `used`/`limit`
 * измеренного процента здесь нет и подделывать их нечем: отказ бэкенда не
 * есть измеренная доля окна.
 */
async function waitForBackendRateLimit(
  refusal: BackendRefusal,
  scopeName: string,
  where: StepAddress,
  context: RunContext,
): Promise<{ readonly kind: 'resumed' } | { readonly kind: 'canceled' } | { readonly kind: 'stopped'; readonly reason: string }> {
  if (refusal.resetAt === undefined) {
    return {
      kind: 'stopped',
      reason: `${scopeName}: бэкенд не сообщил момент сброса окна лимита — ${refusal.message}`,
    };
  }

  const now = Date.now();
  const waitMs = refusal.resetAt - now;
  if (waitMs <= 0) return { kind: 'resumed' };

  const maxWaitMs = context.config.defaults.maxWaitMs;
  if (context.usage.wouldExceedMaxWait(waitMs, maxWaitMs)) {
    return {
      kind: 'stopped',
      reason: `${scopeName}: предел ожидания ${formatDuration(maxWaitMs)} исчерпан; сброс сообщён на ${new Date(refusal.resetAt).toISOString()} — ${refusal.message}`,
    };
  }

  const wakeAt = new Date(refusal.resetAt).toISOString();
  const endWait = context.beginWait(wakeAt);
  context.journal.event({
    kind: 'budget.waiting',
    scope: scopeName,
    job: where.job,
    step: where.step,
    dimension: 'rate_limit',
    resets_at: refusal.resetAt,
    wait_ms: waitMs,
  });

  const started = Date.now();
  const canceled = await sleepInterruptibly(waitMs, context.signal);
  const actualMs = Date.now() - started;

  context.usage.recordWait(started, started + actualMs);
  endWait();
  if (canceled) return { kind: 'canceled' };

  context.journal.event({
    kind: 'budget.resumed',
    job: where.job,
    step: where.step,
    actual_ms: actualMs,
  });
  return { kind: 'resumed' };
}

/**
 * Обработать неустранимый отказ бэкенда — общий путь для шага и судьи внутри
 * него. Событие журнала пишется здесь же: причина видна без чтения
 * `stdout.log` шага.
 */
async function resolveBackendRefusal(
  refusal: BackendRefusal,
  job: Job,
  step: Step,
  attempt: number,
  context: RunContext,
  base: Pick<StepOutcome, 'attempts' | 'results' | 'session'>,
): Promise<RefusalOutcome> {
  context.journal.event({
    kind: 'backend.refused',
    job: job.id,
    step: step.id,
    attempt,
    class: refusal.class,
    ...(refusal.statusCode === undefined ? {} : { status_code: refusal.statusCode }),
    message: refusal.message,
    ...(refusal.resetAt === undefined ? {} : { resets_at: refusal.resetAt }),
  });

  if (refusal.class === 'unauthenticated') {
    return {
      kind: 'final',
      outcome: {
        ...base,
        status: 'failed',
        reason: describeRefusal(refusal),
        cause: HaltCause.backendUnauthenticated,
      },
    };
  }

  const scopeName = `${job.id}/${step.id}`;
  const mode = resolveOnExceedForRateLimit(job, step, context);
  const waited =
    mode === 'wait'
      ? await waitForBackendRateLimit(refusal, scopeName, { job: job.id, step: step.id }, context)
      : ({
          kind: 'stopped',
          reason: `${scopeName}: упор в окно лимита подписки бэкенда — ${refusal.message}`,
        } as const);

  if (waited.kind === 'resumed') {
    // Расход оборванной попытки запечатывается перед переисполнением: иначе
    // новая попытка ляжет под тем же ключом `job/step#attempt` и разностный
    // учёт `UsageAccumulator.record` вычтет из потолков расход прерванной —
    // ровно то, чего требование «расход прерванной попытки остаётся
    // учтённым» запрещает.
    context.usage.sealStep(job.id, step.id);
    return { kind: 'retry' };
  }
  if (waited.kind === 'canceled') {
    return { kind: 'final', outcome: { ...base, status: 'canceled' } };
  }
  return {
    kind: 'final',
    outcome: {
      ...base,
      status: 'budget_exceeded',
      reason: waited.reason,
      cause: HaltCause.backendRateLimited,
    },
  };
}

/** Сон, прерываемый сигналом отмены. Возвращает true, если прерван. */
function sleepInterruptibly(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Якоря работы, которыми пользуется её внешний цикл. `startAnchor` — состояние
 * дерева перед первым шагом первой попытки: откат перед повтором ведёт к нему.
 */
interface AnchorState {
  anchorer: TreeAnchorer | undefined;
  lastAnchor: Anchor | undefined;
  startAnchor: Anchor | undefined;
}

interface IterationOptions {
  /**
   * Момент начала работы. Потолок времени работы меряет её саму, включая все
   * итерации цикла, а не прогон целиком.
   */
  readonly jobStartedAt: number;
  /** Номер итерации. Отсутствует у работы без цикла. */
  readonly iteration?: number;
  /** Номер попытки работы. Отсутствует у работы без `attempts`. */
  readonly jobAttempt?: number;
  /** Результаты непрошедшего `check` предыдущей итерации. */
  readonly previousCheck?: readonly PredicateResult[];
}

async function runJobSteps(
  job: Job,
  declared: Job,
  context: RunContext,
  anchorState: AnchorState,
  iterationOptions: IterationOptions,
): Promise<JobOutcome> {
  const { journal } = context;
  const iteration = iterationOptions.iteration;
  const jobAttempt = iterationOptions.jobAttempt;
  const loopPass = context.loopPass;
  const firstPass = (loopPass?.iteration ?? 1) === 1;
  const jobStartedAt = iterationOptions.jobStartedAt;
  context =
    iterationOptions.previousCheck === undefined
      ? context
      : { ...context, iterationCheck: iterationOptions.previousCheck };

  // Якорь на работу: индексный файл переиспользуется между её шагами, поэтому
  // `add -A` платит только за изменившиеся файлы.
  const scope = { journal, job: job.id };
  const anchorer = bookkeep(scope, 'создание якоря', () =>
    (context.anchorerFor ?? createAnchorer)({
      dir: context.cwd,
      stateDir: journal.paths.anchors,
      kind: context.anchorKind,
      scope: job.id,
      // Рабочая копия сама рабочим деревом git не является: базу объектов ей
      // даёт репозиторий прогона.
      repoDir: context.runCwd,
      // Составной способ допустим и в режиме cwd, и в режиме worktree
      // (checkWorkspaceAvailability): в обоих `context.cwd` — каталог, где
      // объявленные части уже материализованы своими рабочими деревьями. Для
      // остальных способов `nested` попросту не читается.
      ...(context.config.project.nestedRepos === undefined
        ? {}
        : { nested: context.config.project.nestedRepos }),
    }),
  );
  anchorState.anchorer = anchorer;

  /** Снять якорь. Неудача — запись в журнал и `undefined`, статусы не трогает. */
  const capture = (step?: string): Anchor | undefined =>
    anchorer === undefined
      ? undefined
      : bookkeep({ ...scope, ...(step === undefined ? {} : { step }) }, 'снятие якоря', () =>
          anchorer.capture(),
        );

  let treeAnchor = capture();
  anchorState.lastAnchor = treeAnchor;
  // Начало работы — только первая попытка и первая итерация: повтор должен
  // вернуть дерево к состоянию до всех шагов, а не к началу своей итерации.
  anchorState.startAnchor ??= treeAnchor;

  /**
   * Псевдоним сессии, замкнутый на её пространство имён.
   *
   * Без объявленной группы пространство — работа и итерация её цикла: это
   * ровно сегодняшнее поведение, при котором реестр жил в исполнении работы и
   * новая итерация `until` начинала сессии заново.
   *
   * С объявленной группой пространство — сама группа, и итерация в ключ не
   * входит: сессия группы переживает границу работы, и «начинать заново» на
   * итерации было бы нечего — предыдущие работы группы уже закончились. Работе
   * группы цикл `until` поэтому и запрещён (см. линт).
   */
  // Псевдоним принадлежит адаптеру: одинаковое `session: default` у Claude
  // и Codex означает два разных диалога, а идентификатор одной стороны другая
  // продолжить не умеет. Имя агента входит и в обычное пространство работы, и
  // в явную группу сессий.
  const sessionKey = (agent: string, alias: string): string => {
    // Номер попытки работы входит в ключ только у работы с `attempts`: у прочих
    // ключ прежний. Новая попытка начинает сессии заново, как новая итерация.
    // Проход цикла входит в ключ только у участника: новый проход начинает
    // сессии заново, а у работы вне цикла ключ прежний.
    const passPart = loopPass === undefined ? '' : `p${loopPass.iteration}.`;
    const scope = job.sessionGroup === undefined
      ? `${job.id}#${passPart}${jobAttempt === undefined ? '' : `${jobAttempt}.`}${iteration ?? 1}`
      : job.sessionGroup;
    return `${scope}/${agent}/${alias}`;
  };

  // Сессии, в которые уже отправлен контекст самой работы и выходы
  // предшественников. Отслеживание живёт в работе, а не в прогоне, в отличие
  // от контекста пайплайна: собственный контекст второй работы группы — это
  // новое знание, и умолчать о нём потому, что диалог уже начат, значило бы
  // отправить её работать по пустому месту.
  const jobContextSent = new Set<string>();
  const steps: StepRecord[] = [];
  let lastStructuredOutput: unknown;
  let outputFromStep: unknown;
  /** `output.from` назвал переиспользованный шаг, а его выход не перенёсся. */
  let outputFromStepMissing = false;

  // Коллизия `NEEDS_*` от двух производителей — отказ до первого шага, а не
  // тихое перекрытие; повтор воспроизвёл бы её же.
  const { collision } = needsVariables(context, job);
  if (collision !== undefined) return { status: 'failed', reason: collision, terminal: true };

  for (const [position, step] of job.steps.entries()) {
    // Ключ шага держится на нераскрытом определении: отложенные подстановки
    // пространства `run` уникальны для каждого прогона, и раскрытый текст
    // сделал бы ключ невоспроизводимым. Соответствие — позиционное:
    // `resolveLate` обходит дерево работы, не добавляя, не убирая и не
    // переставляя шаги. По `step.id` его устанавливать нельзя — идентификатор
    // сам может содержать подстановку, и тогда раскрытый шаг не нашёл бы себя
    // в нераскрытом определении, а при совпадающих идентификаторах ключ
    // молча считался бы не от того шага.
    const declaredStep = declared.steps[position];
    if (declaredStep === undefined) {
      throw new Error(
        `внутренняя ошибка: шагу ${job.id}/${step.id} не найдено соответствие в нераскрытом определении работы`,
      );
    }

    const stepDirPath = journal.prepareStep(job.id, step.index, step.id, iteration, jobAttempt, loopPass?.iteration);

    // План возобновления описывает исполнение исходного прогона. Повтор работы
    // его не продолжает: переиспользовать шаг во второй попытке значило бы
    // собрать дерево, которого не было ни в одной попытке.
    const planned =
      (jobAttempt !== undefined && jobAttempt > 1) || !firstPass ? undefined : planFor(context, job.id, step.id);
    if (planned?.decision.kind === 'skip') {
      // План перенёс пропуск из исходного прогона и на этом основании
      // переиспользует работы ниже. Раз работа всё же исполняется, её условие
      // посчиталось иначе, чем обещал план, — исполнить её сейчас значило бы
      // оставить ниже переиспользованным то, что опиралось на её отсутствие.
      return {
        status: 'failed',
        reason: `план возобновления считал работу ${job.id} пропущенной условием, как в прошлом прогоне, а условие выполнилось — возобновите без переноса пропуска: burnex resume --from ${job.id}`,
        terminal: true,
      };
    }
    if (planned?.decision.kind === 'reuse') {
      const reused: StepRecord = {
        ...planned.decision.record,
        reused_from: context.resume?.source.manifest.run_id ?? 'неизвестно',
      };
      steps.push(reused);
      journal.writeStepJson(stepDirPath, 'step.json', reused);
      journal.event({
        kind: 'step.reused',
        job: job.id,
        step: step.id,
        source: reused.reused_from as string,
      });
      context.records.set(job.id, {
        ...(context.records.get(job.id) as JobRecord),
        steps: [...steps],
      });
      // Запись шага уже несёт его выходы из исходного прогона: дописывать её незачем.
      const { violation: dataViolation } = foldPublished(context, job, step, reused);
      if (dataViolation !== undefined) return { status: 'failed', reason: dataViolation, terminal: true };
      if (
        (step.kind === 'agent' ||
          step.kind === 'review' ||
          step.kind === 'discuss' ||
          (step.kind === 'run' && step.outputSchemaPath !== undefined) ||
          step.kind === 'script' ||
          step.kind === 'plugin') &&
        planned.decision.record.status === 'success'
      ) {
        // Переиспользованный шаг не исполнялся, структурированного вывода у
        // него в этом прогоне нет: он переносится из исходного прогона —
        // единственный источник `output.from` при частичном переиспользовании
        // работы, когда выход работы целиком не перенесён.
        const transferred = transferStepOutput(context, job.id, step.id, stepDirPath);
        lastStructuredOutput =
          transferred ?? context.resume?.plan.outputs.get(job.id) ?? lastStructuredOutput;
        if (job.output?.from === step.id) {
          // Перенос мог не удаться: файла выхода в исходном прогоне нет или он
          // не разбирается. Отметку нужно сохранить — иначе ниже сработает
          // запасной `lastStructuredOutput`, и работа опубликует как свой выход
          // другого, позже исполненного шага.
          outputFromStep = transferred;
          outputFromStepMissing = transferred === undefined;
        }
      }
      treeAnchor =
        reused.tree_id === undefined
          ? treeAnchor
          : { kind: reused.anchor_kind ?? context.anchorKind, id: reused.tree_id };
      anchorState.lastAnchor = treeAnchor;
      continue;
    }

    // Продолжение оборванной сессии: засев реестра и отметок об отправленном
    // контексте случается до первой попытки — `executeAgentStep` берёт
    // сессию как обычно и получает `resume: true` там, где реестр сегодня
    // выдал бы новый идентификатор (design.md, решение 5).
    const continuing = planned?.decision.kind === 'continue' ? planned.decision : undefined;
    const continuationSourceId = context.resume?.source.manifest.run_id ?? 'неизвестно';
    if (continuing !== undefined && step.kind === 'agent') {
      const key = sessionKey(step.agent, step.session);
      context.sessions.seed(key, continuing.sessionId);
      context.pipelineContextSent.add(key);
      jobContextSent.add(key);
      journal.event({
        kind: 'session.continued',
        job: job.id,
        step: step.id,
        session: continuing.sessionId,
        source: continuationSourceId,
      });
      // Расход оборванной попытки складывается со счётом продолжающего шага
      // независимо от исхода продолжения: он уже потрачен, а не поставлен
      // под вопрос отказом сессии у бэкенда (design.md, решение 8).
      const carriedUsage = continuing.record.attempts.at(-1)?.usage;
      if (carriedUsage !== undefined) context.usage.carry(job.id, step.id, carriedUsage);
      // Нарастающая цена сессии на конец оборванной попытки — от неё
      // продолжение вычтет свою цену, а не запишет всю сессию заново.
      if (carriedUsage?.session_cost_usd !== undefined) {
        context.sessions.noteCost(continuing.sessionId, carriedUsage.session_cost_usd);
      }
    }

    if (loopPass !== undefined) (context.loops.get(loopPass.loop.id) as LoopRuntime).executed = true;
    journal.event({ kind: 'step.started', job: job.id, step: step.id, attempt: 1 });

    const treeBefore = treeAnchor;
    // Отпечаток считается до запуска: он отвечает на вопрос о валидности шага,
    // а вопрос этот имеет смысл только перед исполнением.
    const fingerprint = fingerprintInputs({
      dir: context.cwd,
      treeAnchor: treeBefore,
      declared: job.inputs,
      observed: context.observedInputs?.get(`${job.id}/${step.id}`),
    });

    // Начало шага — здесь: потолок времени шага меряет шаг, а не прогон.
    const stepStartedAt = Date.now();

    // Освобождённая работа (`budget_exempt`) не проверяется на потолок
    // прогона: область `run` выпадает из перечня — кроме сторожа окна лимита
    // подписки, который в ней остаётся (`runScopeOf`). Области работы и шага
    // остаются как есть. Расход при этом по-прежнему копится в счётчиках
    // прогона через context.usage.record — освобождение снимает применение
    // потолка, а не учёт (design.md, решение 4).
    const budgetScopes = (): BudgetScope[] => {
      const scopes: BudgetScope[] = [
        {
          kind: 'step',
          name: `${job.id}/${step.id}`,
          jobId: job.id,
          stepId: step.id,
          startedAt: stepStartedAt,
          budget: step.budget,
        },
        {
          kind: 'job',
          name: `работа ${job.id}`,
          jobId: job.id,
          startedAt: jobStartedAt,
          budget: job.budget,
        },
      ];
      const loop = context.loopPass === undefined ? undefined : loopScope(context, context.loopPass.loop);
      if (loop !== undefined) scopes.push(loop);
      const run = runScopeOf(job, context);
      if (run !== undefined) scopes.push(run);
      return scopes;
    };

    // Потолок, перейдённый до этого шага, решает ровно один вопрос — запускать
    // ли его. Шаг, который движок решил не запускать, получает budget_exceeded
    // тем же путём, что и любой неуспешный шаг ниже, но бэкенд и команда не
    // стартуют вовсе (design.md, решение 1).
    const exceeded = context.usage.check(budgetScopes());

    // Пути, изменившиеся за время шага, нужны только предикату границ —
    // считаем их лениво и только когда он объявлен.
    const wantsChanged = step.expect.some((predicate) => predicate.kind === 'changed_only');
    const changedPaths = (): readonly string[] | undefined => {
      if (!wantsChanged || anchorer === undefined || treeBefore === undefined) return undefined;
      const now = bookkeep({ ...scope, step: step.id }, 'снятие якоря для changed_only', () =>
        anchorer.capture(),
      );
      if (now === undefined) return undefined;
      const comparison = bookkeep({ ...scope, step: step.id }, 'сравнение состояний', () =>
        anchorer.changedPaths(treeBefore, now),
      );
      return comparison?.comparable === true ? comparison.paths : undefined;
    };

    // Исход исполненного шага — его собственный, без исключений: попытку,
    // которую применение потолка оборвало на середине, `runCommandStep`/
    // `runAgentStep` отдают уже как budget_exceeded сами (design.md, решение
    // 2) — здесь статус больше не переписывается.
    const outcome: StepOutcome =
      exceeded !== undefined
        ? { status: 'budget_exceeded', reason: describeExceeded(exceeded), attempts: [], results: [], exceeded }
        : context.mode === 'shadow' && step.kind !== 'plugin' && !isPanelStep(step) && step.external === true
          ? runShadowStep(step, job, context, stepDirPath)
          : step.kind === 'review'
          ? await runReviewStep(step, job, context, stepDirPath, sessionKey, jobContextSent, budgetScopes, changedPaths)
          : step.kind === 'discuss'
          ? await runDiscussStep(step, job, context, stepDirPath, sessionKey, jobContextSent, budgetScopes, changedPaths)
          : step.kind === 'run' || step.kind === 'script'
          ? await runCommandStep(
              step,
              job,
              context,
              stepDirPath,
              context.sessions,
              budgetScopes,
              changedPaths,
            )
          : step.kind === 'plugin'
            ? await runPluginStepDispatch(step, job, context, stepDirPath, budgetScopes, changedPaths, iteration)
            : await runAgentStep(
                step,
                job,
                context,
                stepDirPath,
                context.sessions,
                sessionKey,
                jobContextSent,
                budgetScopes,
                changedPaths,
              );

    for (const [index, results] of outcome.results.entries()) {
      journal.writeExpectReport(stepDirPath, { attempt: index + 1, results: [...results] });
    }

    const status: StatusValue = outcome.status;
    const reason = outcome.reason;
    const cause = causeOf(status, outcome.results, outcome.cause);

    // Защёлка прогона запоминает первое превышение, которое дело остановило.
    // Остановивших два вида, и оба ниже: шаг, который потолок не дал запустить
    // или чью попытку оборвал, — он и числится `budget_exceeded`; и перейдённый
    // потолок прогона, останавливающий всё, что после него, даже когда сам шаг
    // дошёл до конца успехом (design.md, решение 3).
    //
    // Перейдённый потолок шага или работы, никого не остановивший (его перевела
    // последняя запись расхода успевшей попытки, а следующему шагу область
    // отсчитывается заново), в защёлку не идёт: прогон доигрывается целиком, и
    // объявлять его остановленным по бюджету — та же ложь в поле статуса,
    // против которой заведено изменение, только уровнем выше. Она заодно
    // прятала бы под собой настоящий отказ, случившийся позже.
    const stopping =
      outcome.exceeded !== undefined &&
      (status === 'budget_exceeded' || outcome.exceeded.scopeKind === 'run')
        ? outcome.exceeded
        : undefined;

    if (context.budgetExceededLatch.value === undefined && stopping !== undefined) {
      context.budgetExceededLatch.value = {
        scope: stopping.scope,
        dimension: stopping.dimension,
        used: stopping.used,
        limit: stopping.limit,
        at: new Date().toISOString(),
        job: job.id,
        step: step.id,
      };
    }

    // Якорь снимается при любом исходе, включая отказ, отмену и превышение
    // бюджета: разбирать упавший прогон без состояния дерева нечем.
    const treeAfter = capture(step.id);
    treeAnchor = treeAfter ?? treeAnchor;
    anchorState.lastAnchor = treeAnchor;

    if (anchorer !== undefined && treeBefore !== undefined && treeAfter !== undefined) {
      const patch = bookkeep({ ...scope, step: step.id }, 'вычисление diff.patch', () =>
        anchorer.diff(treeBefore, treeAfter),
      );
      if (patch !== undefined) journal.writeStepFile(stepDirPath, 'diff.patch', patch);
    }

    const stepRecord: StepRecord = {
      id: step.id,
      index: step.index,
      kind: step.kind,
      key: computeStepKey({
        // Хеш определения именно этой работы, а не всего пайплайна: правка
        // файла другой работы не должна менять ключ шагов, которые её не
        // касаются. Оба входа — нераскрытые: раскрытие подставляет величины
        // пространства `run`, уникальные для каждого прогона.
        lockHash: jobLockHash(context.expanded.pipeline, declared),
        jobId: job.id,
        step: declaredStep,
        inputsFingerprint: fingerprint?.value,
        ...stepBackendCommands(declaredStep, context.config.backends),
        // Порядок завершения работ у исполнителя свой, у планировщика
        // возобновления свой; общая функция приводит оба к одному виду.
        // Состав берётся по графу, а не по тому, что успело завершиться:
        // иначе ключ шага, а с ним и решение о переиспользовании, зависели бы
        // от длительности соседних работ.
        upstream: upstreamForKey(upstreamOutputs(context.graph, job.id, context.outputs)),
      }),
      status,
      ...(treeAfter === undefined
        ? { anchor_missing: 'якорь состояния дерева снять не удалось' }
        : { tree_id: treeAfter.id, anchor_kind: treeAfter.kind }),
      ...(treeBefore === undefined ? {} : { tree_before: treeBefore.id }),
      ...(fingerprint === undefined
        ? {}
        : { inputs_fingerprint: fingerprint.value, inputs_origin: fingerprint.origin }),
      ...(reason === undefined ? {} : { reason }),
      ...(cause === undefined ? {} : { cause }),
      ...(outcome.session === undefined ? {} : { session: outcome.session }),
      attempts:
        continuing === undefined
          ? [...outcome.attempts]
          : [...carriedAttempts(continuing.record, continuationSourceId), ...outcome.attempts],
      ...(outcome.observedInputs === undefined || outcome.observedInputs.length === 0
        ? {}
        : { observed_inputs: [...outcome.observedInputs] }),
      ...(outcome.backendInit === undefined ? {} : { backend_init: outcome.backendInit }),
      ...(continuing === undefined ? {} : { continued_from: continuationSourceId }),
      ...(step.kind === 'script' && step.resolved !== undefined
        ? {
            script: {
              path: step.path,
              layer: step.resolved.layer,
              ...(step.resolved.package === undefined ? {} : { package: step.resolved.package }),
              absolute_path: step.resolved.absolutePath,
              runner: step.resolved.runner,
              argv: [...step.resolved.argv],
            },
          }
        : {}),
      ...(step.kind === 'script' && step.uses !== undefined
        ? {
            uses: {
              name: step.uses.name,
              ...(step.uses.layer === undefined ? {} : { layer: step.uses.layer }),
              ...(step.uses.package === undefined ? {} : { package: step.uses.package }),
              ...(step.uses.manifestPath === undefined ? {} : { manifest_path: step.uses.manifestPath }),
            },
          }
        : {}),
      // Вид и плагин шага плагинного вида (design.md, риски): читатель без
      // этого плагина показывает запись этими же полями, не отказывая
      // чтением. Владелец не бывает «встроенным» — `kind: plugin` у
      // встроенных видов не встречается вовсе.
      ...(step.kind === 'plugin'
        ? {
            plugin_step: {
              name: step.name,
              plugin: contributionOwner(context.registry, 'steps', step.name) ?? 'неизвестный',
            },
          }
        : {}),
      ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
    };
    steps.push(stepRecord);
    journal.writeStepJson(stepDirPath, 'step.json', stepRecord);

    if (
      (step.kind === 'agent' ||
        // Выход шага `review` — вердикт агрегатора (`review-strategies`),
        // шага `discuss` — проектный документ агрегатора (`discuss-step`).
        step.kind === 'review' ||
        step.kind === 'discuss' ||
        (step.kind === 'run' && step.outputSchemaPath !== undefined) ||
        step.kind === 'script' ||
        // Структурированный выход шага плагинного вида — то, что вернул
        // исполнитель вклада (`StepKindOutcome.structured`): схема `output`
        // его проверяет, когда объявлена, но не она решает, есть ли он.
        step.kind === 'plugin') &&
      outcome.structured !== undefined
    ) {
      lastStructuredOutput = outcome.structured;
      // Шаг `script` уже записал этот файл сам — байт в байт, как и было
      // (design.md, решение 5). Переписать его здесь — заново сериализовать
      // то же значение — значило бы потерять форматирование скрипта.
      if (step.kind !== 'script') {
        journal.writeStepJson(stepDirPath, 'output.json', outcome.structured);
      }
    }
    if (job.output?.from === step.id) outputFromStep = outcome.structured;

    journal.event({
      kind: 'step.finished',
      job: job.id,
      step: step.id,
      // Ни одной попытки не было, когда потолок остановил шаг до запуска
      // (`outcome.attempts` пуст) — событие всё равно называет номер попытки,
      // и им остаётся первая: `step.started` его уже назвал этим же числом.
      attempt: outcome.attempts.length === 0 ? 1 : outcome.attempts.length,
      status,
      ...(reason === undefined ? {} : { reason }),
    });

    context.records.set(job.id, {
      ...(context.records.get(job.id) as JobRecord),
      steps: [...steps],
    });
    // Данные складываются при любом исходе шага — они рассказывают, на чём
    // работа встала, — но исход шага решает первым: шаг, упавший по `expect`,
    // таймауту или бюджету, обязан отдать наружу свою причину и свой
    // `cause`. Нарушение объявления при этом не теряется: оно дописывается к
    // причине, потому что статус у работы всё равно один.
    const { violation: dataViolation, published: publishedOutputs } = foldPublished(context, job, step);
    attachPublishedOutputs(context, job, steps, stepDirPath, publishedOutputs);

    // Шаг сказал «делать нечего» кодом выхода: остальные шаги не идут, работа
    // пропущена, а не упала, и `output` у неё не публикуется. Нарушение
    // объявления `data` от исхода шага не зависит и остаётся отказом.
    if (status === 'skipped') {
      if (dataViolation !== undefined) return { status: 'failed', reason: dataViolation, terminal: true };
      return {
        status: 'skipped',
        skip: 'declared',
        reason: `шаг ${step.id}: ${reason ?? 'шаг объявил пропуск'}`,
      };
    }

    if (status !== 'success') {
      const detail = reason === undefined ? undefined : `шаг ${step.id}: ${reason}`;
      const joined = [detail, dataViolation].filter((part) => part !== undefined).join('; ');
      return {
        status,
        ...(joined === '' ? {} : { reason: joined }),
        ...(cause === undefined ? {} : { cause }),
        // Необъявленный ключ данных повтор воспроизвёл бы: файл остаётся на месте.
        ...(dataViolation === undefined ? {} : { terminal: true }),
      };
    }

    // Шаг отработал успешно, а данные оставил недопустимые: причина отказа —
    // сама запись мимо объявления. Причины остановки прогона (`cause`) здесь
    // нет — перечень закрыт, и ни одна его строка про это не говорит; так же
    // возвращается отказ по неперенесённому выходу шага ниже.
    if (dataViolation !== undefined) return { status: 'failed', reason: dataViolation, terminal: true };
  }

  // У работы с `until` итерация — ещё не конец работы: недостачу проверяет
  // `runIterations` после сошедшейся итерации.
  if (job.until === undefined) {
    const unpublished = unpublishedOutputs(context, job);
    if (unpublished !== undefined) return unpublished;
  }

  if (outputFromStepMissing) {
    return {
      status: 'failed',
      reason: `выход шага ${job.output?.from} не перенесён из исходного прогона: файла нет или он не разбирается`,
    };
  }

  const published = job.output === undefined ? undefined : (outputFromStep ?? lastStructuredOutput);
  if (job.output !== undefined && published !== undefined) {
    const path = journal.writeArtifact(job.id, published);
    // Выходом работы с циклом становится результат последней выполненной
    // итерации: запись замещается, а не накапливается по итерациям.
    const existing = context.outputs.findIndex((output) => output.job === job.id);
    const entry = { job: job.id, path, value: published };
    if (existing === -1) context.outputs.push(entry);
    else context.outputs[existing] = entry;
    context.records.set(job.id, {
      ...(context.records.get(job.id) as JobRecord),
      output: path,
    });
    return { status: 'success', output: published };
  }

  return { status: 'success' };
}

export interface StepOutcome {
  readonly status: StatusValue;
  readonly reason?: string;
  readonly attempts: readonly StepRecord['attempts'][number][];
  readonly results: readonly (readonly PredicateResult[])[];
  readonly structured?: unknown;
  readonly session?: string;
  readonly observedInputs?: readonly string[];
  readonly backendInit?: Record<string, unknown>;
  readonly exceeded?: ReturnType<UsageAccumulator['check']>;
  /**
   * Причина неуспеха, назначенная самим исходом, а не выводимая из статуса
   * позже: неустранимый отказ бэкенда определяет её точнее, чем это умеет
   * `causeOf` по одному статусу и результатам предикатов.
   */
  readonly cause?: HaltCauseValue;
  /**
   * Решение, применённое к ожиданию этого шага (design.md изменения
   * `user-decision-steps`, решение 5) — есть только у шага ожидающего вида,
   * дождавшегося ответа.
   */
  readonly decision?: DecisionRecord;
}

/**
 * Комбинированный сигнал шага: аборт по отмене прогона *или* по превышению
 * бюджета с `on_exceed: wait` по `rate_limit`. Разделены, чтобы после
 * исполнения отличить настоящую отмену от прерывания ради ожидания — только
 * второе ведёт в переисполнение шага, а не в статус `canceled`.
 */
function stepAbort(
  context: RunContext,
  resources: ResourceScope,
): {
  readonly controller: AbortController;
  readonly trigger: (found: Exceeded | undefined) => void;
  waitTrigger: Exceeded | undefined;
} {
  const controller = new AbortController();
  const onRunAbort = (): void => controller.abort();
  context.signal?.addEventListener('abort', onRunAbort, { once: true });
  // Слушатель снимается вместе с областью попытки, а не вручную после
  // исполнения: попытка, прерванная исключением, оставляла бы его висеть на
  // сигнале прогона до конца прогона — по слушателю на попытку.
  resources.defer('снятие слушателя отмены шага', () => {
    context.signal?.removeEventListener('abort', onRunAbort);
  });

  const state = {
    controller,
    waitTrigger: undefined as Exceeded | undefined,
    trigger(found: Exceeded | undefined) {
      if (found === undefined || controller.signal.aborted) return;
      if (found.onExceed === 'wait' && found.dimension === 'rate_limit') state.waitTrigger = found;
      controller.abort();
    },
  };
  return state;
}

/**
 * Отдаёт `budget_exceeded` попытке, которую применение потолка оборвало на
 * середине, — и только ей. Попытка, дошедшая до собственного конца, могла
 * тоже перевести потолок последней записью расхода: `abort.trigger` дошёл до
 * неё и вызвал `controller.abort()`, но слушать сигнал уже некому, и
 * `naturalStatus` при этом остаётся её настоящим исходом, не `canceled`.
 * Различие — ровно в `naturalStatus`: интерполяция чужого исхода делает его
 * `canceled` лишь тогда, когда абort действительно прервал исполнение.
 * Настоящая отмена прогона (`context.signal`) важнее и здесь не подменяется.
 */
function budgetInterrupted(
  exceeded: Exceeded | undefined,
  naturalStatus: StatusValue,
  context: RunContext,
): exceeded is Exceeded {
  return exceeded !== undefined && naturalStatus === 'canceled' && context.signal?.aborted !== true;
}

/** Денежный потолок объявлен хоть на одном из трёх уровней, охватывающих шаг. */
function costBudgetDeclared(context: RunContext, job: Job, step: Step): boolean {
  return (
    step.budget?.costMicroUsd !== undefined ||
    job.budget?.costMicroUsd !== undefined ||
    context.expanded.pipeline.budget?.costMicroUsd !== undefined
  );
}

/** Денежный потолок объявлен хоть где-то в пайплайне: пайплайн, работа или шаг. */
function anyCostBudgetDeclared(pipeline: Pipeline): boolean {
  if (pipeline.budget?.costMicroUsd !== undefined) return true;
  return pipeline.jobs.some(
    (job) =>
      job.budget?.costMicroUsd !== undefined ||
      job.steps.some((step) => step.budget?.costMicroUsd !== undefined),
  );
}

/**
 * Вход отклонённого вызова инструмента в текст для журнала. Полный вход
 * остаётся в `stdout.log` — сюда идёт только то, что помогает опознать вызов
 * в ленте и в `events.ndjson`, до обрезки общим правилом `inline()`.
 */
function describePermissionDenialInput(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/**
 * Вызывается ровно там, где расход попытки уже окончателен — после того как
 * и сам шаг, и все его судьи отчитались. Раньше отсюда цена ещё не пришла бы
 * никогда: она приходит один раз, в финальной записи попытки.
 */
function checkCostUnreported(context: RunContext, job: Job, step: Step, attempt: number): void {
  if (context.usage.takeCostUnreportedEvent(costBudgetDeclared(context, job, step))) {
    context.journal.event({ kind: 'budget.cost_unreported', job: job.id, step: step.id, attempt });
  }
}

/**
 * Шаг с неразрешённым скриптом (design.md, решение 1): линт называет причину
 * заранее, а прогон, дошедший до такого шага, отказывает ему тем же текстом —
 * без попытки запуска, которую нечем было бы исполнить. Ровно одна запись
 * попытки, терминальная, тем же приёмом, что и отказ бэкенда.
 */
function unresolvedScriptOutcome(step: Extract<Step, { kind: 'script' }>): StepOutcome {
  const reason = describeScriptUnresolved(step.unresolved as ScriptUnresolved, step.uses);
  const startedAt = new Date().toISOString();
  const record: StepRecord['attempts'][number] = {
    attempt: 1,
    status: 'failed',
    reason,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: null,
  };
  return {
    status: 'failed',
    reason,
    attempts: [record],
    results: [[{ predicate: 'spawn_failed', passed: false, hard: true, detail: reason }]],
    cause: HaltCause.spawnFailed,
  };
}

/**
 * Шаг `uses`, чьи параметры несли отложенную подстановку и потому не прошли
 * проверку схемой ни при разборе, ни при линте (design.md решение 7):
 * значение стало известно только сейчас, после позднего раскрытия. Отказ —
 * тем же приёмом, что `unresolvedScriptOutcome`: одна терминальная попытка,
 * без запуска процесса, попыток не расходует — повторный запуск не исправит
 * значение, пришедшее выходом работы выше по графу.
 */
function unresolvedUsesParamsOutcome(reason: ScriptUnresolved): StepOutcome {
  const message = describeScriptUnresolved(reason);
  const startedAt = new Date().toISOString();
  const record: StepRecord['attempts'][number] = {
    attempt: 1,
    status: 'failed',
    reason: message,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: null,
  };
  return {
    status: 'failed',
    reason: message,
    attempts: [record],
    results: [[{ predicate: 'params_schema', passed: false, hard: true, detail: message }]],
    cause: HaltCause.spawnFailed,
  };
}

/**
 * Прочитать и проверить файл выхода шага `script` (design.md, решение 6).
 * Движок проверяет схемой сам — одинаково для любого языка, — а не
 * перекладывает это на обёртку раннера, у которой есть только Node.
 *
 * Отсутствие файла без объявленной схемы — не отказ: канал у `script` есть
 * всегда, но обещания результата без `output_schema` не было.
 */
function readScriptOutput(
  outputPath: string,
  outputSchemaPath: string | undefined,
  stepId: string,
): { readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'none' } | { readonly kind: 'failure'; readonly result: PredicateResult } {
  if (!existsSync(outputPath)) {
    if (outputSchemaPath === undefined) return { kind: 'none' };
    return {
      kind: 'failure',
      result: {
        predicate: 'output_schema',
        passed: false,
        hard: true,
        detail: `шаг ${stepId} объявляет output_schema, но файл выхода не записан`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outputPath, 'utf8'));
  } catch (error) {
    return {
      kind: 'failure',
      result: {
        predicate: 'output_schema',
        passed: false,
        hard: true,
        detail: `шаг ${stepId} записал файл выхода, не разбираемый как JSON: ${(error as Error).message}`,
      },
    };
  }

  if (outputSchemaPath === undefined) return { kind: 'value', value: parsed };

  const validated = validateAgainstSchemaFile(outputSchemaPath, parsed);
  if (!validated.passed) {
    return {
      kind: 'failure',
      result: {
        predicate: 'output_schema',
        passed: false,
        hard: true,
        detail: `шаг ${stepId} записал выход не по output_schema:\n${validated.detail ?? ''}`,
      },
    };
  }

  return { kind: 'value', value: parsed };
}

/**
 * Найти вклад шага плагинного вида и передать исполнение `runPluginStep`
 * (`exec/pluginStep.ts`). Вид, снятый вместе с плагином (или которого действующий
 * реестр никогда не знал), — отказ, называющий вид, перечень доступных и, пока
 * живо ядро, помнящее прежнего владельца, — плагин, вместе с которым вид снят
 * (design.md, решение 8).
 */
async function runPluginStepDispatch(
  step: Extract<Step, { kind: 'plugin' }>,
  job: Job,
  context: RunContext,
  stepDirPath: string,
  budgetScopes: () => BudgetScope[],
  changedPaths: () => readonly string[] | undefined,
  iteration?: number,
): Promise<StepOutcome> {
  const contribution = context.registry.steps.get(step.name);
  if (contribution === undefined || !hasStepExecutor(contribution)) {
    const former = formerStepKindOwner(context.registry, step.name);
    const reason =
      former === undefined
        ? `Вид шага ${step.name} неизвестен реестру. Доступны: ${stepKindNames(context.registry).join(', ')}`
        : `Вид шага ${step.name} снят вместе с плагином ${former}`;
    const now = new Date().toISOString();
    return {
      status: 'failed',
      reason,
      attempts: [{ attempt: 1, status: 'failed', reason, started_at: now, finished_at: now }],
      results: [[{ predicate: 'step_kind', passed: false, hard: true, detail: reason }]],
    };
  }
  return runPluginStep(step, job, context, stepDirPath, contribution, budgetScopes, changedPaths, iteration);
}

/**
 * Шаг встроенного вида с `external: true` в shadow-режиме: не исполняется,
 * действие записывается, исход — одна попытка `success` с причиной `shadow`
 * (design.md `shadow-run-mode`, решения 4 и 5). `expect`, `output_schema` и
 * судьи не проверяются: проверять нечего, а провал предиката на пустом выходе
 * дал бы ложный красный прогон.
 */
function runShadowStep(
  step: Extract<Step, { kind: 'agent' | 'run' | 'script' }>,
  job: Job,
  context: RunContext,
  stepDirPath: string,
): StepOutcome {
  const startedAt = new Date().toISOString();
  recordShadowAction(
    context.journal,
    { job: job.id, step: step.id, stepDir: stepDirPath },
    1,
    1,
    describeBuiltinAction(step, {
      cwd: context.cwd,
      envNames: declaredEnvNames(step, job, context),
      secrets: step.secrets ?? [],
    }),
  );
  return {
    status: 'success',
    reason: 'shadow',
    attempts: [{ attempt: 1, status: 'success', reason: 'shadow', started_at: startedAt, finished_at: new Date().toISOString() }],
    results: [],
  };
}

async function runCommandStep(
  step: Extract<Step, { kind: 'run' | 'script' }>,
  job: Job,
  context: RunContext,
  stepDirPath: string,
  _sessions: ReturnType<typeof createSessionRegistry>,
  budgetScopes: () => BudgetScope[],
  changedPaths: () => readonly string[] | undefined,
): Promise<StepOutcome> {
  if (step.kind === 'script' && step.resolved === undefined) {
    return unresolvedScriptOutcome(step);
  }

  // Параметры шага `uses`, не проверенные схемой статически — значение несло
  // отложенную подстановку, и ни разбор, ни линт не могли знать его заранее
  // (design.md, решение 7). Проверяется здесь, один раз, по окончательным
  // значениям — после позднего раскрытия, до записи `input.json`.
  if (step.kind === 'script' && step.uses?.paramsSchema !== undefined) {
    const validated = validateAgainstSchema(step.uses.paramsSchema, step.input ?? {});
    if (!validated.passed) {
      return unresolvedUsesParamsOutcome({
        reason: 'params_invalid',
        name: step.uses.name,
        manifestPath: step.uses.manifestPath ?? '',
        detail: validated.detail ?? 'значение не проходит схему',
      });
    }
  }

  const { journal, config } = context;
  // Разобранный выход командного шага. Заполняется только когда объявлен
  // output_schema — без него у командного шага структурированного выхода
  // нет, и поле остаётся неопределённым до конца функции.
  let structuredOutput: unknown;

  // Файл входа шага `script` пишется движком один раз, до первой попытки
  // (design.md, решение 3): объявленный `input` — раскрытым значением,
  // необъявленный — пустым отображением, чтобы читателю не нужна была ветка
  // «а если файла нет».
  const outputPath = join(stepDirPath, 'output.json');
  if (step.kind === 'script') {
    journal.writeStepJson(stepDirPath, 'input.json', step.input ?? {});
  }

  for (;;) {
    let exceeded: ReturnType<UsageAccumulator['check']>;
    let judgeCallCount = 0;
    const nextCallIndex = (): number => {
      judgeCallCount += 1;
      return judgeCallCount;
    };
    // Отдельная сквозная нумерация от судей: `script-<n>` и `judge-<n>` —
    // разные ряды подкаталогов одного шага (`docs/run-layout.md`).
    let scriptCallCount = 0;
    const nextScriptCallIndex = (): number => {
      scriptCallCount += 1;
      return scriptCallCount;
    };
    const onStall = (silentMs: number): void =>
      journal.event({ kind: 'step.stalled', job: job.id, step: step.id, silent_ms: silentMs });

    // Область попытки: слушатели, взятые на время исполнения шага, снимаются
    // одним `finally` при любом его исходе — успехе, отказе, отмене и
    // исключении посреди исполнения.
    const attemptResources = createScope({ journal, job: job.id, step: step.id });
    const abort = stepAbort(context, attemptResources);

    let result: Awaited<ReturnType<typeof executeRunStep>>;
    try {
      result = await executeRunStep({
        step,
        masker: journal.masker,
        cwd: context.cwd,
        stepDir: stepDirPath,
        stallTimeoutMs: config.defaults.stallTimeoutMs,
        signal: abort.controller.signal,
        env: (plan) => stepEnv(step, job, plan.attempt, context, stepDirPath),
        // Выход прошлой попытки не должен дожить до следующей и выдаться за
        // её результат (design.md, решение 5) — файл снимается перед спавном,
        // а не после чтения: неуспешная попытка, упавшая до записи, не должна
        // унаследовать чужой файл, оставшийся на диске.
        onAttemptStart: () => {
          if (step.kind === 'script') rmSync(outputPath, { force: true });
        },
        evaluate: async (target, process_, plan) => {
          // Попытка начинается без выхода: значение, прочитанное прошлой, не
          // должно дожить до нынешней и выдаться за её результат (design.md,
          // решение 5). Снятия файла для этого мало — попытка, не записавшая
          // его вовсе, иначе унаследовала бы уже прочитанное значение.
          structuredOutput = undefined;

          // Разбор строгий: только пробелы по краям снимаются, без поиска
          // первого объекта и без склейки последней строки — вывод либо один
          // JSON-документ целиком, либо отказ попытки.
          let structured: unknown;
          if (target.kind === 'run' && target.outputSchemaPath !== undefined) {
            try {
              structured = JSON.parse(process_.stdout.trim());
            } catch (error) {
              return [
                {
                  predicate: 'output_schema',
                  passed: false,
                  hard: true,
                  detail: `шаг ${target.id} объявляет output_schema, но stdout не разбирается как JSON: ${(error as Error).message}`,
                },
              ];
            }
            structuredOutput = structured;
          }

          // Промах контракта не отменяет объявленных шагом предикатов, а
          // дописывается к ним последним: у скрипта, упавшего ненулевым кодом
          // и потому не записавшего файл, причиной попытки должен остаться
          // непройденный `exit_code` — настоящая причина, а не её следствие
          // (`firstFailureReason` берёт первый жёсткий промах по порядку).
          let contractFailure: PredicateResult | undefined;
          if (target.kind === 'script') {
            const contract = readScriptOutput(outputPath, target.outputSchemaPath, target.id);
            if (contract.kind === 'failure') contractFailure = contract.result;
            if (contract.kind === 'value') {
              structured = contract.value;
              structuredOutput = structured;
            }
          }

          const firstPass = await evaluatePredicates(
            target.expect,
            {
              exitCode: process_.exitCode,
              text: process_.stdout,
              structured,
              cwd: context.cwd,
              env: stepEnv(step, job, 1, context, stepDirPath, 'check'),
              changedPaths: changedPaths(),
              knowledge: context.knowledgeSource,
              script: {
                stepDir: stepDirPath,
                attempt: plan.attempt,
                journal,
                nextCallIndex: nextScriptCallIndex,
                timeoutMs: target.timeoutMs,
                stallTimeoutMs: config.defaults.stallTimeoutMs,
                signal: abort.controller.signal,
              },
            },
            context.registry,
          );

          // Судьи по промаху контракта не зовутся: структурированного выхода,
          // о котором их спрашивают, у попытки нет, а отказ её уже решён —
          // платить за вызов модели незачем.
          if (contractFailure !== undefined) return [...firstPass, contractFailure];

          if (!target.expect.some((predicate) => predicate.kind === 'judge')) return firstPass;

          // Командный шаг сам расхода не несёт: расход попытки — это расход
          // судей, накапливаемый по мере их вызовов, а не заменяемый последним.
          let attemptUsage: Usage | undefined;
          const judgeResults = await runJudgePass({
            predicates: target.expect,
            firstPass,
            task: describeStepTask(target, context.registry),
            text: process_.stdout,
            structured: structured ?? process_.stdout,
            cwd: context.cwd,
            stepDir: stepDirPath,
            attempt: plan.attempt,
            timeoutMs: target.timeoutMs,
            stallTimeoutMs: config.defaults.stallTimeoutMs,
            signal: abort.controller.signal,
            onStall,
            env: stepEnv(step, job, plan.attempt, context, stepDirPath, 'check'),
            adapterFor: (name) => adapterOf(name, context),
            credentialsFor: (name) => context.backendCredentials.get(name),
            defaultAgent: config.defaults.agent,
            backendSlots: context.backendSlots,
            journal,
            nextCallIndex,
            canCall: () => {
              const found = context.usage.check(budgetScopes());
              exceeded ??= found;
              abort.trigger(found);
              return found === undefined;
            },
            onUsage: (usage) => {
              attemptUsage = attemptUsage === undefined ? usage : sumUsage(attemptUsage, usage);
              context.usage.record(job.id, step.id, plan.attempt, attemptUsage);
              const found = context.usage.check(budgetScopes());
              exceeded ??= found;
              abort.trigger(found);
            },
            ...(context.priceCatalog === undefined ? {} : { priceCatalog: context.priceCatalog }),
          });
          if (attemptUsage !== undefined) checkCostUnreported(context, job, step, plan.attempt);
          return judgeResults;
        },
        onStall,
        onExpectFailed: (plan, failure) =>
          journal.event({
            kind: 'expect.failed',
            job: job.id,
            step: step.id,
            attempt: plan.attempt,
            predicate: failure.predicate,
            ...(failure.detail === undefined ? {} : { detail: failure.detail }),
          }),
      });
    } finally {
      await attemptResources.dispose();
    }

    if (exceeded === undefined) {
      const found = context.usage.check(budgetScopes());
      exceeded = found;
      abort.trigger(found);
    }

    // Отказ бэкенда добирается сюда только через судью: командный шаг сам
    // агентский бэкенд не зовёт.
    const refusal = extractRefusal(result.results.at(-1) ?? []);
    if (refusal !== undefined) {
      const resolved = await resolveBackendRefusal(
        refusal,
        job,
        step,
        result.attempts.at(-1)?.attempt ?? result.attempts.length,
        context,
        { attempts: result.attempts, results: result.results },
      );
      if (resolved.kind === 'retry') continue;
      return resolved.outcome;
    }

    // Пропущенный шаг судей не звал и расхода не нёс: ожидать сброса окна ради
    // повтора шага, который объявил «делать нечего», незачем — исход отдаётся
    // как есть, а окно ждёт следующий шаг, которому оно понадобится.
    if (abort.waitTrigger !== undefined && result.status !== 'skipped') {
      // Реальная отмена уже настигла прогон — ждать нечего, шаг canceled.
      // `exceeded` в этом исходе не отдаётся: иначе runJobSteps прочёл бы
      // его как основание для budget_exceeded и затёр бы canceled, который
      // важнее.
      if (context.signal?.aborted === true) {
        return { status: 'canceled', attempts: result.attempts, results: result.results };
      }
      context.usage.sealStep(job.id, step.id);
      const waited = await waitForReset(abort.waitTrigger, context, { job: job.id, step: step.id });
      if (waited.kind === 'resumed') continue;
      if (waited.kind === 'stopped') {
        return {
          status: 'budget_exceeded',
          reason: describeExceeded(waited.exceeded),
          attempts: result.attempts,
          results: result.results,
          exceeded: waited.exceeded,
        };
      }
      return { status: 'canceled', attempts: result.attempts, results: result.results };
    }

    // Копия в `const`: `exceeded` выше — `let`, переписываемый вложенными
    // колбэками попытки, и сужение типа по нему после вызова функции-охранника
    // не удержалось бы.
    const found = exceeded;
    const interrupted = budgetInterrupted(found, result.status, context);
    const reason = interrupted ? describeExceeded(found) : result.reason;
    return {
      status: interrupted ? 'budget_exceeded' : result.status,
      ...(reason === undefined ? {} : { reason }),
      attempts: result.attempts,
      results: result.results,
      ...(structuredOutput === undefined ? {} : { structured: structuredOutput }),
      ...(found === undefined ? {} : { exceeded: found }),
    };
  }
}

async function runAgentStep(
  step: AgentStep,
  job: Job,
  context: RunContext,
  stepDirPath: string,
  sessions: ReturnType<typeof createSessionRegistry>,
  /** Псевдоним шага в пространстве имён агента и его работы (см. `sessionKey`). */
  sessionKey: (agent: string, alias: string) => string,
  jobContextSent: Set<string>,
  budgetScopes: () => BudgetScope[],
  changedPaths: () => readonly string[] | undefined,
  /**
   * Участник шага `review`, исполняемый этим вызовом (`review-strategies`):
   * его расход ложится отдельной записью под тот же шаг — потолок шага общий,
   * сводка разложена по участникам.
   */
  participant?: string,
): Promise<StepOutcome> {
  const { journal, config } = context;
  const { pipeline } = context.expanded;
  const adapter = adapterOf(step.agent, context);

  /**
   * Запись о прерывании достаётся ровно одному сообщению — первому, которое
   * этот прогон отправляет в продолжаемый диалог. Дальше она была бы либо
   * повтором прочитанного в том же диалоге (вторая и третья попытки обычного
   * продолжения), либо прямой неправдой: попытка после неудавшегося
   * продолжения (`onFailedContinuation`) начинает разговор с чистого листа, и
   * «диалог этого шага продолжается» о ней не сказать.
   */
  let interruptedNotePending = planFor(context, job.id, step.id)?.decision.kind === 'continue';

  for (;;) {
  let exceeded: ReturnType<UsageAccumulator['check']>;
  let judgeCallCount = 0;
  const nextCallIndex = (): number => {
    judgeCallCount += 1;
    return judgeCallCount;
  };
  // Отдельная сквозная нумерация от судей: `script-<n>` и `judge-<n>` —
  // разные ряды подкаталогов одного шага (`docs/run-layout.md`).
  let scriptCallCount = 0;
  const nextScriptCallIndex = (): number => {
    scriptCallCount += 1;
    return scriptCallCount;
  };
  const onStall = (silentMs: number): void =>
    journal.event({ kind: 'step.stalled', job: job.id, step: step.id, silent_ms: silentMs });

  // Область попытки: слушатели, взятые на время исполнения шага, снимаются
  // одним `finally` при любом его исходе — успехе, отказе, отмене и
  // исключении посреди исполнения.
  const attemptResources = createScope({ journal, job: job.id, step: step.id });
  const abort = stepAbort(context, attemptResources);

  // Промпт собирается заново на каждой попытке шага, а выдержка на всех
  // попытках одна и та же: событие об её усечении пишется однажды, иначе
  // разбор по журналу насчитает усечений больше, чем их было.
  let noteTruncationReported = false;

  let result: Awaited<ReturnType<typeof executeAgentStep>>;
  try {
    result = await executeAgentStep({
      step,
      masker: journal.masker,
      adapter,
      credentials: context.backendCredentials.get(step.agent),
      cwd: context.cwd,
      stepDir: stepDirPath,
      scratchDir: jobScratchDir(journal.paths, job.id),
      sessions,
      sessionAlias: sessionKey(step.agent, step.session),
      backendSlots: context.backendSlots,
      stallTimeoutMs: config.defaults.stallTimeoutMs,
      signal: abort.controller.signal,
      env: (plan) => stepEnv(step, job, plan.attempt, context, stepDirPath),
      buildPrompt: (_plan, previousFailure) => {
        // Унаследованный контекст уходит в первое сообщение сессии: повторять
        // агенту то, что он уже прочитал в этой же сессии, незачем. Бэкенд без
        // сессий не продолжает диалог: каждый его вызов — первое сообщение.
        const key = sessionKey(step.agent, step.session);
        const resumes = adapter.capabilities.sessions;
        // Контекст пайплайна — один раз на диалог; контекст работы и выходы
        // предшественников — один раз на работу внутри диалога. У работы без
        // объявленной группы оба совпадают, и поведение прежнее.
        const first = !resumes || !context.pipelineContextSent.has(key);
        const firstInJob = !resumes || !jobContextSent.has(key);
        context.pipelineContextSent.add(key);
        jobContextSent.add(key);
        // Контекст профиля — по правилам общего контекста: один раз на диалог,
        // но для каждого профиля свой — шаги разных профилей в одной сессии
        // не делят его.
        const profileKey = step.profile === undefined ? undefined : `${key}\0profile:${step.profile}`;
        const firstForProfile = profileKey !== undefined && (!resumes || !context.pipelineContextSent.has(profileKey));
        if (profileKey !== undefined) context.pipelineContextSent.add(profileKey);

        const interrupted = interruptedNotePending;
        interruptedNotePending = false;

        const stepEntries = withIterationNote(
          context,
          job.id,
          step.id,
          step.context,
          context.iterationCheck,
          interrupted,
          (truncation) => {
            if (noteTruncationReported) return;
            noteTruncationReported = true;
            journal.event({
              kind: 'context.note_truncated',
              job: job.id,
              step: step.id,
              original_tokens: truncation.originalTokens,
              final_tokens: truncation.finalTokens,
            });
          },
        );

        const assembled = assembleContext({
          workspace: context.cwd,
          ...(firstForProfile && step.profile !== undefined && step.profileContext !== undefined
            ? { profile: { name: step.profile, entries: step.profileContext } }
            : {}),
          pipeline: first ? pipeline.context : [],
          job: firstInJob ? job.context : [],
          step: stepEntries.entries,
          upstream: firstInJob ? upstreamOutputs(context.graph, job.id, context.outputs) : [],
          contextUpstream: job.contextUpstream,
          inherit: step.contextInherit,
          exclude: step.contextExclude,
          deny: config.context.deny,
          inlineThreshold: config.context.inlineThreshold,
          maxTokens: step.contextMaxTokens ?? config.context.maxTokens,
          // Предел выдержки объявляется сборке только тогда, когда выдержка в
          // контексте есть: иначе шаг с узким пределом контекста отказывал бы
          // из-за настройки, которая его не касается.
          ...(stepEntries.hasNote ? { noteMaxTokens: config.context.noteMaxTokens } : {}),
          ...(context.knowledgeSource === undefined
            ? {}
            : {
                knowledge: (selector, budget) =>
                  (context.knowledgeSource as KnowledgeSource).select(
                    budget === undefined || selector.kind === 'index'
                      ? selector
                      : { ...selector, budget },
                  ),
              }),
          onDenied: (path, pattern) =>
            journal.event({ kind: 'context.denied', job: job.id, step: step.id, path, pattern }),
          onDowngraded: (path, tokens) =>
            journal.event({
              kind: 'context.downgraded',
              job: job.id,
              step: step.id,
              path,
              tokens,
            }),
        });

        journal.writeContextReport(stepDirPath, {
          // Ключ, а не псевдоним шага: в группе один псевдоним встречается в
          // нескольких работах, и отчёт обязан называть тот диалог, в который
          // контекст на самом деле ушёл.
          session: key,
          ...assembled.report,
        });

        return [assembled.text, step.prompt, failureBlock(previousFailure)]
          .filter((part) => part !== undefined && part !== '')
          .join('\n\n');
      },
      evaluate: async (target, outcome, plan) => {
        // Неустранимый отказ проверяется раньше кода возврата: у обоих
        // настоящих конвертов отказа (упор в лимит подписки, отказ
        // аутентификации) код возврата ненулевой, и без этой проверки они
        // ушли бы в «бэкенд завершился кодом N», не назвав действительной
        // причины. Судья здесь не вызывается: попытка отклонена в любом случае.
        if (outcome.refusal !== undefined) {
          return [
            {
              predicate: BACKEND_REFUSAL_PREDICATE,
              passed: false,
              hard: true,
              detail: describeRefusal(outcome.refusal),
              actual: outcome.refusal,
            },
          ];
        }

        // Ненулевой код возврата означает, что бэкенд не отработал, и жалобы
        // предикатов на отсутствующий вывод только уводят от причины. Настоящую
        // причину бэкенд написал в stderr — её и показываем первой. Судья здесь
        // не вызывается: попытка отклонена в любом случае.
        if (outcome.process.exitCode !== 0) {
          const detail = outcome.process.stderr.trim().split('\n').slice(-3).join('\n');
          return [
            {
              predicate: 'backend',
              passed: false,
              hard: true,
              actual: outcome.process.exitCode,
              detail:
                detail === ''
                  ? `бэкенд завершился кодом ${outcome.process.exitCode ?? 'нет'}`
                  : detail,
            },
          ];
        }

        const firstPass = await evaluatePredicates(
          target.expect,
          {
            exitCode: outcome.process.exitCode,
            text: outcome.text ?? '',
            structured: outcome.structured,
            cwd: context.cwd,
            env: stepEnv(step, job, 1, context, stepDirPath, 'check'),
            changedPaths: changedPaths(),
            knowledge: context.knowledgeSource,
            script: {
              stepDir: stepDirPath,
              attempt: plan.attempt,
              journal,
              nextCallIndex: nextScriptCallIndex,
              timeoutMs: target.timeoutMs,
              stallTimeoutMs: config.defaults.stallTimeoutMs,
              signal: abort.controller.signal,
            },
          },
          context.registry,
        );

        if (!target.expect.some((predicate) => predicate.kind === 'judge')) {
          checkCostUnreported(context, job, step, plan.attempt);
          return firstPass;
        }

        // Расход попытки уже включает расход самого шага (`outcome.usage`) —
        // судьи добавляются к нему, а не подменяют его.
        let attemptUsage = outcome.usage;
        const results = await runJudgePass({
          predicates: target.expect,
          firstPass,
          task: target.prompt,
          text: outcome.text ?? '',
          structured: outcome.structured,
          cwd: context.cwd,
          stepDir: stepDirPath,
          attempt: plan.attempt,
          timeoutMs: target.timeoutMs,
          stallTimeoutMs: config.defaults.stallTimeoutMs,
          signal: abort.controller.signal,
          onStall,
          env: stepEnv(step, job, plan.attempt, context, stepDirPath, 'check'),
          adapterFor: (name) => adapterOf(name, context),
          credentialsFor: (name) => context.backendCredentials.get(name),
          defaultAgent: config.defaults.agent,
          backendSlots: context.backendSlots,
          journal,
          nextCallIndex,
          canCall: () => {
            const found = context.usage.check(budgetScopes());
            exceeded ??= found;
            abort.trigger(found);
            return found === undefined;
          },
          onUsage: (usage) => {
            attemptUsage = sumUsage(attemptUsage, usage);
            context.usage.record(job.id, step.id, plan.attempt, attemptUsage, participant);
            const found = context.usage.check(budgetScopes());
            exceeded ??= found;
            abort.trigger(found);
          },
          ...(context.priceCatalog === undefined ? {} : { priceCatalog: context.priceCatalog }),
        });
        checkCostUnreported(context, job, step, plan.attempt);
        return results;
      },
      ...(context.priceCatalog === undefined ? {} : { priceCatalog: context.priceCatalog }),
      onUsage: (current, attempt) => {
        context.usage.record(job.id, step.id, attempt, current, participant);
        const found = context.usage.check(budgetScopes(), current);
        exceeded ??= found;
        abort.trigger(found);
      },
      onUnparsed: (line) =>
        journal.event({ kind: 'backend.unparsed', job: job.id, step: step.id, line }),
      onPermissionDenied: (plan, tool, input) => {
        const detail = describePermissionDenialInput(input);
        journal.event({
          kind: 'permission.denied',
          job: job.id,
          step: step.id,
          attempt: plan.attempt,
          tool,
          ...(detail === undefined ? {} : { detail: inline(detail) }),
        });
      },
      onMcpServerUnavailable: (plan, server) => {
        journal.event({
          kind: 'mcp_server.unavailable',
          job: job.id,
          step: step.id,
          attempt: plan.attempt,
          server,
        });
      },
      onStall,
      onExpectFailed: (plan, failure) =>
        journal.event({
          kind: 'expect.failed',
          job: job.id,
          step: step.id,
          attempt: plan.attempt,
          predicate: failure.predicate,
          ...(failure.detail === undefined ? {} : { detail: failure.detail }),
        }),
      canContinue: () => {
        // Отменённый прогон не заводит новых попыток: `AbortController` в
        // `stepAbort` реагирует на сигнал отмены один раз, и попытка,
        // начатая после первой отмены, его больше не увидит — процесс
        // отработал бы до конца непрерванным, будто отмены не было вовсе.
        // На этом же держится продолжение оборванной сессии: последняя
        // запись попытки обязана быть `canceled`, иначе отмену не отличить
        // от попытки, ответившей самой (`resolveContinuation`).
        if (context.signal?.aborted === true) return false;
        const found = exceeded ?? context.usage.check(budgetScopes());
        exceeded ??= found;
        abort.trigger(found);
        return exceeded === undefined;
      },
      // Продолжение не открылось у бэкенда: отказ стоит одну попытку, а не
      // шаг (design.md, решение 6). Следующая попытка того же шага обязана
      // начать разговор заново — с новой сессией и полным контекстом, ровно
      // как первая попытка любого другого переисполняемого шага.
      onFailedContinuation: () => {
        const key = sessionKey(step.agent, step.session);
        sessions.unseed(key);
        context.pipelineContextSent.delete(key);
        jobContextSent.delete(key);
      },
    });
  } finally {
    await attemptResources.dispose();
  }

  if (exceeded !== undefined) {
    journal.event({
      kind: 'budget.exceeded',
      scope: exceeded.scope,
      job: job.id,
      step: step.id,
      dimension: exceeded.dimension,
      used: exceeded.used,
      limit: exceeded.limit,
    });
  }

  // Сессия попадает в исход шага, только если она была: у бэкенда, который
  // заводит нить сам, отменённый или упавший до первой записи шаг остаётся
  // вовсе без идентификатора, и записать за него пустую строку значило бы
  // обещать следующему прогону продолжение несуществующего диалога
  // (`docs/run-layout.md`, «Оборванный шаг продолжает свою сессию»).
  const sessionField = result.sessionId === undefined ? {} : { session: result.sessionId };

  // Отказ бэкенда — свой либо доставшийся судье внутри `evaluate` — приходит
  // тем же именем предиката: источник дальше не различается.
  const refusal = extractRefusal(result.results.at(-1) ?? []);
  if (refusal !== undefined) {
    const resolved = await resolveBackendRefusal(
      refusal,
      job,
      step,
      result.attempts.at(-1)?.attempt ?? result.attempts.length,
      context,
      { attempts: result.attempts, results: result.results, ...sessionField },
    );
    if (resolved.kind === 'retry') continue;
    return resolved.outcome;
  }

  if (abort.waitTrigger !== undefined) {
    // Реальная отмена уже настигла прогон — ждать нечего, шаг canceled.
    // `exceeded` в этом исходе не отдаётся: иначе runJobSteps прочёл бы его
    // как основание для budget_exceeded и затёр бы canceled, который важнее.
    if (context.signal?.aborted === true) {
      return {
        status: 'canceled',
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        attempts: result.attempts,
        results: result.results,
        ...sessionField,
      };
    }
    context.usage.sealStep(job.id, step.id, participant);
    const waited = await waitForReset(abort.waitTrigger, context, { job: job.id, step: step.id });
    if (waited.kind === 'resumed') continue;
    if (waited.kind === 'stopped') {
      return {
        status: 'budget_exceeded',
        reason: describeExceeded(waited.exceeded),
        attempts: result.attempts,
        results: result.results,
        ...sessionField,
        exceeded: waited.exceeded,
      };
    }
    return {
      status: 'canceled',
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      attempts: result.attempts,
      results: result.results,
      ...sessionField,
    };
  }

  // Копия в `const`: `exceeded` выше — `let`, переписываемый вложенными
  // колбэками попытки, и сужение типа по нему после вызова функции-охранника
  // не удержалось бы.
  const found = exceeded;
  const interrupted = budgetInterrupted(found, result.status, context);
  const reason = interrupted ? describeExceeded(found) : result.reason;
  return {
    status: interrupted ? 'budget_exceeded' : result.status,
    ...(reason === undefined ? {} : { reason }),
    attempts: result.attempts,
    results: result.results,
    ...(result.last?.structured === undefined ? {} : { structured: result.last.structured }),
    ...sessionField,
    ...(result.last?.observedInputs === undefined
      ? {}
      : { observedInputs: result.last.observedInputs }),
    ...(result.last?.backendInit === undefined ? {} : { backendInit: result.last.backendInit }),
    ...(found === undefined ? {} : { exceeded: found }),
  };
  }
}

/**
 * Шаг `review` (`review-strategies`): участники исполняются как агентские
 * шаги этим же `runAgentStep` — каждый в своём каталоге журнала и своей
 * сессии `<шаг>/<участник>`, с расходом под своим именем.
 */
async function runReviewStep(
  step: ReviewStep,
  job: Job,
  context: RunContext,
  stepDirPath: string,
  sessionKey: (agent: string, alias: string) => string,
  jobContextSent: Set<string>,
  budgetScopes: () => BudgetScope[],
  changedPaths: () => readonly string[] | undefined,
): Promise<StepOutcome> {
  if (step.unresolved !== undefined || step.aggregator === undefined) {
    return {
      status: 'failed',
      reason: step.unresolved === undefined ? 'стратегия ревью не разрешена' : describeStrategyUnresolved(step.unresolved),
      attempts: [],
      results: [],
    };
  }
  // Сессии участников живут только внутри шага: повтор шага в следующем
  // проходе цикла начинает их заново, с полным контекстом.
  const forget = (key: string): void => {
    context.sessions.unseed(key);
    jobContextSent.delete(key);
    for (const sent of [...context.pipelineContextSent]) {
      if (sent === key || sent.startsWith(`${key}\0`)) context.pipelineContextSent.delete(sent);
    }
  };
  for (const { call } of agentCallsOf(step)) forget(sessionKey(call.agent, call.session));

  // Защитник выбирается один раз за исполнение шага; его же видят ходы и
  // `step.json` участника (`review-defend-shared-session`, решение 1). У
  // `resume` псевдоним защитника засевается сессией имплементатора: ходы
  // продолжают её саму, а контекст она уже получила.
  let choice: DefenderChoice | undefined;
  const chooseDefender = (): DefenderChoice => {
    choice = defenderChoice(step, job, context);
    const key = sessionKey(choice.participant.agent, defenderSession(step));
    forget(key);
    if (choice.resumeSession !== undefined) {
      context.sessions.seed(key, choice.resumeSession);
      context.pipelineContextSent.add(key);
      jobContextSent.add(key);
    }
    return choice;
  };

  return executeReviewStep<StepOutcome>({
    step,
    job: job.id,
    stepDir: stepDirPath,
    journal: context.journal,
    concurrency: context.config.limits.concurrency,
    runParticipant: (participant, call, dir) => {
      // Ревьюер и защитник в защите вызываются не раз, и номера их попыток
      // начинаются заново: прежний расход запечатывается, а не затирается.
      // Ходы защитника в `resume` оплачивает шаг review, а не имплементатор.
      const usageKey = participant.id;
      context.usage.sealStep(job.id, step.id, usageKey);
      if (call.forkFrom !== undefined) {
        // Форк уже несёт контекст имплементатора: блок контекста первым
        // сообщением повторил бы прочитанное в той же сессии.
        const key = sessionKey(call.agent, call.session);
        context.pipelineContextSent.add(key);
        jobContextSent.add(key);
      }
      return runAgentStep(call, job, context, dir, context.sessions, sessionKey, jobContextSent, budgetScopes, changedPaths, usageKey);
    },
    resumable: (agent) => adapterOf(agent, context).capabilities.sessions,
    budgetStop: () => {
      const exceeded = context.usage.check(budgetScopes());
      return exceeded === undefined
        ? undefined
        : { status: 'budget_exceeded', reason: describeExceeded(exceeded), attempts: [], results: [], exceeded };
    },
    chooseDefender,
    originOf: (participant) => {
      // Сессия имплементатора и её форк берут агента у имплементатора, а не у
      // выбора `defender`: происхождение свежего защитника к ним не относится.
      if (participant === DEFENDER_ID && choice !== undefined && choice.record.mode !== 'fresh') return undefined;
      const key = `${job.id}/${step.id}/${participant}`;
      const agent = context.expanded.agentOrigins.get(key);
      if (agent === undefined) return undefined;
      return { agent, model: context.expanded.modelOrigins.get(key), effort: context.expanded.effortOrigins.get(key) };
    },
  });
}

/**
 * Шаг `discuss` (`discuss-step`): участники, автор и агрегатор исполняются как
 * агентские шаги этим же `runAgentStep` — каждый в своём каталоге журнала и
 * своей сессии `<шаг>/<участник>`, с расходом под своим именем.
 */
async function runDiscussStep(
  step: DiscussStep,
  job: Job,
  context: RunContext,
  stepDirPath: string,
  sessionKey: (agent: string, alias: string) => string,
  jobContextSent: Set<string>,
  budgetScopes: () => BudgetScope[],
  changedPaths: () => readonly string[] | undefined,
): Promise<StepOutcome> {
  if (step.unresolved !== undefined || step.aggregator === undefined) {
    return {
      status: 'failed',
      reason: step.unresolved === undefined ? 'стратегия обсуждения не разрешена' : describeStrategyUnresolved(step.unresolved, 'стратегия обсуждения'),
      attempts: [],
      results: [],
    };
  }
  // Сессии участников живут только внутри шага: повтор шага в следующем
  // проходе цикла начинает их заново, с полным контекстом.
  for (const { call } of agentCallsOf(step)) {
    const key = sessionKey(call.agent, call.session);
    context.sessions.unseed(key);
    jobContextSent.delete(key);
    for (const sent of [...context.pipelineContextSent]) {
      if (sent === key || sent.startsWith(`${key}\0`)) context.pipelineContextSent.delete(sent);
    }
  }
  return executeDiscussStep<StepOutcome>({
    step,
    job: job.id,
    stepDir: stepDirPath,
    journal: context.journal,
    concurrency: context.config.limits.concurrency,
    runParticipant: (participant, call, dir) => {
      // Участник вызывается не раз, и номера его попыток начинаются заново:
      // прежний расход запечатывается, а не затирается.
      context.usage.sealStep(job.id, step.id, participant.id);
      return runAgentStep(call, job, context, dir, context.sessions, sessionKey, jobContextSent, budgetScopes, changedPaths, participant.id);
    },
    resumable: (agent) => adapterOf(agent, context).capabilities.sessions,
    budgetStop: () => {
      const exceeded = context.usage.check(budgetScopes());
      return exceeded === undefined
        ? undefined
        : { status: 'budget_exceeded', reason: describeExceeded(exceeded), attempts: [], results: [], exceeded };
    },
    originOf: (participant) => {
      const key = `${job.id}/${step.id}/${participant}`;
      const agent = context.expanded.agentOrigins.get(key);
      if (agent === undefined) return undefined;
      return { agent, model: context.expanded.modelOrigins.get(key), effort: context.expanded.effortOrigins.get(key) };
    },
  });
}

/**
 * Выбор защитника режима `defend` (`review-defend-shared-session`, решение 1).
 * Первое подходящее:
 * - `resume` — сама сессия имплементатора: шаг назвал имплементатора из
 *   того же дерева, он исполнен в этом прогоне, его сессия записана, адаптер
 *   умеет сессии, и продолжить её одновременно с шагом review некому;
 * - `fork` — один форк этой сессии на шаг, когда она принадлежит исходному
 *   прогону (`reused`) или её может продолжить кто-то ещё (`shared`);
 * - `fresh` — свежий агент `defender` стратегии с причиной.
 */
function defenderChoice(step: ReviewStep, job: Job, context: RunContext): DefenderChoice {
  const fresh = step.defender ?? (step.aggregator as ReviewParticipant);
  const freshParticipant: ReviewParticipant = { ...fresh, id: DEFENDER_ID };
  const ref = step.implementer;
  const implementer = ref === undefined ? undefined : `${ref.job}.${ref.step}`;
  const freshChoice = (reason: FreshReason, text?: string): DefenderChoice => ({
    record: {
      kind: 'defender',
      mode: 'fresh',
      ...(implementer === undefined ? {} : { implementer }),
      agent: freshParticipant.agent,
      ...(freshParticipant.model === undefined ? {} : { model: freshParticipant.model }),
      reason,
    },
    participant: freshParticipant,
    ...(text === undefined ? {} : { implementerText: text }),
  });
  if (ref === undefined || implementer === undefined) return freshChoice('no_implementer');

  // Claude хранит сессии по каталогу: из чужого дерева сессии имплементатора
  // не найти (`named-workspace-trees`, решение 8). Другое дерево — обычный
  // исход, а не сбой хода.
  const implementerJob = context.graph.byId.get(ref.job);
  if (implementerJob !== undefined && treeKey(implementerJob) !== treeKey(job)) {
    const record = context.records.get(ref.job)?.steps.find((candidate) => candidate.id === ref.step);
    return freshChoice('other_tree', record === undefined ? undefined : implementerText(context, ref.job, ref.step, record));
  }

  const declared = context.expanded.pipeline.jobs.find((job) => job.id === ref.job)?.steps.find((candidate) => candidate.id === ref.step);
  const record = context.records.get(ref.job)?.steps.find((candidate) => candidate.id === ref.step);
  const text = record === undefined ? undefined : implementerText(context, ref.job, ref.step, record);
  if (declared?.kind !== 'agent' || record?.session === undefined) return freshChoice('no_session', text);
  const adapter = adapterOf(declared.agent, context);
  if (!adapter.capabilities.sessions) return freshChoice('no_session', text);
  // Ход защитника — JSON по схеме защиты; сессия бэкенда, у которого схемы
  // нет никакой, давала бы невалидный ход за токены
  // (`backend-structured-output`, решение 6). Свежий защитник проверен до
  // старта как участник.
  if (structuredOutputMode(adapter.capabilities) === undefined) return freshChoice('no_schema', text);
  const forkReason: ForkReason | undefined =
    record.reused_from !== undefined ? 'reused' : sessionContinuableInPlace(ref, job, step, context) ? undefined : 'shared';
  if (forkReason !== undefined && adapter.capabilities.forkSessions !== true) return freshChoice('no_fork', text);
  // Форк сообщает цену вместе с исходной сессией, продолжение — свою
  // нарастающую. Имплементатор этого прогона уже отметил её в реестре;
  // переиспользованный из исходного прогона — только в своей записи.
  const implementerCost = record.attempts.at(-1)?.usage?.session_cost_usd;
  if (implementerCost !== undefined && context.sessions.costOf(record.session) === undefined) {
    context.sessions.noteCost(record.session, implementerCost);
  }
  // Агент, модель и effort — имплементатора; права и схема хода — шага
  // `review` (`defenderCallBase`).
  const participant: ReviewParticipant = {
    id: DEFENDER_ID,
    agent: declared.agent,
    ...(declared.model === undefined ? {} : { model: declared.model }),
    ...(declared.effort === undefined ? {} : { effort: declared.effort }),
  };
  const base = {
    kind: 'defender' as const,
    implementer,
    agent: declared.agent,
    ...(declared.model === undefined ? {} : { model: declared.model }),
  };
  if (forkReason === undefined) return { record: { ...base, mode: 'resume' }, participant, resumeSession: record.session };
  return { record: { ...base, mode: 'fork', reason: forkReason }, participant, forkFrom: record.session };
}

/**
 * Можно ли продолжить сессию имплементатора на месте: никто не продолжит её
 * одновременно с шагом review. Правило статическое, по графу пайплайна, —
 * динамический захват «кто первый» дал бы прогону недетерминированную
 * раскладку диалогов. Шаги одной работы идут по очереди; законченную
 * работу-предка без `session_group` продолжить больше некому, если на того же
 * имплементатора не ссылается другой шаг review.
 */
function sessionContinuableInPlace(ref: ImplementerRef, job: Job, step: ReviewStep, context: RunContext): boolean {
  if (ref.job === job.id) return true;
  if (context.graph.byId.get(ref.job)?.sessionGroup !== undefined) return false;
  return !context.expanded.pipeline.jobs.some((other) =>
    other.steps.some(
      (candidate) =>
        candidate.kind === 'review' &&
        !(other.id === job.id && candidate.id === step.id) &&
        candidate.implementer?.job === ref.job &&
        candidate.implementer.step === ref.step,
    ),
  );
}

/**
 * Текстовый выход шага имплементатора — свежему защитнику (решение 3):
 * итоговый текст последней попытки из её `stdout`, разобранного адаптером
 * агента, а без него — структурированный выход. Переиспользованный шаг
 * читается из каталога исходного прогона.
 */
function implementerText(context: RunContext, jobId: string, stepId: string, record: StepRecord): string | undefined {
  const paths = record.reused_from === undefined ? context.journal.paths : context.resume?.source.paths;
  const dir = paths === undefined ? undefined : findStepDir(paths, jobId, stepId);
  if (dir === undefined) return undefined;
  const attempt = record.attempts.length;
  const stdout = join(dir, attempt <= 1 ? 'stdout.log' : `stdout.${attempt}.log`);
  const declared = context.expanded.pipeline.jobs.find((job) => job.id === jobId)?.steps.find((step) => step.id === stepId);
  if (declared?.kind === 'agent' && existsSync(stdout)) {
    const adapter = adapterOf(declared.agent, context);
    let text: string | undefined;
    const pieces: string[] = [];
    for (const line of readFileSync(stdout, 'utf8').split('\n')) {
      const event = adapter.parseLine(line);
      if (event.kind === 'result' && event.text !== undefined) text = event.text;
      if (event.kind === 'text') pieces.push(event.text);
    }
    const found = text ?? (pieces.length === 0 ? undefined : pieces.join('\n'));
    if (found !== undefined && found.trim() !== '') return found;
  }
  const output = join(dir, 'output.json');
  return existsSync(output) ? readFileSync(output, 'utf8') : undefined;
}

/** Задание шага без блока контекста — вход судьи на командном или плагинном шаге. */
export function describeStepTask(step: Step, registry: Registry): string {
  if (step.kind === 'agent' || isPanelStep(step)) return step.prompt;
  if (step.kind === 'script') return (step.resolved?.argv ?? [step.path, ...step.args]).join(' ');
  if (step.kind === 'plugin') {
    const contribution = registry.steps.get(step.name);
    const title = contribution !== undefined && hasStepExecutor(contribution) ? contribution.title : step.name;
    return `${title}: ${JSON.stringify(step.fields)}`;
  }
  return typeof step.command === 'string' ? step.command : step.command.join(' ');
}

function failureBlock(previousFailure: string | undefined): string {
  if (previousFailure === undefined) return '';
  return `## Прошлая попытка не прошла проверку\n\n${previousFailure}\n\nПочини причину, а не симптом.`;
}

/** Значения учётных данных бэкендов с путём записи — для проверки `${env.*}` наравне с секретами. */
function credentialValues(context: RunContext): [string, string][] {
  return [...context.backendCredentials].flatMap(([backend, variables]) =>
    Object.entries(variables).map(([variable, value]): [string, string] => [
      `backends.${backend}.credentials.${variable}`,
      value,
    ]),
  );
}

/**
 * Пространство `${env.*}` для позднего раскрытия: объявленный `env` работы без
 * переменных секретов и без переменных, чьё значение содержит значение
 * разрешённого секрета (`DATABASE_URL=postgres://u:<токен>@…`). Подстановка
 * такой переменной вписала бы токен в промпт или argv обходным путём.
 * Окружение процессов при этом не меняется — меняется только подстановка.
 *
 * Вычеркнутое возвращается и отдельно, с причиной: отказ раскрытия называет по
 * нему секрет, а не говорит «не определена».
 */
function substitutableEnv(
  declared: Readonly<Record<string, string>>,
  context: RunContext,
): { env: Record<string, string>; withheld: Record<string, LateWithheld> } {
  const { pipeline } = context.expanded;
  const env: Record<string, string> = {};
  const withheld: Record<string, LateWithheld> = {};

  // Имена `env` секретов называются всегда, и когда работа их не объявляла:
  // обращение к ним — та же ошибка автора, и объяснение нужно то же.
  for (const secret of pipeline.secrets) withheld[secret.env] = { secret: secret.name, reason: 'name' };

  for (const [name, value] of Object.entries(declared)) {
    if (name in withheld) continue;
    const holder = [...context.secretValues, ...credentialValues(context)].find(([, secretValue]) => value.includes(secretValue));
    if (holder === undefined) env[name] = value;
    else withheld[name] = { secret: holder[0], reason: 'value' };
  }
  return { env, withheld };
}

/**
 * Секреты в слоях окружения (`secrets-named-providers`, design.md, решение 3):
 * значения названных секретов — наложением последними, переменные всех
 * остальных объявленных — вычёркиванием. Агентский шаг названных не имеет
 * никогда (ключа `secrets` у него нет), поэтому у него вычёркнуты все.
 *
 * `named` пуст там, где секрет не положен: проверки `expect` и судья идут с
 * окружением шага, но процессом шага не являются, и значение им не нужно.
 */
function secretLayers(
  pipeline: Pipeline,
  values: ReadonlyMap<string, string>,
  named: readonly string[],
): Pick<EnvLayers, 'secrets' | 'withheld'> {
  const granted = new Set(named);
  const secrets: Record<string, string> = {};
  const withheld: Record<string, string> = {};
  for (const secret of pipeline.secrets) {
    const value = values.get(secret.name);
    if (granted.has(secret.name) && value !== undefined) secrets[secret.env] = value;
    else withheld[secret.env] = secret.name;
  }
  return { secrets, withheld };
}

/**
 * Имена объявленного `env:` шага для записи shadow-действия (design.md
 * `shadow-run-mode`, решение 5): пайплайн с переопределениями `--env`, работа,
 * шаг — отсортированы, без повторов. Окружение процесса, `env_files` и
 * внедрённые `BURNEX_*` сюда не входят: они не часть объявления шага, а
 * имена переменных оператора в журнал не должны уходить вовсе.
 */
export function declaredEnvNames(step: Step, job: Job, context: RunContext): string[] {
  const { pipeline } = context.expanded;
  const names = new Set([
    ...Object.keys(pipelineEnv(pipeline, context)),
    ...Object.keys(job.env),
    ...Object.keys(step.env),
  ]);
  return [...names].sort();
}

/**
 * Окружение процесса шага. `grant: 'check'` — для проверок шага (`expect`,
 * судья): окружение то же, но без значений секретов, названных шагом.
 */
export function stepEnv(
  step: Step,
  job: Job,
  attempt: number,
  context: RunContext,
  stepDirPath: string,
  grant: 'step' | 'check' = 'step',
): Record<string, string> {
  const { pipeline } = context.expanded;
  const { env, denied, withheld } = buildStepEnv({
    ...secretLayers(pipeline, context.secretValues, grant === 'step' ? (step.secrets ?? []) : []),
    base: context.baseEnv ?? process.env,
    envFiles: pipeline.envFiles,
    pipeline: pipelineEnv(pipeline, context),
    job: job.env,
    step: step.env,
    injected: injectedVariables({
      runId: context.journal.paths.runId,
      runDir: context.journal.paths.dir,
      binPath: context.engine.entry,
      jobId: job.id,
      jobDir: context.journal.prepareJob(job.id),
      stepId: step.id,
      stepDir: stepDirPath,
      attempt,
      jobAttempt: context.jobAttempt ?? 1,
      jobAttemptMax: job.attempts.max,
      ...loopEnv(context),
      workspace: context.cwd,
      artifacts: context.journal.paths.artifacts,
      scratch: jobScratchDir(context.journal.paths, job.id),
      ...(step.kind === 'script'
        ? {
            contractInputPath: join(stepDirPath, 'input.json'),
            contractOutputPath: join(stepDirPath, 'output.json'),
          }
        : {}),
      // И шагу, и его проверкам (`grant: 'check'`): предикат `script` может
      // держать то же соглашение. Агентскому шагу кода не положено.
      ...((step.kind === 'run' || step.kind === 'script') && step.skipExitCode !== undefined
        ? { skipExitCode: step.skipExitCode }
        : {}),
      // Только шагу `run` и его проверкам: у остальных видов свой контракт публикации.
      ...(step.kind === 'run' ? { jobOutputsPath: jobOutputsPath(context.journal.paths, job.id) } : {}),
      // Слой injected: `env:` работы и шага чужой выход не перекрывает, а `env_deny`
      // его не вычёркивает — производитель уже отклонил похожие на секрет имена.
      needs: needsVariables(context, job).variables,
    }),
    deny: pipeline.envDeny,
    cwd: context.projectRoot,
  });

  for (const item of denied) {
    const seen = `${item.name}|${item.pattern}`;
    if (context.reportedDenials.has(seen)) continue;
    context.reportedDenials.add(seen);
    context.journal.event({
      kind: 'env.denied',
      name: item.name,
      pattern: item.pattern,
      scope: `jobs.${job.id}.steps.${step.id}`,
    });
  }

  // Пара «переменная|адрес шага» — тем же приёмом, что `reportedDenials`: шаг
  // собирает окружение на каждой попытке и в каждой проверке, а сообщать о
  // вычеркнутом достаточно однажды.
  for (const item of withheld) {
    // Окружение проверок шага (`grant: 'check'`) вычёркивает и секрет, который
    // шаг назвал: событие же говорит о секретах, которых шаг не объявлял.
    if (step.secrets?.includes(item.secret) === true) continue;
    const scope = `jobs.${job.id}.steps.${step.id}`;
    const seen = `${item.name}|${scope}`;
    if (context.reportedWithheld.has(seen)) continue;
    context.reportedWithheld.add(seen);
    context.journal.event({ kind: 'env.withheld', name: item.name, secret: item.secret, scope });
  }

  return env;
}

/** Ключ шага: записывается сейчас, используется возобновлением позже. */
/**
 * Причина неуспеха из закрытого перечня `halt.ts`.
 *
 * Выводится из статуса и результатов предикатов, а не назначается в каждой
 * точке отдельно: так место, где заводится новая причина отказа, ровно одно и
 * его видно в обзоре.
 */
function causeOf(
  status: StatusValue,
  results: readonly (readonly PredicateResult[])[],
  assigned?: HaltCauseValue,
): HaltCauseValue | undefined {
  if (assigned !== undefined) return assigned;
  if (status === 'canceled') return HaltCause.canceled;
  if (status === 'budget_exceeded') return HaltCause.budgetExceeded;
  if (status !== 'failed') return undefined;

  const failed = results.at(-1)?.find((item) => !item.passed && item.hard);
  if (failed?.predicate === 'timeout') return HaltCause.timeout;
  if (failed?.predicate === 'spawn_failed') return HaltCause.spawnFailed;
  return HaltCause.expectFailed;
}

/** Решение плана по конкретному шагу, если возобновление вообще идёт. */
function planFor(context: RunContext, jobId: string, stepId: string): StepPlan | undefined {
  return context.resume?.plan.steps.find((item) => item.job === jobId && item.step === stepId);
}

/**
 * Запись оборванной попытки — только последняя, та самая, что дала шагу
 * статус `canceled`: более ранние попытки того же шага уже расходовали
 * бюджет исходного прогона и к продолжению отношения не имеют.
 */
function carriedAttempts(record: StepRecord, sourceRunId: string): readonly StepRecord['attempts'][number][] {
  const last = record.attempts.at(-1);
  return last === undefined ? [] : [{ ...last, carried_from: sourceRunId }];
}

/**
 * Перенести структурированный выход переиспользованного шага из исходного
 * прогона в директорию нового. Без этого файла `output.from` при частичном
 * переиспользовании работы публикует пустоту: выход работы целиком
 * переносится только когда переиспользована вся работа.
 */
function transferStepOutput(
  context: RunContext,
  jobId: string,
  stepId: string,
  stepDirPath: string,
): unknown {
  const source = context.resume?.source;
  if (source === undefined) return undefined;

  const sourceDir = findStepDir(source.paths, jobId, stepId);
  if (sourceDir === undefined) return undefined;

  const sourceFile = join(sourceDir, 'output.json');
  if (!existsSync(sourceFile)) return undefined;

  try {
    const raw = readFileSync(sourceFile, 'utf8');
    context.journal.writeStepFile(stepDirPath, 'output.json', raw);
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Сложить данные, опубликованные работой, в её запись и переписать состояние.
 *
 * Зовётся после каждого шага — и исполненного, и переиспользованного. Файл
 * `data.json` пишет подпроцесс `burnex data`, состояние прогона —
 * исключительно движок: два процесса, пишущих один `status.json`, наступали
 * бы друг на друга. Отсюда же и живость витрины: она опрашивает корень
 * прогонов по mtime состояния, и данные доезжают до подписи узла ровно тем же
 * событием, что и статус шага.
 *
 * Следствие честное и его стоит знать: данные, записанные в середине долгого
 * шага, появятся в витрине по его завершении, а не в момент записи.
 *
 * В запись попадают только ключи, объявленные определением работы, — тем
 * определением, которым движок её исполняет, а не файлом `resolved.json` на
 * диске: иначе шаг, которому доступна файловая система работы, расширял бы
 * себе объявление правкой этого файла. Необъявленный ключ — это `data.json`,
 * написанный в обход команды (`burnex data` сама такого не допустит), и
 * возвращённая причина роняет работу без повторных попыток: файл остался на
 * месте, повтор упёрся бы в то же самое. Объявленные соседи необъявленного
 * ключа в запись всё равно попадают — они и правда опубликованы.
 */
function foldJobData(context: RunContext, job: Job): string | undefined {
  const record = context.records.get(job.id);
  if (record === undefined) return undefined;

  const raw = readJobData(jobDir(context.journal.paths, job.id));
  const declared = new Set(job.data);
  const data: Record<string, string> = {};
  let rejected: string | undefined;
  for (const [key, value] of Object.entries(raw)) {
    if (declared.has(key)) data[key] = value;
    else rejected ??= key;
  }

  context.records.set(job.id, {
    ...record,
    ...(Object.keys(data).length === 0 ? {} : { data }),
  });
  context.refreshStatus();

  if (rejected === undefined) return undefined;
  return (
    `работа ${job.id} не объявляла ключ данных «${rejected}»: ` +
    (job.data.length === 0 ? 'объявленный состав пуст' : `объявлены ${job.data.join(', ')}`)
  );
}

/**
 * Перенести данные работы из исходного прогона в новый.
 *
 * Возобновление заводит новый каталог прогона, а переиспользованный шаг не
 * исполняется и ничего не пишет — без переноса потребитель
 * `${jobs.X.data.*}` ломался бы на пустоте именно при возобновлении, то есть
 * там, где всё остальное как раз сохранено. Тот же перенос уже сделан для
 * выхода работы (`transferStepOutput`).
 *
 * Переносится всё, что успел записать исходный прогон, и только когда хотя бы
 * один шаг работы переиспользуется: работа, переисполняемая с начала, обязана
 * начать с чистого листа. Уже записанное в этом прогоне не затирается.
 *
 * Перенесённое подчиняется объявлению нового определения работы, а не
 * старого: определение могло поменяться между прогонами, и объявление нового
 * прогона — единственное, которым он сам исполняется.
 */
function transferJobData(context: RunContext, job: Job): void {
  const source = context.resume?.source;
  if (source === undefined) return;
  if (!context.resume?.plan.steps.some((step) => step.job === job.id && step.decision.kind === 'reuse')) {
    return;
  }

  const target = jobDir(context.journal.paths, job.id);
  if (existsSync(jobDataPath(target))) return;

  const carried = readJobData(jobDir(source.paths, job.id));
  const declared = new Set(job.data);
  const allowed = Object.fromEntries(Object.entries(carried).filter(([key]) => declared.has(key)));
  if (Object.keys(allowed).length === 0) return;

  // Обход объявления здесь законен и уже отработан: `allowed` отобран по
  // `job.data` строкой выше, то есть тем же объявлением, которым сверяется
  // всякая запись.
  bookkeep({ journal: context.journal, job: job.id }, 'перенос данных работы', () => {
    writeJobDataUnchecked(target, allowed);
  });
}

/** Правила допустимости выхода — те же, что у линта: `env_deny` и переменные секретов пайплайна. */
function outputPolicy(context: RunContext): OutputPolicy {
  const { pipeline } = context.expanded;
  return { envDeny: pipeline.envDeny, secretEnvs: pipeline.secrets.map((secret) => secret.env) };
}

/**
 * Принять опубликованное шагом: данные работы и, у шага `run`, её выходы.
 * Причины двух нарушений объединяются — статус у работы один. `published` —
 * выходы, внесённые именно этим шагом: их несёт запись шага.
 */
function foldPublished(
  context: RunContext,
  job: Job,
  step: Step,
  reused?: StepRecord,
): { readonly violation?: string; readonly published?: Readonly<Record<string, string>> } {
  const outputs = step.kind === 'run' ? foldJobOutputs(context, job, reused) : {};
  const parts = [foldJobData(context, job), outputs.violation].filter((part) => part !== undefined);
  return {
    ...(parts.length === 0 ? {} : { violation: parts.join('; ') }),
    ...(outputs.published === undefined ? {} : { published: outputs.published }),
  };
}

/**
 * Принять выходы работы из `outputs.env` в её запись `status.json`.
 *
 * Файл читается и проверяется целиком после каждого шага `run`: ошибка
 * называет шаг, который её внёс, а не конец работы. В отличие от
 * `foldJobData` объявление записи не ограничивает — необъявленный ключ
 * принимается (design.md, решение 1). Принятое ложится поверх уже лежащего в
 * записи — там могут быть выходы переиспользованных шагов, которых пустой файл
 * не знает, — и предел числа ключей проверяется по объединённому набору:
 * иначе шаг, переписавший файл через `>`, обходил бы его.
 *
 * Переиспользованный шаг файла не пишет: его выходы берутся из его записи в
 * исходном прогоне (`reused.outputs`). Поэтому при `resume` переносятся
 * только выходы переиспользованных шагов, а ключ, опубликованный шагом,
 * который теперь исполняется заново, должен быть опубликован заново.
 *
 * Возвращает выходы, внесённые этим шагом, — ключи, которых в записи не было
 * или чьё значение он изменил. Нарушение роняет работу, и ничего из этого
 * прохода в запись не попадает.
 */
function foldJobOutputs(
  context: RunContext,
  job: Job,
  reused?: StepRecord,
): { readonly violation?: string; readonly published?: Readonly<Record<string, string>> } {
  const record = context.records.get(job.id);
  if (record === undefined) return {};

  let incoming: Readonly<Record<string, string>>;
  if (reused === undefined) {
    const text = readJobOutputsText(jobOutputsPath(context.journal.paths, job.id));
    const parsed = parseJobOutputs(job.id, text, outputPolicy(context));
    if (!parsed.ok) return { violation: parsed.reason };
    incoming = parsed.outputs;
  } else {
    incoming = reused.outputs ?? {};
  }

  const published = Object.fromEntries(
    Object.entries(incoming).filter(([key, value]) => record.outputs?.[key] !== value),
  );
  if (Object.keys(published).length === 0) return {};

  const outputs = { ...record.outputs, ...published };
  if (Object.keys(outputs).length > MAX_OUTPUT_KEYS) {
    return { violation: `работа ${job.id}: больше ${MAX_OUTPUT_KEYS} различных ключей выходов` };
  }
  context.records.set(job.id, { ...record, outputs });
  context.refreshStatus();
  return { published };
}

/**
 * Объявленные выходы, которых работа не опубликовала. Работа с шагом,
 * завершённым как `shadow`, освобождена: её внешнее действие не исполнялось, и
 * иначе каждый прогон насухо падал бы на выходе, которого по построению не
 * могло появиться (design.md, решение 9).
 *
 * Проверяется один раз, когда все шаги работы завершились успехом: у работы
 * без цикла — в конце `runJobSteps`, у работы с `until` — после сошедшейся
 * итерации (`runIterations`). Ключ, который публикует только итерация, где
 * проверка сошлась, ранние итерации не роняет.
 */
function unpublishedOutputs(context: RunContext, job: Job): JobOutcome | undefined {
  if (job.outputs.length === 0) return undefined;
  const record = context.records.get(job.id);
  if (record?.steps.some((step) => step.reason === 'shadow')) return undefined;
  const published = record?.outputs ?? {};
  const missing = job.outputs.filter((key) => !Object.hasOwn(published, key));
  if (missing.length === 0) return undefined;
  // Причины у отказа нет (перечень закрыт, `halt.ts`), поэтому `attempts`
  // его не повторяет: недостача — свойство скриптов работы, а не сбой.
  return {
    status: 'failed',
    reason: `работа ${job.id} объявила выходы, но не опубликовала: ${missing.join(', ')}`,
  };
}

/**
 * Записать в запись шага выходы, которые он внёс: при `resume` переносятся
 * выходы ровно тех шагов, что переиспользуются (`foldJobOutputs`).
 */
function attachPublishedOutputs(
  context: RunContext,
  job: Job,
  steps: StepRecord[],
  stepDirPath: string,
  published: Readonly<Record<string, string>> | undefined,
): void {
  if (published === undefined) return;
  const last = steps.at(-1);
  if (last === undefined) return;
  const updated: StepRecord = { ...last, outputs: { ...last.outputs, ...published } };
  steps[steps.length - 1] = updated;
  context.journal.writeStepJson(stepDirPath, 'step.json', updated);
  context.records.set(job.id, {
    ...(context.records.get(job.id) as JobRecord),
    steps: [...steps],
  });
  context.refreshStatus();
}

/**
 * Переменные `NEEDS_<РАБОТА>_<КЛЮЧ>` для работы-потребителя: выходы её прямых
 * зависимостей (`needs` или все предшествующие при `needs: all`), которые
 * завершились успехом. Транзитивные производители, упавшие, пропущенные и
 * отменённые не дают ничего: частично опубликованное — не результат.
 *
 * Значения берутся из записей в памяти движка, а не из файлов: шаг с доступом
 * к каталогу прогона не должен менять принятое после завершения производителя.
 * Две зависимости, давшие одно имя, — `collision`: тихое перекрытие одного
 * выхода другим недопустимо, потребитель падает до первого шага.
 */
function needsVariables(
  context: RunContext,
  job: Job,
): { readonly variables: Record<string, string>; readonly collision?: string } {
  const variables: Record<string, string> = {};
  const owners = new Map<string, string>();
  for (const dependency of context.graph.dependencies.get(job.id) ?? []) {
    const record = context.records.get(dependency);
    if (record?.status !== 'success' || record.outputs === undefined) continue;
    for (const [key, value] of Object.entries(record.outputs)) {
      const name = needsVarName(dependency, key);
      const owner = owners.get(name);
      if (owner !== undefined && owner !== dependency) {
        return {
          variables,
          collision: `работы ${owner} и ${dependency} дают потребителю ${job.id} одну переменную ${name}`,
        };
      }
      owners.set(name, dependency);
      variables[name] = value;
    }
  }
  return { variables };
}

/**
 * Перенести в новый прогон состояние каталога прогона, оставшееся от
 * переиспользованных шагов.
 *
 * Каталог прогона — такая же среда исполнения, как рабочее дерево, только
 * заведённая движком и своя у каждого прогона: шаг кладёт туда промежуточный
 * файл (`$BURNEX_RUN_DIR/item.json`, `${run.dir}/…`), а соседний шаг читает
 * его оттуда же. Переиспользованный шаг ничего не кладёт — его побочный эффект
 * остался в каталоге исходного прогона, — и переисполняемый читатель не
 * находит файла, хотя ни определение, ни дерево не менялись. Рабочему дереву
 * ту же задачу решает восстановление по якорю; здесь якорей нет, и отвечает ей
 * копия.
 *
 * Копируется всё, чего нет в раскладке журнала: раскладку движок пишет сам, а
 * остальное в каталоге прогона могло появиться только от шага. Переисполняемый
 * шаг, который тот же путь пишет заново, перезаписывает копию до того, как её
 * кто-нибудь прочитает: работа выше по графу завершается раньше нижележащей, а
 * шаг — раньше следующего шага своей работы.
 */
function carryOverRunDir(resume: ResumeContext, journal: RunJournal): void {
  if (!resume.plan.steps.some((step) => step.decision.kind === 'reuse')) return;

  const paths = journal.paths;
  // Имена раскладки берутся из самих путей, а не списком литералов: список
  // разошёлся бы с раскладкой при первом же её пополнении, и новый служебный
  // файл поехал бы из прогона в прогон как чужое состояние.
  const own = new Set(
    [
      paths.manifest,
      paths.lock,
      paths.status,
      paths.events,
      paths.usage,
      paths.artifacts,
      paths.jobs,
      paths.workspace,
      paths.anchors,
      // Снимок движка принадлежит прогону, который его снял: этот прогон снял
      // собственный до первой работы (`run/engine.ts`), и чужой, скопированный
      // поверх, вернул бы исполнение к коду другого прогона — при том что
      // манифест называет путь своего снимка (run-engine-snapshot).
      paths.engine,
      // Записи решений адресованы ожиданиям исходного прогона и этому прогону
      // не годятся: неприменённое решение переносится отдельно и осознанно —
      // `carryOverDecisions` ниже.
      paths.decisions,
    ].map((path) => basename(path)),
  );

  try {
    for (const entry of readdirSync(resume.source.paths.dir)) {
      if (own.has(entry)) continue;
      cpSync(join(resume.source.paths.dir, entry), join(paths.dir, entry), { recursive: true });
      journal.event({ kind: 'run_dir.carried', path: entry, source: resume.source.manifest.run_id });
    }
  } catch (error) {
    // Не отказ: без переноса переисполнится лишнее либо шаг честно упадёт на
    // отсутствующем файле — ровно то, что было бы и без возобновления.
    journal.event({
      kind: 'bookkeeping.failed',
      operation: 'перенос состояния каталога прогона',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Перенести решения, записанные исходному прогону и не применённые им (дельта
 * `run-resume`): человек ответил прогону, чей процесс уже не жил, и команда
 * сказала ему, что решение применится при возобновлении. Переисполняемый шаг
 * получит его первым же тактом своего ожидания, вместо второго вопроса тому же
 * человеку.
 *
 * Событие переноса пишется по каждому решению: оно и след для читателя
 * журнала, и источник, из которого перенос читается ещё раз, если и этот
 * прогон не успеет применить решение.
 */
function carryOverDecisions(
  resume: ResumeContext,
  journal: RunJournal,
  into: Map<string, CarriedDecision>,
): void {
  let pending: readonly CarriedDecision[];
  try {
    pending = collectPendingDecisions(resume.source.paths, resume.source.manifest.run_id);
  } catch (error) {
    // Не отказ, как и у переноса каталога: без переноса прогон спросит
    // человека заново — хуже, но не неверно.
    journal.event({
      kind: 'bookkeeping.failed',
      operation: 'перенос неприменённых решений',
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const entry of pending) {
    into.set(carriedKey(entry.job, entry.step), entry);
    journal.event({
      kind: 'decision.carried',
      wait_id: entry.waitId,
      job: entry.job,
      step: entry.step,
      source: entry.source,
      outcome: entry.record.outcome,
      ...(entry.record.reason === undefined ? {} : { reason: entry.record.reason }),
      ...(entry.record.restart_from === undefined ? {} : { restart_from: entry.record.restart_from }),
    });
  }
}

/**
 * Привести каталог запуска к состоянию, на котором остановилось
 * переиспользование.
 *
 * Только каталог запуска и только пути работ, которые в нём и работали:
 * результат работы изолированного режима лежит в её собственном дереве и
 * туда же возвращается — своей записью плана (`restoreWorkspace`,
 * `restoreJobWorkspace`). Наложить его на главное дерево проекта значило бы
 * испортить репозиторий пользователя возобновлением, которое ничего такого не
 * обещает.
 *
 * Недоступный якорь не отказ: возобновление отступает к ближайшему
 * предшествующему восстановимому состоянию, в пределе — к началу пайплайна.
 * Худший исход равен тому, что пользователь получил бы без `resume` вообще.
 */
function restoreForResume(
  resume: ResumeContext,
  journal: RunJournal,
  cwd: string,
  anchorKind: AnchorKind,
  nestedRepos: readonly string[] | undefined,
): void {
  const restore = resume.plan.restore;
  if (restore === undefined) return;
  restoreTree({
    journal,
    dir: cwd,
    scope: 'resume',
    anchorKind,
    ...(nestedRepos === undefined ? {} : { nestedRepos }),
    anchor: restore.anchor,
    paths: restore.paths,
  });
}

/** Общая механика обоих восстановлений: якорь, пути, каталог — и мягкий отказ. */
function restoreTree(options: {
  readonly journal: RunJournal;
  readonly dir: string;
  readonly scope: string;
  readonly anchorKind: AnchorKind;
  readonly repoDir?: string;
  readonly nestedRepos?: readonly string[];
  readonly anchor: Anchor;
  readonly paths: readonly string[];
}): void {
  const { journal, dir, anchor, paths } = options;
  const anchorer = createAnchorer({
    dir,
    stateDir: journal.paths.anchors,
    kind: options.anchorKind,
    scope: options.scope,
    ...(options.repoDir === undefined ? {} : { repoDir: options.repoDir }),
    ...(options.nestedRepos === undefined ? {} : { nested: options.nestedRepos }),
  });

  try {
    anchorer.restorePaths(anchor, paths);
    journal.event({ kind: 'tree.restored', anchor: anchor.id, path: dir });
  } catch (error) {
    // Недоступный якорь не отказ: переисполнить лишнее дороже, но это ровно
    // то, что пользователь получил бы без возобновления вообще.
    journal.event({
      kind: 'bookkeeping.failed',
      operation: 'восстановление дерева по якорю',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    anchorer.dispose();
  }
}

/**
 * Контекст шага итерации: к его собственным записям добавляется результат
 * непрошедшего `check` **непосредственно предшествующей** итерации. Копить
 * результаты нескольких прошлых итераций незачем: они описывают состояние,
 * которого уже нет.
 */
function withIterationNote(
  context: RunContext,
  jobId: string,
  stepId: string,
  own: readonly ContextEntry[],
  previousCheck: readonly PredicateResult[] | undefined,
  /** Это сообщение — первое, которое прогон отправляет в продолжаемый диалог. */
  interrupted: boolean,
  onTruncated: (truncation: IterationNoteTruncation) => void,
): { entries: readonly ContextEntry[]; hasNote: boolean } {
  const entries = takeFailureNote(context, jobId, stepId, own, interrupted);
  if (previousCheck === undefined) return { entries, hasNote: false };

  const failed = previousCheck.filter((item) => !item.passed && item.hard);
  if (failed.length === 0) return { entries, hasNote: false };

  const { text, truncation } = buildIterationNote(failed, context.config.context.noteMaxTokens);
  if (truncation !== undefined) onTruncated(truncation);

  return { entries: [{ kind: 'text', text }, ...entries], hasNote: true };
}

/**
 * Текст выдержки о прошлом отказе, если прошлый прогон её заслуживает.
 *
 * Работа, чей шаг продолжает оборванную сессию, исключается: её «отказ» —
 * отмена, а не непройденная проверка, и ей достанется запись о прерывании,
 * а не эта выдержка (`takeFailureNote`).
 */
function previousFailureText(resume: ResumeContext): string | undefined {
  const continuingJobs = new Set(
    resume.plan.steps.filter((item) => item.decision.kind === 'continue').map((item) => item.job),
  );
  return buildPreviousFailure(resume.source.paths, resume.source.status, continuingJobs)?.text;
}

/**
 * Подложить выдержку о прошлом отказе первому агентскому шагу работы, с
 * которой возобновление начато, либо запись о прерывании — продолжаемому
 * шагу. Запись входит в состав контекста наравне с остальными и потому
 * учитывается в пределе размера.
 *
 * Шаг, продолжающий сессию, выдержки об отказе не получает вовсе: его не
 * забраковали, а `plan.failureNoteJob` его работу своим адресатом и не
 * выбирает (`resumePlan.ts`). Запись о прерывании при этом кладётся не всякой
 * его попытке, а только той, что действительно продолжает оборванный диалог:
 * решает это вызывающий (`runAgentStep`), потому что засев сессии может быть
 * снят посреди шага отказом продолжения.
 */
function takeFailureNote(
  context: RunContext,
  jobId: string,
  stepId: string,
  own: readonly ContextEntry[],
  interrupted: boolean,
): readonly ContextEntry[] {
  if (interrupted) return [{ kind: 'text', text: buildInterruptedNote() }, ...own];

  const note = context.failureNote.pending;
  if (note === undefined) return own;
  if (context.resume?.plan.failureNoteJob !== jobId) return own;

  context.failureNote.pending = undefined;
  return [{ kind: 'text', text: note }, ...own];
}

export { isBurnexError };

/** Объявление рабочей директории пайплайна для манифеста и состояния. */
function workspaceRecord(workspace: Pipeline['workspace']): RunManifest['workspace'] {
  return {
    mode: workspace.mode,
    ...(workspace.path === undefined ? {} : { path: workspace.path }),
    ...(workspace.scope === undefined ? {} : { scope: workspace.scope }),
    ...(workspace.trees === undefined ? {} : { trees: [...workspace.trees] }),
  };
}
