import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { listPackagePipelineNames, type PackageEntry, type PackageIndex, type PackageLayer, type ResourceKind } from './index.js';
import { describePackageFailure, type PackageNeeds } from './manifest.js';

/**
 * Сводка пакетов для людей и машин (`packages-directory-layer`, design.md,
 * Решение 9): одна модель на `stepcast package list`, его `--json` и
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

/** Виды, у которых в пакете есть хотя бы один ресурс. Порядок — порядок поиска документации. */
export function packageProvides(packageDir: string): readonly ResourceKind[] {
  const provides: ResourceKind[] = [];
  if (listPackagePipelineNames(packageDir).length > 0) provides.push('pipelines');
  if (entriesOf(join(packageDir, 'steps')).some((name) => existsSync(join(packageDir, 'steps', name, 'step.yml')))) {
    provides.push('steps');
  }
  if (entriesOf(join(packageDir, 'scripts')).length > 0) provides.push('scripts');
  if (entriesOf(join(packageDir, 'plugins')).some((name) => isDirectory(join(packageDir, 'plugins', name)))) {
    provides.push('plugins');
  }
  if (entriesOf(join(packageDir, 'widgets')).some((name) => name.endsWith('.tsx'))) provides.push('widgets');
  if (entriesOf(join(packageDir, 'dashboards')).some((name) => name.endsWith('.yml'))) provides.push('dashboards');
  if (existsSync(join(packageDir, 'routes.yml'))) provides.push('routes');
  return provides;
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
      provides: packageProvides(entry.dir),
      ...(unmet === undefined ? {} : { unmetNeeds: unmet }),
    };
  });
}
