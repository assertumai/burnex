import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/projects/declaration.ts';
import { Projects } from '../pages/Projects';
import { SCREEN } from '@burnex/slots';

/**
 * Экран «Projects»: реестр проектов, которые показывает витрина. Страница сама
 * читает `GET /api/projects` и пишет его `POST`/`DELETE` — потока событий у
 * реестра нет.
 */
export default function projects(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: Projects, key: declaration.id });
}
