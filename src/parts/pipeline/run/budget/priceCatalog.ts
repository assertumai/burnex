import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { StepcastError } from '../../../../kernel/errors.js';
import type { BackendAdapter } from '../../backend/types.js';
import { enginePackageRoot } from '../../document/packagePaths.js';
import type { Usage } from '../journal/schema.js';

/**
 * Каталог цен моделей — оценка денежного расхода для бэкенда, который цену
 * не сообщает (design.md изменения model-price-catalog, решения 3 и 4).
 *
 * Каталог поставляется пакетом (`src/builtin/prices/model-prices.json`), так
 * что его порча — дефект поставки, а не данные пользователя: загрузчик
 * отказывает целиком и называет файл и запись.
 */

/** Цена за миллион токенов; все четыре обязательны — «нет цены» не равно нулю. */
const priceField = z.number().nonnegative();

const PriceEntrySchema = z
  .object({
    backend: z.string().min(1),
    model: z.string().min(1),
    aliases: z.array(z.string().min(1)),
    input: priceField,
    output: priceField,
    cache_read: priceField,
    cache_write: priceField,
  })
  .strict();

const PriceCatalogSchema = z
  .object({
    format: z.literal(1),
    as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    currency: z.literal('USD'),
    unit: z.literal('per_million_tokens'),
    sources: z.array(z.string()),
    models: z.array(z.unknown()),
  })
  .strict();

export type PriceEntry = z.infer<typeof PriceEntrySchema>;

export interface PriceCatalog {
  /** Дата прейскуранта — уходит в `usage.json` рядом с оценкой. */
  readonly asOf: string;
  /** Запись для пары «бэкенд, модель» по точному имени или псевдониму. */
  find(backend: string, model: string): PriceEntry | undefined;
}

/** Ошибка старта: каталог поставлен пакетом, его порча — дефект поставки. */
export class PriceCatalogError extends StepcastError {}

export function priceCatalogPath(): string {
  return join(enginePackageRoot(), 'src', 'builtin', 'prices', 'model-prices.json');
}

export function loadPriceCatalog(path: string = priceCatalogPath()): PriceCatalog {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new PriceCatalogError(
      `каталог цен ${path} не читается: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const head = PriceCatalogSchema.safeParse(raw);
  if (!head.success) {
    const issue = head.error.issues[0];
    throw new PriceCatalogError(
      `каталог цен ${path}: поле ${issue?.path.join('.') ?? ''} — ${issue?.message ?? 'неверная форма'}`,
    );
  }

  const byName = new Map<string, PriceEntry>();
  head.data.models.forEach((item, index) => {
    const parsed = PriceEntrySchema.safeParse(item);
    const label = (item as { model?: unknown } | null)?.model;
    const where = `запись ${index + 1}${typeof label === 'string' ? ` (${label})` : ''}`;
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new PriceCatalogError(
        `каталог цен ${path}, ${where}: поле ${issue?.path.join('.') ?? ''} — ${issue?.message ?? 'неверно'}`,
      );
    }
    const entry = parsed.data;
    for (const name of [entry.model, ...entry.aliases]) {
      // Ключ включает бэкенд: псевдоним `opus` осмыслен только внутри своего CLI.
      const key = `${entry.backend}\u0000${name}`;
      if (byName.has(key)) {
        throw new PriceCatalogError(
          `каталог цен ${path}, ${where}: имя «${name}» уже занято для бэкенда ${entry.backend}`,
        );
      }
      byName.set(key, entry);
    }
  });

  return {
    asOf: head.data.as_of,
    // Без нормализации регистра и префиксов: ошибиться ценой хуже, чем её не дать.
    find: (backend, model) => byName.get(`${backend}\u0000${model}`),
  };
}

/**
 * Оценка вызова в долларах: Σ токенов × цена за миллион. Цена за миллион
 * токенов в долларах численно равна цене токена в микродолларах, поэтому
 * сумма считается в микродолларах и округляется вверх один раз — для
 * потолка занизить хуже, чем завысить на микродоллар. Поле с `null` даёт
 * ноль: его неполнота уже отмечена в `unreported`.
 */
export function estimateCostUsd(
  entry: PriceEntry,
  usage: Pick<Usage, 'tokens_in' | 'tokens_out' | 'cache_read' | 'cache_write'>,
): number {
  const micro =
    (usage.tokens_in ?? 0) * entry.input +
    (usage.tokens_out ?? 0) * entry.output +
    (usage.cache_read ?? 0) * entry.cache_read +
    (usage.cache_write ?? 0) * entry.cache_write;
  // Шум двоичной дроби (0.1 × 3 даёт 0.30000000000000004) не должен
  // прибавлять лишний микродоллар к точной сумме.
  return Math.ceil(Math.round(micro * 1e6) / 1e6) / 1_000_000;
}

/**
 * Действующая цена вызова по правилу решения 1: сообщённая бэкендом главнее
 * и каталога не касается; иначе оценка по каталогу, если модель вызова в нём
 * есть, а входные и выходные токены сообщены; иначе вызов неучтён в деньгах.
 * Зовётся один раз на границе вызова, а не по потоковым сообщениям: денежный
 * потолок связывает после попытки (решение 5).
 */
export function priceUsage(usage: Usage, catalog: PriceCatalog | undefined): Usage {
  if (usage.reported_cost_usd !== undefined) {
    return { ...usage, cost_usd: usage.reported_cost_usd, cost_source: 'reported' };
  }
  if (catalog === undefined || usage.model === undefined) return usage;
  if (usage.tokens_in === null || usage.tokens_out === null) return usage;
  const entry = catalog.find(usage.backend, usage.model);
  if (entry === undefined) return usage;
  return { ...usage, cost_usd: estimateCostUsd(entry, usage), cost_source: 'catalog' };
}

/**
 * Вызов без цены: бэкенд её не сообщает, а модель не названа или каталог её не
 * знает — `budget.cost` такой вызов не увидит. Каталог ищется по имени
 * адаптера — тому же, что окажется в `Usage.backend`. Правило одно на раннер
 * (предупреждение `budget.cost_unpriced`) и на экран System.
 */
export function isUnpricedCall(
  adapter: Pick<BackendAdapter, 'name' | 'capabilities'>,
  model: string | undefined,
  catalog: PriceCatalog | undefined,
): boolean {
  if (adapter.capabilities.reportsCost === true) return false;
  return model === undefined || catalog?.find(adapter.name, model) === undefined;
}

const catalogBackendsByModel = new Map<string, Map<string, Set<string>>>();

/**
 * Бэкенды, у которых каталог знает модель — по точному имени или псевдониму.
 * Нужен раскрытию пайплайна как статическое знание «чья эта модель»
 * (`agent-policy-and-pipeline-agents`, решение 4): процессов CLI он не
 * запускает, а каталог читает один раз на путь — раскрытие зовут линт,
 * витрина и `stepcast config`, и перечитывать файл на каждом шаге незачем.
 */
export function backendsKnowingModel(model: string, path: string = priceCatalogPath()): ReadonlySet<string> {
  let index = catalogBackendsByModel.get(path);
  if (index === undefined) {
    index = new Map();
    const catalog = JSON.parse(readFileSync(path, 'utf8')) as {
      models?: Array<{ backend: string; model: string; aliases?: string[] }>;
    };
    // Форму записей проверяет `loadPriceCatalog`; индексу нужны только имена,
    // а порча каталога доходит до старта прогона его же отказом.
    for (const entry of catalog.models ?? []) {
      for (const name of [entry.model, ...(entry.aliases ?? [])]) {
        const owners = index.get(name) ?? new Set<string>();
        owners.add(entry.backend);
        index.set(name, owners);
      }
    }
    catalogBackendsByModel.set(path, index);
  }
  return index.get(model) ?? new Set();
}
