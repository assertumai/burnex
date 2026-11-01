import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/home/declaration.ts';
import type { Overview, ProposalsStreamEvent } from '../api';
import { Home } from '../pages/Home';
import { SCREEN } from '@stepcast/slots';

/** Экран «Home» (`ui-home-screen`): стартовая страница — обзор и очередь предложений приходят props каркаса. */
function HomeScreen({
  overview,
  proposals,
  navigate,
}: {
  readonly overview: Overview | undefined;
  readonly proposals: ProposalsStreamEvent | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  return <Home overview={overview} proposals={proposals} navigate={navigate} />;
}

export default function home(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: HomeScreen, key: declaration.id });
}
