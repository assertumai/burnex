import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';

import type { Config } from '../pipeline/config/resolve.js';
import { listPipelineEntries } from '../pipeline/domain/project/pipelines.js';
import { checkScheduleEntry } from '../pipeline/domain/trigger/entry.js';
import { nextOccurrence } from '../pipeline/domain/trigger/cron.js';
import { displayInputs } from '../pipeline/document/displayInputs.js';
import { expandPipeline } from '../pipeline/document/expand.js';
import { runPaths } from '../pipeline/run/journal/paths.js';
import { listRuns, readManifestSoft, readStatusSoft } from '../pipeline/run/journal/reader.js';
import { shownProjects } from './projects.js';
import type { RunManifest } from '../pipeline/run/journal/schema.js';
import {
  projectSection,
  toFailure,
  withProjectSection,
  type Failure,
  type KernelCache,
} from './pipelines.js';
import { homeRoot } from '../../kernel/dirs.js';

/**
 * Расписания проектов для экрана «Schedule» (`ui-schedule-view`, design.md).
 *
 * Читается раскрытый документ, а не сырой YAML: подключённые работы, пакеты и
 * слои разрешаются так же, как при запуске. Экран только показывает — ничто
 * здесь не пишет в проект, а срабатывание расписания не его забота.
 */

/** Последний прогон, запущенный по записи расписания. */
export interface LastScheduledRun {
  readonly runId: string;
  readonly moment: string;
  readonly catchup: boolean;
  readonly status?: string;
}

export interface ScheduleEntryView {
  readonly index: number;
  readonly cron?: string;
  /** Пояс записи; у записи без пояса — пояс машины демона (`defaultTimezone`). */
  readonly timezone?: string;
  readonly defaultTimezone: boolean;
  /** Ближайший момент срабатывания, ISO в UTC. Нет, если запись не прошла проверку. */
  readonly next?: string;
  /** Причина отказа теми же словами, что у `burnex lint`. */
  readonly error?: string;
  readonly lastRun?: LastScheduledRun;
}

export interface SchedulePipelineView {
  /** Адрес пайплайна, как на «Pipelines». */
  readonly pipeline: string;
  readonly entries: readonly ScheduleEntryView[];
}

/** Пайплайн, который не раскрылся: причина — как на «Pipelines». */
export interface SchedulePipelineFailure extends Failure {
  readonly pipeline: string;
}

export interface ProjectScheduleView {
  readonly projectKey: string;
  readonly projectPath: string;
  /** Конфигурация или плагины проекта не загрузились: ни пайплайнов, ни записей. */
  readonly error?: string;
  readonly errorFile?: string;
  readonly errorAt?: string;
  readonly errorHint?: string;
  readonly pipelines: readonly SchedulePipelineView[];
  readonly pipelineErrors: readonly SchedulePipelineFailure[];
}

/**
 * Сервис триггеров. Форма `present: true` объявлена заранее:
 * `schedule-catchup-and-keep-awake` наполнит её из конфигурации, не меняя экран.
 */
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

export interface BuildScheduleOptions {
  readonly home?: string;
  readonly kernelCache?: KernelCache;
  /** Опорный момент «ближайшего»: параметр, чтобы тесты не зависели от часов. */
  readonly now?: Date;
  readonly signal?: AbortSignal;
}

/**
 * Секции `ui.triggers` в конфигурации пока нет (она заводится в
 * `schedule-catchup-and-keep-awake`), поэтому сервиса нет, а показывать
 * умолчания несуществующей секции значило бы обещать поведение, которого нет.
 */
export function triggerServiceView(_config: Config): TriggerServiceView {
  return { present: false };
}

type ScheduledManifest = RunManifest & { readonly trigger: NonNullable<RunManifest['trigger']> };

/**
 * Прогоны проекта, запущенные по расписанию, — одним проходом по манифестам.
 * Нечитаемый манифест пропускается: у него нет поля, по которому его можно
 * отнести к записи.
 */
/**
 * Путь, по которому сравнивается файл пайплайна. `pipeline_file` записан
 * процессом `burnex run` из его рабочего каталога, а демон раскрывает
 * документ от `project.path` журнала: через симлинк или `/var` против
 * `/private/var` на macOS один файл пишется по-разному. Исчезнувший файл
 * остаётся как есть — сравнить его можно только по написанию.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function scheduledRuns(runsRoot: string, projectKey: string, projectPath: string) {
  const found: { readonly runId: string; readonly manifest: ScheduledManifest; readonly status?: string }[] = [];
  for (const runId of listRuns(runsRoot, projectPath)) {
    const paths = runPaths(runsRoot, projectKey, runId);
    const { manifest } = readManifestSoft(paths);
    if (manifest?.trigger?.kind !== 'schedule') continue;
    const status = manifest.status ?? readStatusSoft(paths).status?.status;
    found.push({
      runId,
      manifest: { ...manifest, pipeline_file: canonicalPath(manifest.pipeline_file) } as ScheduledManifest,
      ...(status === undefined ? {} : { status }),
    });
  }
  return found;
}

async function projectView(
  runsRoot: string,
  project: { readonly key: string; readonly path: string },
  config: Config,
  options: BuildScheduleOptions,
  now: Date,
): Promise<ProjectScheduleView> {
  let forProject: Config;
  let registry;
  try {
    const overrides = await projectSection(project.path, options.home, options.kernelCache);
    forProject = withProjectSection(config, overrides);
    registry = overrides.registry;
  } catch (error) {
    return {
      projectKey: project.key,
      projectPath: project.path,
      ...toFailure(error, project.path),
      pipelines: [],
      pipelineErrors: [],
    };
  }

  const entries = listPipelineEntries(project.path, {
    globalConfigDir: homeRoot(options.home ?? homedir()),
  });

  // Прогоны читаются лениво и один раз на проект: пайплайна с расписанием
  // может не быть вовсе, и тогда сканировать манифесты незачем.
  let runs: ReturnType<typeof scheduledRuns> | undefined;

  const pipelines: SchedulePipelineView[] = [];
  const pipelineErrors: SchedulePipelineFailure[] = [];
  for (const entry of entries) {
    const address = entry.address ?? relative(project.path, entry.path).replace(/\\/g, '/');
    try {
      const { pipeline } = expandPipeline({
        pipelinePath: entry.path,
        config: forProject,
        registry,
        inputs: displayInputs(entry.path),
        ...(entry.address === undefined ? {} : { projectRoot: project.path }),
      });
      const schedule = pipeline.triggers?.schedule ?? [];
      if (schedule.length === 0) continue;

      runs ??= scheduledRuns(runsRoot, project.key, project.path);
      const pipelineFile = canonicalPath(pipeline.file);
      const views = schedule.map((declared, index): ScheduleEntryView => {
        // Последний — по `started_at`; сравнение строк ISO в UTC совпадает с
        // сравнением моментов, а у манифеста без `started_at` быть его нет.
        // Совпадение по файлу, выражению и поясу, а не по номеру: документ
        // правят, и номера сдвигаются (design.md, Решение 3).
        const matching = runs!
          .filter(
            ({ manifest }) =>
              manifest.pipeline_file === pipelineFile &&
              manifest.trigger.cron === declared.cron &&
              manifest.trigger.timezone === declared.timezone,
          )
          .sort((a, b) => b.manifest.started_at.localeCompare(a.manifest.started_at))[0];
        const lastRun: LastScheduledRun | undefined =
          matching === undefined
            ? undefined
            : {
                runId: matching.runId,
                moment: matching.manifest.trigger.moment,
                catchup: matching.manifest.trigger.catchup,
                ...(matching.status === undefined ? {} : { status: matching.status }),
              };

        const checked = checkScheduleEntry(declared, index);
        if (!checked.ok) {
          return {
            index,
            ...(declared.cron === undefined ? {} : { cron: declared.cron }),
            ...(declared.timezone === undefined ? {} : { timezone: declared.timezone }),
            defaultTimezone: declared.timezone === undefined,
            error: checked.reason,
            ...(lastRun === undefined ? {} : { lastRun }),
          };
        }

        const next = nextOccurrence(checked.mask, checked.timezone, now.getTime());
        return {
          index,
          cron: declared.cron!,
          timezone: checked.timezone,
          defaultTimezone: checked.defaultTimezone,
          ...(next.ok ? { next: new Date(next.at).toISOString() } : { error: next.reason }),
          ...(lastRun === undefined ? {} : { lastRun }),
        };
      });
      pipelines.push({ pipeline: address, entries: views });
    } catch (error) {
      pipelineErrors.push({ pipeline: address, ...toFailure(error, project.path) });
    }
  }

  return { projectKey: project.key, projectPath: project.path, pipelines, pipelineErrors };
}

export async function buildSchedule(
  runsRoot: string,
  config: Config,
  options: BuildScheduleOptions = {},
): Promise<ScheduleOverview> {
  const now = options.now ?? new Date();
  const projects: ProjectScheduleView[] = [];

  // Последовательно, как в `buildPipelines`: параллельный импорт чужих
  // плагинов порядка не ускоряет, а карточки делает недетерминированными.
  for (const project of shownProjects(runsRoot)) {
    if (options.signal?.aborted === true) break;
    if (project.path === undefined || !existsSync(project.path)) continue;
    projects.push(await projectView(runsRoot, { key: project.key, path: project.path }, config, options, now));
  }

  return { projects, service: triggerServiceView(config), generatedAt: now.toISOString() };
}
