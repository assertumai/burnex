import type { JSX } from 'react';

import { Badge } from '@burnex/ui';

/**
 * Метка shadow-прогона: локальные шаги исполнены, а внешние действия записаны,
 * не совершены (`shadow-run-mode`). Обычный прогон метки не несёт. Отдельный
 * модуль, а не соседство с `TriggerBadge`: метка нужна и списку, и странице
 * прогона, а те не должны импортировать друг друга.
 */
export function ShadowBadge({ mode }: { readonly mode: 'shadow' | undefined }): JSX.Element | null {
  if (mode === undefined) return null;
  return <Badge title="external actions were recorded, not performed">shadow</Badge>;
}
