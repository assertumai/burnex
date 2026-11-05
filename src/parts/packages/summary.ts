import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { describeConflict, listPackagePipelineNames, type PackageEntry, type PackageIndex, type PackageLayer, type ResourceKind } from './index.js';
import { describePackageFailure, type PackageNeeds } from './manifest.js';

/**
 * Сводка пакетов для людей и машин (`packages-directory-layer`, design.md,
 * Решение 9): одна модель на `burnex package list`, его `--json` и
 * `GET /api/packages` витрины — им негде разойтись.
 */

export type PackageStatus = 'ok' | 'broken' | 'shadowed';

export interface PackageSummary {
  readonly name: string;
  readonly layer: PackageLayer;
  readonly dir: string;
  readonly status: PackageStatus;
  /** Причина поломки; только при `status: 'broken'`. */
  readonly reason?: string;
  /** Слой пакета, затенившего этот; только при `status: 'shadowed'`. */
  readonly shadowedBy?: PackageLayer;
  /** Только у пакета с исправным манифестом. */
  readonly version?: string;
  readonly description?: string;
  /** Виды ресурсов, которые пакет приносит: подкаталог, где есть хоть один ресурс. */
  readonly provides: readonly ResourceKind[];
  /** Состав по именам; есть у пакета в любом статусе — у сломанного и затенённого он не участвует в поиске. */
  readonly contents: PackageContents;
  /** Объявленные потребности, которых не нашлось; справочно, статус они не меняют. */
  readonly unmetNeeds?: Partial<Record<keyof PackageNeeds, readonly string[]>>;
}

function entriesOf(dir: string): readonly string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const KIND_ORDER: readonly ResourceKind[] = ['pipelines', 'steps', 'scripts', 'plugins', 'widgets', 'dashboards', 'routes'];

/** Состав пакета: имена ресурсов по видам в порядке `ResourceKind`; пустой вид опущен. */
export type PackageContents = Partial<Record<ResourceKind, readonly string[]>>;

function namesWithSuffix(dir: string, suffix: string): readonly string[] {
  return entriesOf(dir)
    .filter((name) => name.endsWith(suffix) && name.length > suffix.length)
    .map((name) => name.slice(0, -suffix.length))
    .sort();
}

/**
 * `id` строк `routes.yml` пакета. Файл, который не читается или не
 * разбирается, даёт пустой список без исключения: причину отказа называет
 * состав маршрутов демона, а сводке для `package list` падать нельзя.
 */
function routeIds(packageDir: string): readonly string[] {
  try {
    const document = parseYaml(readFileSync(join(packageDir, 'routes.yml'), 'utf8')) as { routes?: unknown } | null;
    const rows = document?.routes;
    if (!Array.isArray(rows)) return [];
    const ids = rows.flatMap((row: unknown) => {
      const id = (row as { id?: unknown } | null)?.id;
      return typeof id === 'string' ? [id] : [];
    });
    return [...new Set(ids)].sort();
  } catch {
    return [];
  }
}

/** Что лежит в каталоге пакета — независимо от того, исправен ли пакет и участвует ли в поиске. */
export function packageContents(packageDir: string): PackageContents {
  const found: Record<ResourceKind, readonly string[]> = {
    pipelines: listPackagePipelineNames(packageDir),
    steps: entriesOf(join(packageDir, 'steps'))
      .filter((name) => existsSync(join(packageDir, 'steps', name, 'step.yml')))
      .sort(),
    scripts: entriesOf(join(packageDir, 'scripts'))
      .filter((name) => !isDirectory(join(packageDir, 'scripts', name)))
      .sort(),
    plugins: entriesOf(join(packageDir, 'plugins'))
      .filter((name) => isDirectory(join(packageDir, 'plugins', name)))
      .sort(),
    widgets: namesWithSuffix(join(packageDir, 'widgets'), '.tsx'),
    dashboards: namesWithSuffix(join(packageDir, 'dashboards'), '.yml'),
    routes: routeIds(packageDir),
  };
  const contents: Partial<Record<ResourceKind, readonly string[]>> = {};
  for (const kind of KIND_ORDER) if (found[kind].length > 0) contents[kind] = found[kind];
  return contents;
}

/**
 * Виды, которые пакет приносит: ключи состава, плюс `routes` по наличию
 * файла — даже когда он не разобрался (вывод `package list` не меняется).
 */
function providesOf(packageDir: string, contents: PackageContents): readonly ResourceKind[] {
  return KIND_ORDER.filter(
    (kind) => contents[kind] !== undefined || (kind === 'routes' && existsSync(join(packageDir, 'routes.yml'))),
  );
}

/** Реестр бэкендов, если состав собран: имена зарегистрированных бэкендов; `undefined` — сверять не с чем. */
export interface NeedsContext {
  readonly backends?: ReadonlySet<string>;
}

function unmetNeeds(
  entry: PackageEntry,
  index: PackageIndex,
  context: NeedsContext,
): PackageSummary['unmetNeeds'] | undefined {
  const needs = entry.manifest?.needs;
  if (needs === undefined) return undefined;

  const active = new Set(
    index.packages.filter((candidate) => candidate.manifest !== undefined && candidate.shadowedBy === undefined).map((candidate) => candidate.name),
  );
  const missing: Partial<Record<keyof PackageNeeds, readonly string[]>> = {
    ...(needs.packages.some((name) => !active.has(name))
      ? { packages: needs.packages.filter((name) => !active.has(name)) }
      : {}),
    // Реестра нет (состав не собран) — не сверяем: «не проверено» не значит «не хватает».
    ...(context.backends !== undefined && needs.backends.some((name) => !context.backends!.has(name))
      ? { backends: needs.backends.filter((name) => !context.backends!.has(name)) }
      : {}),
    // `mcp` и `secrets` печатаются как объявлены, без проверки: источника истины для них у пакета нет.
    ...(needs.mcp.length > 0 ? { mcp: needs.mcp } : {}),
    ...(needs.secrets.length > 0 ? { secrets: needs.secrets } : {}),
  };
  return Object.keys(missing).length === 0 ? undefined : missing;
}

export function summarizePackages(index: PackageIndex, context: NeedsContext = {}): readonly PackageSummary[] {
  return index.packages.map((entry): PackageSummary => {
    const status: PackageStatus =
      entry.shadowedBy !== undefined ? 'shadowed' : entry.failure !== undefined ? 'broken' : 'ok';
    const unmet = unmetNeeds(entry, index, context);
    const contents = packageContents(entry.dir);
    return {
      name: entry.name,
      layer: entry.layer,
      dir: entry.dir,
      status,
      ...(status === 'broken' && entry.failure !== undefined ? { reason: describePackageFailure(entry.failure) } : {}),
      ...(entry.shadowedBy === undefined ? {} : { shadowedBy: entry.shadowedBy }),
      ...(entry.manifest === undefined
        ? {}
        : { version: entry.manifest.version, description: entry.manifest.description }),
      provides: providesOf(entry.dir, contents),
      contents,
      ...(unmet === undefined ? {} : { unmetNeeds: unmet }),
    };
  });
}

/**
 * Отказ ресурса пакета в форме, общей для сводки и ответа демона
 * (`GET /api/packages`, `problems`): один пакет в `packages` — отказ файла,
 * два и больше — конфликт имени в слое.
 */
export interface PackageProblem {
  readonly layer: PackageLayer;
  readonly packages: readonly string[];
  readonly kind: ResourceKind;
  /** Имя ресурса; нет у нечитаемого `routes.yml` целиком. */
  readonly id?: string;
  readonly file?: string;
  readonly message: string;
}

/**
 * Имена, которые приносят два и более действующих пакета одного слоя. Вид
 * `pipelines` пропущен: адрес пайплайна несёт имя пакета, и конфликтовать ему
 * нечем. Сломанный и затенённый пакет в поиске не участвуют и конфликта не
 * дают — как в `lookupInPackages`. Порядок: слой project, затем home, внутри —
 * по виду и имени.
 *
 * Плагин с `id` из `reservedPluginIds` (имя встроенной строки) конфликта не
 * даёт: такой каталог отказывает в каждом пакете сам по себе
 * (`packagePluginOperations`), и правила функции и состава должны совпадать.
 */
export function packageConflicts(
  summaries: readonly PackageSummary[],
  options: { readonly reservedPluginIds?: readonly string[] } = {},
): readonly PackageProblem[] {
  const reserved = new Set(options.reservedPluginIds ?? []);
  const conflicts: PackageProblem[] = [];
  for (const layer of ['project', 'home'] as const) {
    const active = summaries.filter((summary) => summary.layer === layer && summary.status === 'ok');
    for (const kind of KIND_ORDER) {
      if (kind === 'pipelines') continue;
      const owners = new Map<string, string[]>();
      for (const summary of active) {
        for (const id of summary.contents[kind] ?? []) owners.set(id, [...(owners.get(id) ?? []), summary.name]);
      }
      for (const id of [...owners.keys()].sort()) {
        const names = [...(owners.get(id) as string[])].sort();
        const [first, second] = names;
        if (first === undefined || second === undefined) continue;
        if (kind === 'plugins' && reserved.has(id)) continue;
        conflicts.push({ layer, kind, id, packages: names, message: describeConflict(kind, id, [first, second]) });
      }
    }
  }
  return conflicts;
}
