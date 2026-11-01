import type { JSX } from 'react';

import { TargetLink } from '../routeLink';
import { RUN_TARGET } from '../screens/run';
import '../pages/backlog.css';

/**
 * Владелец взятого пункта (`claimed_by`): ссылка на прогон, когда демон разобрал
 * `run:<id>`, иначе строка как записана — владельца иной формы не прячем, но и
 * сходить к нему некуда. Без владельца место пусто.
 *
 * Правило формы владельца живёт в движке (`parseRunOwner`); сюда приходит уже
 * готовый `ownerRunId`.
 */
export function BacklogOwner({
  projectKey,
  claimedBy,
  ownerRunId,
  navigate,
}: {
  readonly projectKey: string;
  readonly claimedBy: string | undefined;
  readonly ownerRunId: string | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element | null {
  if (ownerRunId !== undefined) {
    return (
      <span className="backlog-owner small">
        owner{' '}
        <TargetLink target={RUN_TARGET} params={{ projectKey, runId: ownerRunId }} navigate={navigate}>
          run {ownerRunId}
        </TargetLink>
      </span>
    );
  }
  if (claimedBy === undefined) return null;
  return (
    <span className="backlog-owner small">
      owner <span className="mono">{claimedBy}</span>
    </span>
  );
}
