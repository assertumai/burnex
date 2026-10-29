/**
 * Маскирование значений секретов в том, что журнал пишет на диск
 * (`secrets-named-providers`, design.md, решение 5).
 *
 * Маскировщик один на прогон и живёт в журнале: точек записи потоков и файлов
 * шага несколько (`runStep`, `agentStep`, `pluginStep`, `judgePass`), и новая
 * точка, забывшая обёртку, тихо вернула бы утечку. Замена — `***`, от более
 * длинного значения к более короткому: значение, содержащее другое, иначе
 * оставляло бы хвост.
 *
 * Не маскируются производные формы значения (base64, URL-кодирование, части)
 * — это граница метода, она названа в `docs/pipeline-format.md`.
 */

export const MASK = '***';

export interface Masker {
  /** Есть ли что маскировать. Пустое множество — проход без обработки. */
  readonly active: boolean;
  /** Длина самого длинного значения: столько без одного символа хвоста нельзя сбрасывать до конца строки. */
  readonly maxLength: number;
  /** Заменить вхождения значений в строке. */
  mask(text: string): string;
  /** То же во всех строках произвольного JSON-значения, включая ключи объектов. */
  maskValue<T>(value: T): T;
}

export function createMasker(values: Iterable<string>): Masker {
  const ordered = [...new Set(values)].filter((value) => value !== '').sort((a, b) => b.length - a.length);
  const maxLength = ordered[0]?.length ?? 0;

  if (ordered.length === 0) {
    return { active: false, maxLength: 0, mask: (text) => text, maskValue: (value) => value };
  }

  const mask = (text: string): string => {
    let out = text;
    for (const value of ordered) {
      if (out.includes(value)) out = out.replaceAll(value, MASK);
    }
    return out;
  };

  const maskValue = <T>(value: T): T => {
    if (typeof value === 'string') return mask(value) as T;
    if (Array.isArray(value)) return value.map((item) => maskValue(item)) as T;
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [mask(key), maskValue(item)]),
      ) as T;
    }
    return value;
  };

  return { active: true, maxLength, mask, maskValue };
}

/** Маскировщик без значений: журнал, созданный без секретов, пишет всё как есть. */
export const NO_MASK: Masker = createMasker([]);
