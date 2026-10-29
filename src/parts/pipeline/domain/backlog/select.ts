import { needsMet, type StatusOf } from './needs.js';
import type { OwnerJudge } from './owner.js';
import { effectiveGroup, type BacklogEntry } from './parse.js';

/**
 * Отбор свободных пунктов очереди по действующим группам.
 *
 * Часы приходят аргументом (`nowMs`), а не из `Date.now()` внутри: иначе
 * правило зависшего пункта было бы нечем проверить без подмены глобального
 * времени, а вызывающий (CLI) и так уже знает текущий момент.
 */

export const DEFAULT_STALE_HOURS = 6;

/** Проверка материалов пункта: пути, не называющие существующий файл (`refs.ts`). */
export type MissingRefsOf = (entry: BacklogEntry) => readonly string[];

/**
 * Свободен ли пункт для взятия в работу.
 *
 * Свободен пункт `todo` — единственное открытое состояние очереди.
 *
 * Пункт `in_progress` с владельцем (`claimed_by`) судит судья `ownerOf`:
 * мёртвый владелец освобождает пункт при любом `started_at` — работа,
 * которую вёл оборванный прогон, ждать порога не должна, — а живой держит
 * его даже старше порога: долгий прогон не должен терять пункт под ногами.
 *
 * Пункт без владельца либо с владельцем, о котором судить нечем (`unknown`,
 * судьи нет), зависает по порогу давности: прогон, оборванный по сигналу,
 * крашу или бюджету, иначе заблокировал бы его навсегда. Отсутствие
 * `started_at` у такого `in_progress` толкуется так же — момент взятия
 * неизвестен, и ждать нечего.
 */
export function isFree(
  entry: BacklogEntry,
  nowMs: number,
  staleMs: number,
  ownerOf?: OwnerJudge,
): boolean {
  const { status, started_at: startedAt, claimed_by: owner } = entry.data;
  if (status === 'todo') return true;
  if (status !== 'in_progress') return false;

  if (owner !== undefined && ownerOf !== undefined) {
    const state = ownerOf(owner);
    if (state === 'dead') return true;
    if (state === 'alive') return false;
  }

  if (startedAt === undefined || startedAt === '') return true;

  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return true;
  return nowMs - startedMs >= staleMs;
}

/**
 * Держит ли пункт свою группу занятой: только `in_progress` и не протухший.
 *
 * `done` и `failed` не свободны для взятия (см. `isFree`), но это состояния
 * терминальные — они не должны запирать группу от других её пунктов.
 */
function isBusy(entry: BacklogEntry, nowMs: number, staleMs: number, ownerOf?: OwnerJudge): boolean {
  return entry.data.status === 'in_progress' && !isFree(entry, nowMs, staleMs, ownerOf);
}

/**
 * Очередь предпочтения при отборе: чем меньше число, тем раньше берётся пункт.
 *
 * Зависший `in_progress` идёт первым: он уже в работе, и вытеснять его новыми
 * пунктами значило бы бросать начатое — ровно то, от чего его освобождает
 * порог давности. Дальше `todo`, и внутри него — порядок файла: приоритет
 * человек задаёт местом пункта в `backlog.md`, в том числе перетаскиванием на
 * доске.
 */
function pickRank(entry: BacklogEntry): number {
  return entry.data.status === 'in_progress' ? 0 : 1;
}

/**
 * Отобрать до `slots` пунктов, по одному на действующую группу: сперва
 * зависшие, затем `todo` сверху вниз.
 *
 * `only` называет единственного кандидата — тот случай, когда пункт выбирает
 * человек (доска витрины), а не очерёдность. Пустой ответ значит, что
 * названный пункт не свободен либо его группа занята; что с этим делать,
 * решает вызывающий.
 *
 * `statusOf` включает зависимости (`needs`): пункт с невыполненной зависимостью
 * не свободен. Без него зависимости не учитываются.
 *
 * `missingRefsOf` включает проверку материалов `goal`/`details`; пропущенный
 * из-за неё пункт сообщается через `onSkippedRefs`.
 *
 * `ownerOf` включает суждение о владельцах (`isFree`): оно же решает, держит
 * ли `in_progress` свою группу.
 *
 * Занятые группы собираются заранее по всей очереди (занятый пункт держит
 * свою группу, даже если сам он ниже места отбора), а затем пополняются по
 * ходу отбора — так пункт одной группы с уже выбранным не берётся в том же
 * проходе.
 */
export function selectItems(
  entries: readonly BacklogEntry[],
  slots: number,
  nowMs: number,
  staleMs: number,
  only?: string,
  statusOf?: StatusOf,
  missingRefsOf?: MissingRefsOf,
  onSkippedRefs?: (entry: BacklogEntry, missing: readonly string[]) => void,
  ownerOf?: OwnerJudge,
): readonly BacklogEntry[] {
  const busyGroups = new Set(
    entries.filter((entry) => isBusy(entry, nowMs, staleMs, ownerOf)).map(effectiveGroup),
  );

  // Стабильная сортировка по рангу: `Array.prototype.sort` стабилен по
  // спецификации, и порядок файла внутри ранга сохраняется сам.
  const ordered = [...entries].sort((left, right) => pickRank(left) - pickRank(right));

  // Названный пункт сужает кандидатов, но не занятость групп: она считается по
  // всей очереди выше. Иначе «возьми вот этот» обходило бы правило группы —
  // пункт ушёл бы в работу рядом с уже идущим пунктом той же группы, то есть
  // ровно в тот конфликт, ради которого группа объявлена.
  const candidates = only === undefined ? ordered : ordered.filter((entry) => entry.slug === only);

  const chosen: BacklogEntry[] = [];
  for (const entry of candidates) {
    if (chosen.length >= slots) break;
    if (!isFree(entry, nowMs, staleMs, ownerOf)) continue;
    // Ждущий пункт пропускается до проверки группы и в `chosen` не попадает,
    // так что группу он не берёт: пункт той же группы ниже идёт вместо него.
    if (statusOf !== undefined && !needsMet(entry, statusOf)) continue;
    // Пункт с отсутствующим материалом пропускается в той же ветке: взять его
    // значило бы запустить работу без файла, который пункт назвал. Пропуск
    // виден вызывающему, а не молчалив.
    if (missingRefsOf !== undefined) {
      const missing = missingRefsOf(entry);
      if (missing.length > 0) {
        onSkippedRefs?.(entry, missing);
        continue;
      }
    }
    const group = effectiveGroup(entry);
    if (busyGroups.has(group)) continue;
    chosen.push(entry);
    busyGroups.add(group);
  }
  return chosen;
}
