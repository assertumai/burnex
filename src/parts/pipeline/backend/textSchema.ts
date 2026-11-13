import { readFileSync } from 'node:fs';

import { validateAgainstSchemaFile } from '../expect/evaluate.js';
import type { PredicateResult } from '../run/journal/schema.js';

/**
 * Схема вызова, которую держит движок, а не CLI (`backend-structured-output`,
 * решения 2–4): для адаптера с `schemaFromText` и без нативной схемы. Схема
 * дописывается в промпт, структура берётся из итогового текста ответа и
 * проверяется той же схемой. Адаптер об этом пути не знает.
 */

/** Имя жёсткого предиката, которым ответ без валидного JSON проваливает попытку. */
export const TEXT_SCHEMA_PREDICATE = 'output_schema';

/** Сколько последних символов текста ищется JSON без огороженного блока. */
const TAIL_CHARS = 64 * 1024;

/** Раздел промпта: какую форму ответа ждёт движок. */
export function schemaPromptSection(schemaPath: string): string {
  const schema = readFileSync(schemaPath, 'utf8').trim();
  return [
    '## Формат итогового ответа',
    '',
    'Закончи ответ одним блоком ```json с JSON-значением, которое проходит эту JSON Schema.',
    'После блока ничего не пиши: движок возьмёт последний JSON-блок ответа и проверит его схемой.',
    '',
    '```json',
    schema,
    '```',
  ].join('\n');
}

/** Промпт с разделом схемы — один вид склейки для шага и судьи. */
export function withSchemaSection(prompt: string, schemaPath: string): string {
  return `${prompt}\n\n${schemaPromptSection(schemaPath)}`;
}

/**
 * Последний JSON итогового текста: последний огороженный блок кода, который
 * разбирается как JSON, а без него — последний сбалансированный объект или
 * массив текста (у вложенных — внешний). Поиск с конца: модель сначала
 * рассуждает, а Cursor склеивает сообщения в `result` без разделителя, так что
 * JSON может начинаться сразу после слова. Ничего не нашлось — `undefined`.
 */
export function extractLastJson(text: string): { readonly value: unknown } | undefined {
  const fences = [...text.matchAll(/```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)```/g)];
  for (let index = fences.length - 1; index >= 0; index -= 1) {
    const parsed = tryParse(fences[index]![1]!.trim());
    if (parsed !== undefined) return parsed;
  }

  // Без блока — разбор хвоста: поиск квадратичен по числу скобок, а ответ по
  // схеме стоит в конце; длинный ответ с кодом иначе разбирался бы секундами.
  const from = Math.max(0, text.length - TAIL_CHARS);
  let best: { readonly start: number; readonly end: number; readonly value: unknown } | undefined;
  for (let start = from; start < text.length; start += 1) {
    const char = text[start];
    if (char !== '{' && char !== '[') continue;
    const end = balancedEnd(text, start);
    if (end === undefined) continue;
    // Не лучше уже найденного: кончается раньше либо там же, но начат позже
    // (вложенный в найденный).
    if (best !== undefined && end <= best.end) continue;
    const parsed = tryParse(text.slice(start, end + 1));
    if (parsed !== undefined) best = { start, end, value: parsed.value };
  }
  return best === undefined ? undefined : { value: best.value };
}

/**
 * Структура из итогового текста и результат её проверки схемой вызова. Провал
 * — жёсткий предикат `output_schema`: он проваливает попытку так же, как
 * провалил бы предикат `schema`, и его текст уходит в повтор с `includeFailure`.
 */
export function structuredFromText(
  schemaPath: string,
  text: string | undefined,
): { readonly structured: unknown; readonly result: PredicateResult } {
  const found = text === undefined ? undefined : extractLastJson(text);
  if (found === undefined) {
    return {
      structured: undefined,
      result: {
        predicate: TEXT_SCHEMA_PREDICATE,
        passed: false,
        hard: true,
        expected: schemaPath,
        detail: 'итоговый ответ не содержит JSON: закончи ответ блоком ```json по схеме',
      },
    };
  }
  const { passed, detail } = validateAgainstSchemaFile(schemaPath, found.value);
  return {
    // Невалидная структура не выдаётся дальше: потребитель увидел бы её в
    // `output.json` как ответ шага.
    structured: passed ? found.value : undefined,
    result: {
      predicate: TEXT_SCHEMA_PREDICATE,
      passed,
      hard: true,
      expected: schemaPath,
      ...(passed ? {} : { detail: `JSON ответа не проходит схему:\n${detail ?? ''}` }),
    },
  };
}

function tryParse(source: string): { readonly value: unknown } | undefined {
  if (source === '') return undefined;
  try {
    return { value: JSON.parse(source) as unknown };
  } catch {
    return undefined;
  }
}

/** Индекс закрывающей скобки значения, начатого в `start`, с учётом строк. */
function balancedEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}
