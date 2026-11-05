import { existsSync, lstatSync, renameSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Имена каталогов и файлов движка на диске.
 *
 * Кабинет проекта — `.burnex/`, домашний каталог — `~/.burnex`, пайплайн по
 * умолчанию — `burnex.yml`. Прежние `.stepcast/`, `~/.stepcast` и
 * `stepcast.yml` читаются один выпуск переходного периода (`docs/release.md`,
 * «Переход со stepcast»): существующий прежний каталог берётся, когда нового
 * нет, и ровно один раз переименовывается — домашний при запуске CLI
 * (`migrateHomeRoot`), проектный пользователь переименовывает сам, о чём ему
 * говорят `burnex lint` и `burnex up`. Всё, что знает о двух именах,
 * собрано здесь — как у переменных окружения (`env-names.ts`) и имени пакета
 * (`package-name.ts`).
 */

export const CABINET_DIR_NAME = '.burnex';
export const LEGACY_CABINET_DIR_NAME = '.stepcast';
export const DEFAULT_PIPELINE_FILE = 'burnex.yml';
export const LEGACY_DEFAULT_PIPELINE_FILE = 'stepcast.yml';

/** Существующий из двух путей: новый, иначе прежний, иначе новый — его и заводить. */
function preferExisting(current: string, legacy: string): string {
  if (existsSync(current)) return current;
  if (existsSync(legacy)) return legacy;
  return current;
}

/** Кабинет проекта: `<root>/.burnex`, при его отсутствии и наличии `<root>/.stepcast` — тот. */
export function cabinetDir(root: string): string {
  return preferExisting(join(root, CABINET_DIR_NAME), join(root, LEGACY_CABINET_DIR_NAME));
}

/** Проект держит кабинет под прежним именем: `.stepcast/` есть, `.burnex/` нет. */
export function hasLegacyCabinet(root: string): boolean {
  return !existsSync(join(root, CABINET_DIR_NAME)) && existsSync(join(root, LEGACY_CABINET_DIR_NAME));
}

/** Домашний каталог движка: `~/.burnex`, при его отсутствии и наличии `~/.stepcast` — тот. */
export function homeRoot(home: string = homedir()): string {
  return preferExisting(join(home, CABINET_DIR_NAME), join(home, LEGACY_CABINET_DIR_NAME));
}

/** Пайплайн по умолчанию в каталоге: `burnex.yml`, при его отсутствии и наличии `stepcast.yml` — тот. */
export function defaultPipelineFile(cwd: string): string {
  return preferExisting(join(cwd, DEFAULT_PIPELINE_FILE), join(cwd, LEGACY_DEFAULT_PIPELINE_FILE));
}

export interface HomeMigration {
  readonly from: string;
  readonly to: string;
}

/**
 * Перенос домашнего каталога: `~/.stepcast` → `~/.burnex` переименованием,
 * на прежнем месте остаётся символьная ссылка на новый. Ссылка — ради
 * установленного релиза: его лаунчер и агент автозапуска указывают внутрь
 * `~/.stepcast/releases/current`, и без неё переименование оборвало бы
 * демон, который сам этот перенос и не делал. Выполняется при запуске CLI,
 * один раз: когда нового каталога нет, а прежний есть и не ссылка.
 * Библиотечные вызовы (`homeRoot`) ничего не переносят — иначе тесты с
 * поддельным домом переносили бы его на первом же чтении.
 * Возвращает, что перенесено, либо `undefined`, если переносить нечего.
 */
export function migrateHomeRoot(home: string = homedir()): HomeMigration | undefined {
  const to = join(home, CABINET_DIR_NAME);
  const from = join(home, LEGACY_CABINET_DIR_NAME);
  if (existsSync(to)) return undefined;
  let stat;
  try {
    stat = lstatSync(from);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
  renameSync(from, to);
  symlinkSync(CABINET_DIR_NAME, from, 'dir');
  return { from, to };
}

/** Имя пайплайна по умолчанию относительно каталога — для сообщений (`ok: burnex.yml`). */
export function defaultPipelineName(cwd: string): string {
  return basename(defaultPipelineFile(cwd));
}

/**
 * Предупреждение о кабинете под прежним именем — одним текстом для `burnex lint`
 * и `burnex up`: проектный кабинет движок не переносит сам (он в репозитории
 * пользователя), а говорит, что сделать. Форма — диагностика линта: у него
 * она печатается в общем перечне, демон печатает те же поля строкой.
 */
export function legacyCabinetDiagnostic(root: string): {
  readonly severity: 'warning';
  readonly message: string;
  readonly file: string;
  readonly hint: string;
} {
  return {
    severity: 'warning',
    message: `кабинет проекта называется ${LEGACY_CABINET_DIR_NAME}/ — прежним именем; читается последний выпуск`,
    file: join(root, LEGACY_CABINET_DIR_NAME),
    hint: `Переименуйте каталог: git mv ${LEGACY_CABINET_DIR_NAME} ${CABINET_DIR_NAME}`,
  };
}
