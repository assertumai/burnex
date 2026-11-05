import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/backlog/declaration.ts';
import type { BacklogOverview } from '../api';
import { Backlog } from '../pages/Backlog';
import { SCREEN } from '@burnex/slots';

function BacklogScreen({
  backlog,
  navigate,
}: {
  readonly backlog: BacklogOverview | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  return <Backlog backlog={backlog} navigate={navigate} />;
}

export default function backlog(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: BacklogScreen, key: declaration.id });
}
