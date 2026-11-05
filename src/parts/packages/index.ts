import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describePackageFailure, readPackageManifest, type PackageFailure, type PackageManifest } from './manifest.js';
import { cabinetDir } from '../../kernel/dirs.js';

/**
 * Указатель пакетов (`packages-directory-layer`, design.md, Решения 1, 3, 4):
 * один обход двух корней, на котором строятся порядок поиска всех видов
 * ресурсов, затенение и конфликт внутри слоя. Семь обходов шагов, скриптов,
 * плагинов, виджетов, дашбордов, маршрутов и пайплайнов каждый хранил бы своё
 * правило затенения — и расходились бы, как уже разошлись наборы их слоёв.
 *
 * Указатель синхронный и без кеша: обходы, которые он заменяет, синхронны, а
 * демон пересобирает составы по отпечаткам каталогов (Решение 8).
 */

export type PackageLayer = 'project' | 'home';

export interface PackageEntry {
  readonly name: string;
  readonly layer: PackageLayer;
  readonly dir: string;
  /** Ровно одно из двух: манифест прошёл проверку либо пакет сломан с причиной. */
  readonly manifest?: PackageManifest;
  readonly failure?: PackageFailure;
  /** Пакет home, затенённый одноимённым пакетом проекта (целиком, в том числе сломанным). */
  readonly shadowedBy?: PackageLayer;
}

export interface PackageIndex {
  /** Пакеты слоя проекта, затем слоя home — в порядке имён каталогов внутри слоя. */
  readonly packages: readonly PackageEntry[];
}

export interface PackageRoots {
  /** Корень проекта; без него (демон вне проекта) слой пакетов проекта пуст. */
  readonly projectRoot?: string;
  /** Путь глобального конфига: пакеты home лежат рядом с ним, а не в `~/.burnex` (Решение 1). */
  readonly globalPath: string;
}

/** Каталог пакетов слоя проекта. */
export function projectPackagesDir(projectRoot: string): string {
  return join(cabinetDir(projectRoot), 'packages');
}

/** Каталог пакетов home — рядом с глобальным конфигом, чтобы подставной путь конфигурации оставался без пользовательских пакетов. */
export function homePackagesDir(globalPath: string): string {
  return join(dirname(globalPath), 'packages');
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Имена каталогов верхнего уровня, отсортированные; файл и скрытый каталог пакетом не считаются. */
function listPackageNames(packagesDir: string): readonly string[] {
  let names: string[];
  try {
    names = readdirSync(packagesDir);
  } catch {
    // Каталога нет либо он исчез между отпечатком и сборкой — законное состояние.
    return [];
  }
  return names.filter((name) => !name.startsWith('.') && isDirectory(join(packagesDir, name))).sort();
}

function scanLayer(layer: PackageLayer, packagesDir: string): readonly PackageEntry[] {
  return listPackageNames(packagesDir).map((name) => {
    const dir = join(packagesDir, name);
    const result = readPackageManifest(dir);
    return result.ok ? { name, layer, dir, manifest: result.manifest } : { name, layer, dir, failure: result.failure };
  });
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

export function buildPackageIndex(roots: PackageRoots): PackageIndex {
  const projectDir = roots.projectRoot === undefined ? undefined : projectPackagesDir(roots.projectRoot);
  const homeDir = homePackagesDir(roots.globalPath);

  const project = projectDir === undefined ? [] : scanLayer('project', projectDir);
  // Проект в самом домашнем каталоге: оба слоя — один каталог, и пакет затенял
  // бы сам себя. Слой пакетов home тогда пуст, а пакеты остаются пакетами проекта.
  const homeIsProject = projectDir !== undefined && sameDirectory(projectDir, homeDir);
  const projectNames = new Set(project.map((entry) => entry.name));
  const home = homeIsProject
    ? []
    : scanLayer('home', homeDir).map((entry): PackageEntry =>
        projectNames.has(entry.name) ? { ...entry, shadowedBy: 'project' } : entry,
      );

  return { packages: [...project, ...home] };
}

/** Действующие пакеты слоя: исправные и не затенённые. */
export function activePackages(index: PackageIndex, layer: PackageLayer): readonly PackageEntry[] {
  return index.packages.filter(
    (entry) => entry.layer === layer && entry.manifest !== undefined && entry.shadowedBy === undefined,
  );
}

/** Сломанные пакеты, участвующие в поиске (затенённый сломанный пакет home в нём не участвует вовсе). */
export function brokenPackages(index: PackageIndex): readonly PackageEntry[] {
  return index.packages.filter((entry) => entry.failure !== undefined && entry.shadowedBy === undefined);
}

/** Одной строкой: «сломан пакет X: причина» — для промаха поиска, чтобы он не выглядел обычным «нет такого». */
export function describeBrokenPackages(index: PackageIndex): readonly string[] {
  return brokenPackages(index).map(
    (entry) => `пакет ${entry.name} (${entry.layer === 'project' ? 'проект' : 'home'}) сломан: ${describePackageFailure(entry.failure!)}`,
  );
}

/** Действующий пакет по имени: проект выше home; затенённый и сломанный не найдутся. */
export function findPackage(
  index: PackageIndex,
  name: string,
): { readonly entry: PackageEntry } | { readonly broken: PackageEntry } | undefined {
  const entry = index.packages.find((candidate) => candidate.name === name && candidate.shadowedBy === undefined);
  if (entry === undefined) return undefined;
  return entry.manifest === undefined ? { broken: entry } : { entry };
}

export type ResourceKind = 'steps' | 'scripts' | 'plugins' | 'widgets' | 'dashboards' | 'routes' | 'pipelines';

/** Подкаталог ресурса в свободной раскладке `.burnex/` и в пакете; у маршрутов — один файл. */
const RESOURCE_PATH: Readonly<Record<ResourceKind, string>> = {
  steps: 'steps',
  scripts: 'scripts',
  plugins: 'plugins',
  widgets: 'widgets',
  dashboards: 'dashboards',
  routes: 'routes.yml',
  pipelines: 'pipelines',
};

/**
 * Слои, которые у вида ресурса есть сегодня: «встроенное» — слой поставки,
 * «project»/«home» — свободные каталоги. Пакетные слои добавляются ко всем
 * видам; недостающие свободные слои указатель не выдумывает (Решение 1):
 * виджеты не читаются из home, дашборды не имеют встроенного.
 */
const FREE_LAYERS: Readonly<Record<ResourceKind, { project: boolean; home: boolean; builtin: boolean }>> = {
  steps: { project: true, home: true, builtin: true },
  scripts: { project: true, home: true, builtin: true },
  plugins: { project: true, home: true, builtin: false },
  widgets: { project: true, home: false, builtin: false },
  dashboards: { project: true, home: true, builtin: false },
  routes: { project: true, home: true, builtin: true },
  pipelines: { project: true, home: false, builtin: false },
};

export interface PackageResourcePath {
  readonly package: string;
  /** Каталог ресурса пакета (`<пакет>/steps`) либо файл (`<пакет>/routes.yml`). */
  readonly path: string;
}

export type ResourceLayer =
  /** Свободный каталог (или файл маршрутов) слоя. */
  | { readonly source: 'project' | 'home'; readonly path: string }
  | { readonly source: 'project-packages' | 'home-packages'; readonly packages: readonly PackageResourcePath[] }
  /** Каталог поставки известен потребителю, а не указателю. */
  | { readonly source: 'builtin' };

export interface ResourceLayerRoots {
  readonly projectRoot?: string;
  /** Каталог глобального конфига — корень свободных ресурсов home. */
  readonly homeStepcastDir: string;
}

/**
 * Упорядоченные слои вида ресурса: свободный проект → пакеты проекта →
 * свободный home → пакеты home → встроенное (первый найденный побеждает;
 * маршруты сливаются в обратном порядке). Слой пакетов присутствует всегда,
 * пусть и пустой: потребителю не нужна особая ветвь для «пакетов нет».
 */
export function resourceLayers(index: PackageIndex, kind: ResourceKind, roots: ResourceLayerRoots): readonly ResourceLayer[] {
  const relative = RESOURCE_PATH[kind];
  const free = FREE_LAYERS[kind];
  const packagesOf = (layer: PackageLayer): readonly PackageResourcePath[] =>
    activePackages(index, layer).map((entry) => ({ package: entry.name, path: join(entry.dir, relative) }));

  const layers: ResourceLayer[] = [];
  if (free.project && roots.projectRoot !== undefined) {
    layers.push({ source: 'project', path: join(cabinetDir(roots.projectRoot), relative) });
  }
  layers.push({ source: 'project-packages', packages: packagesOf('project') });
  if (free.home) layers.push({ source: 'home', path: join(roots.homeStepcastDir, relative) });
  layers.push({ source: 'home-packages', packages: packagesOf('home') });
  if (free.builtin) layers.push({ source: 'builtin' });
  return layers;
}

export type PackageLookup =
  | { readonly kind: 'found'; readonly package: string; readonly path: string }
  | { readonly kind: 'miss' }
  /** Два пакета одного слоя приносят ресурс одного имени: не разрешается ни в один и не проваливается вниз. */
  | { readonly kind: 'conflict'; readonly packages: readonly [string, string]; readonly paths: readonly [string, string] };

/**
 * Поиск ресурса по имени в слое пакетов. `locate` возвращает путь ресурса
 * внутри каталога вида либо `undefined`, если его там нет. Больше двух
 * пакетов с одним именем конфликт всё равно называет двух — первых по имени.
 */
export function lookupInPackages(
  packages: readonly PackageResourcePath[],
  locate: (resourcePath: string) => string | undefined,
): PackageLookup {
  const found: { package: string; path: string }[] = [];
  for (const candidate of packages) {
    const path = locate(candidate.path);
    if (path !== undefined) found.push({ package: candidate.package, path });
  }
  const [first, second] = found;
  if (first === undefined) return { kind: 'miss' };
  if (second === undefined) return { kind: 'found', package: first.package, path: first.path };
  return { kind: 'conflict', packages: [first.package, second.package], paths: [first.path, second.path] };
}

/** Причина отказа конфликта: ресурс и оба пакета. */
export function describeConflict(resourceKind: string, name: string, packages: readonly [string, string]): string {
  return `${resourceKind} ${name} приносят два пакета одного слоя — ${packages[0]} и ${packages[1]}`;
}

const PIPELINE_SUFFIXES = ['.yml', '.yaml'] as const;

/** Имена пайплайнов пакета (`pipelines/<имя>.yml|.yaml`), отсортированные и без повторов. */
export function listPackagePipelineNames(packageDir: string): readonly string[] {
  let names: string[];
  try {
    names = readdirSync(join(packageDir, 'pipelines'));
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const file of names) {
    const suffix = PIPELINE_SUFFIXES.find((candidate) => file.endsWith(candidate));
    if (suffix !== undefined && file.length > suffix.length) found.add(file.slice(0, -suffix.length));
  }
  return [...found].sort();
}

/** Файл пайплайна пакета по имени; `.yml` предпочтительнее `.yaml`. */
export function packagePipelineFile(packageDir: string, name: string): string | undefined {
  for (const suffix of PIPELINE_SUFFIXES) {
    const path = join(packageDir, 'pipelines', `${name}${suffix}`);
    if (existsSync(path)) return path;
  }
  return undefined;
}
