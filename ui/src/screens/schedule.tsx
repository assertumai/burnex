import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/schedule/declaration.ts';
import { Schedule } from '../pages/Schedule';
import { SCREEN } from '@burnex/slots';

/**
 * Экран «Schedule»: страница сама читает `GET /api/schedule` при открытии.
 * Потока событий у него нет — расписание не событие журнала, а свёртка
 * документов пайплайнов и манифестов прогонов.
 */
function ScheduleScreen({ navigate }: { readonly navigate: (href: string) => void }): JSX.Element {
  return <Schedule navigate={navigate} />;
}

export default function schedule(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: ScheduleScreen, key: declaration.id });
}
