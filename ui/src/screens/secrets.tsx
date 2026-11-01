import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/secrets/declaration.ts';
import { Secrets } from '../pages/Secrets';
import { SCREEN } from '@stepcast/slots';

/**
 * Экран «Secrets»: страница сама читает `GET /api/secrets` при открытии и по
 * кнопке. Потока событий у него нет — статус секрета не событие журнала, а
 * результат пробы здесь и сейчас.
 */
export default function secrets(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: Secrets, key: declaration.id });
}
