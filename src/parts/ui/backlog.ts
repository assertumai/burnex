import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

import {
  backlogLockPath,
  effectiveGroup,
  parseBacklogFile,
  parseRunOwner,
  readBacklogFile,
  type BacklogEntry,
  type BacklogStatus,
} from '../pipeline/domain/backlog/index.js';
import { isAbandoned, readOwner } from '../pipeline/domain/lockfile.js';
import { isStepcastError } from '../../kernel/errors.js';
import { BOARD_FILE, readBoardColumns } from './boardFile.js';
import type { Overview } from './overview.js';
import { DEFAULT_BOARD_COLUMNS, type BoardColumnSpec } from './scrumView.js';

/**
 * Вид очереди улучшений по проектам, видимым в обзоре.
 *
 * Читает диск (`backlog.md` и `archived.md` в корне каждого проекта), поэтому
 * браузеру этот модуль не отдаётся: ни в `server.fs.allow` (`vite.config.ts`), ни в
 * `include` (`ui/tsconfig.json`) он не входит, в отличие от `routes.ts` и
 * `grouping.ts`.
 *
 * Список проектов и их корни берутся из готового обзора (`buildOverview`), а
 * не обходом корня прогонов заново: обзор уже отбросил проекты без прогонов и
 * уже разрешил путь по указателю `projects.json` (design.md, Решение 2).
 */

/**
 * Два файла проекта, которые читает очередь: открытые пункты и решённые,
 * вынесенные из `backlog.md` (`docs/backlog.md`). Порядок перечня — порядок
 * их слияния в разделе проекта: сперва пункты `backlog.md`, затем `archived.md`.
 */
const SOURCE_FILES = ['backlog.md', 'archived.md'] as const;
export type BacklogSourceFile = (typeof SOURCE_FILES)[number];

export interface BacklogItemView {
  readonly slug: string;
  readonly status: BacklogStatus;
  readonly title: string;
  /**
   * `why` и `done_when` — абзацы текста, а не строки списка: список из тысячи
   * пунктов они сделали бы нечитаемым. Экран раскрывает их по требованию
   * (design.md, Решение 3), но само значение вид несёт всегда.
   */
  readonly why: string;
  readonly doneWhen: string;
  /** Объявленная группа либо, если пункт её не назвал, слаг самого пункта. */
  readonly group: string;
  /** Объявленный вес пункта; пусто, когда поле не заполнено — без слова по умолчанию. */
  readonly track: string;
  /** Слаги зависимостей в объявленном порядке; пусто, когда поле не заполнено. */
  readonly needs: readonly string[];
  readonly startedAt?: string;
  readonly reason?: string;
  /** `claimed_by` как записан; показывается и владелец иной формы, чем `run:<id>`. */
  readonly claimedBy?: string;
  /**
   * Идентификатор прогона-владельца, разобранный `parseRunOwner` движка: браузеру
   * правило формы не отдаётся, второе правило разошлось бы с первым.
   */
  readonly ownerRunId?: string;
  /** Файл, из которого пришёл пункт — `backlog.md` либо `archived.md`. */
  readonly sourceFile: BacklogSourceFile;
}

/**
 * Отказ разбора одного файла очереди проекта. Поля — теми же именами, что у
 * `PipelineView` (`src/parts/ui/pipelines.ts`): карточка неразбираемого пайплайна и
 * запись неразбираемой очереди показываются одним и тем же приёмом.
 *
 * Подсказки (`errorHint` у пайплайна) здесь нет: ядро очереди её не даёт
 * вовсе — ни один отказ `src/parts/pipeline/domain/backlog/parse.ts` не заполняет `hint`, а
 * `readBacklogFile` кладёт в ошибку только путь и причину. Поле, которое
 * никогда не заполняется, обещало бы экрану несуществующее объяснение.
 *
 * Отдельного `errorFile` нет: `sourceFile` уже называет отказавший файл — оба
 * поля несли бы одно и то же значение.
 */
export interface BacklogFailure {
  /** Файл очереди либо раскладка колонок доски (`.burnex/board.yml`). */
  readonly sourceFile: BacklogSourceFile | typeof BOARD_FILE;
  readonly error: string;
  readonly errorAt?: string;
}

/**
 * Состояние lock-файла очереди проекта. Занятая блокировка — предупреждение, а
 * не отказ: запрос верен, очередь просто занята.
 */
export type BacklogLockView =
  | { readonly state: 'free' }
  | {
      readonly state: 'held';
      readonly command: string;
      readonly pid: number;
      readonly host: string;
      readonly acquiredAt: string;
      /** Та же машина, процесса нет: следующий писатель снимет lock сам. */
      readonly abandoned: boolean;
      /** Владелец на другой машине: демон его не проверит, снимает человек. */
      readonly foreignHost: boolean;
      readonly path: string;
    }
  | { readonly state: 'unreadable'; readonly path: string };

export interface BacklogProjectView {
  readonly projectKey: string;
  readonly projectPath: string;
  /**
   * Пункты обоих файлов одним списком: сперва `backlog.md` в его файловом
   * порядке, затем `archived.md` в его. Тот же порядок — приоритет отбора.
   */
  readonly items: readonly BacklogItemView[];
  /** Отказ разбора — по одному на файл, не разобравшийся по формату; пустой список — оба разобрались (или отсутствуют). */
  readonly failures: readonly BacklogFailure[];
  /**
   * Раскладка колонок доски (`.burnex/board.yml`); без файла — встроенная.
   * Несётся вместе с пунктами, а не отдельным запросом: колонка и пункты
   * одного статуса обязаны появиться на доске одним кадром.
   */
  readonly columns: readonly BoardColumnSpec[];
  /** Блокировка очереди проекта — тем же кадром, что и пункты. */
  readonly lock: BacklogLockView;
}

export interface BacklogOverview {
  readonly projects: readonly BacklogProjectView[];
  readonly generatedAt: string;
}

/** Отсутствие файла — не беда: `readBacklogFile` кладёт код ошибки чтения в `cause`, текст сообщения не смотрим. */
function isMissingFile(error: unknown): boolean {
  if (!isStepcastError(error)) return false;
  return (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Место внутри документа — половина объяснения; файл называет вызывающий по своему `sourceFile`. */
function toFailure(error: unknown, sourceFile: BacklogFailure['sourceFile']): BacklogFailure {
  if (!isStepcastError(error)) return { sourceFile, error: (error as Error).message };
  return { sourceFile, error: error.message, ...(error.at === undefined ? {} : { errorAt: error.at }) };
}

/**
 * Через сколько запасной путь lock'а (git не ответил) спрашивается у git снова.
 * Реже такта наблюдателя, чтобы проект без репозитория не порождал git каждую
 * секунду; достаточно часто, чтобы `git init` при живом демоне дошёл до экрана.
 */
export const LOCK_PATH_RETRY_MS = 30_000;

/**
 * Пути lock'а по пути проекта. `backlogLockPath` порождает git, а отпечаток
 * наблюдателя считается каждый такт: общий каталог git за жизнь демона не
 * меняется, и путь в нём запоминается навсегда. Запасной `.backlog.lock`
 * рядом с файлом — лишь до `retryAt`: git мог не ответить временно, а проект
 * мог стать репозиторием, и движок тогда пишет уже в общий каталог git
 * (design.md, Решение 4).
 */
const lockPaths = new Map<string, { readonly path: string; readonly retryAt: number }>();

export function lockPathOf(projectPath: string, now: number = Date.now()): string {
  const cached = lockPaths.get(projectPath);
  if (cached !== undefined && now < cached.retryAt) return cached.path;
  const path = backlogLockPath(join(projectPath, 'backlog.md'));
  const fallback = path === join(resolve(projectPath), '.backlog.lock');
  lockPaths.set(projectPath, { path, retryAt: fallback ? now + LOCK_PATH_RETRY_MS : Number.POSITIVE_INFINITY });
  return path;
}

export function readBacklogLock(projectPath: string): BacklogLockView {
  const path = lockPathOf(projectPath);
  const owner = readOwner(path);
  if (owner === undefined) return { state: 'free' };
  if (owner === 'unreadable') return { state: 'unreadable', path };
  return {
    state: 'held',
    command: owner.command,
    pid: owner.pid,
    host: owner.host,
    acquiredAt: owner.acquired_at,
    abandoned: isAbandoned(owner),
    foreignHost: owner.host !== hostname(),
    path,
  };
}

function toItemView(entry: BacklogEntry, sourceFile: BacklogSourceFile): BacklogItemView {
  const claimedBy = entry.data.claimed_by;
  const ownerRunId = claimedBy === undefined ? undefined : parseRunOwner(claimedBy);
  return {
    slug: entry.slug,
    status: entry.data.status,
    title: entry.data.title,
    why: entry.data.why,
    doneWhen: entry.data.done_when,
    group: effectiveGroup(entry),
    track: entry.data.track ?? '',
    needs: entry.data.needs ?? [],
    ...(entry.data.started_at === undefined ? {} : { startedAt: entry.data.started_at }),
    ...(entry.data.reason === undefined ? {} : { reason: entry.data.reason }),
    ...(claimedBy === undefined ? {} : { claimedBy }),
    ...(ownerRunId === undefined ? {} : { ownerRunId }),
    sourceFile,
  };
}

export function buildBacklog(overview: Overview): BacklogOverview {
  const projects: BacklogProjectView[] = [];

  for (const project of overview.projects) {
    // Проект без пути в указателе: читать очередь неоткуда, догадка о пути запрещена.
    if (project.path === undefined) continue;

    const items: BacklogItemView[] = [];
    const failures: BacklogFailure[] = [];
    // Хотя бы один из двух файлов должен существовать — иначе разделу проекта
    // нечего показывать, тем же правилом, что раньше решало судьбу одного
    // `backlog.md` (design.md изменения ui-backlog-reads-resolved).
    let anyFilePresent = false;

    for (const sourceFile of SOURCE_FILES) {
      const file = join(project.path, sourceFile);

      let text: string;
      try {
        text = readBacklogFile(file);
      } catch (error) {
        if (isMissingFile(error)) continue;
        anyFilePresent = true;
        failures.push(toFailure(error, sourceFile));
        continue;
      }

      anyFilePresent = true;
      try {
        const entries = parseBacklogFile(file, text);
        for (const entry of entries) items.push(toItemView(entry, sourceFile));
      } catch (error) {
        failures.push(toFailure(error, sourceFile));
      }
    }

    if (!anyFilePresent) continue;

    // Сломанная раскладка не гасит доску: колонки встают встроенные, а отказ
    // виден рядом с отказами файлов очереди.
    let columns: readonly BoardColumnSpec[] = DEFAULT_BOARD_COLUMNS;
    try {
      columns = readBoardColumns(project.path);
    } catch (error) {
      failures.push(toFailure(error, BOARD_FILE));
    }

    projects.push({ projectKey: project.key, projectPath: project.path, items, failures, columns, lock: readBacklogLock(project.path) });
  }

  return { projects, generatedAt: overview.generatedAt };
}
