import type { ModelTier, ModelTiers } from '../../src/parts/pipeline/config/modelTiers.js';

/**
 * Договор витрины с демоном.
 *
 * Типы описаны здесь заново, а не импортированы из `src/ui`: между браузером и
 * демоном лежит JSON, и общий тип создавал бы впечатление общей памяти —
 * браузер собирается бандлером, демон компилируется `tsc`, и модулями они не
 * делятся. Расхождение с сервером типизация здесь не поймает; его ловят тесты
 * сервера, проверяющие ответы. Зато вся граница видна в одном файле.
 *
 * Поля сверены построчно с `src/parts/ui/overview.ts`, `src/parts/ui/snapshot.ts`,
 * `src/parts/ui/pipelines.ts`, `src/parts/ui/graph.ts` и `src/parts/ui/settings.ts`, а формы
 * ответов на отбор и удаление — с обработчиками `src/parts/ui/server.ts`.
 */

export type StatusValue =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'canceled'
  | 'budget_exceeded';

export interface TokenBreakdown {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Откуда взята цена; нет поля — сообщённая (прогон прежней формы). */
export type CostSource = 'reported' | 'catalog' | 'mixed';

export interface RunUsageOverview {
  readonly billableTokens: number;
  readonly wallclockMs: number;
  readonly breakdown?: TokenBreakdown;
  readonly costUsd: number | null;
  readonly costSource?: CostSource;
  /** Дата прейскуранта, если в расходе прогона есть оценка по каталогу. */
  readonly costCatalogAsOf?: string;
  readonly aggregated: boolean;
  /** Сводка прочитана, но прогон ещё не завершён: величины накоплены, не подведены. */
  readonly partial: boolean;
  readonly unreported: readonly string[];
}

/**
 * `version-skew` — журнал новее читателя: лечится перезапуском демона.
 * `legacy-journal` — журнал старше читателя и написан формой, которой
 * действующие схемы уже не знают: лекарства нет. `malformed` — файл
 * пострадал, `missing` — файла нет.
 */
export type JournalProblemKind = 'version-skew' | 'legacy-journal' | 'malformed' | 'missing';

/** Беда чтения файла журнала — данные, а не только текст исключения. */
export interface JournalProblem {
  readonly kind: JournalProblemKind;
  /** Файл журнала — именем внутри каталога прогона: `run.json`, `status.json`. */
  readonly file: string;
  /** Место внутри документа: имя ключа или путь вроде `jobs.2.steps.0`. */
  readonly at?: string;
  /** Что именно не так: «неизвестный ключ pid». */
  readonly detail: string;
  /** Версия формата, объявленная журналом. Нет у журнала прежней формы. */
  readonly journalFormat?: number;
  /** Версия формата, которую знает этот читатель. */
  readonly readerFormat: number;
}

/** Эффект решения — закрытый набор движка (`user-decision-steps`). */
export type DecisionEffect = 'continue' | 'reject' | 'restart';

/** Один допустимый исход объявленного ожидания: эффект и подпись для кнопки. */
export interface AwaitingOutcome {
  readonly effect: DecisionEffect;
  readonly label?: string;
}

/** Ожидание решения человека, идущее прямо сейчас. */
export interface AwaitingDecision {
  readonly wait_id: string;
  readonly job: string;
  readonly step: string;
  readonly outcomes: Readonly<Record<string, AwaitingOutcome>>;
  readonly prompt?: string;
  readonly since: string;
  readonly deadline?: string;
  readonly on_expire?: string;
}

/** Решение, применённое к ожиданию, — на карточке шага прогона. */
export interface DecisionRecord {
  readonly outcome: string;
  readonly effect: DecisionEffect;
  readonly by: 'user' | 'deadline';
  readonly reason?: string;
  readonly restart_from?: string;
}

export interface RunOverview {
  readonly runId: string;
  readonly shortId: string;
  readonly pipeline: string;
  /**
   * Файл, которым запущен прогон, — относительно корня проекта, тем же видом,
   * что `PipelineView.file`: по нему прогон и находит свой пайплайн. Пусто,
   * если манифест прогона не прочитался.
   */
  readonly pipelineFile?: string;
  readonly status?: StatusValue;
  readonly running: boolean;
  /** Состояние осталось `running`, но процесс мёртв. Ложно вне `running`. */
  readonly abandoned: boolean;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly wakeAt?: string;
  /** Ожидания решения человека, идущие прямо сейчас — тем же полем, что и `wakeAt`. */
  readonly awaiting?: readonly AwaitingDecision[];
  /** Режим прогона из манифеста: `shadow` — внешние действия записаны, а не совершены. */
  readonly mode?: 'shadow';
  /** Агент, выбранный `run --agent` на этот прогон; без флага поля нет. */
  readonly agentOverride?: string;
  /** Прогон запущен по записи расписания; у ручного прогона поля нет. */
  readonly trigger?: {
    readonly entry: number;
    readonly cron: string;
    readonly timezone?: string;
    readonly moment: string;
    readonly catchup: boolean;
  };
  readonly swept: boolean;
  /** У прогона нет каталога вовсе — виден по записи хранилища расхода. Отличимо от `swept`. */
  readonly filesGone: boolean;
  readonly durationMs?: number;
  readonly unreadable: boolean;
  /** Диагноз беды чтения: файл, место, версии. Отсутствует, когда читаются штатно. */
  readonly problem?: JournalProblem;
  readonly usage?: RunUsageOverview;
}

export interface ProjectOverview {
  readonly key: string;
  readonly path?: string;
  readonly runs: readonly RunOverview[];
}

export interface Overview {
  readonly projects: readonly ProjectOverview[];
  readonly generatedAt: string;
}

/** Цикл участника в узле графа — сверено с `GraphLoop` в `src/parts/ui/graph.ts`. */
export interface GraphLoop {
  readonly id: string;
  readonly iterations: number;
  readonly maxIterations: number;
  readonly current?: number;
  readonly verdict?: 'done' | 'exhausted' | 'canceled';
  readonly status: StatusValue;
}

export interface GraphNode {
  readonly id: string;
  readonly column: number;
  readonly row: number;
  readonly needs: readonly string[];
  readonly on: 'success' | 'failure' | 'always';
  readonly if?: string;
  readonly conditional: boolean;
  readonly status?: StatusValue;
  /** Раскрытая подпись работы: ключ `title` показывается строкой в узле. */
  readonly display?: Readonly<Record<string, string>>;
  readonly loop?: GraphLoop;
  readonly blockedBy: readonly string[];
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly blocking: boolean;
}

export interface JobGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly columns: number;
}

export interface JournalFileRef {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
}

export interface UsageSnapshot {
  readonly billableTokens: number | null;
  readonly wallclockMs: number | null;
  readonly costUsd: number | null;
  readonly costSource?: CostSource;
}

export interface ContextBreakdown {
  readonly levels: Readonly<Record<'upstream' | 'pipeline' | 'job' | 'step', number>>;
  readonly total: number;
}

/** Модель одной попытки шага, как её сообщил бэкенд в `usage.json`. */
export interface AttemptModel {
  readonly attempt: number;
  /** Отсутствует, если бэкенду не передавали `--model` вовсе. */
  readonly model?: string;
}

export interface StepSnapshot {
  readonly id: string;
  readonly kind: 'agent' | 'run' | 'script' | 'plugin';
  readonly agent?: string;
  /** Модель, объявленная определением. */
  readonly model?: string;
  /** Модели попыток, которыми шаг фактически исполнился, — из сводки расхода. */
  readonly attemptModels: readonly AttemptModel[];
  readonly status?: StatusValue;
  readonly reason?: string;
  readonly attempts: number;
  /** Отрезок исполнения шага: начало первой попытки и конец последней. */
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly prompt?: string;
  readonly command?: string;
  /** Путь скрипта, объявленный документом, — у шага script. */
  readonly scriptPath?: string;
  /** Имя раннера, которым скрипт разрешён исполниться. */
  readonly scriptRunner?: string;
  /** Объявлен ли вход контракта (`input`) — у шага script. */
  readonly hasScriptInput?: boolean;
  /** Путь объявленной схемы выхода — у script означает проверку файла, а не разбор stdout. */
  readonly scriptOutputSchemaPath?: string;
  /** Имя переиспользуемого шага — у script, собранного из манифеста (`uses`). */
  readonly usesName?: string;
  /** Слой, в котором разрешён манифест. */
  readonly usesLayer?: string;
  /** Путь манифеста, из которого собран шаг. */
  readonly usesManifestPath?: string;
  /** Сведённые параметры вызова, с применёнными умолчаниями. */
  readonly usesParams?: Readonly<Record<string, unknown>>;
  /** Имя вида шага плагинного вида — из замка прогона. */
  readonly pluginKindName?: string;
  /** Плагин, внёсший этот вид шага в этом прогоне. */
  readonly pluginPlugin?: string;
  /** Поля шага, как записаны замком. */
  readonly pluginFields?: unknown;
  /** Чем показанные поля являются и откуда взяты — вместо подписей из схемы вклада. */
  readonly pluginNote?: string;
  /** Ожидание решения на этом шаге, если оно идёт прямо сейчас. */
  readonly awaiting?: AwaitingDecision;
  /** Решение, применённое к ожиданию этого шага, если оно уже принято. */
  readonly decision?: DecisionRecord;
  readonly context: readonly string[];
  readonly contextBreakdown?: ContextBreakdown;
  readonly files: readonly JournalFileRef[];
  readonly usage: UsageSnapshot;
}

/** Цикл участника — сверено с `JobLoopSnapshot` в `src/parts/ui/snapshot.ts`. */
export interface JobLoop extends GraphLoop {
  /** Проходы работы, чьи каталоги есть на диске, по возрастанию. */
  readonly passes: readonly number[];
}

export interface JobSnapshot {
  readonly id: string;
  readonly description?: string;
  readonly status?: StatusValue;
  readonly reason?: string;
  /** Отрезок исполнения работы: у идущей конца ещё нет. */
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly needs: readonly string[];
  readonly if?: string;
  readonly on: 'success' | 'failure' | 'always';
  /** Дорожка, объявленная на месте подключения работы. */
  readonly lane?: string;
  /** Группа сессий, объявленная на месте подключения работы. */
  readonly sessionGroup?: string;
  readonly context: readonly string[];
  readonly inputs: readonly JournalFileRef[];
  readonly output?: JournalFileRef;
  readonly outputDeclared: boolean;
  /** Цикл, в который входит работа; у работы вне цикла поля нет. */
  readonly loop?: JobLoop;
  /** Подпись работы, раскрытая демоном против данных прогона. */
  readonly display?: Readonly<Record<string, string>>;
  /** Данные, опубликованные самой работой командой `stepcast data`. */
  readonly data?: Readonly<Record<string, string>>;
  readonly steps: readonly StepSnapshot[];
  readonly usage: UsageSnapshot;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly projectKey: string;
  readonly pipeline: string;
  readonly status?: StatusValue;
  readonly jobs: readonly JobSnapshot[];
  readonly graph: JobGraph;
  /** Режим прогона из манифеста: `shadow` — внешние действия записаны, а не совершены. */
  readonly mode?: 'shadow';
  /** Агент, выбранный `run --agent`; шапка показывает его рядом с режимом. */
  readonly agentOverride?: string;
  readonly swept: boolean;
  /** У прогона нет каталога — снимок собран по записи хранилища расхода. */
  readonly filesGone: boolean;
  /** Процесс прогона жив — ключ есть только тогда. */
  readonly alive?: true;
  /** Итог прогона — только когда `filesGone: true`. */
  readonly total?: UsageSnapshot;
  /** Дата прейскуранта прогона — для подсказки к метке оценки. */
  readonly costCatalogAsOf?: string;
  /** Разрез по моделям — только когда `filesGone: true`. */
  readonly models?: readonly { readonly model: string; readonly billableTokens: number; readonly costUsd: number | null }[];
  /** Диагноз беды чтения журнала: манифест, состояние, сводка расхода — в этом порядке. */
  readonly problem?: JournalProblem;
}

/** Явная модель документа, отброшенная как чужая выбранному агенту. */
export interface DroppedModel {
  readonly model: string;
  readonly layer: 'step' | 'job' | 'pipeline';
}

/** Слой, давший значение из записи `pipeline_agents` / `step_agents`, — всегда с файлом. */
export interface PipelineEntryLayer {
  readonly layer: 'pipeline_agents' | 'step_agents';
  readonly file: string;
}

/** Слой, давший агента шага. */
export type PipelineAgentOrigin =
  | { readonly layer: 'step' }
  | { readonly layer: 'job' }
  | { readonly layer: 'pipeline' }
  | { readonly layer: 'config' }
  | PipelineEntryLayer;

/** Слой, из которого пришла модель шага. Слой `config` несёт файл, победивший в этом проекте. */
export type PipelineModelOrigin = (
  | { readonly layer: 'step' }
  | { readonly layer: 'job' }
  | {
      readonly layer: 'tier';
      readonly backend: string;
      readonly tier: string;
      readonly tierLayer: 'pipeline' | 'job' | 'step' | 'pipeline_agents' | 'step_agents';
      readonly file?: string;
      readonly fallback?: true;
    }
  | { readonly layer: 'pipeline' }
  | { readonly layer: 'config'; readonly file: string }
  | PipelineEntryLayer
  | { readonly layer: 'backend'; readonly backend: string }
  | { readonly layer: 'none' }
) & { readonly dropped?: DroppedModel };

/** Слой, из которого пришёл действующий reasoning effort шага. */
export type PipelineEffortOrigin =
  | { readonly layer: 'step' }
  | { readonly layer: 'job' }
  | {
      readonly layer: 'tier';
      readonly backend: string;
      readonly tier: string;
      readonly tierLayer: 'pipeline' | 'job' | 'step' | 'pipeline_agents' | 'step_agents';
      readonly file?: string;
    }
  | { readonly layer: 'pipeline' }
  | { readonly layer: 'config'; readonly file: string }
  | PipelineEntryLayer
  | { readonly layer: 'none' };

export interface AgentEntryFieldView {
  readonly value: string;
  readonly file: string;
}

/**
 * Запись выбора пользователя, действующая для пайплайна или шага. Отметка
 * говорит, почему правка с экрана может ничего не менять: запись проигрывает
 * документу при действующей политике либо задана проектным файлом, а экран
 * пишет только глобальный. Сверено с `AgentEntryView` (`src/parts/ui/pipelines.ts`).
 */
export interface AgentEntryView {
  readonly key: string;
  readonly agent?: AgentEntryFieldView;
  readonly model?: AgentEntryFieldView;
  readonly modelTier?: AgentEntryFieldView;
  readonly effort?: AgentEntryFieldView;
  readonly mark?: 'loses_to_document' | 'no_agent_steps' | 'shadowed_by_project';
}

export interface PipelineStepView {
  readonly id: string;
  readonly kind: 'agent' | 'run' | 'script' | 'plugin';
  readonly agent?: string;
  /** Модель, которой шаг исполнится. Отсутствует у шага без модели ни на одном слое. */
  readonly model?: string;
  /** Слой, давший `model`, — только у агентских шагов. */
  readonly modelOrigin?: PipelineModelOrigin;
  /** Effective reasoning effort и слой, который его дал. */
  readonly effort?: string;
  readonly effortOrigin?: PipelineEffortOrigin;
  /** Слой, давший агента, — только у агентских шагов. */
  readonly agentOrigin?: PipelineAgentOrigin;
  /** Запись `step_agents` этого шага, если она есть. */
  readonly agentEntry?: AgentEntryView;
  readonly command?: string;
  /** Путь скрипта, объявленный в документе, — у шага script. */
  readonly scriptPath?: string;
  /** Имя раннера, которым скрипт исполнится, — только у разрешённого шага. */
  readonly scriptRunner?: string;
  /** Объявлен ли вход контракта (`input`) — у шага script. */
  readonly hasScriptInput?: boolean;
  /** Путь объявленной схемы выхода — у script означает проверку файла, а не разбор stdout. */
  readonly scriptOutputSchemaPath?: string;
  /** Имя переиспользуемого шага и слой, из которого разрешён его манифест, — у script, собранного из `uses`. */
  readonly usesName?: string;
  readonly usesLayer?: 'project' | 'home' | 'builtin';
  /** Переданные параметры вызова — со сведёнными умолчаниями. */
  readonly usesParams?: Readonly<Record<string, unknown>>;
  /** Имя вида шага плагинного вида — оно же ключ шага в документе. */
  readonly pluginKindName?: string;
  /** Название вклада — из реестра, когда вид ему известен. */
  readonly pluginKindTitle?: string;
  /** Поля с подписями из схемы вклада — тот же вид, что параметры манифеста. */
  readonly pluginFields?: readonly StepParamView[];
  /** Вклад объявляет схему `output` — структурированный выход у шага есть. */
  readonly pluginHasOutput?: boolean;
  /** Действующий реестр вида не знает: причина вместо пустой карточки. */
  readonly pluginUnknownReason?: string;
}

export interface PipelineJobView {
  readonly id: string;
  readonly description?: string;
  readonly needs: readonly string[];
  readonly on: 'success' | 'failure' | 'always';
  readonly if?: string;
  readonly publishesOutput: boolean;
  /** Ключ работы для `step_agents` её шагов: у дорожки — работа до раскрытия, если точной записи дорожки нет. */
  readonly agentEntryJob: string;
  readonly steps: readonly PipelineStepView[];
}

export interface PipelineView {
  readonly projectKey: string;
  readonly projectPath: string;
  /** Путь файла относительно корня проекта либо адрес `<пакет>:<имя>` у пайплайна пакета — им же он запускается. */
  readonly file: string;
  /** Пакет, давший пайплайн, и его слой — только у пайплайна пакета. */
  readonly package?: string;
  readonly packageLayer?: 'project' | 'home';
  readonly name: string;
  readonly concurrency?: number;
  readonly failFast?: boolean;
  readonly jobs: readonly PipelineJobView[];
  /** Действующая политика выбора агента и файл, давший её; у пайплайна с ошибкой разбора не определены. */
  readonly agentPolicy?: 'force' | 'fallback';
  readonly agentPolicyFile?: string;
  /** Запись `pipeline_agents` этого пайплайна, если она есть. */
  readonly agentEntry?: AgentEntryView;
  /** Имя записей выбора — `name` документа; у пайплайна без `name` выбора с экрана нет. */
  readonly agentEntryName?: string;
  /** Имена объявленных входов пайплайна: доска предлагает к запуску только те, кому слаг пункта есть куда передать. */
  readonly inputs: readonly string[];
  /** Имена верхнеуровневого `env:` — значения демон не отдаёт. */
  readonly envNames: readonly string[];
  /** Готовность к shadow-режиму: у неготового — адреса `<работа>.<шаг>` без `external`. */
  readonly shadow: { readonly ready: true } | { readonly ready: false; readonly steps: readonly string[] };
  readonly graph?: JobGraph;
  /** Файл не разбирается: текст, место и подсказка — тем же составом, что печатает CLI. */
  readonly error?: string;
  /** Файл ошибки относительно корня проекта: у `uses` это файл работы, а не пайплайна. */
  readonly errorFile?: string;
  /** Место ошибки внутри документа, например `jobs.propose-a`. */
  readonly errorAt?: string;
  readonly errorHint?: string;
}

/** Сверено с `StepParamView` (`src/parts/ui/steps.ts`). */
export interface StepParamView {
  readonly name: string;
  readonly type?: string;
  readonly required: boolean;
  readonly default?: unknown;
  readonly description?: string;
}

export interface PipelinesOverview {
  readonly pipelines: readonly PipelineView[];
  readonly generatedAt: string;
}

/** Сверено построчно с `WidgetView`/`ProjectWidgetsView`/`WidgetsOverview` (`src/parts/ui/widgets.ts`). */
/** Сверено с `WidgetDeprecation` (`src/parts/ui/widgets.ts`). */
export interface WidgetDeprecation {
  /** `specifier` — таблица не несёт самого голого спецификатора; `name` — специфик остался, а имя из него ушло. */
  readonly kind: 'specifier' | 'name';
  readonly name: string;
  readonly noteText?: string;
}

export interface WidgetView {
  readonly id: string;
  /** Версия — отпечаток файла (`mtime` и размер); идёт в адрес модуля, чтобы отличить новую редакцию от прежней. */
  readonly version: string;
  /**
   * Где лежит виджет: свободный каталог проекта либо пакет проекта или home
   * (`packages-directory-layer`). Витрина его не читает — поле для людей и
   * скриптов, читающих `/api/widgets`, поэтому необязательное на стороне браузера.
   */
  readonly source?: { readonly layer: 'project' | 'home'; readonly package?: string };
  /** Конфликт `id` в слое пакетов: виджет не отдаётся, причина названа здесь. */
  readonly error?: string;
  readonly deprecated?: WidgetDeprecation;
}

export interface ProjectWidgetsView {
  readonly projectKey: string;
  readonly widgets: readonly WidgetView[];
}

export interface WidgetsOverview {
  readonly projects: readonly ProjectWidgetsView[];
  readonly generatedAt: string;
}

/** Сверено построчно с `ProposalOrigin`/`ProposalRecord` (`src/parts/pipeline/domain/proposals/entry.ts`). */
export interface ProposalOrigin {
  readonly run?: string;
  readonly job?: string;
  readonly step?: string;
}

export type ProposalAction = 'create' | 'update';
export type ProposalState = 'pending' | 'accepted' | 'rejected';

export interface ProposalFingerprint {
  readonly mtimeMs: number;
  readonly size: number;
}

export interface ProposalRecord {
  readonly id: string;
  readonly target: string;
  readonly action: ProposalAction;
  readonly content: string;
  readonly reason?: string;
  readonly origin: ProposalOrigin;
  readonly baseFingerprint: ProposalFingerprint | null;
  readonly state: ProposalState;
  readonly createdAt: string;
  readonly decidedAt?: string;
}

/** Негодная запись очереди — сверено с `InvalidProposalFile` (`src/parts/pipeline/domain/proposals/store.ts`). */
export interface ProposalsInvalidFile {
  readonly file: string;
  readonly reason: string;
}

/** Запись, отданная `GET /api/proposals`, — та же запись плюс содержимое цели сейчас (`src/parts/ui/screens/proposals/server.ts`). `null` — цели ещё нет (действие `create`). */
export interface ProposalApiRecord extends ProposalRecord {
  readonly currentContent: string | null;
}

export interface ProjectProposalsPayload {
  readonly projectKey: string;
  readonly projectPath: string;
  /** Действующий режим доставки этого проекта — виден на экране (`ui-proposals`, «Действующий режим доставки MUST быть виден на экране»). */
  readonly mode: 'queue' | 'direct';
  readonly records: readonly ProposalApiRecord[];
  readonly invalid: readonly ProposalsInvalidFile[];
}

export interface ProposalsOverview {
  readonly projects: readonly ProjectProposalsPayload[];
}

/**
 * Состав очереди предложений потоком — облегчённый: без содержимого записи
 * (до 256 КиБ на запись), без текущего содержимого цели и без режима доставки
 * (`ui-proposals`, Решение 15: «поток несёт только состав очереди»). Служит
 * сигналом «перечитай `GET /api/proposals`», а не прямым источником данных для
 * дифа. Сверено с `ProposalStreamRecord` (`src/parts/ui/proposals.ts`).
 */
export type ProposalStreamRecord = Omit<ProposalRecord, 'content'>;

export interface ProjectProposalsStream {
  readonly projectKey: string;
  readonly records: readonly ProposalStreamRecord[];
  readonly invalid: readonly ProposalsInvalidFile[];
}

export interface ProposalsStreamEvent {
  readonly projects: readonly ProjectProposalsStream[];
}

/**
 * Строка состава браузерных плагинов — сверено построчно с `PluginRowView`
 * (`src/parts/ui/plugins.ts`, design.md изменения `hot-swap-preserves-data`,
 * Решение 12): `id` каталога плагина домашнего слоя, версия — отпечаток
 * каталога, идёт в адрес модуля и в ключ сверки состава ядра
 * (`ui/src/services/plugins.ts`).
 */
export interface PluginRowView {
  readonly id: string;
  readonly version: string;
}

export interface PluginsOverview {
  readonly plugins: readonly PluginRowView[];
}

/** Разобранная ошибка компиляции виджета — сверено с `CompileFailure` (`src/parts/ui/widgets.ts`). */
export interface WidgetCompileFailure {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

/** Файл, из которого пришёл пункт очереди — открытые либо решённые (`docs/backlog.md`). */
export type BacklogSourceFile = 'backlog.md' | 'archived.md';

/**
 * Состояние пункта очереди: любое слово формы `BACKLOG_STATUS_PATTERN`
 * (`src/parts/pipeline/domain/backlog/schema.ts`). Смысл движок знает только у
 * `todo`, `in_progress`, `done` и `failed`.
 */
export type BacklogStatus = string;

/**
 * Колонка доски: статус, под который она заведена, либо `archive` — не
 * состояние, а файл `archived.md` (`docs/backlog.md`).
 */
export type ScrumColumn = string;

/** Колонка в раскладке доски проекта — сверено с `BoardColumnSpec` (`src/parts/ui/scrumView.ts`). */
export interface BoardColumnSpec {
  readonly id: string;
  readonly title?: string;
}

/** Сверено построчно с `src/parts/ui/backlog.ts`. */
export interface BacklogItemView {
  readonly slug: string;
  readonly status: BacklogStatus;
  readonly title: string;
  /** Абзацы текста — раскрываются по требованию, а не занимают строку списка. */
  readonly why: string;
  readonly doneWhen: string;
  /** Объявленная группа либо, если пункт её не назвал, слаг самого пункта. */
  readonly group: string;
  /** Объявленный вес пункта; пусто, когда поле не заполнено — без слова по умолчанию. */
  readonly track: string;
  /** Слаги зависимостей в объявленном порядке; пусто, когда поле не заполнено. */
  readonly needs: readonly string[];
  readonly startedAt?: string;
  readonly reason?: string;
  /** `claimed_by` как записан; показывается и владелец иной формы, чем `run:<id>`. */
  readonly claimedBy?: string;
  /** Идентификатор прогона-владельца, разобранный демоном (`parseRunOwner`). */
  readonly ownerRunId?: string;
  readonly sourceFile: BacklogSourceFile;
}

/** Сверено построчно с `BacklogLockView` (`src/parts/ui/backlog.ts`). */
export type BacklogLockView =
  | { readonly state: 'free' }
  | {
      readonly state: 'held';
      readonly command: string;
      readonly pid: number;
      readonly host: string;
      readonly acquiredAt: string;
      readonly abandoned: boolean;
      readonly foreignHost: boolean;
      readonly path: string;
    }
  | { readonly state: 'unreadable'; readonly path: string };

/**
 * Отказ разбора одного файла очереди проекта: текст, файл и место внутри
 * документа. Подсказки (`errorHint` у `PipelineView`) здесь нет — ядро
 * очереди её не даёт.
 */
export interface BacklogFailure {
  /** Файл очереди либо раскладка колонок доски. */
  readonly sourceFile: BacklogSourceFile | '.stepcast/board.yml';
  readonly error: string;
  readonly errorAt?: string;
}

export interface BacklogProjectView {
  readonly projectKey: string;
  readonly projectPath: string;
  /** Пункты обоих файлов одним списком: сперва `backlog.md`, затем `archived.md`. */
  readonly items: readonly BacklogItemView[];
  /** Отказ разбора — по одному на не разобравшийся файл; пустой список — оба разобрались (или отсутствуют). */
  readonly failures: readonly BacklogFailure[];
  /** Раскладка колонок доски (`.stepcast/board.yml`); без файла — встроенная. */
  readonly columns: readonly BoardColumnSpec[];
  /** Блокировка очереди проекта — тем же кадром, что и пункты. */
  readonly lock: BacklogLockView;
}

export interface BacklogOverview {
  readonly projects: readonly BacklogProjectView[];
  readonly generatedAt: string;
}

/** Сверено построчно с `UsageMeasure` (`src/parts/ui/usage.ts`). */
export interface UsageMeasure {
  readonly billableTokens: number;
  readonly costUsd: number;
  readonly costSource?: CostSource;
}

export interface UsageModelSlice extends UsageMeasure {
  readonly model: string;
}

export interface UsageDaySlice {
  readonly day: string;
  readonly models: readonly UsageModelSlice[];
}

export interface UsagePipelineRun {
  readonly runId: string;
  readonly shortId: string;
  readonly startedAt?: string;
  /** Календарный день захода в поясе демона — тот же, что у записи в `days`. */
  readonly day: string;
  readonly status?: StatusValue;
  readonly billableTokens: number;
  /** `null` — цена прогона ни разу не сообщена, а не «потрачено ноль». */
  readonly costUsd: number | null;
  readonly costSource?: CostSource;
  readonly costCatalogAsOf?: string;
  readonly costUnreportedAttempts: number;
  readonly breakdownAvailable: boolean;
}

export interface UsagePipelineSlice extends UsageMeasure {
  readonly projectKey: string;
  readonly projectPath?: string;
  readonly pipeline: string;
  readonly pipelineFile?: string;
  readonly costUnreportedAttempts: number;
  readonly runs: readonly UsagePipelineRun[];
}

export interface UsageTotal extends UsageMeasure {
  readonly costUnreportedAttempts: number;
  readonly runs: number;
}

export interface UsageResult {
  readonly from: string;
  readonly to: string;
  readonly generatedAt: string;
  readonly total: UsageTotal;
  readonly models: readonly UsageModelSlice[];
  readonly days: readonly UsageDaySlice[];
  readonly pipelines: readonly UsagePipelineSlice[];
  readonly runsWithoutBreakdown: number;
  readonly undated: number;
}

/**
 * Доля расхода, чью модель назвать нечем (`src/parts/ui/usage.ts`).
 *
 * Строка продублирована, а не импортирована: `usage.ts` читает диск через
 * `reader.js` и живёт только в демоне (см. заголовок этого файла), а значение
 * сверяется тестами сервера.
 */
export const UNKNOWN_MODEL = 'model not reported';

/** Какой конец крупного файла запрошен и показан. */
export type FileSide = 'head' | 'tail';

export interface FileContent {
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly side: FileSide;
}

/**
 * Вывод шага по логическому адресу — сверено построчно с
 * `src/parts/ui/stepOutput.ts` и обработчиком `/api/step-output` в `src/parts/ui/server.ts`.
 */
export interface StepOutputStream {
  readonly exists: boolean;
  readonly content: string;
  readonly bytes: number;
  readonly offset: number;
  readonly truncated: boolean;
  readonly truncatedFrom?: number;
  readonly restarted: boolean;
}

export interface StepOutputResult {
  readonly attempts: readonly number[];
  readonly attempt?: number;
  /** Прочитанный проход цикла — только у участника цикла. */
  readonly pass?: number;
  readonly done: boolean;
  readonly stdout?: StepOutputStream;
  readonly stderr?: StepOutputStream;
}

export interface SettingsValue {
  readonly value?: string;
  /** Откуда взято значение: встроенное умолчание или путь файла. */
  readonly source: string;
}

export interface BackendView {
  readonly name: string;
  readonly command: string;
  readonly enabled: boolean;
  readonly defaultModel?: string;
  readonly available: boolean;
  /** Строка для `plugins:` у поставляемого, ещё не подключённого бэкенда. */
  readonly plugin?: string;
  readonly defaultModelSource: string;
  readonly modelTiers: ModelTiers;
  readonly modelTierSources: Readonly<Record<string, string>>;
  readonly modelTierEffortSources: Readonly<Record<string, string>>;
}

export interface Settings {
  readonly agent: SettingsValue;
  readonly model: SettingsValue;
  readonly effort: SettingsValue;
  readonly modelTiers: readonly string[];
  readonly backends: readonly BackendView[];
  /** Файл, в который витрина пишет. Пользователь должен знать, что правит. */
  readonly file: string;
}

/** Одна модель, названная CLI, — подсказка, а не перечень допустимого. */
export interface ModelOption {
  readonly name: string;
  readonly label?: string;
  readonly title?: string;
  readonly defaultEffort?: string;
  readonly efforts?: readonly { readonly name: string; readonly description?: string }[];
}

/**
 * Итог перечисления моделей одного агента — те же имена причин, что у
 * `discoverModels` демона (`src/parts/pipeline/backend/models.ts`): `unsupported` —
 * бэкенд перечислять не умеет, `not_installed` — команда не найдена,
 * `timeout` — не ответил за отпущенное время, `failed` — ответил отказом
 * (текст CLI как есть), `unparsed` — ответ не разобран, `probe_error` — код
 * бэкенда, собирающий пробу или разбирающий её вывод, сорвался исключением.
 */
export type ModelsForBackend =
  | { readonly status: 'ok'; readonly models: readonly ModelOption[] }
  | { readonly status: 'unsupported' }
  | { readonly status: 'not_installed'; readonly command: string }
  | { readonly status: 'timeout' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'unparsed' }
  | { readonly status: 'probe_error'; readonly message: string };

export interface ModelsResult {
  readonly backends: Readonly<Record<string, ModelsForBackend>>;
}

export interface SettingsPatch {
  /** Имена поставляемых бэкендов, которые правка подключает. */
  readonly connect?: readonly string[];
  /** Прежняя форма `connect: ['codex']`; витрина её больше не шлёт. */
  readonly connectCodex?: true;
  readonly backends?: Readonly<Record<string, {
    readonly defaultModel?: string | null;
    readonly modelTiers?: Readonly<Record<ModelTier, {
      readonly model: string | null;
      readonly effort?: string | null;
    }>>;
  }>>;
  readonly agent?: string;
  /** `null` — снять значение и вернуться к модели бэкенда. */
  readonly model?: string | null;
  /** `null` — не передавать effort и оставить выбор модели/CLI. */
  readonly effort?: string | null;
  /** Кастомные tier удаляются из карт всех агентов одной записью. */
  readonly removeModelTiers?: readonly string[];
}

/** Признак отбора прогонов к уборке. Имена — те же, что принимает демон. */
export type CleanupTrait = 'abandoned' | 'failed';

export interface RunCandidate {
  readonly address: string;
  readonly sizeBytes: number;
  readonly ageMs: number;
  readonly endedAt?: string;
  /** Журнал не прочитался: возраст взят по каталогу, статуса нет. */
  readonly unreadable: boolean;
  /** У прогона уже есть запись в хранилище расхода — статистика ему есть что сохранять. */
  readonly hasUsageRecord: boolean;
}

export interface RunSelection {
  readonly runs: readonly RunCandidate[];
  readonly count: number;
  readonly totalBytes: number;
  /**
   * Число прогонов области отбора, чей статус демон не смог прочитать ни из
   * состояния, ни из манифеста и которых поэтому не назвал (`selectCandidates`
   * в `src/parts/pipeline/run/cleanup.ts`). Отобранные сюда не входят: срок берёт такой
   * прогон по времени каталога, и он уже стоит в `runs`. У отбора по явному
   * списку адресов всегда 0 — проверять там нечего.
   */
  readonly uncheckedCount: number;
}

export type RemovalOutcomeKind = 'removed' | 'skipped_missing' | 'skipped_alive' | 'failed';

/**
 * Судьба статистики при удалении: `kept` — сохранена, `removed` — снята явной
 * просьбой, `missing` — записи у прогона не было и снимать было нечего
 * (`StatsOutcome` в `src/parts/pipeline/run/cleanup.ts`).
 */
export type StatsOutcome = 'kept' | 'removed' | 'missing';
export type StatsDisposition = 'keep' | 'drop';

export interface RemovalOutcome {
  readonly address: string;
  readonly outcome: RemovalOutcomeKind;
  readonly sizeBytes?: number;
  readonly reason?: string;
  /** Есть только у `outcome: 'removed'`: что стало с записью хранилища расхода. */
  readonly stats?: StatsOutcome;
}

export interface RemovalSummary {
  readonly outcomes: readonly RemovalOutcome[];
  readonly freedBytes: number;
}

/** Кандидат к снятию из хранилища расхода — сверено с `handleSelectUsageRecords` в `src/parts/ui/server.ts`. */
export interface UsageRecordCandidate {
  readonly address: string;
  readonly ageMs: number;
  readonly endedAt: string;
  readonly status: StatusValue;
}

export interface UsageRecordSelection {
  readonly records: readonly UsageRecordCandidate[];
  readonly count: number;
}

export type UsageRecordOutcomeKind = 'removed' | 'skipped_missing';

export interface UsageRecordOutcome {
  readonly address: string;
  readonly outcome: UsageRecordOutcomeKind;
}

export interface UsageRecordRemovalSummary {
  readonly outcomes: readonly UsageRecordOutcome[];
  readonly removed: number;
}

/** Ответ демона с внятной ошибкой: её текст показывается как есть. */
async function json<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Daemon responded ${response.status}`);
  return data;
}

/** Прямой запрос обзора: живой поток (`live.ts`) присылает его же событием `overview`. */
export async function fetchOverview(): Promise<Overview> {
  return json<Overview>(await fetch('/api/overview'));
}

export async function fetchRun(address: string): Promise<RunSnapshot> {
  return json<RunSnapshot>(await fetch(`/api/run?run=${encodeURIComponent(address)}`));
}

/**
 * Приём решения (`user-decision-steps`, design.md решение 5, 11): демон не
 * пишет ничего сам — проверяет запрос по состоянию прогона и порождает
 * `stepcast decide`. `202` здесь — подтверждение приёма, а не применения:
 * отклонение маршрута (400) значит, что запрос сам по себе негоден, а не что
 * решение не применилось (та проверка — уже в `stepcast decide`).
 */
/**
 * Запуск пайплайна проекта либо пайплайна поставки (`stepcast:<имя>`)
 * (`ui-daemon`, «Запуск прогона принимает пайплайн поставки»): `202` —
 * подтверждение приёма запроса, а не обещание идентификатора прогона —
 * появившийся прогон виден обычным тактом обзора.
 */
export async function launchRun(payload: {
  readonly project: string;
  readonly pipeline: string;
  /** Значения объявленных входов пайплайна: доска шлёт сюда `item` — слаг пункта. */
  readonly inputs?: Readonly<Record<string, string>>;
  /** Переопределения объявленного `env:` пайплайна на этот прогон. */
  readonly env?: Readonly<Record<string, string>>;
  /** Shadow-режим: внешние действия шагов записываются, а не совершаются. */
  readonly shadow?: boolean;
  /** Бэкенд агента на этот прогон — слой флага над `defaults.agent`. */
  readonly agent?: string;
}): Promise<{ readonly ok: true }> {
  return json(
    await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

/**
 * Перенести пункт очереди в колонку доски и на место перед `before` (без него
 * — в конец колонки). Правит `backlog.md`/`archived.md` на диске и отвечает
 * синхронно: отказ доезжает до карточки, а не теряется.
 *
 * Колонки `in_progress` маршрут не принимает нарочно: в работу пункт переводит
 * запуск пайплайна (`backlog pick`), который проставляет и статус, и
 * `started_at` одним вызовом.
 */
export async function moveBacklogItem(payload: {
  readonly project: string;
  readonly slug: string;
  readonly column: ScrumColumn;
  readonly before?: string;
}): Promise<{ readonly ok: true }> {
  return json(
    await fetch('/api/backlog/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

/**
 * Завести на доске проекта колонку под статус, которого она не знает, на
 * место `index` (0 — самая левая). Колонка появится следующим кадром потока
 * `backlog`, а не ответом.
 */
export async function addBoardColumn(payload: {
  readonly project: string;
  readonly id: string;
  readonly title?: string;
  readonly index: number;
}): Promise<{ readonly ok: true }> {
  return json(
    await fetch('/api/board/columns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

/**
 * Правка полей пункта очереди — то, что сохраняет панель деталей доски.
 *
 * Пустая строка у необязательного поля (`group`, `track`, `repos`, `needs`) убирает
 * само поле; у обязательного — отказ. Статус здесь не правится: его задаёт
 * колонка доски.
 */
export async function editBacklogItem(payload: {
  readonly project: string;
  readonly slug: string;
  readonly fields: {
    readonly title?: string;
    readonly why?: string;
    readonly done_when?: string;
    readonly group?: string;
    readonly track?: string;
    readonly repos?: string;
    readonly needs?: string;
  };
}): Promise<{ readonly ok: true }> {
  return json(
    await fetch('/api/backlog/item', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

export async function decideRun(payload: {
  readonly run: string;
  readonly outcome: string;
  readonly step?: string;
  readonly reason?: string;
  readonly from?: string;
}): Promise<{ readonly ok: true }> {
  return json(
    await fetch('/api/run/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

/** Возобновление прогона с выбранной работы: отказ предстартовой проверки приходит ошибкой с причиной. */
export async function resumeRun(payload: {
  readonly run: string;
  readonly from: string;
}): Promise<{ readonly ok: true }> {
  return json(
    await fetch('/api/run/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

/**
 * Содержимое файла журнала. `side` — какой конец показать, если файл крупнее
 * потолка демона; на файле меньше потолка параметр ничего не меняет.
 */
export async function fetchFile(
  address: string,
  path: string,
  side: FileSide = 'tail',
): Promise<FileContent> {
  const query = `run=${encodeURIComponent(address)}&path=${encodeURIComponent(path)}&side=${side}`;
  return json<FileContent>(await fetch(`/api/file?${query}`));
}

/**
 * Дописанное с вывода шага. Присутствие `stdoutOffset`/`stderrOffset` в
 * параметрах — сама просьба прочитать поток (см. `StepOutputQuery` в
 * `src/parts/ui/stepOutput.ts`): не запрошенный поток демон не читает и не отдаёт.
 */
export async function fetchStepOutput(options: {
  readonly address: string;
  readonly jobId: string;
  readonly stepId: string;
  readonly attempt?: number;
  /** Проход цикла; без него демон отдаёт последний. */
  readonly pass?: number;
  readonly stdoutOffset?: number;
  readonly stderrOffset?: number;
}): Promise<StepOutputResult> {
  const query = new URLSearchParams({
    run: options.address,
    job: options.jobId,
    step: options.stepId,
  });
  if (options.attempt !== undefined) query.set('attempt', String(options.attempt));
  if (options.pass !== undefined) query.set('pass', String(options.pass));
  if (options.stdoutOffset !== undefined) query.set('stdoutOffset', String(options.stdoutOffset));
  if (options.stderrOffset !== undefined) query.set('stderrOffset', String(options.stderrOffset));
  return json<StepOutputResult>(await fetch(`/api/step-output?${query.toString()}`));
}

export async function fetchPipelines(): Promise<PipelinesOverview> {
  return json<PipelinesOverview>(await fetch('/api/pipelines'));
}

/**
 * Секреты проектов (`ui-secrets-screen`): зеркало `src/parts/ui/secrets.ts`.
 * Поля значения нет намеренно — демон его не отдаёт, и тип не даёт странице
 * случайно сослаться на несуществующее.
 */
export type SecretStatus = 'resolved' | 'not-found' | 'provider-unavailable';

interface SecretOutcome {
  readonly status: SecretStatus;
  readonly reason?: string;
  readonly reasonAt?: string;
  readonly reasonHint?: string;
}

export interface SecretUsage {
  readonly pipeline: string;
  readonly steps: readonly string[];
}

export interface SecretView extends SecretOutcome {
  readonly name: string;
  readonly env: string;
  readonly provider: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly usedBy: readonly SecretUsage[];
  readonly unused: boolean;
}

export interface CredentialView extends SecretOutcome {
  readonly backend: string;
  readonly variable: string;
  readonly provider: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly at: string;
  readonly inUse: boolean;
}

export interface ProviderView {
  readonly name: string;
  readonly owner: string;
}

export interface SecretsPipelineError {
  readonly pipeline: string;
  readonly error: string;
  readonly errorFile?: string;
  readonly errorAt?: string;
  readonly errorHint?: string;
}

export interface ProjectSecretsView {
  readonly projectKey: string;
  readonly projectPath: string;
  readonly error?: string;
  readonly errorFile?: string;
  readonly errorAt?: string;
  readonly errorHint?: string;
  readonly providers: readonly ProviderView[];
  readonly secrets: readonly SecretView[];
  readonly credentials: readonly CredentialView[];
  readonly pipelineErrors: readonly SecretsPipelineError[];
}

export interface SecretsOverview {
  readonly projects: readonly ProjectSecretsView[];
  readonly generatedAt: string;
}

/** Каждый вызов — настоящая проба провайдеров: кеша статусов нет ни здесь, ни у демона. */
export async function fetchSecrets(): Promise<SecretsOverview> {
  return json<SecretsOverview>(await fetch('/api/secrets'));
}

/**
 * Пакеты слоёв проекта и home (`ui-packages-screen`): зеркало
 * `PackageSummary` и `PackageProblem` (`src/parts/packages/summary.ts`) и ответа
 * `GET /api/packages` (`src/parts/ui/screens/packages/server.ts`).
 */
export type PackageResourceKind = 'pipelines' | 'steps' | 'scripts' | 'plugins' | 'widgets' | 'dashboards' | 'routes';

export interface PackageView {
  readonly name: string;
  readonly layer: 'project' | 'home';
  readonly dir: string;
  readonly status: 'ok' | 'broken' | 'shadowed';
  readonly reason?: string;
  readonly shadowedBy?: 'project' | 'home';
  readonly version?: string;
  readonly description?: string;
  readonly provides: readonly PackageResourceKind[];
  readonly contents: Readonly<Partial<Record<PackageResourceKind, readonly string[]>>>;
  readonly unmetNeeds?: Readonly<Record<string, readonly string[]>>;
}

export interface PackageProblemView {
  readonly layer: 'project' | 'home';
  /** Один пакет — отказ файла, два и больше — конфликт имени в слое. */
  readonly packages: readonly string[];
  readonly kind: PackageResourceKind;
  readonly id?: string;
  readonly file?: string;
  readonly message: string;
}

export interface PackagesOverview {
  readonly packages: readonly PackageView[];
  readonly problems: readonly PackageProblemView[];
  /** Каталоги слоёв — для пустого слоя; слоя проекта нет, если демон не знает корня проекта. */
  readonly layers?: { readonly project?: string; readonly home?: string };
  /** Дерево плагинов не собралось: отказов плагинов в `problems` нет. */
  readonly pluginsError?: string;
}

export async function fetchPackages(): Promise<PackagesOverview> {
  return json<PackagesOverview>(await fetch('/api/packages'));
}

/** Здоровье установки (`ui-system-health`): зеркало `src/parts/ui/system.ts`. */
export interface SystemEngine {
  readonly version?: string;
  readonly root: string;
  readonly method?: 'managed' | 'checkout' | 'npm';
  readonly source?: 'manifest' | 'inferred';
  readonly managed?: {
    readonly ref: string;
    readonly version: string;
    readonly installedAt?: string;
    readonly release?: string;
  };
  readonly checkoutDir?: string;
  readonly npmPackage?: string;
  /** Способ установки не определён — «Обновить» неактивна с этой причиной. */
  readonly error?: string;
}

export interface SystemDaemon {
  readonly pid: number;
  readonly startedAt: string;
  readonly port: number;
  readonly projectRoot?: string;
  readonly entry: string;
  readonly underLaunchd: boolean;
}

export type SystemAutostart =
  | { readonly supported: false; readonly reason: string }
  | {
      readonly supported: true;
      readonly plist: boolean;
      readonly loaded: boolean;
      readonly thisDaemon: boolean;
      readonly pid?: number;
      readonly entry?: string;
      readonly entryStable?: boolean;
    };

export type SystemProbe =
  | { readonly status: 'not-probed' }
  | { readonly status: ModelsForBackend['status']; readonly modelCount?: number; readonly message?: string };

export interface SystemRefusal {
  readonly class: 'rate_limit' | 'unauthenticated';
  readonly at: string;
  readonly project: string;
  readonly run: string;
  readonly job: string;
  readonly step: string;
  readonly statusCode?: number;
  readonly message: string;
  readonly backend?: string;
}

export interface SystemBackend {
  readonly id: string;
  readonly command: string;
  readonly enabled: boolean;
  readonly adapter: boolean;
  readonly commandState: { readonly status: 'found'; readonly path: string } | { readonly status: 'missing' };
  readonly probe: SystemProbe;
  readonly refusals: readonly SystemRefusal[];
}

export interface SystemUnpricedModel {
  readonly backend: string;
  /** `null` — конфигурация модели не называет: вызов пойдёт на модели CLI по умолчанию. */
  readonly model: string | null;
  readonly path: string | null;
}

export interface SystemOverview {
  readonly generatedAt: string;
  readonly engine: SystemEngine;
  readonly daemon: SystemDaemon;
  readonly autostart: SystemAutostart;
  readonly backends: readonly SystemBackend[];
  readonly backendsError?: string;
  readonly unattributedRefusals: readonly SystemRefusal[];
  readonly unpriced: { readonly asOf?: string; readonly models: readonly SystemUnpricedModel[] };
}

export type SystemUpdateCheck =
  | { readonly status: 'available'; readonly current: string; readonly latest?: string; readonly commits?: number }
  | { readonly status: 'up-to-date'; readonly version: string }
  | { readonly status: 'blocked' | 'no-tags' | 'unknown'; readonly reason: string; readonly hint?: string };

export interface SystemUpdate {
  readonly checkedAt: string;
  readonly held: boolean;
  readonly error?: string;
  readonly check?: SystemUpdateCheck;
}

export type SystemActionKind = 'update' | 'autostart';

/** Последний процесс действия, порождённый этим демоном; `exitCode: null` — убит сигналом или не запустился. */
export interface SystemMaintenanceRun {
  readonly startedAt: string;
  readonly running: boolean;
  readonly exitCode?: number | null;
  readonly finishedAt?: string;
}

export interface SystemLog {
  readonly kind: SystemActionKind;
  readonly path: string;
  readonly lines: readonly string[];
  /** Нет — этот демон действия не запускал (или уже перезапущен). */
  readonly run?: SystemMaintenanceRun;
}

/** Без сети и без новых проб бэкендов: только диск, launchd и память демона. */
export async function fetchSystem(): Promise<SystemOverview> {
  return json<SystemOverview>(await fetch('/api/system'));
}

/** Единственный вызов экрана, который ходит в сеть; `refresh` обходит удержанное демоном. */
export async function fetchSystemUpdate(refresh?: boolean): Promise<SystemUpdate> {
  return json<SystemUpdate>(await fetch(`/api/system/update${refresh === true ? '?refresh=1' : ''}`));
}

/** `202`: процесс порождён; `409` и `400` приходят ошибкой с причиной демона. */
export async function startSystemUpdate(): Promise<{ readonly log: string }> {
  return json<{ readonly log: string }>(await fetch('/api/system/update', { method: 'POST' }));
}

export async function setSystemAutostart(enabled: boolean): Promise<{ readonly log: string }> {
  return json<{ readonly log: string }>(
    await fetch('/api/system/autostart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  );
}

export async function fetchSystemLog(kind: SystemActionKind): Promise<SystemLog> {
  return json<SystemLog>(await fetch(`/api/system/log?kind=${kind}`));
}

export interface LastScheduledRun {
  readonly runId: string;
  readonly moment: string;
  readonly catchup: boolean;
  readonly status?: string;
}

export interface ScheduleEntryView {
  readonly index: number;
  readonly cron?: string;
  readonly timezone?: string;
  /** Пояс не объявлен в записи — это пояс машины демона. */
  readonly defaultTimezone: boolean;
  readonly next?: string;
  readonly error?: string;
  readonly lastRun?: LastScheduledRun;
}

export interface SchedulePipelineView {
  readonly pipeline: string;
  readonly entries: readonly ScheduleEntryView[];
}

export interface SchedulePipelineError {
  readonly pipeline: string;
  readonly error: string;
  readonly errorFile?: string;
  readonly errorAt?: string;
  readonly errorHint?: string;
}

export interface ProjectScheduleView {
  readonly projectKey: string;
  readonly projectPath: string;
  readonly error?: string;
  readonly errorFile?: string;
  readonly errorAt?: string;
  readonly errorHint?: string;
  readonly pipelines: readonly SchedulePipelineView[];
  readonly pipelineErrors: readonly SchedulePipelineError[];
}

export type TriggerServiceView =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly enabled: boolean;
      readonly keepAwake: boolean;
      readonly requireNetwork: boolean;
      readonly maxCatchupHours: number;
    };

export interface ScheduleOverview {
  readonly projects: readonly ProjectScheduleView[];
  readonly service: TriggerServiceView;
  readonly generatedAt: string;
}

export async function fetchSchedule(): Promise<ScheduleOverview> {
  return json<ScheduleOverview>(await fetch('/api/schedule'));
}

/**
 * Правка выбора пользователя. Поле со значением `null` снимается; `selection:
 * null` снимает запись целиком. Выбор tier снимает `model` той же записи,
 * и наоборот — это делает демон.
 */
export interface PipelineAgentSelection {
  readonly agent?: string | null;
  readonly model?: string | null;
  readonly model_tier?: string | null;
  readonly effort?: string | null;
}

export interface PipelineAgentTarget {
  readonly pipeline: string;
  readonly job?: string;
  readonly step?: string;
}

/**
 * Записать выбор в глобальный файл. Ответ — заново раскрытые пайплайны, а не
 * эхо правки: запись могла проиграть документу, и показывать надо итог.
 */
export async function savePipelineAgent(
  target: PipelineAgentTarget,
  selection: PipelineAgentSelection | null,
): Promise<PipelinesOverview> {
  return json<PipelinesOverview>(
    await fetch('/api/pipelines/agents', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...target, selection }),
    }),
  );
}

/**
 * Прямой запрос очереди: типизированный клиент маршрута. Экран очереди его
 * не зовёт — живой поток (`live.ts`) присылает то же самое событием `backlog`
 * первым же кадром, и второй запрос дублировал бы уже пришедшее.
 */
export async function fetchBacklog(): Promise<BacklogOverview> {
  return json<BacklogOverview>(await fetch('/api/backlog'));
}

/**
 * Прямой запрос очереди предложений: запись несёт содержимое файла, и класть
 * его в поток обзора незачем (`ui-proposals`, Решение 15) — событие `proposals`
 * лишь будит экран перечитать этот маршрут.
 */
/** Ключ каталога поставки в адресе модуля виджета — сверено с `BUILTIN_WIDGETS_KEY` (`src/parts/ui/widgets.ts`). */
export const BUILTIN_WIDGETS_KEY = 'builtin';

/** Сверено с `BuiltinWidgetView` (`src/parts/ui/widgets.ts`). */
export interface BuiltinWidgetView {
  readonly id: string;
  readonly description: string;
  readonly version: string;
}

export async function fetchWidgetCatalog(): Promise<{ readonly widgets: readonly BuiltinWidgetView[] }> {
  return json(await fetch('/api/widgets/catalog'));
}

export async function installWidget(payload: {
  readonly projectKey: string;
  readonly id: string;
}): Promise<{ readonly installed: { readonly projectKey: string; readonly id: string; readonly file: string } }> {
  return json(
    await fetch('/api/widgets/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

export async function fetchProposals(): Promise<ProposalsOverview> {
  return json<ProposalsOverview>(await fetch('/api/proposals'));
}

/**
 * Решение по одной записи очереди (`ui-proposals`, «Витрина показывает
 * очередь дифом и решает запись двумя кнопками»): принятие пишет цель сама
 * демон, отклонение — переводит состояние, не трогая цель.
 */
export async function decideProposal(payload: {
  readonly project: string;
  readonly id: string;
  readonly decision: 'accept' | 'reject';
}): Promise<{ readonly ok: true; readonly record: ProposalRecord }> {
  return json(
    await fetch('/api/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

/** Без `days` — весь период наблюдений. */
export async function fetchUsage(days?: number): Promise<UsageResult> {
  const query = days === undefined ? '' : `?days=${days}`;
  return json<UsageResult>(await fetch(`/api/usage${query}`));
}

export async function fetchSettings(): Promise<Settings> {
  return json<Settings>(await fetch('/api/settings'));
}

/**
 * Списки моделей — отдельным запросом после настроек (design.md, решение 5):
 * пробы поднимают дочерние процессы демона и могут занять секунды на агента,
 * поэтому страница не должна ждать их ответа, чтобы отрисоваться.
 * `refresh: true` обходит удержанное демоном и перечисляет заново.
 */
export async function fetchModels(refresh?: boolean): Promise<ModelsResult> {
  const query = refresh === true ? '?refresh=1' : '';
  return json<ModelsResult>(await fetch(`/api/models${query}`));
}

/**
 * Записать дефолты. Ответ — уже перечитанные настройки, а не эхо правки:
 * значение могло лечь не так, как выглядела правка (снятая модель уходит к
 * умолчанию бэкенда), и показывать надо то, что теперь в файле.
 */
export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  return json<Settings>(
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

/**
 * Отбор прогонов к уборке по признаку. Ничего не удаляет: показывает, что
 * удалится и сколько места освободится, — удаление идёт отдельным запросом по
 * списку адресов, которые пользователь увидел здесь.
 */
export async function selectRuns(options: {
  readonly traits: readonly CleanupTrait[];
  readonly olderThan?: string;
  readonly project?: string;
}): Promise<RunSelection> {
  const query = new URLSearchParams();
  for (const trait of options.traits) query.append('trait', trait);
  if (options.olderThan !== undefined && options.olderThan !== '') {
    query.set('older-than', options.olderThan);
  }
  if (options.project !== undefined) query.set('project', options.project);
  return json<RunSelection>(await fetch(`/api/runs?${query.toString()}`));
}

/**
 * Отбор прогонов к уборке по явному списку адресов, увиденных пользователем
 * (флажки списка прогонов) — а не по признаку. Отдельная функция, а не общий
 * параметр с `selectRuns`: демон отклоняет запрос, называющий и то и другое
 * (design.md изменения ui-runs-list-controls, Решение 9), и заводить тип,
 * допускающий такое сочетание, значило бы переносить эту ошибку на выполнение
 * вместо того, чтобы её не пускать на уровне вызова.
 */
export async function selectRunsByAddresses(addresses: readonly string[]): Promise<RunSelection> {
  const query = new URLSearchParams();
  for (const address of addresses) query.append('run', address);
  return json<RunSelection>(await fetch(`/api/runs?${query.toString()}`));
}

/**
 * Удаление файлов прогона. `stats` не назван — умолчание демона «сохранить»
 * (design.md изменения run-stats-retention, Решение 10): снятие статистики
 * требует отдельного, явно вооружённого действия (Решение 11).
 */
export async function deleteRun(
  address: string,
  stats?: StatsDisposition,
): Promise<{ readonly removed: string; readonly stats: StatsOutcome }> {
  const query = stats === undefined ? '' : `&stats=${stats}`;
  return json(await fetch(`/api/run?run=${encodeURIComponent(address)}${query}`, { method: 'DELETE' }));
}

export async function deleteRuns(addresses: readonly string[], stats?: StatsDisposition): Promise<RemovalSummary> {
  return json<RemovalSummary>(
    await fetch('/api/runs', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runs: addresses, ...(stats === undefined ? {} : { stats }) }),
    }),
  );
}

/**
 * Отбор записей хранилища расхода к снятию — только отчёт, файлов прогонов
 * не касается. Те же признаки, что у `selectRuns`, кроме «оборванного»: он к
 * записи не применим (`selectUsageRecords` в `parts/pipeline/run/journal/usageStore.ts`).
 */
export async function selectUsageRecords(options: {
  readonly failed?: boolean;
  readonly olderThan?: string;
  readonly project?: string;
}): Promise<UsageRecordSelection> {
  const query = new URLSearchParams();
  if (options.failed === true) query.append('trait', 'failed');
  if (options.olderThan !== undefined && options.olderThan !== '') {
    query.set('older-than', options.olderThan);
  }
  if (options.project !== undefined) query.set('project', options.project);
  return json<UsageRecordSelection>(await fetch(`/api/usage-records?${query.toString()}`));
}

export async function deleteUsageRecords(addresses: readonly string[]): Promise<UsageRecordRemovalSummary> {
  return json<UsageRecordRemovalSummary>(
    await fetch('/api/usage-records', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ records: addresses }),
    }),
  );
}
