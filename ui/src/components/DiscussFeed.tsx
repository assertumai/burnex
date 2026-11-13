import { useEffect, useState, type JSX, type ReactNode } from 'react';

import { Alert, AlertDescription, Badge, Button, EmptyState, Tabs, TabsList, TabsTrigger, type BadgeVariant } from '@burnex/ui';
import {
  designRenderUrl,
  fetchDiscussFeed,
  type DiscussFeed,
  type DiscussFeedCall,
  type DiscussFeedMessage,
  type DiscussFeedObjection,
  type DiscussFeedParticipant,
  type DiscussObjectionStatus,
  type DiscussPhaseName,
  type DiscussPhaseState,
  type UsageSnapshot,
} from '../api';
import { fmtDuration, fmtTokens } from '../format';
import { Cost } from './Cost';
import { DesignDocView } from './DesignDoc';
import { FileView } from './FileView';
import { MermaidDiagram } from './Mermaid';
import { colorClass, initials, ReusedNotice } from './ReviewFeed';
import './reviewFeed.css';
import './discussFeed.css';

/**
 * Шаг `discuss` в деталях прогона (`render-design`, design.md, решение 8):
 * строка фаз, участники с их вызовами и две вкладки — итоговый документ с
 * диаграммами и скачиванием и лента обсуждения: предложения, черновик
 * автора, возражения по точкам решения и реплики раундов защиты. Реплики
 * автора — справа, участников — слева, как в ленте `review`.
 *
 * Данные — модель ленты от демона (`GET /api/discuss-feed`); пока шаг идёт,
 * она перечитывается раз в секунду.
 */

const POLL_MS = 1000;

const PHASE_LABEL: Readonly<Record<DiscussPhaseName, string>> = {
  proposals: 'proposals',
  draft: 'draft',
  objections: 'objections',
  defense: 'defense',
  aggregate: 'document',
};

const PHASE_VARIANT: Readonly<Record<DiscussPhaseState, BadgeVariant>> = {
  pending: 'outline',
  running: 'running',
  done: 'success',
  skipped: 'secondary',
};

const OBJECTION_STATUS: Readonly<Record<DiscussObjectionStatus, { readonly label: string; readonly variant: BadgeVariant }>> = {
  open: { label: 'open', variant: 'running' },
  accepted: { label: 'accepted', variant: 'success' },
  withdrawn: { label: 'withdrawn', variant: 'secondary' },
  contested: { label: 'contested', variant: 'destructive' },
  note: { label: 'note', variant: 'outline' },
};

const STANCE_LABEL: Readonly<Record<string, string>> = {
  accept: 'accepts',
  dispute: 'disputes',
  clarify: 'clarifies',
  maintain: 'maintains',
  withdraw: 'withdraws',
};

export type DiscussTab = 'document' | 'discussion';

/** Выбранный вызов участника — индекс в его `calls`. */
export interface DiscussSelection {
  readonly participant: string;
  readonly call: number;
}

/** Подпись вызова: фаза, раунд и повтор черновика. */
export function callLabel(call: Pick<DiscussFeedCall, 'phase' | 'round' | 'retry'>): string {
  const base = call.phase === 'defense' ? `round ${call.round ?? '?'}` : PHASE_LABEL[call.phase];
  return call.retry === true ? `${base} (retry)` : base;
}

/** Вкладка по умолчанию: документ, когда он есть, иначе обсуждение. */
export function defaultTab(feed: Pick<DiscussFeed, 'document' | 'output'>): DiscussTab {
  return feed.document !== undefined || feed.output !== undefined ? 'document' : 'discussion';
}

/** Подписи идущих вызовов — «… is writing». */
export function runningLabels(participants: readonly DiscussFeedParticipant[]): string[] {
  return participants.flatMap((participant) =>
    participant.calls.filter((call) => call.running).map((call) => `${participant.id} is writing (${callLabel(call)})…`),
  );
}

function Who({ participant, id }: { readonly participant: DiscussFeedParticipant | undefined; readonly id: string }): JSX.Element {
  return (
    <>
      <span className={`review-name ${colorClass(participant)}`}>{id}</span>
      {participant === undefined || participant.role === 'participant' ? null : <span className="kind">{participant.role}</span>}
    </>
  );
}

function Message({
  participant,
  id,
  own = false,
  children,
}: {
  readonly participant: DiscussFeedParticipant | undefined;
  readonly id: string;
  readonly own?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <li className={`review-message ${own ? 'own' : ''} ${colorClass(participant)}`}>
      <span className="review-avatar discuss-avatar" aria-hidden="true">
        {initials(id)}
      </span>
      <div className="review-bubble">{children}</div>
    </li>
  );
}

function ObjectionView({ objection }: { readonly objection: DiscussFeedObjection }): JSX.Element {
  const status = OBJECTION_STATUS[objection.status];
  return (
    <div className="discuss-objection">
      <div className="review-bubble-head">
        <span className="mono">{objection.id}</span>
        <span className="kind">on {objection.target}</span>
        <Badge variant={objection.weight === 'blocking' ? 'destructive' : 'outline'}>{objection.weight}</Badge>
        <Badge variant={status.variant}>{status.label}</Badge>
        {objection.round === undefined ? null : <span className="kind">round {objection.round}</span>}
      </div>
      <p className="review-text">
        <b>{objection.title}</b>
      </p>
      {objection.breaks === undefined ? null : (
        <p className="review-text">
          <span className="kind">breaks</span> {objection.breaks}
        </p>
      )}
      {objection.alternative === undefined ? null : (
        <p className="review-text">
          <span className="kind">alternative</span> {objection.alternative}
        </p>
      )}
    </div>
  );
}

function ReplyView({ message }: { readonly message: DiscussFeedMessage }): JSX.Element {
  return (
    <>
      <div className="review-bubble-head">
        <span className="kind">round {message.round}</span>
        {message.invalid === true ? <Badge variant="destructive">invalid</Badge> : null}
      </div>
      {message.failure === undefined ? null : <p className="review-text kind">{message.failure}</p>}
      {message.text === '' ? null : <p className="review-text">{message.text}</p>}
      {message.responses.length === 0 ? null : (
        <ul className="review-responses">
          {message.responses.map((response) => (
            <li key={response.objection} className="review-response">
              <span className="mono">{response.objection}</span>{' '}
              <Badge variant={response.stance === 'accept' || response.stance === 'withdraw' ? 'success' : 'secondary'}>
                {STANCE_LABEL[response.stance] ?? response.stance}
              </Badge>
              {response.text === '' ? null : <span className="review-response-text"> {response.text}</span>}
              {response.change === undefined ? null : (
                <span className="review-evidence">
                  <span className="kind">change</span> <b>{response.change.choice}</b> — {response.change.rationale}
                </span>
              )}
              {response.evidence === undefined ? null : (
                <span className="review-evidence">
                  <span className="kind">evidence</span> <code>{response.evidence}</code>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Лента обсуждения: предложения, черновик, возражения по точкам и раунды. */
function DiscussionLog({ feed }: { readonly feed: DiscussFeed }): JSX.Element {
  const participants = new Map(feed.participants.map((participant) => [participant.id, participant]));
  const author = feed.participants.find((participant) => participant.role === 'author');
  const running = feed.done ? [] : runningLabels(feed.participants);
  const empty = feed.proposals.length === 0 && feed.draft === undefined && running.length === 0;
  if (empty) return <EmptyState title="No messages yet" description="The participants have not written anything so far." />;
  const byObjector = new Map<string, DiscussFeedObjection[]>();
  for (const objection of feed.objections) byObjector.set(objection.by, [...(byObjector.get(objection.by) ?? []), objection]);
  return (
    <ol className="review-log" role="log" aria-live={feed.done ? 'off' : 'polite'} aria-label="Discussion feed">
      {feed.proposals.length === 0 ? null : <li className="review-system">Proposals</li>}
      {feed.proposals.map((proposal) => (
        <Message key={`proposal-${proposal.participant}`} participant={participants.get(proposal.participant)} id={proposal.participant}>
          <div className="review-bubble-head">
            <Who participant={participants.get(proposal.participant)} id={proposal.participant} />
            {proposal.status === 'success' ? null : <Badge variant="destructive">{proposal.status ?? 'no proposal'}</Badge>}
          </div>
          {proposal.reason === undefined ? null : <p className="review-text kind">{proposal.reason}</p>}
          {proposal.summary === undefined ? null : <p className="review-text">{proposal.summary}</p>}
          {proposal.approach === undefined ? null : (
            <details>
              <summary className="kind">Approach</summary>
              <p className="review-text">{proposal.approach}</p>
            </details>
          )}
        </Message>
      ))}

      {feed.draft === undefined ? null : (
        <>
          <li className="review-system">Draft</li>
          <Message participant={author} id={author?.id ?? 'author'} own>
            <div className="review-bubble-head">
              <Who participant={author} id={author?.id ?? 'author'} />
              <span className="kind">
                {feed.draft.decisions.length} decisions · {feed.draft.diagrams.length} diagrams
              </span>
            </div>
            <p className="review-text">{feed.draft.summary}</p>
            <details>
              <summary className="kind">Decisions</summary>
              <ol className="design-decisions">
                {feed.draft.decisions.map((decision) => (
                  <li key={decision.id} className="design-decision">
                    <span className="mono">{decision.id}</span> <b>{decision.question}</b>
                    <p className="design-choice">{decision.choice}</p>
                    <p className="design-text">{decision.rationale}</p>
                    {decision.options.length === 0 ? null : (
                      <p className="kind">options: {decision.options.map((option) => `${option.summary} (${option.by})`).join('; ')}</p>
                    )}
                  </li>
                ))}
              </ol>
            </details>
            {feed.draft.diagrams.map((diagram) => (
              <details key={diagram.id}>
                <summary className="kind">
                  <span className="mono">{diagram.id}</span> {diagram.title}
                </summary>
                <MermaidDiagram source={diagram.source} title={diagram.title} />
              </details>
            ))}
          </Message>
        </>
      )}

      {feed.objections.length === 0 ? null : <li className="review-system">Objections</li>}
      {[...byObjector].map(([by, objections]) => (
        <Message key={`objections-${by}`} participant={participants.get(by)} id={by}>
          <div className="review-bubble-head">
            <Who participant={participants.get(by)} id={by} />
          </div>
          {objections.map((objection) => (
            <ObjectionView key={objection.id} objection={objection} />
          ))}
        </Message>
      ))}

      {feed.messages.length === 0 ? null : <li className="review-system">Defense</li>}
      {feed.messages.map((message) => {
        const participant = participants.get(message.from);
        return (
          <Message key={message.id} participant={participant} id={message.from} own={participant?.role === 'author'}>
            <div className="review-bubble-head">
              <Who participant={participant} id={message.from} />
            </div>
            <ReplyView message={message} />
          </Message>
        );
      })}

      {feed.outcome === undefined ? null : (
        <li className="review-system">
          {feed.outcome.accepted} accepted · {feed.outcome.withdrawn} withdrawn · {feed.outcome.contested} contested ·{' '}
          {feed.outcome.preference} notes
        </li>
      )}
      {running.map((label) => (
        <li key={label} className="review-system review-typing">
          {label}
        </li>
      ))}
    </ol>
  );
}

function CallView({
  address,
  participant,
  call,
  onClose,
}: {
  readonly address: string;
  readonly participant: DiscussFeedParticipant;
  readonly call: DiscussFeedCall;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <section className="review-turn" aria-label={`Call of ${participant.id}`}>
      <header className="review-bubble-head">
        <b>
          {participant.id} · {callLabel(call)}
        </b>
        {call.status === undefined ? null : <span className="kind">{call.status}</span>}
        {call.reason === undefined ? null : <span className="kind">{call.reason}</span>}
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </header>
      {call.output === undefined ? null : (
        <div className="row">
          <span className="label">output</span>
          <FileView address={address} file={call.output} />
        </div>
      )}
      {call.stdout === undefined ? null : (
        <div className="row">
          <span className="label">raw</span>
          <FileView address={address} file={call.stdout} />
        </div>
      )}
    </section>
  );
}

function SidePanel({
  feed,
  stepUsage,
  asOf,
  selected,
  onSelect,
}: {
  readonly feed: DiscussFeed;
  readonly stepUsage: UsageSnapshot | undefined;
  readonly asOf: string | undefined;
  readonly selected: DiscussSelection | undefined;
  readonly onSelect: (selection: DiscussSelection | undefined) => void;
}): JSX.Element {
  return (
    <aside className="review-side" aria-label="Discussion summary">
      <section>
        <h4>Participants</h4>
        <ul>
          {feed.participants.map((participant) => (
            <li key={participant.id} className="discuss-participant">
              <span className={`review-name ${colorClass(participant)}`}>{participant.id}</span>{' '}
              <span className="kind">
                {participant.role === 'participant' ? '' : `${participant.role} · `}
                {[participant.agent, participant.model].filter((part) => part !== undefined).join(' · ')}
              </span>
              {participant.focus === undefined ? null : <div className="kind discuss-focus">{participant.focus}</div>}
              <div className="kind">
                {fmtTokens(participant.usage.billableTokens)} · {fmtDuration(participant.usage.wallclockMs)} ·{' '}
                <Cost usd={participant.usage.costUsd} source={participant.usage.costSource} asOf={asOf} />
              </div>
              {participant.calls.length === 0 ? null : (
                <div className="discuss-calls">
                  {participant.calls.map((call, index) => {
                    const active = selected?.participant === participant.id && selected.call === index;
                    return (
                      <Button
                        key={index}
                        variant={active ? 'default' : 'outline'}
                        size="sm"
                        className="discuss-call"
                        onClick={() => onSelect(active ? undefined : { participant: participant.id, call: index })}
                        title={call.reason ?? call.status ?? (call.running ? 'running' : undefined)}
                      >
                        {callLabel(call)}
                        {call.running ? '…' : call.status === undefined || call.status === 'success' ? '' : ' ✕'}
                      </Button>
                    );
                  })}
                </div>
              )}
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
      {feed.objections.length === 0 ? null : (
        <section>
          <h4>Objections</h4>
          <ul>
            {feed.objections.map((objection) => (
              <li key={objection.id} title={objection.title}>
                <span className="mono">{objection.id}</span> <span className="kind">→ {objection.target}</span>{' '}
                <Badge variant={OBJECTION_STATUS[objection.status].variant}>{OBJECTION_STATUS[objection.status].label}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

/** Лента по готовой модели — без сети: её рисуют и тесты статическим рендером. */
export function DiscussFeedView({
  feed,
  address,
  jobId,
  stepId,
  pass,
  stepUsage,
  asOf,
  initialTab,
  navigate = () => undefined,
}: {
  readonly feed: DiscussFeed;
  readonly address: string;
  readonly jobId: string;
  readonly stepId: string;
  readonly pass?: number | undefined;
  readonly stepUsage?: UsageSnapshot | undefined;
  readonly asOf?: string | undefined;
  readonly initialTab?: DiscussTab;
  readonly navigate?: (href: string) => void;
}): JSX.Element {
  const [chosen, setTab] = useState<DiscussTab | undefined>(initialTab);
  const [selected, setSelected] = useState<DiscussSelection | undefined>(undefined);
  const tab = chosen ?? defaultTab(feed);
  const selectedParticipant = selected === undefined ? undefined : feed.participants.find((entry) => entry.id === selected.participant);
  const selectedCall = selected === undefined ? undefined : selectedParticipant?.calls[selected.call];
  const target = { address, jobId, stepId, ...(pass === undefined ? {} : { pass }) };

  return (
    <div className="review-feed discuss-feed">
      <div className="review-chat">
        {feed.reusedFrom === undefined ? null : (
          <ReusedNotice runId={feed.reusedFrom.runId} available={feed.reusedFrom.available} address={address} navigate={navigate} subject="discussion" />
        )}
        <ol className="discuss-phases" aria-label="Discussion phases">
          {feed.phases.map((phase) => (
            <li key={phase.name}>
              <Badge variant={PHASE_VARIANT[phase.state]}>
                {PHASE_LABEL[phase.name]}
                {phase.name === 'defense' && phase.state !== 'skipped' ? ` ≤${feed.rounds}` : ''}
              </Badge>
            </li>
          ))}
        </ol>
        <Tabs value={tab} onValueChange={(value) => setTab(value as DiscussTab)} className="review-tabs">
          <TabsList aria-label="Discussion views">
            <TabsTrigger value="document">Document</TabsTrigger>
            <TabsTrigger value="discussion">Discussion</TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === 'document' ? (
          feed.document !== undefined ? (
            <DesignDocView
              document={feed.document}
              downloads={{ html: designRenderUrl({ ...target, format: 'html' }), openspec: designRenderUrl({ ...target, format: 'openspec' }) }}
            />
          ) : feed.output !== undefined ? (
            <>
              <Alert>
                <AlertDescription>The step output is not a burnex:design-doc document: {feed.documentError}</AlertDescription>
              </Alert>
              <pre className="mermaid-source">{JSON.stringify(feed.output, null, 2)}</pre>
            </>
          ) : (
            <EmptyState title="No document yet" description={feed.done ? 'The step finished without a document.' : 'The aggregator has not written the document so far.'} />
          )
        ) : (
          <DiscussionLog feed={feed} />
        )}
        {selectedParticipant === undefined || selectedCall === undefined ? null : (
          <CallView address={address} participant={selectedParticipant} call={selectedCall} onClose={() => setSelected(undefined)} />
        )}
      </div>
      <SidePanel feed={feed} stepUsage={stepUsage} asOf={asOf} selected={selected} onSelect={setSelected} />
    </div>
  );
}

/** Лента шага `discuss` с опросом демона, пока шаг идёт. */
export function DiscussFeedPanel({
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
  const [feed, setFeed] = useState<DiscussFeed | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // Перевзводимый таймер: следующий опрос — после ответа на предыдущий, как в ленте review.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      fetchDiscussFeed({ address, jobId, stepId, ...(pass === undefined ? {} : { pass }) })
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
    <DiscussFeedView
      feed={feed}
      address={address}
      jobId={jobId}
      stepId={stepId}
      pass={pass}
      stepUsage={stepUsage}
      asOf={asOf}
      {...(navigate === undefined ? {} : { navigate })}
    />
  );
}
