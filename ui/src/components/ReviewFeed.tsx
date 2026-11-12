import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

import { Alert, AlertDescription, Badge, Button, EmptyState, type BadgeVariant } from '@burnex/ui';
import {
  fetchReviewFeed,
  type NoConsensusReason,
  type ReviewFeed,
  type ReviewFeedEntry,
  type ReviewFeedParticipant,
  type ReviewFeedProposal,
  type ReviewFeedQuote,
  type ReviewStance,
  type UsageSnapshot,
} from '../api';
import { fmtDuration, fmtTokens } from '../format';
import { TargetLink } from '../routeLink';
import { declaration as runScreen } from '../../../src/parts/ui/screens/run/declaration.ts';
import { Cost } from './Cost';
import { FileView } from './FileView';
import { StepOutput } from './StepOutput';
import './reviewFeed.css';

/**
 * Шаг `review` лентой обсуждения, как переписка в мессенджере
 * (`ui-review-discussion`): ревьюеры слева, вердикт агрегатора справа —
 * «наша сторона», выносящая итог (design.md, Решение 2). Рядом — панель
 * лимита реплик, предложений и расхода (Решение 3).
 *
 * Данные — модель ленты, собранная демоном из журнала шага
 * (`GET /api/review-feed`). Пока шаг идёт, она перечитывается раз в секунду —
 * тем же приёмом, что вывод шага в `StepOutput`, — и лента дополняется без
 * перезагрузки страницы.
 */

const POLL_MS = 1000;

/** Сколько реплик лента показывает развёрнутыми целиком; сверх — раунды, кроме последнего, свёрнуты. */
export const COLLAPSE_AFTER = 30;

/** Цветов участников в палитре витрины (`--participant-*` в `styles.css`). */
const PALETTE_SIZE = 6;

const STANCE: Readonly<Record<ReviewStance, { readonly label: string; readonly variant: BadgeVariant }>> = {
  propose: { label: 'proposes', variant: 'secondary' },
  agree: { label: 'agrees', variant: 'success' },
  disagree: { label: 'disagrees', variant: 'destructive' },
};

const NO_CONSENSUS: Readonly<Record<NoConsensusReason, string>> = {
  limit: 'message limit exhausted',
  stalled: 'positions stopped changing',
  budget: 'step budget exhausted',
  participants: 'only one reviewer gave findings',
};

const PROPOSAL_STATUS: Readonly<
  Record<ReviewFeedProposal['status'], { readonly label: string; readonly variant: BadgeVariant }>
> = {
  active: { label: 'active', variant: 'secondary' },
  accepted: { label: 'accepted by consensus', variant: 'success' },
  unsupported: { label: 'no support', variant: 'outline' },
};

/** Инициалы аватара: первые буквы двух слов id, иначе первые две буквы. */
export function initials(id: string): string {
  const words = id.split(/[-_.\s]+/).filter((word) => word !== '');
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : id.slice(0, 2);
  return letters.toUpperCase();
}

function colorClass(participant: ReviewFeedParticipant | undefined): string {
  return `participant-c${(participant?.color ?? 0) % PALETTE_SIZE}`;
}

/** Выбранный вызов участника: `round` — реплика раунда, без него — первый вызов. */
export interface ReviewSelection {
  readonly participant: string;
  readonly round?: number;
}

function Avatar({
  participant,
  id,
  onSelect,
}: {
  readonly participant: ReviewFeedParticipant | undefined;
  readonly id: string;
  readonly onSelect: (selection: ReviewSelection) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`review-avatar ${colorClass(participant)}`}
      aria-label={`Open the turn of ${id}`}
      title={`Open the turn of ${id}`}
      onClick={() => onSelect({ participant: id })}
    >
      {initials(id)}
    </button>
  );
}

function Who({ participant, id }: { readonly participant: ReviewFeedParticipant | undefined; readonly id: string }): JSX.Element {
  return (
    <>
      <span className={`review-name ${colorClass(participant)}`}>{id}</span>
      <span className="kind">{participant?.role ?? 'reviewer'}</span>
      {participant?.agent === undefined ? null : (
        <span className="kind dim">
          {participant.agent}
          {participant.model === undefined ? '' : ` · ${participant.model}`}
        </span>
      )}
    </>
  );
}

function Quote({ label, quote }: { readonly label: string; readonly quote: ReviewFeedQuote }): JSX.Element {
  return (
    <blockquote className="review-quote">
      <span className="kind">
        {label} {quote.id}
        {quote.by === undefined ? '' : ` · ${quote.by}`}
      </span>
      {quote.summary === '' ? null : <span className="review-quote-text">{quote.summary}</span>}
    </blockquote>
  );
}

function SystemLine({ children }: { readonly children: ReactNode }): JSX.Element {
  return <li className="review-system">{children}</li>;
}

function EntryView({
  entry,
  participants,
  maxMessages,
  onSelect,
}: {
  readonly entry: ReviewFeedEntry;
  readonly participants: ReadonlyMap<string, ReviewFeedParticipant>;
  readonly maxMessages: number | undefined;
  readonly onSelect: (selection: ReviewSelection) => void;
}): JSX.Element {
  switch (entry.kind) {
    case 'round':
      return <SystemLine>Round {entry.round}</SystemLine>;
    case 'failure':
      return (
        <SystemLine>
          Reviewer {entry.participant} gave no findings: {entry.reason}
        </SystemLine>
      );
    case 'outcome':
      return (
        <SystemLine>
          {entry.consensus ? `Consensus on proposal ${entry.proposal}` : `No consensus: ${NO_CONSENSUS[entry.reason]}`}
        </SystemLine>
      );
    case 'findings': {
      const participant = participants.get(entry.participant);
      return (
        <li className="review-message">
          <Avatar participant={participant} id={entry.participant} onSelect={onSelect} />
          <article className={`review-bubble ${colorClass(participant)}`}>
            <header className="review-bubble-head">
              <Who participant={participant} id={entry.participant} />
              <Badge variant="secondary">findings</Badge>
              {entry.proposal === undefined ? null : <span className="kind">proposal {entry.proposal}</span>}
              <OpenTurn selection={{ participant: entry.participant }} onSelect={onSelect} />
            </header>
            {entry.summary === '' ? null : <p className="review-text">{entry.summary}</p>}
            {entry.findings.length === 0 ? null : (
              <ul className="review-findings">
                {entry.findings.map((finding, index) => (
                  <li key={index}>
                    {finding.severity === undefined ? null : (
                      <Badge variant={finding.severity === 'critical' ? 'destructive' : 'outline'}>{finding.severity}</Badge>
                    )}{' '}
                    <b>{finding.title}</b>
                    {finding.location === undefined ? null : <span className="kind"> · {finding.location}</span>}
                  </li>
                ))}
              </ul>
            )}
          </article>
        </li>
      );
    }
    case 'message': {
      const participant = participants.get(entry.participant);
      const stance = STANCE[entry.stance];
      return (
        <li className="review-message">
          <Avatar participant={participant} id={entry.participant} onSelect={onSelect} />
          <article className={`review-bubble ${colorClass(participant)}`}>
            <header className="review-bubble-head">
              <Who participant={participant} id={entry.participant} />
              <Badge variant={stance.variant}>{stance.label}</Badge>
              {entry.invalid === true ? <Badge variant="destructive">reply failed the schema check</Badge> : null}
              {entry.failure === undefined ? null : <Badge variant="destructive">reply failed: {entry.failure}</Badge>}
              <span className="kind review-counter" title="reviewer's messages used of the limit">
                {entry.count}/{maxMessages ?? '?'}
              </span>
              <OpenTurn selection={{ participant: entry.participant, round: entry.round }} onSelect={onSelect} />
            </header>
            {entry.target === undefined ? null : (
              <Quote label={entry.stance === 'agree' ? 'agrees with' : 'replies to'} quote={entry.target} />
            )}
            {entry.target !== undefined
              ? null
              : entry.replyTo?.map((reply) => <Quote key={reply.id} label="in reply to" quote={reply} />)}
            {entry.text === '' ? null : <p className="review-text">{entry.text}</p>}
            {entry.proposal === undefined ? null : <Quote label="new proposal" quote={entry.proposal} />}
          </article>
        </li>
      );
    }
    case 'verdict': {
      const participant = participants.get(entry.participant);
      return (
        <li className="review-message own">
          <article className={`review-bubble ${colorClass(participant)}`}>
            <header className="review-bubble-head">
              <Who participant={participant} id={entry.participant} />
              <Badge variant={entry.status === 'success' ? 'success' : 'destructive'}>
                verdict{entry.verdict === undefined ? '' : `: ${entry.verdict}`}
              </Badge>
              <OpenTurn selection={{ participant: entry.participant }} onSelect={onSelect} />
            </header>
            {entry.reason === undefined ? null : <p className="review-text dim">{entry.reason}</p>}
            {entry.summary === undefined ? null : <p className="review-text">{entry.summary}</p>}
            {entry.output === undefined ? null : (
              <details>
                <summary className="kind">full output</summary>
                <pre>{JSON.stringify(entry.output, null, 2)}</pre>
              </details>
            )}
          </article>
          <Avatar participant={participant} id={entry.participant} onSelect={onSelect} />
        </li>
      );
    }
  }
}

function OpenTurn({
  selection,
  onSelect,
}: {
  readonly selection: ReviewSelection;
  readonly onSelect: (selection: ReviewSelection) => void;
}): JSX.Element {
  return (
    <Button variant="link" size="sm" className="review-open" onClick={() => onSelect(selection)}>
      turn ›
    </Button>
  );
}

/** Записи раунда — для сворачивания длинной ленты; раунд 0 — находки. */
function roundOf(entry: ReviewFeedEntry, current: number): number {
  return entry.kind === 'round' ? entry.round : current;
}

/**
 * Ленту делят на группы по раундам. Сворачиваются все раунды, кроме
 * последнего, когда реплик больше `COLLAPSE_AFTER` (design.md, «Риски»):
 * находки, системные строки исхода и вердикт остаются на виду.
 */
export function groupEntries(entries: readonly ReviewFeedEntry[]): {
  readonly round: number;
  readonly entries: readonly ReviewFeedEntry[];
  readonly collapsed: boolean;
}[] {
  const groups: { round: number; entries: ReviewFeedEntry[] }[] = [];
  let round = 0;
  for (const entry of entries) {
    const next = entry.kind === 'outcome' || entry.kind === 'verdict' ? -1 : roundOf(entry, round);
    round = next === -1 ? round : next;
    const key = next === -1 ? -1 : round;
    const last = groups.at(-1);
    if (last !== undefined && last.round === key) last.entries.push(entry);
    else groups.push({ round: key, entries: [entry] });
  }
  const messages = entries.filter((entry) => entry.kind === 'message').length;
  const rounds = groups.filter((group) => group.round > 0).map((group) => group.round);
  const lastRound = rounds.at(-1);
  return groups.map((group) => ({
    ...group,
    collapsed: messages > COLLAPSE_AFTER && group.round > 0 && group.round !== lastRound,
  }));
}

function runningLabel(participant: ReviewFeedParticipant): string {
  if (participant.role === 'aggregator') return `${participant.id} is writing the verdict…`;
  const round = participant.sessions.at(-1)?.round;
  return round === undefined ? `${participant.id} is reviewing…` : `${participant.id} is replying in round ${round}…`;
}

function SidePanel({
  feed,
  stepUsage,
  asOf,
}: {
  readonly feed: ReviewFeed;
  readonly stepUsage: UsageSnapshot | undefined;
  readonly asOf: string | undefined;
}): JSX.Element {
  const reviewers = feed.participants.filter((participant) => participant.role === 'reviewer');
  return (
    <aside className="review-side" aria-label="Discussion summary">
      {feed.mode !== 'discussion' || feed.maxMessages === undefined ? null : (
        <section>
          <h4>Message limit</h4>
          <ul>
            {reviewers.map((reviewer) => {
              const exhausted = reviewer.messages >= (feed.maxMessages ?? 0);
              return (
                <li key={reviewer.id} className={exhausted ? 'exhausted' : undefined}>
                  <span className={`review-name ${colorClass(reviewer)}`}>{reviewer.id}</span>{' '}
                  <span className="mono">
                    {reviewer.messages}/{feed.maxMessages}
                  </span>
                  {exhausted ? <span className="kind"> · exhausted</span> : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {feed.proposals.length === 0 ? null : (
        <section>
          <h4>Proposals</h4>
          <ul>
            {feed.proposals.map((proposal) => (
              <li key={proposal.id} title={proposal.summary}>
                <span className="mono">{proposal.id}</span> <span className="kind">by {proposal.by}</span>{' '}
                <Badge variant={PROPOSAL_STATUS[proposal.status].variant}>{PROPOSAL_STATUS[proposal.status].label}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h4>Usage</h4>
        <ul>
          {feed.participants.map((participant) => (
            <li key={participant.id}>
              <span className={`review-name ${colorClass(participant)}`}>{participant.id}</span>{' '}
              <span className="kind">
                {fmtTokens(participant.usage.billableTokens)} · {fmtDuration(participant.usage.wallclockMs)} ·{' '}
                <Cost usd={participant.usage.costUsd} source={participant.usage.costSource} asOf={asOf} />
              </span>
            </li>
          ))}
          {stepUsage === undefined ? null : (
            <li className="review-total">
              <b>step</b>{' '}
              <span className="kind">
                {fmtTokens(stepUsage.billableTokens)} · {fmtDuration(stepUsage.wallclockMs)} ·{' '}
                <Cost usd={stepUsage.costUsd} source={stepUsage.costSource} asOf={asOf} />
              </span>
            </li>
          )}
        </ul>
      </section>
    </aside>
  );
}

function ParticipantTurn({
  address,
  jobId,
  stepId,
  pass,
  feed,
  selection,
  onClose,
}: {
  readonly address: string;
  readonly jobId: string;
  readonly stepId: string;
  readonly pass: number | undefined;
  readonly feed: ReviewFeed;
  readonly selection: ReviewSelection;
  readonly onClose: () => void;
}): JSX.Element {
  const participant = feed.participants.find((entry) => entry.id === selection.participant);
  const session = participant?.sessions.find((entry) => entry.round === selection.round);
  // Ход открывается под лентой: выбранный у первых сообщений длинной ленты
  // иначе остался бы за краем экрана.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'start' });
  }, [selection.participant, selection.round]);
  return (
    <section ref={ref} className="review-turn" aria-label={`Turn of ${selection.participant}`}>
      <header className="review-bubble-head">
        <b>
          Turn of {selection.participant}
          {selection.round === undefined ? '' : ` · round ${selection.round}`}
        </b>
        {session?.status === undefined ? null : <span className="kind">{session.status}</span>}
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </header>
      {session?.stdout === undefined ? null : (
        <div className="row">
          <span className="label">raw</span>
          <FileView address={address} file={session.stdout} />
        </div>
      )}
      <StepOutput
        key={`${selection.participant}/${selection.round ?? 0}`}
        address={address}
        jobId={jobId}
        stepId={stepId}
        kind="agent"
        participant={selection.participant}
        {...(selection.round === undefined ? {} : { round: selection.round })}
        {...(pass === undefined ? {} : { pass })}
        defaultOpen
      />
    </section>
  );
}

/** Лента по готовой модели — без сети: её рисуют и тесты статическим рендером. */
export function ReviewFeedView({
  feed,
  address,
  jobId,
  stepId,
  pass,
  stepUsage,
  asOf,
  selected,
  onSelect,
  navigate = () => undefined,
}: {
  readonly feed: ReviewFeed;
  readonly address: string;
  readonly jobId: string;
  readonly stepId: string;
  readonly pass?: number | undefined;
  readonly stepUsage?: UsageSnapshot | undefined;
  readonly asOf?: string | undefined;
  readonly selected: ReviewSelection | undefined;
  readonly onSelect: (selection: ReviewSelection | undefined) => void;
  readonly navigate?: (href: string) => void;
}): JSX.Element {
  const participants = new Map(feed.participants.map((participant) => [participant.id, participant]));
  const running = feed.participants.filter((participant) => participant.running);
  const groups = groupEntries(feed.entries);

  const render = (entry: ReviewFeedEntry, index: number): JSX.Element => (
    <EntryView
      key={`${entry.kind}-${'messageId' in entry && entry.messageId !== undefined ? entry.messageId : index}`}
      entry={entry}
      participants={participants}
      maxMessages={feed.maxMessages}
      onSelect={onSelect}
    />
  );

  return (
    <div className="review-feed">
      <div className="review-chat">
        {feed.reusedFrom === undefined ? null : (
          <ReusedNotice runId={feed.reusedFrom.runId} available={feed.reusedFrom.available} address={address} navigate={navigate} />
        )}
        {feed.legacy ? (
          <Alert className="review-legacy">
            <AlertDescription>
              This step&apos;s journal has no discussion record — showing the participants and the aggregator output.
            </AlertDescription>
          </Alert>
        ) : null}
        {feed.legacy ? (
          <ul className="review-participants">
            {feed.participants.map((participant) => (
              <li key={participant.id} className="review-message">
                <Avatar participant={participant} id={participant.id} onSelect={onSelect} />
                <span className="review-bubble-head">
                  <Who participant={participant} id={participant.id} />
                  {participant.status === undefined ? null : <span className="kind">{participant.status}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <ol className="review-log" role="log" aria-live={feed.done ? 'off' : 'polite'} aria-label="Review discussion">
          {groups.map((group, index) =>
            group.collapsed ? (
              <li key={`group-${index}`} className="review-round-collapsed">
                <details>
                  <summary className="review-system">
                    Round {group.round} — {group.entries.filter((entry) => entry.kind === 'message').length} messages
                  </summary>
                  <ol className="review-log-inner">{group.entries.map(render)}</ol>
                </details>
              </li>
            ) : (
              group.entries.map((entry, inner) => render(entry, index * 1000 + inner))
            ),
          )}
          {running.map((participant) => (
            <li key={`running-${participant.id}`} className="review-system review-typing">
              {runningLabel(participant)}
            </li>
          ))}
        </ol>
        {feed.entries.length === 0 && running.length === 0 && !feed.legacy ? (
          <EmptyState title="No messages yet" description="The reviewers have not written anything so far." />
        ) : null}
        {selected === undefined ? null : (
          <ParticipantTurn
            address={address}
            jobId={jobId}
            stepId={stepId}
            pass={pass}
            feed={feed}
            selection={selected}
            onClose={() => onSelect(undefined)}
          />
        )}
      </div>
      <SidePanel feed={feed} stepUsage={stepUsage} asOf={asOf} />
    </div>
  );
}

/**
 * Шаг переиспользован при возобновлении: лента — из исходного прогона, а если
 * его уже нет, от неё остался вердикт.
 */
function ReusedNotice({
  runId,
  available,
  address,
  navigate,
}: {
  readonly runId: string;
  readonly available: boolean;
  readonly address: string;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const projectKey = address.slice(0, address.lastIndexOf('/'));
  return (
    <Alert className="review-legacy">
      <AlertDescription>
        Reused from run{' '}
        <TargetLink target={{ kind: 'screen', id: runScreen.id }} params={{ projectKey, runId }} navigate={navigate}>
          {runId}
        </TargetLink>
        {available
          ? ' — the discussion is shown from that run.'
          : ' — that run is no longer available, so only the verdict is shown.'}
      </AlertDescription>
    </Alert>
  );
}

/** Лента шага `review` с опросом демона, пока шаг идёт. */
export function ReviewFeedPanel({
  address,
  jobId,
  stepId,
  pass,
  stepUsage,
  asOf,
  navigate,
}: {
  readonly address: string;
  readonly jobId: string;
  readonly stepId: string;
  readonly pass?: number | undefined;
  readonly stepUsage?: UsageSnapshot | undefined;
  readonly asOf?: string | undefined;
  readonly navigate?: (href: string) => void;
}): JSX.Element {
  const [feed, setFeed] = useState<ReviewFeed | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<ReviewSelection | undefined>(undefined);

  // Перевзводимый таймер, а не `setInterval`: следующий опрос — после ответа
  // на предыдущий, тем же приёмом, что `StepOutput`. Модель ленты ограничена
  // лимитом реплик, и демон отдаёт её целиком, а не дописанным хвостом.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      fetchReviewFeed({ address, jobId, stepId, ...(pass === undefined ? {} : { pass }) })
        .then((next) => {
          if (!alive) return;
          setFeed(next);
          setError(undefined);
          if (!next.done) timer = setTimeout(tick, POLL_MS);
        })
        .catch((failure: Error) => {
          if (!alive) return;
          setError(failure.message);
          timer = setTimeout(tick, POLL_MS);
        });
    };
    tick();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [address, jobId, stepId, pass]);

  if (feed === undefined) {
    return error === undefined ? (
      <EmptyState title="Loading…" />
    ) : (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  return (
    <ReviewFeedView
      feed={feed}
      address={address}
      jobId={jobId}
      stepId={stepId}
      pass={pass}
      stepUsage={stepUsage}
      asOf={asOf}
      selected={selected}
      onSelect={setSelected}
      {...(navigate === undefined ? {} : { navigate })}
    />
  );
}
