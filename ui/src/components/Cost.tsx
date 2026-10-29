import type { JSX } from 'react';

import { costTitle, fmtCost } from '../format';
import type { CostSource } from '../api';

/**
 * Цена с пометкой источника. Оценка по каталогу и смесь с ней несут `≈` и
 * подсказку — источник и дата прейскуранта; сообщённая цена и цена прогона
 * прежней формы (источника нет) выводятся как раньше, без метки.
 */
export function Cost({
  usd,
  source,
  asOf,
}: {
  readonly usd: number | null | undefined;
  readonly source?: CostSource | undefined;
  readonly asOf?: string | undefined;
}): JSX.Element {
  const title = usd === null || usd === undefined ? undefined : costTitle(source, asOf);
  return <span title={title}>{fmtCost(usd, source)}</span>;
}
