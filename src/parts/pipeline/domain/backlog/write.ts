import { StepcastError } from '../../../../kernel/errors.js';
import { parse } from './parse.js';

/**
 * Проставить поля пункту и вернуть новый текст файла. Файлов модуль не
 * трогает — запись остаётся заботой вызывающего (см. `atomicWrite`).
 *
 * Существующее поле переписывается на месте, новое дописывается за последним
 * полем пункта. Разбор повторяется на каждом поле: вставка строки сдвигает
 * все последующие позиции, а файл очереди заведомо мал.
 */
export function withFields(
  text: string,
  slug: string,
  values: Readonly<Record<string, string>>,
): string {
  let result = text;

  for (const [name, value] of Object.entries(values)) {
    assertSingleLine(name, value);
    const lines = result.split('\n');
    const entry = parse(result).find((candidate) => candidate.slug === slug);
    if (entry === undefined) {
      throw new StepcastError(`пункт «${slug}» в очереди не найден`, { at: slug });
    }

    const existing = entry.fields.get(name);
    if (existing === undefined) lines.splice(entry.lastFieldLine + 1, 0, `${name}: ${value}`);
    else lines[existing.line] = `${name}: ${value}`;

    result = lines.join('\n');
  }

  return result;
}

/**
 * Значение поля обязано занимать ровно одну строку.
 *
 * Разбор читает пункт построчно: перевод строки в значении превратил бы его
 * хвост в строку, которую не разобрать ни как поле, ни как заголовок, — и
 * следующее же чтение очереди отказало бы целиком, а не на одном пункте.
 * Сведение чужого многострочного текста к одной строке — забота вызывающего
 * (см. `runFinish`): что именно значит «свести», знает он, а не ядро.
 */
function assertSingleLine(name: string, value: string): void {
  if (!/[\n\r]/.test(value)) return;
  throw new StepcastError(
    `значение поля «${name}» обязано занимать одну строку: перевод строки сделал бы очередь неразбираемой`,
    { at: name },
  );
}

/**
 * Убрать поля у пункта, вернув новый текст файла.
 *
 * Обратная `withFields` сторона, нужная правке пункта с витрины: пустое
 * значение необязательного поля (`group`, `track`, `repos`) означает «поля
 * нет», а не «поле есть и пусто» — пустая метка веса не прошла бы разбор, а
 * строка `track:` в файле сбивала бы с толку читателя.
 *
 * Отсутствующее поле — не отказ: убрать то, чего нет, значит оставить как
 * есть, и вызывающему не приходится сперва выяснять, что там было.
 */
export function withoutFields(text: string, slug: string, names: readonly string[]): string {
  let result = text;

  for (const name of names) {
    const lines = result.split('\n');
    const entry = parse(result).find((candidate) => candidate.slug === slug);
    if (entry === undefined) {
      throw new StepcastError(`пункт «${slug}» в очереди не найден`, { at: slug });
    }

    const existing = entry.fields.get(name);
    if (existing === undefined) continue;

    lines.splice(existing.line, 1);
    result = lines.join('\n');
  }

  return result;
}

/**
 * Вставить новый пункт и вернуть новый текст файла: сразу за пунктом `after`
 * либо в конец. Остальной текст не трогается — ни порядок, ни пустые строки
 * соседей, в отличие от пересборки файла из разобранных пунктов.
 *
 * Названный `after` обязан быть в тексте: вставка «куда-нибудь» при опечатке
 * в слаге молча поставила бы пункт не туда, где его ждали.
 */
export function insertItem(
  text: string,
  slug: string,
  fields: Readonly<Record<string, string>>,
  after?: string,
): string {
  assertSingleLine('slug', slug);
  const block = ['', `## ${slug}`, ''];
  for (const [name, value] of Object.entries(fields)) {
    assertSingleLine(name, value);
    block.push(`${name}: ${value}`);
  }

  if (after === undefined) {
    return `${text.replace(/\n*$/u, '')}\n${block.join('\n')}\n`;
  }

  const entry = parse(text).find((candidate) => candidate.slug === after);
  if (entry === undefined) {
    throw new StepcastError(`пункт «${after}» в очереди не найден`, { at: after });
  }
  const lines = text.split('\n');
  lines.splice(entry.lastFieldLine + 1, 0, ...block);
  return lines.join('\n');
}
