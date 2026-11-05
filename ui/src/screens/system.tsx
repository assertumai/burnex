import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/system/declaration.ts';
import { System } from '../pages/System';
import { SCREEN } from '@burnex/slots';

/**
 * Экран «System»: страница сама читает `GET /api/system` при открытии и после
 * действий. Потока событий у него нет — состояние установки не событие журнала.
 */
export default function system(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: System, key: declaration.id });
}
