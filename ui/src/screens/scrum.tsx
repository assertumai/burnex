import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/scrum/declaration.ts';
import type { BacklogOverview } from '../api';
import { Scrum } from '../pages/Scrum';
import { SCREEN } from '@stepcast/slots';

function ScrumScreen({
  backlog,
  navigate,
}: {
  readonly backlog: BacklogOverview | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  return <Scrum backlog={backlog} navigate={navigate} />;
}

export default function scrum(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: ScrumScreen, key: declaration.id });
}
