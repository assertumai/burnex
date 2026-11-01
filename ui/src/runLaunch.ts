import type { BackendView, PipelineView } from './api';
import { envOfRows, parseEnvLines, type EnvRow } from './runLaunchEnv';

/**
 * Логика формы запуска без отрисовки (`ui-run-launch-dialog`): что предвыбрать,
 * что форма знает о пайплайне заранее и какое тело уходит в `POST /api/run`.
 * Компонент только держит состояние и рисует — решения принимаются здесь, где
 * их проверяет тест.
 */

/** Название входа, которым пайплайн принимает слаг пункта доски. */
export const ITEM_INPUT = 'item';

/** Запись агента «по умолчанию»: поле пусто, и в запрос флаг не попадает. */
export const DEFAULT_AGENT = '';

export interface LaunchPayload {
  readonly project: string;
  readonly pipeline: string;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly shadow?: boolean;
  readonly agent?: string;
}

/** Что набрано в форме. Пустые поля в запрос не попадают. */
export interface LaunchDraft {
  readonly project: string;
  readonly pipeline: string;
  readonly inputs: Readonly<Record<string, string>>;
  /** Строки `KEY=VALUE` одним текстом, как их набрали. */
  readonly envText: string;
  readonly shadow: boolean;
  readonly agent: string;
}

export interface LaunchProject {
  readonly key: string;
  readonly path: string;
}

/** Проекты, у которых витрина нашла пайплайны, — в порядке появления. */
export function projectsOf(pipelines: readonly PipelineView[]): LaunchProject[] {
  const seen = new Map<string, LaunchProject>();
  for (const pipeline of pipelines) {
    if (!seen.has(pipeline.projectKey)) seen.set(pipeline.projectKey, { key: pipeline.projectKey, path: pipeline.projectPath });
  }
  return [...seen.values()];
}

/** Пайплайны проекта, которые разбираются: сломанный файл виден отдельно, выбрать его нельзя. */
export function runnableOf(pipelines: readonly PipelineView[], projectKey: string): PipelineView[] {
  return pipelines.filter((pipeline) => pipeline.projectKey === projectKey && pipeline.error === undefined);
}

/**
 * Предвыбранный пайплайн: при пункте доски — тот, кто принимает вход `item`
 * (иначе запуск потерял бы выбранный пункт), и только потом первый по порядку.
 */
export function initialPipeline(runnable: readonly PipelineView[], item: string | undefined): PipelineView | undefined {
  if (item !== undefined) {
    const takesItem = runnable.find((pipeline) => pipeline.inputs.includes(ITEM_INPUT));
    if (takesItem !== undefined) return takesItem;
  }
  return runnable[0];
}

/** Входы выбранного пайплайна: слаг пункта подставлен тому, кто объявил `item`. */
export function initialInputs(pipeline: PipelineView | undefined, item: string | undefined): Record<string, string> {
  if (pipeline === undefined || item === undefined || !pipeline.inputs.includes(ITEM_INPUT)) return {};
  return { [ITEM_INPUT]: item };
}

/**
 * Сколько шагов выбор агента реально затронет: те, где слой `config`
 * (`defaults.agent`, куда кладётся флаг) сильнее нынешнего источника агента.
 * Это шаги из самого `config`, а под `agent_policy: fallback` ещё и шаги с
 * агентом корня документа: там корень слабее `defaults.agent`
 * (`src/parts/pipeline/document/agentChoice.ts`, RANK). Агент шага и работы,
 * `pipeline_agents` и `step_agents` сильнее флага при любой политике — форма
 * показывает число, чтобы выбор не был невидимым.
 */
export function agentImpact(pipeline: PipelineView): { readonly affected: number; readonly agentSteps: number } {
  const yieldsToFlag = (layer: string | undefined): boolean =>
    layer === 'config' || (layer === 'pipeline' && pipeline.agentPolicy === 'fallback');
  let affected = 0;
  let agentSteps = 0;
  for (const job of pipeline.jobs) {
    for (const step of job.steps) {
      if (step.kind !== 'agent') continue;
      agentSteps += 1;
      if (yieldsToFlag(step.agentOrigin?.layer)) affected += 1;
    }
  }
  return { affected, agentSteps };
}

/** Агенты, из которых форма предлагает выбрать: недоступный бэкенд остаётся виден, но выключен. */
export function agentChoices(backends: readonly BackendView[]): { name: string; disabled: boolean }[] {
  return backends.map((backend) => ({ name: backend.name, disabled: !backend.enabled || !backend.available }));
}

export function envRowsOf(draft: Pick<LaunchDraft, 'envText'>, pipeline: PipelineView | undefined): EnvRow[] {
  return parseEnvLines(draft.envText.split(/\r?\n/), pipeline?.envNames ?? []);
}

/** Почему запуск сейчас невозможен; `undefined` — можно отправлять. */
export function launchBlocker(draft: LaunchDraft, pipeline: PipelineView | undefined): string | undefined {
  if (pipeline === undefined) return 'Choose a pipeline';
  if (envRowsOf(draft, pipeline).some((row) => row.error !== undefined)) return 'Fix the env lines marked with an error';
  if (draft.shadow && !pipeline.shadow.ready) return 'This pipeline is not ready for shadow mode';
  return undefined;
}

/**
 * Тело запроса. Пустое поле — это «не менять», а не «пустое значение»: ключ
 * не уходит вовсе, и запрос без дополнительных полей остаётся таким, каким его
 * слала прежняя форма доски.
 */
export function buildLaunchBody(draft: LaunchDraft, pipeline: PipelineView): LaunchPayload {
  const inputs: Record<string, string> = {};
  for (const name of pipeline.inputs) {
    const value = draft.inputs[name];
    if (value !== undefined && value !== '') inputs[name] = value;
  }
  const env = envOfRows(envRowsOf(draft, pipeline));
  const agent = draft.agent.trim();

  return {
    project: draft.project,
    pipeline: pipeline.file,
    ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(draft.shadow && pipeline.shadow.ready ? { shadow: true } : {}),
    ...(agent === DEFAULT_AGENT ? {} : { agent }),
  };
}

export type LaunchOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Отправить запрос. Отказ демона (400) возвращается текстом, а не бросается:
 * диалог остаётся открытым и показывает фразу демона, закрывается он только на
 * 202.
 */
export async function submitLaunch(
  body: LaunchPayload,
  launch: (payload: LaunchPayload) => Promise<unknown>,
): Promise<LaunchOutcome> {
  try {
    await launch(body);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: (cause as Error).message };
  }
}
