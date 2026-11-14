import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Document, isMap, isScalar, isSeq, parse as parseYaml, parseDocument } from 'yaml';

import { BurnexError } from '../../kernel/errors.js';
import { ProfileNameSchema } from '../pipeline/config/schema.js';
import type { z } from 'zod';

import {
  discussionLayerDirs,
  DiscussionStrategySchema,
  loadDiscussionStrategy,
} from '../pipeline/document/discussionStrategy.js';
import {
  describeStrategyUnresolved,
  loadReviewStrategy,
  ReviewStrategySchema,
  strategyLayerDirs,
} from '../pipeline/document/reviewStrategy.js';
import type { StrategyLoad, StrategyRoots } from '../pipeline/document/strategyDocument.js';
import type { PipelineStepView, PipelineView } from './pipelines.js';

/**
 * Стратегии для экранов «Review strategies» (`ui-review-strategies`) и
 * «Discussion strategies» (`ui-discussion-strategies`): оба слоя — проект, в
 * котором поднят демон, и домашний каталог — тем же разрешением, что движок,
 * запись через `yaml` `Document` с проверкой разбором движка до подмены файла.
 * Виды различаются только описанием `StrategyKind`.
 */

/** Вид стратегии: каталоги слоёв, загрузка движком, схема и ссылка шага на неё. */
export interface StrategyKind {
  /** Подпись вида в тексте отказа. */
  readonly title: string;
  readonly layerDirs: (roots: StrategyRoots) => readonly { readonly layer: 'project' | 'home'; readonly dir: string }[];
  readonly load: (ref: string, path: string, layer: 'project' | 'home' | 'explicit', backendNames: readonly string[]) => StrategyLoad<unknown>;
  /** Схема документа: из её замечания берётся лишний ключ корня. */
  readonly schema: z.ZodType;
  /** Путь файла стратегии, в который разрешилась ссылка шага, — если шаг этого вида. */
  readonly stepStrategyPath: (step: PipelineStepView) => string | undefined;
}

export const REVIEW_STRATEGY: StrategyKind = {
  title: 'стратегия ревью',
  layerDirs: strategyLayerDirs,
  load: loadReviewStrategy,
  schema: ReviewStrategySchema,
  stepStrategyPath: (step) => step.reviewStrategy?.path,
};

export const DISCUSSION_STRATEGY: StrategyKind = {
  title: 'стратегия обсуждения',
  layerDirs: discussionLayerDirs,
  load: loadDiscussionStrategy,
  schema: DiscussionStrategySchema,
  stepStrategyPath: (step) => step.discussStrategy?.path,
};

export type StrategyLayer = 'project' | 'home';

/** Отказ разбора: текст движка и путь ключа внутри документа, если он известен. */
export interface StrategyProblem {
  readonly message: string;
  readonly at?: string;
}

/** Шаг пайплайна проекта, чья ссылка `review:` разрешилась в этот файл. */
export interface StrategyUsage {
  readonly pipeline: string;
  /** Файл пайплайна относительно корня проекта либо адрес пакета. */
  readonly file: string;
  readonly job: string;
  readonly step: string;
}

export interface StrategyView {
  /** Имя файла без `.yml`: по нему шаг ссылается на стратегию. */
  readonly name: string;
  readonly layer: StrategyLayer;
  readonly path: string;
  /** Текст файла как есть — для файла, который не разбирается. */
  readonly text: string;
  /** Одноимённая стратегия проекта побеждает эту: только чтение. */
  readonly shadowed?: true;
  /** Документ в объявленном виде (`file:` не раскрыт) — только у разобранного. */
  readonly document?: Record<string, unknown>;
  readonly error?: StrategyProblem;
  readonly usage: readonly StrategyUsage[];
}

export interface StrategiesOverview {
  /** Каталог проектного слоя; нет, если демон не знает своего проекта. */
  readonly projectDir?: string;
  readonly homeDir: string;
  readonly strategies: readonly StrategyView[];
  readonly generatedAt: string;
}

export interface StrategyRootsOptions {
  /** Корень проекта демона: без него проектного слоя нет. */
  readonly projectRoot?: string;
  readonly home: string;
}

function layerDirs(kind: StrategyKind, options: StrategyRootsOptions): ReadonlyMap<StrategyLayer, string> {
  const dirs = kind.layerDirs({ project: options.projectRoot ?? '', home: options.home });
  return new Map(
    dirs.filter((entry) => entry.layer === 'home' || options.projectRoot !== undefined).map((entry) => [entry.layer, entry.dir]),
  );
}

function layerDir(kind: StrategyKind, layer: StrategyLayer, options: StrategyRootsOptions): string {
  const dir = layerDirs(kind, options).get(layer);
  if (dir === undefined) throw new BurnexError('The daemon does not know its project: the project layer is unavailable');
  return dir;
}

function strategyFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yml'))
    .map((file) => file.slice(0, -'.yml'.length))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Отказ разбора движка в форме экрана. Лишний ключ корня движок называет
 * текстом без пути (`describeSchemaFailure`), а форме нужно поле: путь берётся
 * из того же замечания схемы движка — тот ключ, который она отвергла.
 */
function problemOf(kind: StrategyKind, unresolved: StrategyLoad<unknown>, document: unknown): StrategyProblem | undefined {
  if (!('unresolved' in unresolved)) return undefined;
  const failure = unresolved.unresolved;
  if (failure.reason === 'invalid') {
    if (failure.at !== undefined) return { message: failure.detail, at: failure.at };
    const parsed = kind.schema.safeParse(document);
    const extra = parsed.success
      ? undefined
      : parsed.error.issues.find((issue) => issue.code === 'unrecognized_keys' && issue.path.length === 0);
    const key = extra?.code === 'unrecognized_keys' ? extra.keys[0] : undefined;
    return key === undefined ? { message: failure.detail } : { message: failure.detail, at: key };
  }
  if (failure.reason === 'name_mismatch') return { message: describeStrategyUnresolved(failure, kind.title), at: 'name' };
  return { message: describeStrategyUnresolved(failure, kind.title) };
}

/** Путь без символических ссылок: раскрытие ищет проект от настоящего пути (`/var` и `/private/var`). */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Шаги, чья стратегия разрешилась в этот файл: имя по слоям и явный путь — одним сравнением пути. */
export function strategyUsage(kind: StrategyKind, pipelines: readonly PipelineView[], path: string): readonly StrategyUsage[] {
  const target = realPath(path);
  const usage: StrategyUsage[] = [];
  for (const pipeline of pipelines) {
    for (const job of pipeline.jobs) {
      for (const step of job.steps) {
        const strategyPath = kind.stepStrategyPath(step);
        if (strategyPath === undefined || realPath(strategyPath) !== target) continue;
        usage.push({ pipeline: pipeline.name, file: pipeline.file, job: job.id, step: step.id });
      }
    }
  }
  return usage;
}

export function readStrategies(
  kind: StrategyKind,
  options: StrategyRootsOptions & {
    readonly backendNames: readonly string[];
    /** Раскрытые пайплайны проекта демона: из них — использование. */
    readonly pipelines?: readonly PipelineView[];
    readonly now?: Date;
  },
): StrategiesOverview {
  const dirs = layerDirs(kind, options);
  const projectNames = new Set(dirs.has('project') ? strategyFiles(dirs.get('project')!) : []);
  const strategies: StrategyView[] = [];
  for (const [layer, dir] of dirs) {
    for (const name of strategyFiles(dir)) {
      const path = join(dir, `${name}.yml`);
      const text = readFileSync(path, 'utf8');
      let document: unknown;
      try {
        document = parseYaml(text);
      } catch {
        document = undefined;
      }
      const error = problemOf(kind, kind.load(name, path, layer, options.backendNames), document);
      strategies.push({
        name,
        layer,
        path,
        text,
        ...(layer === 'home' && projectNames.has(name) ? { shadowed: true as const } : {}),
        ...(error === undefined ? { document: document as Record<string, unknown> } : { error }),
        usage: strategyUsage(kind, options.pipelines ?? [], path),
      });
    }
  }
  return {
    ...(dirs.has('project') ? { projectDir: dirs.get('project')! } : {}),
    homeDir: dirs.get('home')!,
    strategies,
    generatedAt: (options.now ?? new Date()).toISOString(),
  };
}

/** Отказ записи, который форма показывает у поля: текст движка и путь ключа. */
export class StrategyRejected extends BurnexError {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Привести узел документа к значению, не трогая совпадающее: нетронутые узлы
 * остаются теми же объектами `yaml` вместе с комментариями и порядком ключей,
 * у изменённого скаляра меняется только значение (комментарий при нём цел).
 */
function syncNode(document: Document, path: readonly (string | number)[], value: unknown): void {
  const node = path.length === 0 ? document.contents : document.getIn(path, true);
  if (isPlainObject(value) && isMap(node)) {
    for (const pair of [...node.items]) {
      const key = isScalar(pair.key) ? pair.key.value : pair.key;
      if (!Object.hasOwn(value, String(key))) node.delete(key);
    }
    for (const [key, child] of Object.entries(value)) syncNode(document, [...path, key], child);
    return;
  }
  if (Array.isArray(value) && isSeq(node)) {
    while (node.items.length > value.length) node.delete(node.items.length - 1);
    value.forEach((child, index) => {
      if (index < node.items.length) syncNode(document, [...path, index], child);
      else node.add(document.createNode(child));
    });
    return;
  }
  if (isScalar(node) && !isPlainObject(value) && !Array.isArray(value)) {
    if (node.value !== value) node.value = value;
    return;
  }
  if (path.length === 0) document.contents = document.createNode(value);
  else document.setIn(path, document.createNode(value));
}

export interface SaveStrategyRequest {
  readonly layer: StrategyLayer;
  readonly name: string;
  readonly document: Record<string, unknown>;
  /** Новая стратегия: файла слоя ещё нет, и затирать существующий нельзя. */
  readonly create?: boolean | undefined;
}

function strategyPath(kind: StrategyKind, layer: StrategyLayer, name: string, options: StrategyRootsOptions): string {
  if (!ProfileNameSchema.safeParse(name).success) {
    throw new StrategyRejected(`Strategy name “${name}”: use lowercase letters, digits, hyphens or underscores; start with a letter`, {
      at: 'name',
    });
  }
  return join(layerDir(kind, layer, options), `${name}.yml`);
}

/**
 * Записать стратегию в файл её слоя. Текст собирается правкой прежнего
 * документа (комментарии на месте), кладётся рядом временным файлом и
 * разбирается тем же загрузчиком вида (`kind.load`), каким его прочтёт движок: `file:`
 * разрешается от того же каталога, `name` обязан совпасть с именем файла.
 * Только прошедший разбор файл подменяет прежний переименованием.
 */
export function saveStrategy(
  kind: StrategyKind,
  request: SaveStrategyRequest,
  options: StrategyRootsOptions & { readonly backendNames: readonly string[] },
): string {
  const path = strategyPath(kind, request.layer, request.name, options);
  const exists = existsSync(path);
  if (request.create === true && exists) {
    throw new StrategyRejected(`Strategy ${request.name} already exists in the ${request.layer} layer: ${path}`, { file: path, at: 'name' });
  }
  if (request.create !== true && !exists) {
    throw new BurnexError(`Strategy ${request.name} does not exist in the ${request.layer} layer: ${path}`, { file: path });
  }

  let document: Document;
  if (exists) {
    document = parseDocument(readFileSync(path, 'utf8'));
    if (document.errors.length > 0) {
      throw new BurnexError(`The file is not valid YAML and cannot be edited by the form: ${document.errors[0]!.message}`, { file: path });
    }
    syncNode(document, [], request.document);
  } else {
    document = new Document(request.document);
  }
  const text = document.toString();

  mkdirSync(layerDir(kind, request.layer, options), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text);
  const problem = problemOf(kind, kind.load(request.name, temporary, request.layer, options.backendNames), request.document);
  if (problem !== undefined) {
    rmSync(temporary, { force: true });
    throw new StrategyRejected(problem.message, { file: path, ...(problem.at === undefined ? {} : { at: problem.at }) });
  }
  renameSync(temporary, path);
  return path;
}

export function deleteStrategy(kind: StrategyKind, layer: StrategyLayer, name: string, options: StrategyRootsOptions): void {
  const path = strategyPath(kind, layer, name, options);
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BurnexError(`Strategy ${name} does not exist in the ${layer} layer: ${path}`, { file: path });
    }
    throw error;
  }
}
