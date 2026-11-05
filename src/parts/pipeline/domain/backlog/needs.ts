import { BurnexError } from '../../../../kernel/errors.js';
import type { BacklogEntry } from './parse.js';

/**
 * Зависимости пунктов (`needs`): откуда берётся статус слага, проверка графа
 * и выполненность зависимостей. Без ввода-вывода — архив приходит разобранным
 * (`readArchivedEntries`, `file.ts`).
 */

/** Статус пункта по слагу; `undefined` — такого пункта нет ни в очереди, ни в архиве. */
export type StatusOf = (slug: string) => string | undefined;

/** Отметка вместо статуса в перечне невыполненных зависимостей, когда пункта нет вовсе. */
export const MISSING_STATUS = 'нет в очереди';

/**
 * Статус слага: очередь приоритетнее архива. Слаг, оказавшийся в обоих
 * файлах, — пункт, который вернули в работу, и рабочим считается файл очереди.
 */
export function statusResolver(entries: readonly BacklogEntry[], archived: readonly BacklogEntry[]): StatusOf {
  const statuses = new Map<string, string>();
  for (const entry of archived) statuses.set(entry.slug, entry.data.status);
  for (const entry of entries) statuses.set(entry.slug, entry.data.status);
  return (slug) => statuses.get(slug);
}

export function needsOf(entry: BacklogEntry): readonly string[] {
  return entry.data.needs ?? [];
}

/** Объявил ли хоть один пункт зависимости — иначе архив читать незачем. */
export function declaresNeeds(entries: readonly BacklogEntry[]): boolean {
  return entries.some((entry) => needsOf(entry).length > 0);
}

/**
 * Проверка связей: каждая зависимость названа пунктом очереди либо архива, и
 * цикла нет (самоссылка — цикл длины один). Отказ называет пункт и слаг либо
 * путь цикла.
 *
 * Обход идёт по пунктам файла очереди, тремя цветами: серый — на стеке
 * текущего пути, и ребро в серый пункт замыкает цикл. Рёбра в архивные пункты
 * не продолжаются: те решены, их собственные `needs` не проверяются.
 */
export function checkNeeds(entries: readonly BacklogEntry[], archived: readonly BacklogEntry[]): void {
  const queue = new Map(entries.map((entry) => [entry.slug, entry]));
  const archivedSlugs = new Set(archived.map((entry) => entry.slug));
  const finished = new Set<string>();
  const path: string[] = [];

  const visit = (entry: BacklogEntry): void => {
    path.push(entry.slug);
    for (const need of needsOf(entry)) {
      const target = queue.get(need);
      if (target === undefined) {
        if (archivedSlugs.has(need)) continue;
        throw new BurnexError(
          `пункт «${entry.slug}»: зависимость «${need}» не найдена ни в очереди, ни в архиве`,
          { at: entry.slug },
        );
      }
      const onPath = path.indexOf(need);
      if (onPath !== -1) {
        throw new BurnexError(
          `циклическая зависимость пунктов: ${[...path.slice(onPath), need].join(' → ')}`,
          { at: need },
        );
      }
      if (!finished.has(need)) visit(target);
    }
    path.pop();
    finished.add(entry.slug);
  };

  for (const entry of entries) {
    if (!finished.has(entry.slug)) visit(entry);
  }
}

/** Выполнены ли зависимости пункта: выполняет зависимость только статус ровно `done`. */
export function needsMet(entry: BacklogEntry, statusOf: StatusOf): boolean {
  return needsOf(entry).every((slug) => statusOf(slug) === 'done');
}

/** Невыполненные зависимости пункта со статусами — для отказа и панели. */
export function unmetNeeds(
  entry: BacklogEntry,
  statusOf: StatusOf,
): readonly { readonly slug: string; readonly status: string }[] {
  return needsOf(entry)
    .map((slug) => ({ slug, status: statusOf(slug) ?? MISSING_STATUS }))
    .filter((need) => need.status !== 'done');
}
