import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative } from 'node:path';

import { listPipelineEntries, type PipelineEntry } from '../pipeline/domain/project/pipelines.js';
import { listProjects } from '../pipeline/run/journal/reader.js';
import { expandPipeline } from '../pipeline/document/expand.js';
import { displayInputs } from '../pipeline/document/displayInputs.js';
import { isStepcastError, StepcastError } from '../../kernel/errors.js';
import { describeSource } from '../pipeline/config/merge.js';
import { resolveConfig, type Config, type ResolveOptions } from '../pipeline/config/resolve.js';
import { resolveWithPlugins, type ResolvedWithPlugins } from '../resolve.js';
import type { BuiltinRow, LoadOptions } from '../../kernel/load.js';
import type { Kernel } from '../../kernel/kernel.js';
import { kernelFromRegistry, registryFromKernel, type Registry } from '../../kernel/registry.js';
import type { TreeRow } from '../../kernel/tree/tree.js';
import type { AgentOrigin, EffortOrigin, Job, ModelOrigin, Pipeline, UnusedAgentEntry } from '../pipeline/document/model.js';
import type { AgentSelectionConfig } from '../pipeline/config/agentSelections.js';
import type { AgentPolicy } from '../pipeline/config/schema.js';
import { stepsMissingExternal } from '../pipeline/run/shadow.js';
import { hasStepExecutor } from '../pipeline/contract.js';
import { layoutJobs, type JobGraph } from './graph.js';
import { paramViews, type StepParamView } from './steps.js';
import { homeRoot } from '../../kernel/dirs.js';

/**
 * Пайплайны проектов, известных корню прогонов.
 *
 * «Загруженных» пайплайнов у демона нет и быть не может: пайплайн — это файл,
 * который передают команде `run`, а не запись в реестре. Поэтому список
 * собирается обходом корней проектов из `projects.json` — тех самых, чьи
 * прогоны витрина и показывает.
 *
 * Сам обход файлов живёт в `src/parts/pipeline/domain/project/pipelines.ts`: планировщик
 * расписания ищет те же файлы тем же правилом, и держать это правило в двух
 * местах значило бы дать им разойтись.
 */

/**
 * Слой, из которого пришла модель шага, — то же деление, что и
 * `ModelOrigin` раскрытия, но с именем файла на месте слоя `config`: витрина
 * уже держит на руках разрешение конфигурации показываемого проекта
 * (`provenance.get('defaults.model')`), и подписывать слой обязана она, а не
 * раскрытие — так провенанс не приходится тащить через `ExpandOptions`
 * (design.md, Решение 1).
 */
export type PipelineModelOrigin =
  | Exclude<ModelOrigin, { readonly layer: 'config' }>
  | { readonly layer: 'config'; readonly file: string };

/** Слой, из которого пришёл reasoning effort шага. */
export type PipelineEffortOrigin =
  | Exclude<EffortOrigin, { readonly layer: 'config' }>
  | { readonly layer: 'config'; readonly file: string };

/** Слой, из которого пришёл агент шага; у записей конфигурации — с файлом. */
export type PipelineAgentOrigin = AgentOrigin;

/** Поле записи выбора пользователя вместе с файлом, давшим его. */
export interface AgentEntryFieldView {
  readonly value: string;
  readonly file: string;
}

/**
 * Запись `pipeline_agents` либо `step_agents`, действующая для пайплайна или
 * шага. Отметка говорит, почему правка с экрана может ничего не менять:
 * запись проигрывает документу при действующей политике, в пайплайне нет
 * агентских шагов, которым она могла бы достаться, либо поле задано
 * проектным файлом, а экран пишет только глобальный.
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
  /** Агент шага: он и есть ответ на вопрос «чем это будет исполняться». */
  readonly agent?: string;
  /** Модель, которой шаг исполнится. Отсутствует у шага без модели ни на одном слое. */
  readonly model?: string;
  /** Слой, давший `model`, — только у агентских шагов. */
  readonly modelOrigin?: PipelineModelOrigin;
  /** Действующий reasoning effort и слой, который его дал. */
  readonly effort?: string;
  readonly effortOrigin?: PipelineEffortOrigin;
  /** Слой, давший агента, — только у агентских шагов. */
  readonly agentOrigin?: PipelineAgentOrigin;
  /** Запись `step_agents` этого шага, если она есть, и отметка, что она не действует. */
  readonly agentEntry?: AgentEntryView;
  readonly command?: string;
  /** Путь скрипта, объявленный в документе, — у шага script. */
  readonly scriptPath?: string;
  /** Имя раннера, которым скрипт исполнится, — только у разрешённого шага. */
  readonly scriptRunner?: string;
  /** Объявлен ли вход контракта (`input`) — сам вход в карточку не идёт: он может быть велик. */
  readonly hasScriptInput?: boolean;
  /** Путь объявленной схемы выхода — тем же полем, что и у `run`/`agent`, но у script означает проверку файла, а не разбор stdout. */
  readonly scriptOutputSchemaPath?: string;
  /**
   * Имя переиспользуемого шага и слой, из которого разрешён его манифест, —
   * у script, собранного из `uses`. Имя занимает место пути на карточке: путь
   * в чужой `node_modules` не говорит читателю ничего (design.md изменения
   * reusable-steps, решение 13).
   */
  readonly usesName?: string;
  readonly usesLayer?: 'project' | 'home' | 'builtin';
  /** Переданные параметры вызова — со сведёнными умолчаниями. */
  readonly usesParams?: Readonly<Record<string, unknown>>;
  /** Имя вида шага плагинного вида — оно же ключ шага в документе. */
  readonly pluginKindName?: string;
  /** Название вклада для витрины — из реестра, когда вид известен. */
  readonly pluginKindTitle?: string;
  /** Поля с подписями из схемы вклада (design.md, решение 11). */
  readonly pluginFields?: readonly StepParamView[];
  /** Вклад объявляет схему `output` — структурированный выход у шага есть. */
  readonly pluginHasOutput?: boolean;
  /**
   * Действующий реестр не знает этого вида (плагин снят, прогон читается без
   * него): поля берутся из замка как есть, а не из схемы, и причина названа —
   * не пустая карточка и не «неизвестно» (design.md, решение 11).
   */
  readonly pluginUnknownReason?: string;
}

export interface PipelineJobView {
  readonly id: string;
  readonly description?: string;
  readonly needs: readonly string[];
  readonly on: 'success' | 'failure' | 'always';
  readonly if?: string;
  readonly publishesOutput: boolean;
  /**
   * Ключ работы, под которым экран пишет `step_agents` её шагов. У дорожки это
   * работа до раскрытия (`implement`, а не `implement-a`): запись действует на
   * все копии. Исключение — уже существующая точная запись дорожки: она ближе
   * общей и действует, поэтому правится она, а не общая под ней.
   */
  readonly agentEntryJob: string;
  readonly steps: readonly PipelineStepView[];
}

export interface PipelineView {
  readonly projectKey: string;
  readonly projectPath: string;
  /**
   * Путь файла относительно корня проекта: он же адрес для `burnex run`. У
   * пайплайна пакета — адрес `<пакет>:<имя>` (`packages-directory-layer`): путь
   * пакета home лежит вне проекта, и запуск путём отказал бы как «путь наружу».
   */
  readonly file: string;
  /** Пакет, давший пайплайн, и его слой — только у пайплайна пакета. */
  readonly package?: string;
  readonly packageLayer?: 'project' | 'home';
  readonly name: string;
  readonly concurrency?: number;
  readonly failFast?: boolean;
  readonly jobs: readonly PipelineJobView[];
  /** Действующая политика выбора агента и файл, давший её (встроенное умолчание — тоже источник). */
  readonly agentPolicy?: AgentPolicy;
  readonly agentPolicyFile?: string;
  /** Запись `pipeline_agents` этого пайплайна, если она есть. */
  readonly agentEntry?: AgentEntryView;
  /**
   * Имя, под которым экран читает и пишет записи выбора, — `name` документа.
   * У пайплайна без `name` отсутствует: записи такой пайплайн не читает, и
   * выбор с экрана ему не предлагается, а не сохраняется впустую.
   */
  readonly agentEntryName?: string;
  /**
   * Имена объявленных входов пайплайна (`inputs`), в порядке объявления.
   *
   * Нужны доске: она запускает пайплайн «для этой работы» и обязана знать, кому
   * слаг пункта вообще есть куда передать. Пайплайн без входа `item` в диалоге
   * выбора не предлагается — запуск, который молча потерял бы выбранный пункт,
   * хуже отсутствия кнопки.
   *
   * Значения не публикуются намеренно: умолчание входа — часть документа
   * пайплайна, а не состояние, за которым витрине стоит следить.
   */
  readonly inputs: readonly string[];
  /**
   * Имена верхнеуровневого `env:` — то, что форма запуска может переопределить
   * (`run --env`). Только имена: значения могут нести `${secrets.*}`, и витрине
   * они не нужны.
   */
  readonly envNames: readonly string[];
  /**
   * Готовность к shadow-режиму: у каждого шага встроенного вида объявлен
   * `external`. Тот же перечень шагов, что в отказе `run --shadow`, — форма
   * показывает его до запуска, потому что отказ дочернего процесса после 202
   * витрина не видит. У пайплайна, который не разбирается, готовности нет.
   */
  readonly shadow: { readonly ready: true } | { readonly ready: false; readonly steps: readonly string[] };
  readonly graph?: JobGraph;
  /**
   * Пайплайн не разбирается. Как и нечитаемый прогон в обзоре, он остаётся
   * видимым с объяснением: молча пропущенный файл выглядел бы как его
   * отсутствие, а это разные вещи.
   *
   * Место ошибки и подсказка идут соседними полями, а не приклеены к тексту:
   * склеенную строку экран не может ни выделить, ни показать иначе, чем
   * прочий текст, — а карточка заводится именно ради объяснения. Поля
   * плоские, потому что `error` склейка прогонов (`src/parts/ui/grouping.ts`)
   * читает как признак «файл не разбирается».
   */
  readonly error?: string;
  /**
   * Файл, к которому относится ошибка, относительно корня проекта. Он не
   * всегда совпадает с файлом пайплайна: ошибка приходит и из файла работы,
   * подключённой по `uses`.
   *
   * Файл вне корня проекта — глобальный `~/.burnex/config.yml`, объявивший
   * плагин, — назван абсолютным путём: он и не принадлежит проекту, а цепочка
   * `../../..` от его корня не отвечает на вопрос «какой файл править».
   * Абсолютным именем тот же экран уже называет файл слоя `config` на
   * карточке шага.
   */
  readonly errorFile?: string;
  /** Место ошибки внутри документа, например `jobs.propose-a`. */
  readonly errorAt?: string;
  /** Что делать пользователю — та же подсказка, что печатает CLI. */
  readonly errorHint?: string;
}

export interface PipelinesOverview {
  readonly pipelines: readonly PipelineView[];
  readonly generatedAt: string;
}

/**
 * Слой раскрытия в форму витрины: слой `config` получает файл, победивший в
 * этом проекте.
 *
 * Оба отсутствия здесь — не граничный случай показа, а расхождение внутри
 * демона: раскрытие заводит запись каждому агентскому шагу, а слой `config`
 * означает, что `defaults.model` кем-то задан, — значит, у провенанса есть
 * источник. Подставить на этом месте «модель не задана» значило бы показать
 * противоречивую пару: значение модели рядом со словами о её отсутствии.
 * Поэтому пайплайн уходит в карточку с объяснением — тем же путём, каким
 * показывается любой неразобранный.
 */
function toModelOriginView(
  origin: ModelOrigin | undefined,
  modelConfigFile: string | undefined,
  at: string,
): PipelineModelOrigin {
  const hint = 'This is an inconsistency inside the daemon: restart `burnex up` and report it';
  if (origin === undefined) {
    throw new StepcastError('Resolution did not name the layer that supplied the step model', { at, hint });
  }
  if (origin.layer !== 'config') return origin;
  if (modelConfigFile === undefined) {
    throw new StepcastError('The step model came from settings, but the file that set it is unknown', {
      at,
      hint,
    });
  }
  return { layer: 'config', file: modelConfigFile };
}

function toEffortOriginView(
  origin: EffortOrigin | undefined,
  effortConfigFile: string | undefined,
  at: string,
): PipelineEffortOrigin {
  const hint = 'This is an inconsistency inside the daemon: restart `burnex up` and report it';
  if (origin === undefined) {
    throw new StepcastError('Resolution did not name the layer that supplied the step effort', { at, hint });
  }
  if (origin.layer !== 'config') return origin;
  if (effortConfigFile === undefined) {
    throw new StepcastError('The step effort came from settings, but the file that set it is unknown', { at, hint });
  }
  return { layer: 'config', file: effortConfigFile };
}

/** Всё, что нужно собрать карточку пайплайна из раскрытия и конфигурации проекта. */
interface ViewContext {
  readonly modelOrigins: ReadonlyMap<string, ModelOrigin>;
  readonly modelConfigFile: string | undefined;
  readonly effortOrigins: ReadonlyMap<string, EffortOrigin>;
  readonly effortConfigFile: string | undefined;
  readonly agentOrigins: ReadonlyMap<string, AgentOrigin>;
  readonly unusedAgentEntries: readonly UnusedAgentEntry[];
  /** Имя записей выбора — `name` документа; у безымянного пайплайна отсутствует. */
  readonly agentEntryName: string | undefined;
  readonly config: Config;
  /** Файл политики: у встроенного умолчания — его описание. */
  readonly agentPolicyFile: string;
  readonly registry: Registry;
}

/**
 * Запись выбора как её видит карточка. `unused` — почему запись не дала шагу
 * ни одного значения (агент, модель, effort): проиграла документу или ей
 * некому достаться; в обоих случаях правка с экрана ничего не изменит.
 */
function toEntryView(
  key: string,
  entry: AgentSelectionConfig | undefined,
  unused: 'loses_to_document' | 'no_agent_steps' | undefined,
  globalConfigFile: string,
): AgentEntryView | undefined {
  if (entry === undefined) return undefined;
  const fields = [entry.agent, entry.model, entry.modelTier, entry.effort];
  const fromProject = fields.some((field) => field !== undefined && field.file !== globalConfigFile);
  return {
    key,
    ...(entry.agent === undefined ? {} : { agent: entry.agent }),
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.modelTier === undefined ? {} : { modelTier: entry.modelTier }),
    ...(entry.effort === undefined ? {} : { effort: entry.effort }),
    ...(unused !== undefined ? { mark: unused } : fromProject ? { mark: 'shadowed_by_project' as const } : {}),
  };
}

/** Работа документа до раскрытия дорожек: `implement-a` дорожки `a` — это `implement`. */
function laneBaseOf(jobId: string, lane: string | undefined): string | undefined {
  return lane !== undefined && lane !== '' && jobId.endsWith(`-${lane}`) ? jobId.slice(0, -(lane.length + 1)) : undefined;
}

/**
 * Ключ работы в `step_agents` для записи с экрана — тем же правилом, что и у
 * раскрытия (`findJobEntryKey`): если точная запись дорожки есть, раскрытие
 * читает только её, и правка идёт туда же; иначе — работа до раскрытия дорожек.
 */
function entryJobOf(config: Config, pipelineName: string | undefined, job: Job): string {
  const base = laneBaseOf(job.id, job.lane);
  if (base === undefined) return job.id;
  const jobs = pipelineName !== undefined && Object.hasOwn(config.stepAgents, pipelineName) ? config.stepAgents[pipelineName] : undefined;
  return jobs !== undefined && Object.hasOwn(jobs, job.id) ? job.id : base;
}

function stepEntryOf(config: Config, pipelineName: string, jobId: string, stepId: string, lane: string | undefined): { key: string; entry: AgentSelectionConfig } | undefined {
  const jobs = Object.hasOwn(config.stepAgents, pipelineName) ? config.stepAgents[pipelineName] : undefined;
  if (jobs === undefined) return undefined;
  const base = laneBaseOf(jobId, lane);
  const jobKey = Object.hasOwn(jobs, jobId) ? jobId : base !== undefined && Object.hasOwn(jobs, base) ? base : undefined;
  const entry = jobKey === undefined ? undefined : jobs[jobKey]?.[stepId];
  return jobKey === undefined || entry === undefined ? undefined : { key: `step_agents.${pipelineName}.${jobKey}.${stepId}`, entry };
}

function toJobView(job: Job, pipelineName: string | undefined, ctx: ViewContext): PipelineJobView {
  const globalFile = ctx.config.globalConfigFile;
  return {
    id: job.id,
    ...(job.description === undefined ? {} : { description: job.description }),
    needs: job.needs === 'all' ? ['all'] : job.needs,
    on: job.on,
    ...(job.if === undefined ? {} : { if: job.if }),
    publishesOutput: job.output !== undefined,
    agentEntryJob: entryJobOf(ctx.config, pipelineName, job),
    steps: job.steps.map((step) => {
      const at = `jobs.${job.id}.steps.${step.id}`;
      const key = `${job.id}/${step.id}`;
      const agentOrigin = step.kind === 'agent' ? ctx.agentOrigins.get(key) : undefined;
      const modelOrigin = step.kind === 'agent' ? toModelOriginView(ctx.modelOrigins.get(key), ctx.modelConfigFile, at) : undefined;
      const effortOrigin = step.kind === 'agent' ? toEffortOriginView(ctx.effortOrigins.get(key), ctx.effortConfigFile, at) : undefined;
      const found = step.kind === 'agent' && pipelineName !== undefined ? stepEntryOf(ctx.config, pipelineName, job.id, step.id, job.lane) : undefined;
      const wins = (layer: 'step_agents'): boolean =>
        agentOrigin?.layer === layer ||
        modelOrigin?.layer === layer ||
        (modelOrigin?.layer === 'tier' && modelOrigin.tierLayer === layer) ||
        effortOrigin?.layer === layer ||
        (effortOrigin?.layer === 'tier' && effortOrigin.tierLayer === layer);
      const agentEntry = found === undefined ? undefined : toEntryView(found.key, found.entry, wins('step_agents') ? undefined : 'loses_to_document', globalFile);
      return {
        id: step.id,
        kind: step.kind,
        ...(step.kind === 'agent' ? { agent: step.agent } : {}),
        ...(step.kind === 'agent' && step.model !== undefined ? { model: step.model } : {}),
        ...(step.kind === 'agent' && step.effort !== undefined ? { effort: step.effort } : {}),
        ...(modelOrigin === undefined ? {} : { modelOrigin }),
        ...(effortOrigin === undefined ? {} : { effortOrigin }),
        ...(agentOrigin === undefined ? {} : { agentOrigin }),
        ...(agentEntry === undefined ? {} : { agentEntry }),
        ...(step.kind === 'run'
          ? { command: Array.isArray(step.command) ? step.command.join(' ') : String(step.command) }
          : {}),
        ...(step.kind === 'script' ? { scriptPath: step.path } : {}),
        ...(step.kind === 'script' && step.resolved !== undefined
          ? { scriptRunner: step.resolved.runner }
          : {}),
        ...(step.kind === 'script' ? { hasScriptInput: step.input !== undefined } : {}),
        ...(step.kind === 'script' && step.outputSchemaPath !== undefined
          ? { scriptOutputSchemaPath: step.outputSchemaPath }
          : {}),
        ...(step.kind === 'script' && step.uses !== undefined ? { usesName: step.uses.name } : {}),
        ...(step.kind === 'script' && step.uses?.layer !== undefined ? { usesLayer: step.uses.layer } : {}),
        ...(step.kind === 'script' && step.uses?.params !== undefined ? { usesParams: step.uses.params } : {}),
        ...(step.kind === 'plugin' ? pluginStepView(step, ctx.registry) : {}),
      };
    }),
  };
}

/**
 * Карточка шага плагинного вида — из действующего реестра (design.md, решение
 * 11): название вклада, поля с подписями из схемы (`ui/steps.ts:paramViews`,
 * тот же вывод, каким строятся параметры манифеста переиспользуемого шага),
 * признак структурированного выхода. Вид, которого реестр не знает (плагин
 * снят), показывается именем вида и полями из замка — с названной причиной, а
 * не пустой карточкой.
 */
function pluginStepView(
  step: Extract<Job['steps'][number], { kind: 'plugin' }>,
  registry: Registry,
): Pick<
  PipelineStepView,
  'pluginKindName' | 'pluginKindTitle' | 'pluginFields' | 'pluginHasOutput' | 'pluginUnknownReason'
> {
  const contribution = registry.steps.get(step.name);
  if (contribution === undefined || !hasStepExecutor(contribution)) {
    return {
      pluginKindName: step.name,
      pluginUnknownReason: `step kind ${step.name} is unknown to the active registry`,
    };
  }
  return {
    pluginKindName: step.name,
    pluginKindTitle: contribution.title,
    pluginFields: paramViews(contribution.fields as Record<string, unknown>),
    pluginHasOutput: contribution.output !== undefined,
  };
}

function toView(
  projectKey: string,
  projectPath: string,
  file: string,
  pipeline: Pipeline,
  ctx: ViewContext,
): PipelineView {
  const name = ctx.agentEntryName;
  const jobs = pipeline.jobs.map((job) => toJobView(job, name, ctx));
  // Запись пайплайна не действует, если раскрытие назвало её среди записей без
  // действия: на уровне пайплайна «хотя бы на одном шаге» — единственный честный
  // счёт. Причина различает «проиграла документу» и «шагов, которым она могла бы
  // достаться, нет»: та же, что печатает `burnex config --pipeline`.
  const pipelineKey = `pipeline_agents.${name ?? ''}`;
  const unused = ctx.unusedAgentEntries.find((entry) => entry.key === pipelineKey);
  const pipelineEntry = name !== undefined && Object.hasOwn(ctx.config.pipelineAgents, name)
    ? toEntryView(
        pipelineKey,
        ctx.config.pipelineAgents[name],
        unused === undefined ? undefined : unused.reason.kind === 'no_agent_steps' ? 'no_agent_steps' : 'loses_to_document',
        ctx.config.globalConfigFile,
      )
    : undefined;
  return {
    projectKey,
    projectPath,
    file,
    name: pipeline.name,
    concurrency: pipeline.concurrency,
    failFast: pipeline.failFast,
    jobs,
    agentPolicy: ctx.config.agentPolicy,
    agentPolicyFile: ctx.agentPolicyFile,
    ...(pipelineEntry === undefined ? {} : { agentEntry: pipelineEntry }),
    ...(name === undefined ? {} : { agentEntryName: name }),
    // Ключи раскрытых входов — это и есть объявленные имена: раскрытие
    // подставляет умолчания объявленным и ничего не добавляет от себя.
    inputs: Object.keys(pipeline.inputs),
    envNames: Object.keys(pipeline.env),
    shadow: shadowReadiness(pipeline),
    graph: layoutJobs(
      jobs.map((job) => ({
        id: job.id,
        needs: job.needs,
        on: job.on,
        ...(job.if === undefined ? {} : { if: job.if }),
      })),
    ),
  };
}

function shadowReadiness(pipeline: Pick<Pipeline, 'jobs'>): PipelineView['shadow'] {
  const steps = stepsMissingExternal(pipeline);
  return steps.length === 0 ? { ready: true } : { ready: false, steps };
}

/** Отказ разбора в полях карточки: место и подсказка — половина объяснения. */
export interface Failure {
  readonly error: string;
  readonly errorFile?: string;
  readonly errorAt?: string;
  readonly errorHint?: string;
}

/**
 * Имя файла ошибки для карточки: внутри проекта — путь от его корня, в том же
 * виде, что `PipelineView.file` (абсолютный путь машины демона на экране
 * проекта ничего не добавляет); вне проекта — сам абсолютный путь.
 *
 * Вне корня проекта файл оказывается не по недосмотру: плагин вправе быть
 * объявлен глобальным `~/.burnex/config.yml`, и его отказ показывается
 * карточками проекта. Относительное имя вышло бы цепочкой `../../..` до
 * домашнего каталога — путём, который ни на что не указывает и вдобавок врёт
 * про принадлежность файла проекту.
 */
function errorFileName(projectPath: string, file: string): string {
  const inside = relative(projectPath, file).replace(/\\/g, '/');
  return inside === '..' || inside.startsWith('../') ? file : inside;
}

/**
 * Место ошибки и подсказка доезжают до экрана наравне с текстом: CLI печатает
 * их отдельными строками, и витрина, показывая один только `message`,
 * оставляла бы пользователя без ответа на вопрос «где именно».
 */
export function toFailure(error: unknown, projectPath: string): Failure {
  if (!isStepcastError(error)) return { error: (error as Error).message };
  const file = error.file === undefined ? undefined : errorFileName(projectPath, error.file);
  return {
    error: error.message,
    ...(file === undefined || file === '' ? {} : { errorFile: file }),
    ...(error.at === undefined ? {} : { errorAt: error.at }),
    ...(error.hint === undefined ? {} : { errorHint: error.hint }),
  };
}

/** Карточка с объяснением вместо устройства: имя берётся из файла, раскрытие до `name` не дошло. */
function errorView(
  projectKey: string,
  projectPath: string,
  file: string,
  failure: Failure,
  origin: PackageOrigin = {},
): PipelineView {
  return { projectKey, projectPath, file, ...origin, name: file, jobs: [], inputs: [], envNames: [], shadow: { ready: false, steps: [] }, ...failure };
}

/** Пакет и слой пайплайна пакета — то, что карточка несёт рядом с адресом. */
type PackageOrigin = { readonly package?: string; readonly packageLayer?: 'project' | 'home' };

export function originOf(entry: PipelineEntry): PackageOrigin {
  return entry.package === undefined || entry.packageLayer === undefined
    ? {}
    : { package: entry.package, packageLayer: entry.packageLayer };
}

function readPipeline(
  projectKey: string,
  projectPath: string,
  entry: PipelineEntry,
  config: Config,
  registry: Registry,
  files: Pick<ProjectOverrides, 'modelConfigFile' | 'effortConfigFile' | 'agentPolicyFile'>,
): PipelineView {
  const absolute = entry.path;
  const file = entry.address ?? relative(projectPath, absolute).replace(/\\/g, '/');
  try {
    const { pipeline, modelOrigins, effortOrigins, agentOrigins, unusedAgentEntries, agentEntryName } = expandPipeline({
      pipelinePath: absolute,
      config,
      registry,
      inputs: displayInputs(absolute),
      // Пайплайн пакета работает с проектом, в котором его показывают: слои
      // шагов и скриптов ищутся от корня проекта, а не от каталога пакета.
      ...(entry.address === undefined ? {} : { projectRoot: projectPath }),
    });
    const view = toView(projectKey, projectPath, file, pipeline, {
      modelOrigins,
      modelConfigFile: files.modelConfigFile,
      effortOrigins,
      effortConfigFile: files.effortConfigFile,
      agentOrigins,
      unusedAgentEntries,
      agentEntryName,
      config,
      agentPolicyFile: files.agentPolicyFile,
      registry,
    });
    return { ...view, ...originOf(entry) };
  } catch (error) {
    return errorView(projectKey, projectPath, file, toFailure(error, projectPath), originOf(entry));
  }
}

/** `project`, `defaults`, `backends` и реестр вкладов того репозитория, чей пайплайн раскрывается. */
export interface ProjectOverrides {
  readonly project: Config['project'];
  readonly defaults: Config['defaults'];
  readonly backends: Config['backends'];
  /** Файл, победивший в `defaults.model` этого проекта — для слоя `config` на карточке шага. */
  readonly modelConfigFile: string | undefined;
  /** Файл, победивший в `defaults.effort` этого проекта. */
  readonly effortConfigFile: string | undefined;
  /** Политика выбора агента проекта и файл, давший её. */
  readonly agentPolicy: Config['agentPolicy'];
  readonly agentPolicyFile: string;
  readonly pipelineAgents: Config['pipelineAgents'];
  readonly stepAgents: Config['stepAgents'];
  /** Глобальный конфиг, прочитанный от домашнего каталога вызова: рядом с ним лежат пакеты home. */
  readonly globalConfigDir: Config['globalConfigDir'];
  readonly globalConfigFile: Config['globalConfigFile'];
  /**
   * Реестр вкладов этого проекта: без него плагинный предикат отклоняется
   * разбором как неизвестный ключ, а умолчание плагинного бэкенда не доезжает
   * до модели шага (design.md, Решение 2).
   */
  readonly registry: Registry;
}

/**
 * Слой-источник строки совпал: тот же вид, и для файла — тот же путь, для
 * каталога (`user-plugins`) — тот же каталог и тот же слой. Строка,
 * переехавшая между слоями (домашний каталог заменён проектным с тем же
 * `id`), несёт разный `layer` и потому строкой той же не считается.
 */
function sourceEqual(a: TreeRow['source'], b: TreeRow['source']): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'file') return b.kind === 'file' && a.path === b.path;
  if (a.kind === 'directory') {
    return b.kind === 'directory' && a.dir === b.dir && a.layer === b.layer && a.package === b.package;
  }
  return true;
}

/**
 * Дерево плагинов совпало: тот же `id`, тот же модуль, тот же признак
 * включённости, тот же слой-источник, в том же порядке (`plugin-tree`,
 * design.md, Решение 10).
 *
 * Слой-источник входит в сравнение наравне с модулем: относительный `use`
 * разрешается от файла, объявившего строку (`resolveModulePath`), и строка,
 * перекочевавшая с тем же `./x.mjs` из домашнего патча в проектный, называет
 * уже другой файл на диске. Ядро, удержанное по «равному» дереву, держало бы
 * модуль прежнего каталога (`ui-daemon`: правка любого файла, участвующего в
 * сборке дерева, действует со следующего запроса).
 */
export function treeEqual(a: readonly TreeRow[], b: readonly TreeRow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      row.id === other.id &&
      row.use === other.use &&
      row.enabled === other.enabled &&
      sourceEqual(row.source, other.source)
    );
  });
}

export interface KernelCacheEntry {
  readonly tree: readonly TreeRow[];
  readonly kernel: Kernel;
}

/**
 * Ядра, поднятые по корню проекта, — переживают отдельный запрос (design.md,
 * Решение 3 и 6). Ключ — сам корень проекта; совпадение записи проверяется
 * деревом плагинов проекта (`id`, модуль, включённость, порядок —
 * `plugin-tree`), а не временем правки файлов конфигурации: правка соседнего
 * ключа не обязана сбрасывать ядро, а два разных содержимого с одной меткой
 * времени неразличимы.
 *
 * Отдельный корневой контекст на проект, а не форк общего корня: сервис,
 * заведённый плагином одного проекта, не виден другому и не конфликтует с
 * одноимённым — хранилище сервисов cordis принадлежит корню, а не области
 * (design.md, Решение 6).
 *
 * Не модульный синглтон: тесты поднимают несколько демонов в одном процессе,
 * и общий кеш связал бы их между собой. Экземпляр создаёт `createUiServer` и
 * передаёт `buildPipelines` опцией.
 *
 * Владение считается не по кешу, а по ядру: `raised` — ядра, поднятые именно
 * этим доступом к кешу. Сервер, получивший кеш снаружи, берёт к нему
 * собственный доступ (`shareKernelCache`) и при закрытии снимает ровно то, что
 * поднял сам, — записи, положенные хозяином кеша, остаются действующими. Кеш,
 * общий на два сервера, иначе оставлял бы текущими контексты, которых уже никто
 * не спросит (design.md, Решение 6, ui-daemon spec).
 */
export interface KernelCache {
  /** Записи по ключу — общие у всех, кто делит этот кеш. */
  readonly entries: Map<string, KernelCacheEntry>;
  /** Ядра, поднятые через этот доступ, — их и снимает его владелец. */
  readonly raised: Set<Kernel>;
  /** Журнал демона: отказ снятия записывается, а не валит процесс. */
  readonly log?: ((line: string) => void) | undefined;
}

export function createKernelCache(log?: (line: string) => void): KernelCache {
  return { entries: new Map(), raised: new Set(), log };
}

/** Доступ к чужому кешу: те же записи, свой счёт поднятого. */
export function shareKernelCache(cache: KernelCache, log?: (line: string) => void): KernelCache {
  return { entries: cache.entries, raised: new Set(), log: log ?? cache.log };
}

/**
 * Снять ядра, поднятые через этот доступ. Снятое ядро выбывает и из перечня
 * поднятого: повторный вызов — не двойное снятие.
 */
export async function disposeRaisedKernels(cache: KernelCache): Promise<void> {
  const raised = [...cache.raised];
  cache.raised.clear();
  await Promise.all(raised.map((kernel) => disposeKernel(kernel, cache)));
}

/**
 * Снятие ядра в демоне: отказ disposer'а какого-нибудь плагина — строка в
 * журнале, а не необработанное отклонение промиса, валящее долгоживущий
 * процесс.
 */
async function disposeKernel(kernel: Kernel, cache: KernelCache): Promise<void> {
  try {
    await kernel.dispose();
  } catch (error) {
    cache.log?.(`не удалось снять контекст плагинов: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Разрешить конфигурацию с плагинами, взяв ядро из кеша либо подняв заново,
 * если дерево плагинов разошлось с закешированным, — общий приём для реестра
 * каждого проекта (`projectSection`) и для собственного ядра демона
 * (`src/parts/ui/settings.ts`, `src/parts/ui/models.ts`, design.md Решение 6): ключ кеша
 * там — не корень проекта, а домашний каталог, но правило то же самое. Правка
 * `plugins.patch.yml` действует тем же путём, что и правка `plugins:` раньше
 * (`plugin-tree`, ui-daemon): дерево строится заново на каждый обход,
 * расхождение с закешированным снимает прежнее ядро и поднимает новое.
 *
 * Отдельное разрешение перед основным нужно ровно для одного: сверить ключ
 * кеша с записью, которая уже есть. Записи нет — сверять не с чем, и лишнего
 * чтения слоёв не делается: промах всё равно ведёт к полной сборке.
 *
 * `builtinRows` — строки поставки витрины (`ui-shell` и по строке на экран,
 * `src/parts/ui/rows.ts`): доезжают до обоих проходов разрешения — их `id`
 * встают в семя встроенного слоя (`ResolveOptions.builtinRows`), их фабрики
 * ищет загрузчик (`LoadOptions.builtinRows`) — и входят в ключ пригодности
 * удержанного ядра наравне с деревом, потому что сам список строк поставки
 * определяет форму встроенного слоя дерева, которое сравнивает `treeEqual`
 * (design.md, Решение 2, 6). Собственное ядро демона (`src/parts/ui/daemon/kernel.ts`)
 * передаёт их; `projectSection` — нет: строки витрины не должны появиться в
 * дереве, по которому раскрывается пайплайн проекта.
 *
 * `onDirectoryRow` (`LoadOptions`, design.md изменения `hot-swap-preserves-data`,
 * Решение 1) доходит до `loadPlugins` только тогда, когда дерево разошлось с
 * закешированным и сборка идёт заново: попадание в кеш ядра (дерево совпало)
 * `loadPlugins` не зовёт вовсе, и вклад вызывающего в этом случае не звучит —
 * `currentDaemonKernel` переживает это тем же приёмом, что и `outcomes`
 * (держит прежний собранный состав, а не считает его пустым).
 */
export async function resolveWithCachedKernel(
  key: string,
  options: ResolveOptions,
  projectRoot: string,
  cache: KernelCache | undefined,
  builtinRows: readonly BuiltinRow[] = [],
  onDirectoryRow?: LoadOptions['onDirectoryRow'],
): Promise<ResolvedWithPlugins> {
  const resolveOptions: ResolveOptions =
    builtinRows.length === 0 ? options : { ...options, builtinRows: builtinRows.map((row) => row.id) };
  const cached = cache?.entries.get(key);
  const tree = cached === undefined ? undefined : resolveConfig(resolveOptions).pluginTree;
  const cachedRegistry =
    cached !== undefined && tree !== undefined && treeEqual(cached.tree, tree)
      ? registryFromKernel(cached.kernel)
      : undefined;

  const result = await resolveWithPlugins(
    resolveOptions,
    cachedRegistry === undefined
      ? { projectRoot, builtinRows, ...(onDirectoryRow === undefined ? {} : { onDirectoryRow }) }
      : { projectRoot, registry: cachedRegistry },
  );

  // Кешируется только успешно собранный реестр: если строка выше не бросила,
  // отказа загрузки не было. Совпавшая запись не перезаписывается — иначе
  // объект реестра на каждый запрос был бы новым, хотя и с тем же содержимым.
  if (cachedRegistry === undefined && cache !== undefined) {
    // Дерево разошлось — или записи не было вовсе. Прежнее ядро, если оно
    // было, осталось не у дел: снимаем его сразу, а не откладываем до
    // `close()`, иначе оно текло бы всё время жизни демона (design.md, Риск 4).
    // Снимается оно независимо от того, кто его поднял: из кеша запись ушла, и
    // дотянуться до неё больше некому.
    if (cached !== undefined) {
      cache.raised.delete(cached.kernel);
      void disposeKernel(cached.kernel, cache);
    }
    const kernel = kernelFromRegistry(result.registry);
    cache.raised.add(kernel);
    cache.entries.set(key, {
      tree: tree ?? result.resolved.pluginTree,
      kernel,
    });
  }

  return result;
}

/**
 * `project`, `defaults`, `backends` и реестр вкладов того репозитория, чей
 * пайплайн раскрывается.
 *
 * Витрина смотрит на все проекты корня прогонов сразу, а конфигурация у неё
 * одна — резолвнутая по каталогу, из которого подняли `burnex up`. Раньше
 * подмена ограничивалась секцией `project`: `defaults.model` и `backends`
 * влияли только на то, чем шаг исполнится, а не на то, разбирается ли
 * документ, — и разбор оставался верным при чужих умолчаниях. Теперь карточка
 * шага показывает эффективную модель, и то же самое `defaults.model`
 * демонского каталога стало значением, которое видит пользователь: проект со
 * своим `.burnex/config.yml` обязан быть раскрыт своими умолчаниями, а не
 * чужими. Подмена не расширяется до конфигурации целиком: `runs.root`,
 * `ui.port` и `limits` не влияют на показ пайплайна, а витрина уже работает в
 * корне прогонов и с потолками, выбранными при старте демона (design.md,
 * Решение 2).
 *
 * Реестр берётся из `resolveWithPlugins`, а не из `loadPlugins` поверх уже
 * разрешённой конфигурации: умолчания плагинных бэкендов приносит именно
 * второй проход разрешения, и без него карточка шага показала бы верный
 * разбор документа, но неверную модель (design.md, Решение 2).
 * `builtinCommands` не передаётся: вклады команд витрине не нужны, их
 * диспетчеризует CLI.
 */
export async function projectSection(
  projectPath: string,
  home: string | undefined,
  kernelCache: KernelCache | undefined,
): Promise<ProjectOverrides> {
  const options = { cwd: projectPath, ...(home === undefined ? {} : { home }) };
  const { resolved, registry } = await resolveWithCachedKernel(projectPath, options, projectPath, kernelCache);

  const modelSource = resolved.provenance.get('defaults.model');
  const effortSource = resolved.provenance.get('defaults.effort');
  return {
    project: resolved.config.project,
    defaults: resolved.config.defaults,
    backends: resolved.config.backends,
    modelConfigFile: modelSource === undefined ? undefined : describeSource(modelSource),
    effortConfigFile: effortSource === undefined ? undefined : describeSource(effortSource),
    agentPolicy: resolved.config.agentPolicy,
    agentPolicyFile: describeSource(resolved.provenance.get('agent_policy') ?? { kind: 'builtin' }),
    globalConfigDir: resolved.config.globalConfigDir,
    globalConfigFile: resolved.config.globalConfigFile,
    pipelineAgents: resolved.config.pipelineAgents,
    stepAgents: resolved.config.stepAgents,
    registry,
  };
}

/**
 * Конфигурация демона, подменённая секциями проекта. Глобальный конфиг проекта
 * — тот, что прочитан от `home`: от него `expandPipeline` строит слой пакетов
 * home, и он обязан совпасть с каталогом, из которого перечень пайплайнов взял
 * пайплайны пакетов home. Общая для «Pipelines» и «Secrets»: экран секретов
 * раскрывает пайплайны той же конфигурацией, иначе его статусы разошлись бы с
 * карточками.
 */
export function withProjectSection(config: Config, overrides: ProjectOverrides): Config {
  return {
    ...config,
    project: overrides.project,
    defaults: overrides.defaults,
    backends: overrides.backends,
    agentPolicy: overrides.agentPolicy,
    pipelineAgents: overrides.pipelineAgents,
    stepAgents: overrides.stepAgents,
    globalConfigDir: overrides.globalConfigDir,
    globalConfigFile: overrides.globalConfigFile,
  };
}

export interface BuildPipelinesOptions {
  /** Домашний каталог: из него читается глобальный слой конфигурации проекта. */
  readonly home?: string;
  readonly now?: Date;
  /**
   * Ядра по корню проекта, живущие дольше одного вызова. Без него —
   * например, в прямых вызовах тестов — каждый обход поднимает ядро заново,
   * как и раньше.
   */
  readonly kernelCache?: KernelCache;
}

export async function buildPipelines(
  runsRoot: string,
  config: Config,
  options: BuildPipelinesOptions = {},
): Promise<PipelinesOverview> {
  const pipelines: PipelineView[] = [];

  // Проекты обходятся последовательно, а не `Promise.all`: параллельный
  // импорт чужого кода плагинов не выигрывает после первого запроса (реестр
  // кешируется) и стоит недетерминированного порядка карточек (design.md,
  // Решение 5). Событийный цикл при этом не блокируется — обработчик
  // `/api/pipelines` асинхронен.
  for (const project of listProjects(runsRoot)) {
    // Проект, чей путь неизвестен, обходить негде: в указателе его нет.
    if (project.path === undefined || !existsSync(project.path)) continue;
    const entries = listPipelineEntries(project.path, {
      globalConfigDir: homeRoot(options.home ?? homedir()),
    });
    if (entries.length === 0) continue;

    // Нечитаемая конфигурация и отказ загрузки плагина показываются одной
    // веткой: с объяснением. Молча раскрыть проект чужой конфигурацией или
    // пропустить плагин значило бы показать устройство, которого у прогона в
    // этом проекте не будет.
    let forProject: Config | undefined;
    let registry: Registry | undefined;
    let modelConfigFile: string | undefined;
    let effortConfigFile: string | undefined;
    let agentPolicyFile = '';
    let failure: Failure | undefined;
    try {
      const overrides = await projectSection(project.path, options.home, options.kernelCache);
      forProject = withProjectSection(config, overrides);
      registry = overrides.registry;
      modelConfigFile = overrides.modelConfigFile;
      effortConfigFile = overrides.effortConfigFile;
      agentPolicyFile = overrides.agentPolicyFile;
    } catch (error) {
      failure = toFailure(error, project.path);
    }

    for (const entry of entries) {
      pipelines.push(
        failure !== undefined || forProject === undefined || registry === undefined
          ? errorView(
              project.key,
              project.path,
              entry.address ?? relative(project.path, entry.path).replace(/\\/g, '/'),
              failure ?? { error: 'Project configuration cannot be read' },
              originOf(entry),
            )
          : readPipeline(
              project.key, project.path, entry, forProject, registry,
              { modelConfigFile, effortConfigFile, agentPolicyFile },
            ),
      );
    }
  }

  return { pipelines, generatedAt: (options.now ?? new Date()).toISOString() };
}
