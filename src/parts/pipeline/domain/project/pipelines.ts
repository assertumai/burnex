import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  activePackages,
  buildPackageIndex,
  listPackagePipelineNames,
  packagePipelineFile,
  type PackageLayer,
} from '../../../packages/index.js';

/**
 * Обход файлов-кандидатов пайплайна в проекте.
 *
 * Общий модуль для витрины (`src/parts/ui/pipelines.ts`) и планировщика расписания:
 * оба ищут одни и те же файлы одним и тем же правилом, и раздваивать его —
 * плодить два места, которые могут разойтись.
 *
 * Обход намеренно мелкий: корневой `stepcast.yml` и `.stepcast/pipelines/*.yml`
 * — раскладка, которую заводит `stepcast init` и которой держится сам проект.
 * Полный обход дерева проекта стоил бы дорого и находил бы чужие YAML.
 */

/** Каталог пайплайнов проекта относительно его корня. */
const PIPELINE_DIR = join('.stepcast', 'pipelines');

/** Пайплайн ли это. Определение работы лежит в таком же `.yml` и им не является. */
export function isPipelineFile(path: string): boolean {
  try {
    // Достаточно шапки: `kind` объявляется в первых строках документа.
    return /^kind:\s*pipeline\s*$/m.test(readFileSync(path, 'utf8').slice(0, 4096));
  } catch {
    return false;
  }
}

/** Файлы-кандидаты пайплайна проекта, в порядке от корневого к каталогу пайплайнов. */
export function listPipelineFiles(projectPath: string): string[] {
  const out: string[] = [];
  const root = join(projectPath, 'stepcast.yml');
  if (existsSync(root)) out.push(root);

  const dir = join(projectPath, PIPELINE_DIR);
  try {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.yml') || name.endsWith('.yaml')) out.push(join(dir, name));
    }
  } catch {
    // Каталога пайплайнов у проекта может не быть — это не ошибка.
  }
  return out.filter(isPipelineFile);
}

/** Пайплайн перечня: файл проекта либо пайплайн пакета с адресом `<пакет>:<имя>`. */
export interface PipelineEntry {
  readonly path: string;
  /** Адрес, которым пайплайн пакета запускается; у файла проекта его нет. */
  readonly address?: string;
  /** Пакет и его слой — только у пайплайна пакета. */
  readonly package?: string;
  readonly packageLayer?: PackageLayer;
}

export interface PipelineEntriesOptions {
  /** Каталог глобального конфига: пакеты home лежат рядом. По умолчанию `~/.stepcast`. */
  readonly globalConfigDir?: string;
}

/**
 * Перечень пайплайнов проекта и действующих пакетов (`packages-directory-layer`,
 * Решение 7): сначала файлы проекта — ровно `listPipelineFiles`, — затем
 * пайплайны исправных незатенённых пакетов проекта и home в порядке имён.
 * Сломанный и затенённый пакет в перечень не входят: запустить из него нечего,
 * а причина видна в `stepcast package list`.
 */
export function listPipelineEntries(projectPath: string, options: PipelineEntriesOptions = {}): PipelineEntry[] {
  const entries: PipelineEntry[] = listPipelineFiles(projectPath).map((path) => ({ path }));

  const index = buildPackageIndex({
    projectRoot: projectPath,
    globalPath: join(options.globalConfigDir ?? join(homedir(), '.stepcast'), 'config.yml'),
  });
  for (const layer of ['project', 'home'] as const) {
    for (const pack of activePackages(index, layer)) {
      for (const name of listPackagePipelineNames(pack.dir)) {
        const path = packagePipelineFile(pack.dir, name);
        if (path === undefined || !isPipelineFile(path)) continue;
        entries.push({ path, address: `${pack.name}:${name}`, package: pack.name, packageLayer: layer });
      }
    }
  }
  return entries;
}
