import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

import { Alert, AlertDescription, Badge, Button, EmptyState, Tabs, TabsList, TabsTrigger, type BadgeVariant } from '@burnex/ui';
import {
  fetchReviewFeed,
  type ReviewFeed,
  type ReviewFeedDefender,
  type ReviewFeedEntry,
  type ReviewFeedParticipant,
  type ReviewFeedResponse,
  type ReviewFeedSession,
  type ReviewFinding,
  type ReviewFindingStatus,
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
 * Шаг `review` лентой, как переписка в мессенджере (`review-defend`,
 * design.md, решение 8): ревьюеры слева со своими находками, под находками —
 * ветка защиты; защитник и вердикт агрегатора — справа, на противоположной
 * стороне. Рядом — панель находок со статусами, раундов веток и расхода.
 * Ревьюеров больше одного — над лентой вкладки «All» и по ревьюеру: вкладка
 * показывает ветку одного ревьюера и сводку по его находкам.
 *
 * Данные — модель ленты, собранная демоном из журнала шага
 * (`GET /api/review-feed`). Пока шаг идёт, она перечитывается раз в секунду —
 * тем же приёмом, что вывод шага в `StepOutput`, — и лента дополняется без
 * перезагрузки страницы: новые реплики и закрытия находок приходят со
 * следующим опросом.
 */

const POLL_MS = 1000;

/** Цветов участников в палитре витрины (`--participant-*` в `styles.css`). */
const PALETTE_SIZE = 6;

const STATUS: Readonly<Record<ReviewFindingStatus, { readonly label: string; readonly variant: BadgeVariant }>> = {
  open: { label: 'open', variant: 'running' },
  accepted: { label: 'accepted', variant: 'success' },
  withdrawn: { label: 'withdrawn', variant: 'secondary' },
  contested: { label: 'contested', variant: 'destructive' },
};

const STANCE: Readonly<Record<ReviewFeedResponse['stance'], { readonly label: string; readonly variant: BadgeVariant }>> = {
  accept: { label: 'accepts', variant: 'success' },
  dispute: { label: 'disputes', variant: 'destructive' },
  clarify: { label: 'clarifies', variant: 'secondary' },
  maintain: { label: 'maintains', variant: 'destructive' },
  withdraw: { label: 'withdraws', variant: 'success' },
  revise: { label: 'revises', variant: 'secondary' },
};

/** Почему защищает свежий агент — значения `reason` (design.md, решение 3). */
const FRESH_REASON: Readonly<Record<string, string>> = {
  no_implementer: 'the step names no implementer',
  no_session: 'the implementer step recorded no session',
  no_fork: "the implementer's agent cannot fork sessions",
  no_schema: "the implementer's agent cannot answer by a JSON schema",
  other_tree: "the implementer ran in another workspace tree",
};

/** Инициалы аватара: первые буквы двух слов id, иначе первые две буквы. */
export function initials(id: string): string {
  const words = id.split(/[-_.\s]+/).filter((word) => word !== '');
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : id.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * Итог ревью в интерфейсе называется судьёй: роль `aggregator` журнала и
 * участник с умолчательным id `aggregator` показываются как `judge`. Данные и
 * ключ стратегии не меняются.
 */
export function roleLabel(role: string | undefined): string {
  if (role === undefined) return 'reviewer';
  return role === 'aggregator' ? 'judge' : role;
}

export function displayId(id: string): string {
  return id === 'aggregator' ? 'judge' : id;
}

/** Вкладка ленты: все сообщения либо ветка одного ревьюера. */
export const ALL_TAB = 'all';

/** Ревьюеры, по которым ленту можно разложить на вкладки, в порядке участников. */
export function reviewerTabs(feed: Pick<ReviewFeed, 'participants'>): string[] {
  return feed.participants.filter((participant) => participant.role === 'reviewer').map((participant) => participant.id);
}

/**
 * Записи вкладки ревьюера: строка о защитнике (кто ему отвечает), его
 * находки или отказ и его ветка защиты. Итог защиты и вердикт — общие, они
 * только во вкладке «All».
 */
export function entriesForTab(entries: readonly ReviewFeedEntry[], tab: string): readonly ReviewFeedEntry[] {
  if (tab === ALL_TAB) return entries;
  return entries.filter((entry) => {
    switch (entry.kind) {
      case 'defender':
        return true;
      case 'findings':
      case 'failure':
        return entry.participant === tab;
      case 'reply':
        return entry.thread === tab;
      case 'outcome':
      case 'verdict':
        return false;
    }
  });
}

function colorClass(participant: ReviewFeedParticipant | undefined): string {
  return `participant-c${(participant?.color ?? 0) % PALETTE_SIZE}`;
}

/**
 * Выбранный вызов участника: без `round` — первый вызов, с `round` — ответ
 * этого раунда, с `thread` и `round` — ход защитника в ветке ревьюера.
 */
export interface ReviewSelection {
  readonly participant: string;
  readonly round?: number;
  readonly thread?: string;
}

/** Метка позиции ответа: `revises → major` несёт новую серьёзность. */
export function stanceLabel(response: Pick<ReviewFeedResponse, 'stance' | 'severity'>): string {
  const label = STANCE[response.stance].label;
  return response.stance === 'revise' && response.severity !== undefined ? `${label} → ${response.severity}` : label;
}

/** Строка о защитнике: форк сессии имплементатора либо свежий агент с причиной. */
export function defenderLine(defender: ReviewFeedDefender): string {
  const agent = [defender.agent, defender.model].filter((part) => part !== undefined).join(' · ');
  if (defender.mode === 'fork') {
    return `Defender: fork of the ${defender.implementer ?? 'implementer'} session${agent === '' ? '' : ` · ${agent}`}`;
  }
  const reason = defender.reason === undefined ? undefined : (FRESH_REASON[defender.reason] ?? defender.reason);
  return `Defender: fresh agent${agent === '' ? '' : ` ${agent}`}${reason === undefined ? '' : ` — ${reason}`}`;
}

function Avatar({
  participant,
  id,
  selection,
  onSelect,
}: {
  readonly participant: ReviewFeedParticipant | undefined;
  readonly id: string;
  readonly selection?: ReviewSelection;
  readonly onSelect: (selection: ReviewSelection) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`review-avatar ${colorClass(participant)}`}
      aria-label={`Open the turn of ${displayId(id)}`}
      title={`Open the turn of ${displayId(id)}`}
      onClick={() => onSelect(selection ?? { participant: id })}
    >
      {initials(displayId(id))}
    </button>
  );
}

function Who({ participant, id }: { readonly participant: ReviewFeedParticipant | undefined; readonly id: string }): JSX.Element {
  return (
    <>
      <span className={`review-name ${colorClass(participant)}`}>{displayId(id)}</span>
      <span className="kind">{roleLabel(participant?.role)}</span>
      {participant?.agent === undefined ? null : (
        <span className="kind dim">
          {participant.agent}
          {participant.model === undefined ? '' : ` · ${participant.model}`}
        </span>
      )}
    </>
  );
}

function SystemLine({ children }: { readonly children: ReactNode }): JSX.Element {
  return <li className="review-system">{children}</li>;
}

function Severity({ severity, revisedFrom }: { readonly severity: string | undefined; readonly revisedFrom?: string | undefined }): JSX.Element | null {
  if (severity === undefined) return null;
  return (
    <Badge variant={severity === 'critical' ? 'destructive' : 'outline'} title={revisedFrom === undefined ? undefined : `revised from ${revisedFrom}`}>
      {severity}
      {revisedFrom === undefined ? '' : ` (revised from ${revisedFrom})`}
    </Badge>
  );
}

function FindingCard({ finding }: { readonly finding: ReviewFinding }): JSX.Element {
  return (
    <li className="review-finding">
      {finding.id === undefined ? null : <span className="mono">{finding.id}</span>}{' '}
      {finding.status === undefined ? null : <Badge variant={STATUS[finding.status].variant}>{STATUS[finding.status].label}</Badge>}{' '}
      <Severity severity={finding.severity} revisedFrom={finding.revisedFrom} /> <b>{finding.title}</b>
      {finding.location === undefined ? null : <span className="kind"> · {finding.location}</span>}
    </li>
  );
}

function ResponseView({ response }: { readonly response: ReviewFeedResponse }): JSX.Element {
  return (
    <li className="review-response">
      <span className="mono">{response.finding}</span>{' '}
      <Badge variant={STANCE[response.stance].variant}>{stanceLabel(response)}</Badge>
      {response.text === '' ? null : <span className="review-response-text"> {response.text}</span>}
      {response.evidence === undefined ? null : (
        <span className="review-evidence">
          <span className="kind">evidence</span> <code>{response.evidence}</code>
        </span>
      )}
    </li>
  );
}

function EntryView({
  entry,
  participants,
  rounds,
  onSelect,
}: {
  readonly entry: ReviewFeedEntry;
  readonly participants: ReadonlyMap<string, ReviewFeedParticipant>;
  readonly rounds: number | undefined;
  readonly onSelect: (selection: ReviewSelection) => void;
}): JSX.Element {
  switch (entry.kind) {
    case 'defender':
      return <SystemLine>{defenderLine(entry)}</SystemLine>;
    case 'failure':
      return (
        <SystemLine>
          Reviewer {entry.participant} gave no findings: {entry.reason}
        </SystemLine>
      );
    case 'outcome':
      return (
        <SystemLine>
          Defense finished: {entry.accepted} accepted · {entry.withdrawn} withdrawn · {entry.contested} contested
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
              <OpenTurn selection={{ participant: entry.participant }} onSelect={onSelect} />
            </header>
            {entry.summary === '' ? null : <p className="review-text">{entry.summary}</p>}
            {entry.findings.length === 0 ? (
              <p className="review-text dim">No findings.</p>
            ) : (
              <ul className="review-findings">
                {entry.findings.map((finding, index) => (
                  <FindingCard key={finding.id ?? index} finding={finding} />
                ))}
              </ul>
            )}
          </article>
        </li>
      );
    }
    case 'reply': {
      const participant = participants.get(entry.participant);
      const defender = entry.side === 'defender';
      const selection: ReviewSelection = defender
        ? { participant: entry.participant, thread: entry.thread, round: entry.round }
        : { participant: entry.participant, round: entry.round };
      const avatar = <Avatar participant={participant} id={entry.participant} selection={selection} onSelect={onSelect} />;
      return (
        <li className={`review-message review-thread${defender ? ' own' : ''}`}>
          {defender ? null : avatar}
          <article className={`review-bubble ${colorClass(participant)}`}>
            <header className="review-bubble-head">
              <Who participant={participant} id={entry.participant} />
              {defender ? <span className="kind">on {entry.thread}</span> : null}
              {entry.invalid === true ? <Badge variant="destructive">reply failed the schema check</Badge> : null}
              {entry.failure === undefined ? null : <Badge variant="destructive">reply failed: {entry.failure}</Badge>}
              <span className="kind review-counter" title="round of this thread of the limit">
                round {entry.round}/{rounds ?? '?'}
              </span>
              <OpenTurn selection={selection} onSelect={onSelect} />
            </header>
            {entry.text === '' ? null : <p className="review-text">{entry.text}</p>}
            {entry.responses.length === 0 ? null : (
              <ul className="review-responses">
                {entry.responses.map((response) => (
                  <ResponseView key={response.finding} response={response} />
                ))}
              </ul>
            )}
          </article>
          {defender ? avatar : null}
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

function sessionLabel(participant: ReviewFeedParticipant, session: ReviewFeedSession): string {
  const id = displayId(participant.id);
  if (participant.role === 'aggregator') return `${id} is writing the verdict…`;
  if (session.thread !== undefined) return `${id} is answering ${session.thread} in round ${session.round ?? '?'}…`;
  return session.round === undefined
    ? `${id} is reviewing…`
    : `${id} is answering the defender in round ${session.round}…`;
}

/**
 * Кто пишет прямо сейчас: по строке на начатый вызов — ветки защитника идут
 * параллельно. Во вкладке ревьюера — только он сам и защитник в его ветке.
 */
export function runningLabels(participants: readonly ReviewFeedParticipant[], tab: string = ALL_TAB): string[] {
  return participants.flatMap((participant) => {
    if (!participant.running) return [];
    if (tab !== ALL_TAB && participant.role !== 'defender' && participant.id !== tab) return [];
    const sessions = participant.sessions.filter(
      (session) => session.running && (tab === ALL_TAB || participant.role !== 'defender' || session.thread === tab),
    );
    if (tab !== ALL_TAB && participant.role === 'defender' && sessions.length === 0) return [];
    return sessions.length === 0 ? [sessionLabel(participant, { running: true })] : sessions.map((session) => sessionLabel(participant, session));
  });
}

function SidePanel({
  feed,
  tab,
  stepUsage,
  asOf,
}: {
  readonly feed: ReviewFeed;
  readonly tab: string;
  readonly stepUsage: UsageSnapshot | undefined;
  readonly asOf: string | undefined;
}): JSX.Element {
  const findings = tab === ALL_TAB ? feed.findings : feed.findings.filter((finding) => finding.by === tab);
  const threads = tab === ALL_TAB ? feed.threads : feed.threads.filter((thread) => thread.reviewer === tab);
  return (
    <aside className="review-side" aria-label="Review summary">
      {findings.length === 0 ? null : (
        <section>
          <h4>Findings</h4>
          <ul>
            {findings.map((finding) => (
              <li key={finding.id} title={finding.title}>
                <span className="mono">{finding.id}</span>{' '}
                <Badge variant={STATUS[finding.status].variant}>{STATUS[finding.status].label}</Badge>{' '}
                <Severity severity={finding.severity} revisedFrom={finding.revisedFrom} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {threads.length === 0 ? null : (
        <section>
          <h4>Rounds</h4>
          <ul>
            {threads.map((thread) => {
              const reviewer = feed.participants.find((participant) => participant.id === thread.reviewer);
              return (
                <li key={thread.reviewer} className={thread.settled ? 'settled' : undefined}>
                  <span className={`review-name ${colorClass(reviewer)}`}>{thread.reviewer}</span>{' '}
                  <span className="mono">
                    {thread.rounds}/{feed.rounds ?? '?'}
                  </span>
                  {thread.settled ? <span className="kind"> · settled</span> : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section>
        <h4>Usage</h4>
        <ul>
          {feed.participants.map((participant) => (
            <li key={participant.id}>
              <span className={`review-name ${colorClass(participant)}`}>{displayId(participant.id)}</span>{' '}
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

function selectionTitle(selection: ReviewSelection): string {
  const thread = selection.thread === undefined ? '' : ` · on ${selection.thread}`;
  const round = selection.round === undefined ? '' : ` · round ${selection.round}`;
  return `Turn of ${displayId(selection.participant)}${thread}${round}`;
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
  const session = participant?.sessions.find((entry) => entry.round === selection.round && entry.thread === selection.thread);
  // Ход открывается под лентой: выбранный у первых сообщений длинной ленты
  // иначе остался бы за краем экрана.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'start' });
  }, [selection.participant, selection.round, selection.thread]);
  return (
    <section ref={ref} className="review-turn" aria-label={`Turn of ${displayId(selection.participant)}`}>
      <header className="review-bubble-head">
        <b>{selectionTitle(selection)}</b>
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
        key={`${selection.participant}/${selection.thread ?? ''}/${selection.round ?? 0}`}
        address={address}
        jobId={jobId}
        stepId={stepId}
        kind="agent"
        participant={selection.participant}
        {...(selection.round === undefined ? {} : { round: selection.round })}
        {...(selection.thread === undefined ? {} : { thread: selection.thread })}
        {...(pass === undefined ? {} : { pass })}
        defaultOpen
      />
    </section>
  );
}

function legacyNotice(feed: ReviewFeed): string {
  return feed.legacyMode === 'discussion'
    ? 'This step ran in the retired discussion mode — showing the participants and the judge output.'
    : 'This step’s journal has no review record — showing the participants and the judge output.';
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
  initialTab = ALL_TAB,
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
  /** Вкладка при первом рендере — для тестов статическим рендером. */
  readonly initialTab?: string;
  readonly navigate?: (href: string) => void;
}): JSX.Element {
  const participants = new Map(feed.participants.map((participant) => [participant.id, participant]));
  const reviewers = reviewerTabs(feed);
  // Вкладки — когда ревьюеров больше одного: с одним «All» и его вкладка совпадают.
  const tabbed = !feed.legacy && reviewers.length > 1;
  const [chosen, setTab] = useState(initialTab);
  const tab = tabbed && (chosen === ALL_TAB || reviewers.includes(chosen)) ? chosen : ALL_TAB;
  const entries = entriesForTab(feed.entries, tab);
  const running = runningLabels(feed.participants, tab);

  return (
    <div className="review-feed">
      <div className="review-chat">
        {feed.reusedFrom === undefined ? null : (
          <ReusedNotice runId={feed.reusedFrom.runId} available={feed.reusedFrom.available} address={address} navigate={navigate} />
        )}
        {feed.legacy ? (
          <Alert className="review-legacy">
            <AlertDescription>{legacyNotice(feed)}</AlertDescription>
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
        {tabbed ? (
          <Tabs value={tab} onValueChange={setTab} className="review-tabs">
            <TabsList aria-label="Review threads">
              <TabsTrigger value={ALL_TAB}>All</TabsTrigger>
              {reviewers.map((reviewer) => (
                <TabsTrigger key={reviewer} value={reviewer} className={colorClass(participants.get(reviewer))}>
                  {reviewer}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}
        <ol className="review-log" role="log" aria-live={feed.done ? 'off' : 'polite'} aria-label="Review feed">
          {entries.map((entry, index) => (
            <EntryView
              key={`${entry.kind}-${entry.kind === 'reply' ? entry.messageId : 'participant' in entry ? entry.participant : index}`}
              entry={entry}
              participants={participants}
              rounds={feed.rounds}
              onSelect={onSelect}
            />
          ))}
          {running.map((label) => (
            <li key={`running-${label}`} className="review-system review-typing">
              {label}
            </li>
          ))}
        </ol>
        {entries.length === 0 && running.length === 0 && !feed.legacy ? (
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
      <SidePanel feed={feed} tab={tab} stepUsage={stepUsage} asOf={asOf} />
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
          ? ' — the review is shown from that run.'
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
  // числом раундов веток, и демон отдаёт её целиком, а не дописанным хвостом.
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
