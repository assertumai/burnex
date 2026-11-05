import { readYamlDocument } from './load.js';
import type { ParamValue } from './params.js';

/**
 * Заглушки для обязательных входов без умолчания. Экран и `burnex config
 * --pipeline` показывают устройство пайплайна, а не запуск: значение такого
 * входа приходит только с `--input`, и без заглушки раскрытие отказало бы
 * файлу, который исправен. Заглушка видна там, куда вход подставлен
 * (`<item>`), а не выдаёт себя за настоящее значение. Документ, который не
 * читается, раскрытие разберёт само и отдаст свою диагностику — здесь его
 * ошибка глотается.
 *
 * Код общий для витрины и команды: две копии правила разошлись бы, и один и
 * тот же пайплайн раскрывался бы там и тут по-разному.
 */
export function displayInputs(pipelinePath: string): Record<string, ParamValue> {
  let raw: unknown;
  try {
    raw = readYamlDocument(pipelinePath);
  } catch {
    return {};
  }
  const declared = (raw as { inputs?: unknown } | null)?.inputs;
  if (declared === null || typeof declared !== 'object') return {};

  const out: Record<string, ParamValue> = {};
  for (const [name, spec] of Object.entries(declared as Record<string, unknown>)) {
    if (spec === null || typeof spec !== 'object') continue;
    const { required, default: fallback, type } = spec as { required?: unknown; default?: unknown; type?: unknown };
    if (required !== true || fallback !== undefined) continue;
    out[name] = type === 'int' ? 0 : type === 'bool' ? false : `<${name}>`;
  }
  return out;
}
