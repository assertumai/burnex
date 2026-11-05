import { compileNameGlob } from '../domain/lint.js';

/**
 * Выходы работы — строки `ключ=значение`, которые шаги `run` дописывают в
 * `$BURNEX_JOB_OUTPUTS`, а прямые зависимые читают переменными
 * `NEEDS_<РАБОТА>_<КЛЮЧ>` (job-outputs-key-value, design.md).
 *
 * Модуль чистый: его разделяют схема документа, исполнение и линт, и правило
 * формы ключа, предела и «похожести на секрет» должно быть одним на всех.
 */

/** Форма ключа: одна на схему документа, разбор файла и линт. */
export const JOB_OUTPUT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Предел значения в байтах UTF-8. */
export const MAX_OUTPUT_VALUE_BYTES = 4096;

/** Предел числа различных ключей одной работы. */
export const MAX_OUTPUT_KEYS = 32;

/**
 * Имя переменной для потребителя. `<РАБОТА>` нормализуется (идентификаторы
 * работ содержат дефисы, а переменной нужен `[A-Za-z0-9_]`), ключ остаётся как
 * записан: `sha` и `SHA` — разные ключи без отдельного правила о регистре.
 */
export function needsVarName(jobId: string, key: string): string {
  return `NEEDS_${needsJobSegment(jobId)}_${key}`;
}

/** Сегмент `<РАБОТА>` имени переменной; префикс для разбора ссылок в линте. */
export function needsJobSegment(jobId: string): string {
  return jobId.toUpperCase().replace(/[^A-Za-z0-9_]/g, '_');
}

export interface OutputPolicy {
  /** Шаблоны `env_deny` пайплайна. */
  readonly envDeny: readonly string[];
  /** Переменные объявленных секретов пайплайна. */
  readonly secretEnvs: readonly string[];
}

/**
 * Причина, по которой ключ нельзя публиковать, либо `undefined`. Проверяется
 * итоговая переменная теми же шаблонами, что вычёркивают переменные из
 * окружения шага, — второго списка «секретных» подстрок нет (решение 4).
 */
export function keyRejection(jobId: string, key: string, policy: OutputPolicy): string | undefined {
  if (!JOB_OUTPUT_KEY.test(key)) {
    return `ключ «${key}» не подходит под ${JOB_OUTPUT_KEY.source}`;
  }
  const variable = needsVarName(jobId, key);
  for (const pattern of policy.envDeny) {
    if (compileNameGlob(pattern).test(variable)) {
      return `переменная ${variable} подпадает под шаблон env_deny «${pattern}»: похоже на учётные данные`;
    }
  }
  for (const env of policy.secretEnvs) {
    if (compileNameGlob(env).test(variable)) {
      return `переменная ${variable} совпадает с переменной объявленного секрета`;
    }
  }
  return undefined;
}

export type ParsedOutputs =
  | { readonly ok: true; readonly outputs: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string };

/**
 * Разобрать текст файла выходов и проверить его целиком. Ключ — всё до первого
 * `=`, значение — остальное буквально: без снятия кавычек и обрезки пробелов,
 * в отличие от `parseEnvFile`, потому что значение здесь данные, а не
 * конфигурация. `\r` в конце строки срезается, пустые строки пропускаются,
 * повтор ключа даёт последнее значение.
 */
export function parseJobOutputs(jobId: string, text: string, policy: OutputPolicy): ParsedOutputs {
  const outputs: Record<string, string> = {};
  const lines = text.split('\n');

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') continue;

    const separator = line.indexOf('=');
    if (separator === -1) {
      return {
        ok: false,
        reason: `работа ${jobId}: строка ${index + 1} файла выходов без «=»; ожидалось ключ=значение`,
      };
    }

    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);

    const rejection = keyRejection(jobId, key, policy);
    if (rejection !== undefined) {
      return { ok: false, reason: `работа ${jobId}: выход отклонён — ${rejection}` };
    }
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_OUTPUT_VALUE_BYTES) {
      return {
        ok: false,
        reason: `работа ${jobId}: значение выхода «${key}» занимает ${bytes} байт, предел ${MAX_OUTPUT_VALUE_BYTES}`,
      };
    }

    outputs[key] = value;
    if (Object.keys(outputs).length > MAX_OUTPUT_KEYS) {
      return {
        ok: false,
        reason: `работа ${jobId}: больше ${MAX_OUTPUT_KEYS} различных ключей выходов`,
      };
    }
  }

  return { ok: true, outputs };
}
