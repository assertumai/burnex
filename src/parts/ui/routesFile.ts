import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, parse as parseYaml, parseDocument } from 'yaml';
import { z } from 'zod';

import { isBurnexError, BurnexError } from '../../kernel/errors.js';
import { findPackageRoot } from '../pipeline/domain/package-schema.js';
import { describeSchemaFailure } from '../../kernel/schema-failure.js';
import { buildPackageIndex, resourceLayers, type PackageResourcePath } from '../packages/index.js';
import {
  isReservedPath,
  normalizedTemplate,
  paramPlaceholderNames,
  templateParamNames,
  type NavGroupEntry,
  type RouteLayerName,
  type RouteDefinition,
  type RouteNav,
  type RouteTable,
  type RouteTarget,
} from './routes.js';
import { cabinetDir, homeRoot } from '../../kernel/dirs.js';

/**
 * Файл маршрутов и его три слоя (`ui-routes`, design.md Решение 1, 2, 9).
 *
 * Модуль демона: он один читает диск и знает про `findPackageRoot`,
 * `homedir()` и проектный корень. Разбор адреса и сборка ссылки по уже
 * собранной таблице остаются в `src/parts/ui/routes.ts` — общем и демону, и
 * браузеру.
 */

const ROUTE_NAME = /^[A-Za-z0-9_]+$/;

/** Потолок длины значка-картинки: PNG 64×64 укладывается с запасом, а значок лежит строкой в файле и едет в каждом событии. */
const MAX_ICON_LENGTH = 16_384;

/**
 * Значок пункта (docs/routes.md): имя набора витрины, `text:<символы>` либо
 * растровая `data:`-картинка. Набора демон не знает — незнакомое имя витрина
 * рисует запасным значком; а вот `data:` проверяется здесь: внешних адресов
 * и SVG среди значков нет, чтобы файл слоя не мог подгрузить чужое.
 */
const NavIconSchema = z
  .string()
  .min(1)
  .max(MAX_ICON_LENGTH)
  .refine((value) => !/^(data|https?|file|javascript):/i.test(value) || /^data:image\/(png|webp|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(value), {
    message: 'icon must be a set name, text:<glyphs>, or a base64 data:image/png|webp|jpeg|gif',
  });

const RouteNavSchema = z
  .object({
    title: z.string().min(1).optional(),
    order: z.number().optional(),
    // `null` — явное «без группы»: слияние идёт по листьям, и пропуск поля
    // означал бы «как в нижнем слое», а не «снять группу».
    group: z.string().min(1).nullable().optional(),
    active_for: z.array(z.string().min(1)).optional(),
    icon: NavIconSchema.optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

const NavGroupSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    order: z.number().optional(),
  })
  .strict();

export type NavGroupDocument = z.infer<typeof NavGroupSchema>;

const RouteTargetSchema = z.union([
  z.object({ screen: z.string().min(1) }).strict(),
  z.object({ widget: z.string().min(1) }).strict(),
  z.object({ dashboard: z.string().min(1) }).strict(),
]);

export const RouteRowSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().regex(/^\//, 'path must start with /').optional(),
    target: RouteTargetSchema.optional(),
    params: z.record(z.string().regex(ROUTE_NAME), z.string()).optional(),
    values: z.record(z.string().regex(ROUTE_NAME), z.array(z.string().min(1)).min(1)).optional(),
    nav: RouteNavSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type RouteRowDocument = z.infer<typeof RouteRowSchema>;

export const RouteDocumentSchema = z
  .object({
    routes: z.array(RouteRowSchema),
    nav_groups: z.array(NavGroupSchema).optional(),
  })
  .strict();

export type RouteFileDocument = z.infer<typeof RouteDocumentSchema>;

const ROUTES_FILE_NAME = 'routes.yml';

/** Расположение встроенного файла маршрутов — тем же приёмом, что `src/builtin/steps` (`src/parts/ui/steps.ts:63`). */
export function builtinRoutesPath(): string {
  return join(findPackageRoot(fileURLToPath(new URL('.', import.meta.url))), 'src', 'builtin', ROUTES_FILE_NAME);
}

export function homeRoutesPath(home: string): string {
  return join(homeRoot(home), ROUTES_FILE_NAME);
}

export function projectRoutesPath(projectRoot: string): string {
  return join(cabinetDir(projectRoot), ROUTES_FILE_NAME);
}

function readRoutesDocument(path: string): RouteFileDocument {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new BurnexError(`Routes file cannot be read: ${path}`, {
      file: path,
      hint: (error as NodeJS.ErrnoException).message,
      cause: error,
    });
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new BurnexError(`Routes file is not valid YAML: ${path}`, { file: path, cause: error });
  }

  const parsed = RouteDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const failure = describeSchemaFailure(parsed.error);
    throw new BurnexError(`Routes file ${path} does not match the format: ${failure.message}`, {
      file: path,
      ...(failure.at === undefined ? {} : { at: failure.at }),
      hint: 'The format is described in docs/routes.md; schema: schema/routes.schema.json',
    });
  }
  return parsed.data;
}

export type { NavGroupEntry, RouteLayerName };

interface LayerFile {
  readonly layer: RouteLayerName;
  /** Пакет, чей `routes.yml` это слой; `layer` при этом — слой самого пакета. */
  readonly package?: string;
  readonly path: string;
  readonly rows: readonly RouteRowDocument[];
  readonly groups: readonly NavGroupDocument[];
}

function readLayer(layer: RouteLayerName, path: string, required: boolean, packageName?: string): LayerFile | undefined {
  if (!required && !existsSync(path)) return undefined;
  const document = readRoutesDocument(path);
  return {
    layer,
    ...(packageName === undefined ? {} : { package: packageName }),
    path,
    rows: document.routes,
    groups: document.nav_groups ?? [],
  };
}

/** Откуда пришло поле строки маршрута — слой и файл (для перечня в витрине); у маршрута пакета — ещё и пакет. */
export interface RouteFieldSource {
  readonly layer: RouteLayerName;
  readonly package?: string;
  readonly file: string;
}

interface FieldSlot<T> {
  readonly value: T;
  readonly source: RouteFieldSource;
}

/** Поля строки, слитые по листьям через слои (`ui-routes`, Решение 2). */
interface MergedFields {
  path?: FieldSlot<string>;
  target?: FieldSlot<NonNullable<RouteRowDocument['target']>>;
  params?: FieldSlot<Readonly<Record<string, string>>>;
  values?: FieldSlot<Readonly<Record<string, readonly string[]>>>;
  navTitle?: FieldSlot<string>;
  navOrder?: FieldSlot<number>;
  navGroup?: FieldSlot<string | null>;
  navActiveFor?: FieldSlot<readonly string[]>;
  navIcon?: FieldSlot<string>;
  navHidden?: FieldSlot<boolean>;
  enabled?: FieldSlot<boolean>;
}

interface MergedRow {
  readonly id: string;
  readonly fields: MergedFields;
  /** Файлы, коснувшиеся строки — последний нужен как место отказа «нет пути/цели». */
  readonly touchedFiles: readonly string[];
}

/** Слить строки слоёв по `id`, по листьям, сохраняя порядок первого появления (`ui-routes`, Решение 1, 2). */
function mergeRows(layers: readonly LayerFile[]): readonly MergedRow[] {
  const order: string[] = [];
  const byId = new Map<string, { fields: MergedFields; touchedFiles: string[] }>();

  for (const layer of layers) {
    for (const raw of layer.rows) {
      let entry = byId.get(raw.id);
      if (entry === undefined) {
        entry = { fields: {}, touchedFiles: [] };
        byId.set(raw.id, entry);
        order.push(raw.id);
      }
      entry.touchedFiles.push(layer.path);
      const source: RouteFieldSource = {
        layer: layer.layer,
        ...(layer.package === undefined ? {} : { package: layer.package }),
        file: layer.path,
      };
      if (raw.path !== undefined) entry.fields.path = { value: raw.path, source };
      if (raw.target !== undefined) entry.fields.target = { value: raw.target, source };
      if (raw.params !== undefined) entry.fields.params = { value: raw.params, source };
      if (raw.values !== undefined) entry.fields.values = { value: raw.values, source };
      if (raw.enabled !== undefined) entry.fields.enabled = { value: raw.enabled, source };
      if (raw.nav?.title !== undefined) entry.fields.navTitle = { value: raw.nav.title, source };
      if (raw.nav?.order !== undefined) entry.fields.navOrder = { value: raw.nav.order, source };
      if (raw.nav?.group !== undefined) entry.fields.navGroup = { value: raw.nav.group, source };
      if (raw.nav?.active_for !== undefined) entry.fields.navActiveFor = { value: raw.nav.active_for, source };
      if (raw.nav?.icon !== undefined) entry.fields.navIcon = { value: raw.nav.icon, source };
      if (raw.nav?.hidden !== undefined) entry.fields.navHidden = { value: raw.nav.hidden, source };
    }
  }

  return order.map((id) => ({ id, ...byId.get(id)! }));
}

function toRouteTarget(raw: NonNullable<RouteRowDocument['target']>): RouteTarget {
  if ('screen' in raw) return { kind: 'screen', id: raw.screen };
  if ('widget' in raw) return { kind: 'widget', id: raw.widget };
  return { kind: 'dashboard', id: raw.dashboard };
}

/** Маршрут действующей таблицы вместе с источником каждого поля — для перечня в витрине. */
export interface RouteEntry {
  readonly id: string;
  readonly definition: RouteDefinition;
  readonly sources: {
    readonly path: RouteFieldSource;
    readonly target: RouteFieldSource;
    readonly params?: RouteFieldSource;
    readonly values?: RouteFieldSource;
    readonly navTitle?: RouteFieldSource;
    readonly navOrder?: RouteFieldSource;
    readonly navGroup?: RouteFieldSource;
    readonly navActiveFor?: RouteFieldSource;
    readonly navIcon?: RouteFieldSource;
    readonly navHidden?: RouteFieldSource;
    readonly enabled?: RouteFieldSource;
  };
}

/** Слить объявления групп слоёв по `id`, по листьям, в порядке первого появления. */
function mergeGroups(layers: readonly LayerFile[]): readonly NavGroupEntry[] {
  const byId = new Map<string, { title?: string; order?: number; layers: RouteLayerName[] }>();
  for (const layer of layers) {
    for (const raw of layer.groups) {
      let entry = byId.get(raw.id);
      if (entry === undefined) {
        entry = { layers: [] };
        byId.set(raw.id, entry);
      }
      if (raw.title !== undefined) entry.title = raw.title;
      if (raw.order !== undefined) entry.order = raw.order;
      if (!entry.layers.includes(layer.layer)) entry.layers.push(layer.layer);
    }
  }
  return [...byId].map(([id, entry]) => ({ id, ...entry }));
}

/**
 * Отключённая строка маршрута: в действующую таблицу она не входит вовсе
 * (`enabled: false` убирает маршрут из навигации, разбора адреса и сборки
 * ссылок), но перечню в витрине видна — иначе включить её обратно можно было
 * бы только правкой файла руками, а перечень маршрутов обязан оставаться
 * входом в любом состоянии таблицы (`ui-routes`, «Витрина показывает маршруты
 * с источником и правит файл слоя»).
 */
export interface DisabledRouteEntry {
  readonly id: string;
  readonly path?: string;
  readonly target?: RouteTarget;
  readonly nav?: RouteNav;
  /** Файл, объявивший строку отключённой, — его и называет витрина. */
  readonly disabledBy: RouteFieldSource;
}

/**
 * Отказ, ограниченный одним пакетом или одной строкой пакетов: битый
 * `routes.yml` пакета исключает только этот файл, а `id`, объявленный двумя
 * пакетами одного слоя, — только эту строку обоих пакетов. Остальная таблица
 * собирается (`packages-directory-layer`, «Сломанный пакет падает отдельно»).
 */
export interface RoutePackageFailure {
  readonly layer: 'home' | 'project';
  /** Пакеты, к которым относится отказ: один — битый файл, два и больше — конфликт `id`. */
  readonly packages: readonly string[];
  /** `id` строки в конфликте; у битого файла его нет. */
  readonly id?: string;
  readonly file: string;
  readonly message: string;
}

export interface RouteBuildResult {
  readonly table: RouteTable;
  readonly entries: readonly RouteEntry[];
  readonly disabled: readonly DisabledRouteEntry[];
  readonly failures: readonly RoutePackageFailure[];
  readonly navGroups: readonly NavGroupEntry[];
}

/** Строка действующей таблицы, обогащённая источником каждого поля — форма ответа `GET /api/routes` и события потока `routes`. */
export interface RoutePayloadEntry extends RouteDefinition {
  readonly sources: RouteEntry['sources'];
}

/** Действующая таблица с источниками, готовая к отправке JSON — общая форма для `GET /api/routes` и события `routes` (`ui-daemon`). */
export function routesPayload(result: RouteBuildResult): readonly RoutePayloadEntry[] {
  return result.entries.map((entry) => ({ ...entry.definition, sources: entry.sources }));
}

export interface RouteBuildOptions {
  readonly home: string;
  /** Корень проекта, в котором поднят демон — `undefined`, если демон его не знает. */
  readonly projectRoot?: string;
  /**
   * Файл поставки. У поставки он один (`builtinRoutesPath()`), и подменяется
   * только проверкой: сломать настоящий файл пакета ради сценария «Встроенный
   * файл сломан» ей негде.
   */
  readonly builtinPath?: string;
}

function buildNav(fields: MergedFields): RouteNav | undefined {
  if (
    fields.navTitle === undefined &&
    fields.navOrder === undefined &&
    fields.navGroup === undefined &&
    fields.navActiveFor === undefined &&
    fields.navIcon === undefined &&
    fields.navHidden === undefined
  ) {
    return undefined;
  }
  return {
    ...(fields.navTitle === undefined ? {} : { title: fields.navTitle.value }),
    ...(fields.navOrder === undefined ? {} : { order: fields.navOrder.value }),
    // `group: null` верхнего слоя снимает группу нижнего: в действующей строке её просто нет.
    ...(fields.navGroup === undefined || fields.navGroup.value === null ? {} : { group: fields.navGroup.value }),
    ...(fields.navActiveFor === undefined ? {} : { activeFor: fields.navActiveFor.value }),
    ...(fields.navIcon === undefined ? {} : { icon: fields.navIcon.value }),
    ...(fields.navHidden === undefined || !fields.navHidden.value ? {} : { hidden: true }),
  };
}

function validateParamPlaceholders(id: string, path: string, params: FieldSlot<Readonly<Record<string, string>>>): void {
  const names = new Set(templateParamNames(path));
  for (const [key, value] of Object.entries(params.value)) {
    for (const name of paramPlaceholderNames(value)) {
      if (names.has(name)) continue;
      throw new BurnexError(
        `Route ${id}: target parameter ${key} references \${params.${name}}, which is absent from path ${path}`,
        {
          file: params.source.file,
          at: `${id}.params.${key}`,
          hint:
            names.size === 0
              ? `Route path ${path} declares no parameters`
              : `Route path declares parameters: ${[...names].join(', ')}`,
        },
      );
    }
  }
}

/**
 * `routes.yml` пакетов одного слоя. Битый файл пакета исключает только этот
 * пакет; строка с одним `id` в двух пакетах слоя исключается из обоих —
 * исход иначе зависел бы от имени каталога, а не от намерения автора
 * (Решение 4). Оба отказа уходят в `failures` и называют пакеты, а прочие
 * строки и слои собираются как обычно. Строку в конфликте может объявить
 * слой выше — тогда действует она.
 */
function readPackageLayers(
  layer: 'home' | 'project',
  packages: readonly PackageResourcePath[],
  failures: RoutePackageFailure[],
): readonly LayerFile[] {
  const files: LayerFile[] = [];
  for (const entry of packages) {
    try {
      const file = readLayer(layer, entry.path, false, entry.package);
      if (file !== undefined) files.push(file);
    } catch (error) {
      if (!isBurnexError(error)) throw error;
      failures.push({ layer, packages: [entry.package], file: entry.path, message: error.message });
    }
  }

  const owners = new Map<string, LayerFile[]>();
  for (const file of files) {
    for (const id of new Set(file.rows.map((row) => row.id))) {
      const list = owners.get(id) ?? [];
      list.push(file);
      owners.set(id, list);
    }
  }
  const conflicted = new Set<string>();
  for (const [id, list] of owners) {
    if (list.length < 2) continue;
    conflicted.add(id);
    const names = list.map((file) => file.package as string);
    failures.push({
      layer,
      packages: names,
      id,
      file: (list[1] as LayerFile).path,
      message: `Route ${id} is declared by two packages of one layer: ${names.join(' and ')} (${list.map((file) => file.path).join(', ')}); rename the route in one package, remove one package, or override it in .burnex/routes.yml`,
    });
  }
  if (conflicted.size === 0) return files;
  return files.map((file) => ({ ...file, rows: file.rows.filter((row) => !conflicted.has(row.id)) }));
}

/**
 * Собрать действующую таблицу маршрутов пяти слоёв. Отказ — исключение
 * `BurnexError`: вызывающий (`src/parts/ui/daemon/kernel.ts`) обязан оставить в силе
 * последнюю успешно собранную таблицу, а не гасить витрину (`ui-routes`,
 * «Отказ таблицы не гасит витрину»).
 */
export function buildRouteTable(options: RouteBuildOptions): RouteBuildResult {
  const layers: LayerFile[] = [];
  const builtin = readLayer('builtin', options.builtinPath ?? builtinRoutesPath(), true);
  if (builtin !== undefined) layers.push(builtin);

  // Слияние идёт снизу вверх: встроенное ← пакеты home ← home ← пакеты проекта ←
  // проект (`packages-directory-layer`, Решение 7); верхний слой перекрывает
  // нижний по листьям. Пакетные слои отдаёт указатель в порядке поиска, поэтому
  // здесь они берутся по источнику, а не по позиции.
  const homeBurnexDir = homeRoot(options.home);
  const index = buildPackageIndex({
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    globalPath: join(homeBurnexDir, 'config.yml'),
  });
  const searchLayers = resourceLayers(index, 'routes', {
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    homeBurnexDir,
  });
  const packagesOf = (source: 'home-packages' | 'project-packages'): readonly PackageResourcePath[] => {
    const found = searchLayers.find((layer) => layer.source === source);
    return found !== undefined && 'packages' in found ? found.packages : [];
  };

  const failures: RoutePackageFailure[] = [];
  layers.push(...readPackageLayers('home', packagesOf('home-packages'), failures));
  const home = readLayer('home', homeRoutesPath(options.home), false);
  if (home !== undefined) layers.push(home);
  layers.push(...readPackageLayers('project', packagesOf('project-packages'), failures));
  if (options.projectRoot !== undefined) {
    const project = readLayer('project', projectRoutesPath(options.projectRoot), false);
    if (project !== undefined) layers.push(project);
  }

  const merged = mergeRows(layers);
  const entries: RouteEntry[] = [];
  const disabled: DisabledRouteEntry[] = [];

  for (const row of merged) {
    const enabledField = row.fields.enabled;
    if (enabledField !== undefined && !enabledField.value) {
      // Отключённая строка не проверяется на путь, цель и конфликты: её нет в
      // действующей таблице, и отказывать из-за неё значило бы гасить рабочие
      // маршруты ради выключенного. Витрине она отдаётся отдельным перечнем.
      const disabledNav = buildNav(row.fields);
      disabled.push({
        id: row.id,
        ...(row.fields.path === undefined ? {} : { path: row.fields.path.value }),
        ...(row.fields.target === undefined ? {} : { target: toRouteTarget(row.fields.target.value) }),
        ...(disabledNav === undefined ? {} : { nav: disabledNav }),
        disabledBy: enabledField.source,
      });
      continue;
    }

    if (row.fields.path === undefined || row.fields.target === undefined) {
      throw new BurnexError(`Route ${row.id} declares neither path nor target in any layer`, {
        file: row.touchedFiles[row.touchedFiles.length - 1] as string,
        at: row.id,
        hint: 'A route that adds a new id must declare path and target: there is nothing to merge them from',
      });
    }

    const path = row.fields.path.value;
    if (isReservedPath(path)) {
      throw new BurnexError(`Route ${row.id} declares a reserved path ${path}`, {
        file: row.fields.path.source.file,
        at: row.id,
        hint: 'Paths /api, /widgets/, /plugins/ and /shared/ are handled by the daemon: no page opens at them',
      });
    }

    if (row.fields.params !== undefined) validateParamPlaceholders(row.id, path, row.fields.params);

    const nav = buildNav(row.fields);
    const definition: RouteDefinition = {
      id: row.id,
      path,
      target: toRouteTarget(row.fields.target.value),
      ...(row.fields.params === undefined ? {} : { params: row.fields.params.value }),
      ...(row.fields.values === undefined ? {} : { values: row.fields.values.value }),
      ...(nav === undefined ? {} : { nav }),
    };

    entries.push({
      id: row.id,
      definition,
      sources: {
        path: row.fields.path.source,
        target: row.fields.target.source,
        ...(row.fields.params === undefined ? {} : { params: row.fields.params.source }),
        ...(row.fields.values === undefined ? {} : { values: row.fields.values.source }),
        ...(row.fields.navTitle === undefined ? {} : { navTitle: row.fields.navTitle.source }),
        ...(row.fields.navOrder === undefined ? {} : { navOrder: row.fields.navOrder.source }),
        ...(row.fields.navGroup === undefined ? {} : { navGroup: row.fields.navGroup.source }),
        ...(row.fields.navActiveFor === undefined ? {} : { navActiveFor: row.fields.navActiveFor.source }),
        ...(row.fields.navIcon === undefined ? {} : { navIcon: row.fields.navIcon.source }),
        ...(row.fields.navHidden === undefined ? {} : { navHidden: row.fields.navHidden.source }),
        ...(row.fields.enabled === undefined ? {} : { enabled: row.fields.enabled.source }),
      },
    });
  }

  // Путь принадлежит одному маршруту (`ui-routes`, Решение 3): шаблоны,
  // различающиеся только именами параметров, — тот же адрес.
  const byNormalized = new Map<string, RouteEntry>();
  for (const entry of entries) {
    const key = normalizedTemplate(entry.definition.path);
    const existing = byNormalized.get(key);
    if (existing !== undefined) {
      throw new BurnexError(
        `Path ${entry.definition.path} is taken by routes ${existing.id} (${existing.sources.path.file}) and ${entry.id} (${entry.sources.path.file})`,
        {
          at: entry.id,
          hint: `One path, one route: edit row ${existing.id} under its own id instead of adding a second row for the same path`,
        },
      );
    }
    byNormalized.set(key, entry);
  }

  return { table: entries.map((entry) => entry.definition), entries, disabled, failures, navGroups: mergeGroups(layers) };
}

/** Имя файла слоя, в который пишет витрина, — для подсказок и для `POST /api/routes`. */
export type WritableRouteLayer = 'home' | 'project';

export function writableLayerPath(layer: WritableRouteLayer, options: RouteBuildOptions): string {
  if (layer === 'home') return homeRoutesPath(options.home);
  if (options.projectRoot === undefined) {
    throw new BurnexError('The daemon does not know the project root: there is nowhere to write the project routes layer', {
      hint: 'Start the dashboard in the project directory (burnex up) or save the route to the home layer',
    });
  }
  return projectRoutesPath(options.projectRoot);
}

/**
 * Открыть файл слоя как `Document` библиотеки `yaml` для записи: комментарии,
 * порядок прочих строк и форматирование пользователя переживают правку
 * (`ui-routes`, Решение 11). Файл, который не разбирается, не переписывается —
 * отказ называет место разбора. `text` — прежнее содержимое файла
 * (`undefined` — файла не было): им запись откатывается, если таблица после
 * неё не собралась.
 */
function openLayerDocument(path: string): { doc: Document; text: string | undefined } {
  if (!existsSync(path)) return { doc: new Document({ routes: [] }), text: undefined };

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new BurnexError(`Routes file cannot be read: ${path}`, {
      file: path,
      hint: (error as NodeJS.ErrnoException).message,
      cause: error,
    });
  }
  const doc = parseDocument(text);
  // `parseDocument` на синтаксической ошибке не бросает — она едет списком
  // `doc.errors`, и без этой проверки сохранение переписывало бы файл,
  // который чтение слоя (`parse`, выше) считает сломанным, по своему
  // «как получится» разбору (`ui-routes`, «Файл, который не разбирается, не
  // переписывается»).
  const parseFailure = doc.errors[0];
  if (parseFailure !== undefined) {
    const pos = parseFailure.linePos?.[0];
    throw new BurnexError(`Routes file ${path} is not valid YAML, write cancelled: ${parseFailure.message}`, {
      file: path,
      ...(pos === undefined ? {} : { at: `line ${pos.line}, column ${pos.col}` }),
      hint: 'Fix the file by hand before saving from the dashboard',
    });
  }
  const existing = RouteDocumentSchema.safeParse(doc.toJS());
  if (!existing.success) {
    const failure = describeSchemaFailure(existing.error);
    throw new BurnexError(`Routes file ${path} does not match the format, write cancelled: ${failure.message}`, {
      file: path,
      ...(failure.at === undefined ? {} : { at: failure.at }),
      hint: 'Fix the file by hand before saving from the dashboard',
    });
  }
  return { doc, text };
}

/** Запись через временный файл и переименование: наблюдатель и чтение слоя не видят файла, записанного наполовину. */
function saveLayerDocument(path: string, doc: Document): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, doc.toString(), 'utf8');
  renameSync(temporary, path);
}

/** Листья `nav`, которых форма экрана «Маршруты» не знает: запись строки из неё не должна их стирать. */
const NAV_LEAVES_KEPT_ON_ROW_WRITE = ['active_for', 'icon', 'hidden'] as const;

/**
 * Записать строку маршрута в файл слоя. Строка заменяется целиком, кроме
 * листьев `nav`, которые пишет экран меню и поставка (`icon`, `hidden`,
 * `active_for`): строка, пришедшая без них, оставляет уже записанные.
 */
export function writeRouteRow(layer: WritableRouteLayer, row: RouteRowDocument, options: RouteBuildOptions): void {
  const path = writableLayerPath(layer, options);
  const { doc } = openLayerDocument(path);

  const rows = (doc.toJS() as RouteFileDocument).routes;
  const index = rows.findIndex((existingRow) => existingRow.id === row.id);
  if (index === -1) {
    doc.addIn(['routes', rows.length], row);
  } else {
    const kept: Record<string, unknown> = {};
    const existingNav = (rows[index] as RouteRowDocument).nav;
    for (const leaf of NAV_LEAVES_KEPT_ON_ROW_WRITE) {
      if (existingNav?.[leaf] !== undefined && row.nav?.[leaf] === undefined) kept[leaf] = existingNav[leaf];
    }
    const nav = { ...kept, ...row.nav };
    doc.setIn(['routes', index], Object.keys(nav).length === 0 ? row : { ...row, nav });
  }

  saveLayerDocument(path, doc);
}

/**
 * Правка меню одним запросом экрана «Navigation»: только названные листья.
 * У пункта `null` в `title`, `order`, `icon`, `hidden` снимает собственный
 * лист слоя (значение снова берётся из нижних слоёв), а `group: null`
 * пишется как есть — это явное «без группы». У группы `null` в `title` и
 * `order` снимает лист; `removeGroups` убирает объявление группы из слоя.
 */
export const NavPatchSchema = z
  .object({
    routes: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: z.string().min(1).nullable().optional(),
            order: z.number().nullable().optional(),
            group: z.string().min(1).nullable().optional(),
            icon: NavIconSchema.nullable().optional(),
            hidden: z.boolean().nullable().optional(),
          })
          .strict(),
      )
      .optional(),
    groups: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: z.string().min(1).nullable().optional(),
            order: z.number().nullable().optional(),
          })
          .strict(),
      )
      .optional(),
    removeGroups: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type NavPatch = z.infer<typeof NavPatchSchema>;

/** Листья `nav`, которыми распоряжается экран меню; `active_for` — не его забота и сбросом не снимается. */
const NAV_MENU_LEAVES = ['title', 'order', 'group', 'icon', 'hidden'] as const;

/** Индекс строки списка `key` с названным `id`; строки нет — она добавляется одним `id`. */
function ensureListRow(doc: Document, key: 'routes' | 'nav_groups', id: string): number {
  // Узлы, а не голые значения: в строку, добавленную объектом JS, `setIn` листа уже не войдёт.
  if (doc.get(key) === undefined) doc.set(key, doc.createNode([]));
  const rows = ((doc.toJS() as Record<string, unknown>)[key] ?? []) as readonly { id: string }[];
  const index = rows.findIndex((row) => row.id === id);
  if (index !== -1) return index;
  doc.addIn([key, rows.length], doc.createNode({ id }));
  return rows.length;
}

/**
 * Убрать из слоя то, что после правки ничего не объявляет: пустой `nav`,
 * строку маршрута из одного `id` и пустую секцию групп. Строка из одного
 * `id` законна, но бессмысленна, а копить такие в файле пользователя незачем.
 */
function pruneEmptyNav(doc: Document): void {
  const js = doc.toJS() as { routes?: readonly Record<string, unknown>[]; nav_groups?: readonly unknown[] };
  const routes = js.routes ?? [];
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    const row = routes[index] as Record<string, unknown>;
    const nav = row.nav as Record<string, unknown> | undefined;
    const navEmpty = nav !== undefined && Object.keys(nav).length === 0;
    if (navEmpty) doc.deleteIn(['routes', index, 'nav']);
    const keys = Object.keys(row).filter((key) => !(key === 'nav' && navEmpty));
    if (keys.length === 1 && keys[0] === 'id') doc.deleteIn(['routes', index]);
  }
  if (js.nav_groups !== undefined && js.nav_groups.length === 0) doc.delete('nav_groups');
}

/**
 * Сохранить файл слоя и проверить, что таблица с ним собирается; отказ
 * сборки возвращает файл к прежнему содержимому и уходит вызывающему —
 * правка меню не должна оставить витрину на «последней успешной таблице».
 */
function saveLayerChecked(path: string, doc: Document, previous: string | undefined, options: RouteBuildOptions): void {
  saveLayerDocument(path, doc);
  try {
    buildRouteTable(options);
  } catch (error) {
    if (previous === undefined) rmSync(path, { force: true });
    else writeFileSync(path, previous, 'utf8');
    throw error;
  }
}

/** Применить правку меню к файлу слоя — только названные листья, остальное содержимое файла не тронуто. */
export function writeNavPatch(layer: WritableRouteLayer, patch: NavPatch, options: RouteBuildOptions): void {
  const path = writableLayerPath(layer, options);
  const { doc, text } = openLayerDocument(path);

  for (const { id, ...leaves } of patch.routes ?? []) {
    const index = ensureListRow(doc, 'routes', id);
    for (const leaf of NAV_MENU_LEAVES) {
      const value = leaves[leaf];
      if (value === undefined) continue;
      if (value === null && leaf !== 'group') doc.deleteIn(['routes', index, 'nav', leaf]);
      else doc.setIn(['routes', index, 'nav', leaf], value);
    }
  }

  for (const { id, ...leaves } of patch.groups ?? []) {
    const index = ensureListRow(doc, 'nav_groups', id);
    for (const leaf of ['title', 'order'] as const) {
      const value = leaves[leaf];
      if (value === undefined) continue;
      if (value === null) doc.deleteIn(['nav_groups', index, leaf]);
      else doc.setIn(['nav_groups', index, leaf], value);
    }
  }

  for (const id of patch.removeGroups ?? []) {
    const groups = (doc.toJS() as RouteFileDocument).nav_groups ?? [];
    const index = groups.findIndex((group) => group.id === id);
    if (index !== -1) doc.deleteIn(['nav_groups', index]);
  }

  pruneEmptyNav(doc);
  saveLayerChecked(path, doc, text, options);
}

/**
 * Снять из слоя все настройки меню: листья `nav`, которыми распоряжается
 * экран меню, и объявления групп. Пути, цели, `active_for` и собственные
 * маршруты пользователя остаются; его маршрут без `nav` из меню пропадает,
 * адрес по-прежнему открывается.
 */
export function resetNav(layer: WritableRouteLayer, options: RouteBuildOptions): void {
  const path = writableLayerPath(layer, options);
  if (!existsSync(path)) return;
  const { doc, text } = openLayerDocument(path);

  const rows = (doc.toJS() as RouteFileDocument).routes;
  rows.forEach((row, index) => {
    for (const leaf of NAV_MENU_LEAVES) {
      if (row.nav?.[leaf] !== undefined) doc.deleteIn(['routes', index, 'nav', leaf]);
    }
  });
  if (doc.get('nav_groups') !== undefined) doc.delete('nav_groups');

  pruneEmptyNav(doc);
  saveLayerChecked(path, doc, text, options);
}
