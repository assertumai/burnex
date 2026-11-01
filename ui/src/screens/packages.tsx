import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/packages/declaration.ts';
import { Packages } from '../pages/Packages';
import { SCREEN } from '@stepcast/slots';

/**
 * Экран «Packages»: страница сама читает `GET /api/packages` при открытии и по
 * кнопке. Потока событий у него нет — сводку пересобирает наблюдатель демона,
 * а экран перечитывает её по требованию.
 */
export default function packages(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: Packages, key: declaration.id });
}
