/**
 * Владелец взятого пункта очереди: строка `<вид>:<id>` в поле `claimed_by`.
 *
 * Судить о живости умеет только вид `run:` — прогон, взявший пункт. Другие
 * виды форма оставляет на будущее, но сегодня владелец иной формы «не судим»
 * (`unknown`), и пункт ведёт себя по порогу давности, как без владельца.
 * Модуль чист: каталогов прогонов он не знает, судья приходит аргументом.
 */

const RUN_PREFIX = 'run:';

/** Идентификатор прогона годится для имени каталога: непустой, без пробелов и `/`. */
const RUN_ID = /^[^\s/]+$/;

/** Что известно о владельце: жив, мёртв или судить о нём нечем. */
export type OwnerState = 'alive' | 'dead' | 'unknown';

/** Судья владельца: по строке `claimed_by` отвечает, жив ли он. */
export type OwnerJudge = (owner: string) => OwnerState;

/** Идентификатор прогона из `run:<id>`; `undefined`, если форма иная. */
export function parseRunOwner(owner: string): string | undefined {
  if (!owner.startsWith(RUN_PREFIX)) return undefined;
  const id = owner.slice(RUN_PREFIX.length);
  return RUN_ID.test(id) ? id : undefined;
}

export function isRunOwner(owner: string): boolean {
  return parseRunOwner(owner) !== undefined;
}

/** Владелец-прогон по идентификатору каталога прогона. */
export function runOwner(runId: string): string {
  return `${RUN_PREFIX}${runId}`;
}
