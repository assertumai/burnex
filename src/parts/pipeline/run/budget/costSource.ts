import type { CostSource } from '../journal/schema.js';

/**
 * Как источник цены виден в отчётах. Один набор правил на `stepcast usage`,
 * `status` и ленту прогона: метку, расставленную в одном месте и забытую в
 * другом, читатель принял бы за точную цену.
 */

/** Оценка по каталогу или смесь с ней — сумма не равна счёту бэкенда. */
export function isEstimate(source: CostSource | undefined): boolean {
  return source === 'catalog' || source === 'mixed';
}

/** Метка перед суммой: `≈` у оценки, пусто у сообщённой цены и у записи прежней формы. */
export function estimateMark(source: CostSource | undefined): string {
  return isEstimate(source) ? '≈' : '';
}

/** Источник суммы нескольких частей: общий источник либо `mixed`; частей без цены нет — нет и источника. */
export function mergeCostSources(sources: readonly (CostSource | undefined)[]): CostSource | undefined {
  const present = new Set(sources.filter((source) => source !== undefined));
  if (present.size === 0) return undefined;
  return present.size === 1 ? [...present][0] : 'mixed';
}

/** Строка-пояснение метки; дата — прейскуранта, по которому считался этот прогон. */
export function estimateNote(asOf: string): string {
  return `≈ — оценка по каталогу цен от ${asOf}`;
}
