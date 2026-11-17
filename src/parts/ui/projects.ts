import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { BurnexError } from '../../kernel/errors.js';
import { findProjectRoot, projectKey } from '../pipeline/run/journal/paths.js';
import { listProjects, listRunsByKey, type ProjectEntry } from '../pipeline/run/journal/reader.js';
import { atomicWrite } from '../pipeline/run/journal/writer.js';

/**
 * Реестр проектов витрины: проекты, которые пользователь добавил сам.
 *
 * Указатель `projects.json` пишет каждый прогон — в том числе прогон из
 * временного каталога, — поэтому по нему витрина показывала всё, что когда-либо
 * запускалось на машине. Реестр — отдельный файл рядом: его пишет только
 * экран «Projects», и уборка осиротевших записей указателя его не трогает.
 *
 * Пока файла нет, витрина показывает все проекты указателя, как раньше:
 * установка, обновившаяся до этой версии, не должна открыться пустой. С первым
 * добавленным проектом файл появляется, и показываются только добавленные.
 */
export const REGISTRY_FILE = 'added-projects.json';

interface RegistryEntry {
  readonly path: string;
  readonly added_at: string;
}

type Registry = Record<string, RegistryEntry>;

/** `undefined` — реестр не заведён (или нечитаем): действует показ всех проектов. */
function readRegistry(runsRoot: string): Registry | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(runsRoot, REGISTRY_FILE), 'utf8')) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const registry: Registry = {};
    for (const [key, entry] of Object.entries(raw as Record<string, Partial<RegistryEntry>>)) {
      if (typeof entry?.path !== 'string') continue;
      registry[key] = { path: entry.path, added_at: typeof entry.added_at === 'string' ? entry.added_at : '' };
    }
    return registry;
  } catch {
    return undefined;
  }
}

function writeRegistry(runsRoot: string, registry: Registry): void {
  atomicWrite(join(runsRoot, REGISTRY_FILE), `${JSON.stringify(registry, null, 2)}\n`);
}

/**
 * Проекты, которые показывает витрина, — замена `listProjects` для всех её
 * экранов. Добавленный проект виден и до первого прогона: каталога прогонов у
 * него ещё нет, но пайплайны, секреты и расписания читаются из его корня.
 */
export function shownProjects(runsRoot: string): ProjectEntry[] {
  const registry = readRegistry(runsRoot);
  if (registry === undefined) return listProjects(runsRoot);
  return Object.keys(registry)
    .sort()
    .map((key) => ({ key, path: registry[key]!.path }));
}

export interface ProjectView {
  readonly key: string;
  readonly path: string;
  /** Каталог проекта на месте: пропавший остаётся в списке, чтобы его можно было убрать. */
  readonly exists: boolean;
  readonly runs: number;
  readonly latestRun?: string;
  readonly addedAt?: string;
}

export interface ProjectsOverview {
  /** Реестр заведён: показываются только `projects`. Иначе — все проекты указателя. */
  readonly registered: boolean;
  readonly projects: readonly ProjectView[];
  readonly generatedAt: string;
}

function toView(runsRoot: string, key: string, path: string, addedAt?: string): ProjectView {
  const runs = listRunsByKey(runsRoot, key);
  return {
    key,
    path,
    exists: existsSync(path),
    runs: runs.length,
    ...(runs[0] === undefined ? {} : { latestRun: runs[0] }),
    ...(addedAt === undefined || addedAt === '' ? {} : { addedAt }),
  };
}

export function buildProjects(runsRoot: string, now: Date = new Date()): ProjectsOverview {
  const registry = readRegistry(runsRoot);
  const added = registry ?? {};
  const projects = Object.keys(added)
    .sort()
    .map((key) => toView(runsRoot, key, added[key]!.path, added[key]!.added_at));
  return { registered: registry !== undefined, projects, generatedAt: now.toISOString() };
}

function refuse(message: string): never {
  throw new BurnexError(message);
}

/**
 * Добавляет проект по абсолютному пути. В реестр идёт корень проекта — тот же,
 * под ключом которого прогон пишет журнал (`findProjectRoot`): путь вглубь
 * репозитория иначе завёл бы запись, у которой никогда не будет прогонов.
 */
export function addProject(runsRoot: string, rawPath: string, now: Date = new Date()): ProjectView {
  const path = rawPath.trim();
  if (!isAbsolute(path)) refuse(`Project path must be absolute: ${rawPath}`);
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) refuse(`Project path is not an existing directory: ${path}`);

  const root = findProjectRoot(path);
  const key = projectKey(root);
  const registry = readRegistry(runsRoot) ?? {};
  const entry = registry[key] ?? { path: root, added_at: now.toISOString() };
  writeRegistry(runsRoot, { ...registry, [key]: entry });
  return toView(runsRoot, key, entry.path, entry.added_at);
}

/** Убирает проект из реестра. Журналы прогонов остаются на диске — это забота уборки. */
export function removeProject(runsRoot: string, key: string): void {
  const registry = readRegistry(runsRoot);
  if (registry === undefined || !(key in registry)) refuse(`Project ${key} is not in the added projects registry`);
  const { [key]: _removed, ...rest } = registry;
  writeRegistry(runsRoot, rest);
}

const PICK_PROMPT = 'Select a project folder';

/** Команда системного диалога выбора папки; `undefined` — платформа его не даёт. */
function pickerCommand(platform: NodeJS.Platform): readonly [string, readonly string[]] | undefined {
  if (platform === 'darwin') {
    return [
      'osascript',
      ['-e', 'tell current application to activate', '-e', `POSIX path of (choose folder with prompt "${PICK_PROMPT}")`],
    ];
  }
  if (platform === 'win32') {
    return [
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
          `$d.Description = '${PICK_PROMPT}'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }`,
      ],
    ];
  }
  if (platform === 'linux') return ['zenity', ['--file-selection', '--directory', `--title=${PICK_PROMPT}`]];
  return undefined;
}

/**
 * Системный диалог выбора папки на машине демона. Страница в браузере пути
 * выбранной папки не узнаёт (File System Access API его не отдаёт), а демон
 * работает на той же машине, что и пользователь, — диалог открывает он.
 * `undefined` — пользователь закрыл диалог, ничего не выбрав.
 */
export function pickDirectory(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const command = pickerCommand(platform);
  if (command === undefined) refuse(`Folder picker is not available on ${platform}: POST /api/projects with a path instead`);
  return new Promise((resolve, reject) => {
    execFile(command[0], [...command[1]], (error, stdout) => {
      const picked = stdout.trim();
      if (error === null) {
        resolve(picked === '' ? undefined : picked);
        return;
      }
      // Отмена диалога — ненулевой код возврата у всех трёх команд; команды,
      // которой нет на машине, — отказ запуска (`ENOENT`).
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new BurnexError(`Folder picker needs ${command[0]}, which is not installed: POST /api/projects with a path instead`));
        return;
      }
      resolve(undefined);
    });
  });
}
