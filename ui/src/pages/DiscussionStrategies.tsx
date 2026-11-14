import type { JSX } from 'react';

import type { StrategyProblem } from '../api';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from '@burnex/ui';
import type { ProfileDraft } from './AgentsProfiles';
import {
  CourseList,
  Field,
  FieldError,
  LocalProfiles,
  ParticipantFields,
  StrategiesPage,
  StrategiesView,
  TextOrFile,
  agentGroups,
  baseDocumentOf,
  errorAt,
  participantDraftOf,
  participantValue,
  profileDraftsOf,
  promptedDraftOf,
  promptedValue,
  setRole,
  text,
  UsedBy,
  type AgentGroups,
  type ParticipantDraft,
  type PromptedDraft,
  type Raw,
  type StrategiesViewProps,
  type StrategyEditorBaseProps,
  type StrategyKindUi,
} from './StrategyScreen';

/**
 * Экран «Discussion strategies» (`ui-discussion-strategies`): стратегии
 * шагов `discuss:` — участники, автор черновика, агрегатор итога, раунды
 * защиты и локальные профили. Каркас экрана общий со стратегиями ревью
 * (`StrategyScreen.tsx`); разбор и запись — на демоне тем же разбором, что у
 * движка (`DiscussionStrategySchema`).
 */

/** Раунды защиты — тот же диапазон и умолчание, что у разбора `rounds`. */
export const DISCUSS_ROUNDS_RANGE = { min: 1, max: 5 } as const;
export const DEFAULT_DISCUSS_ROUNDS = 1;

export interface DiscussParticipantDraft extends ParticipantDraft {
  readonly id: string;
  /** Текст либо `file:<путь>` — второй экран показывает путём и не правит. */
  readonly focus: string;
}

export interface DiscussionDraft {
  readonly name: string;
  readonly description: string;
  readonly rounds: number;
  readonly participants: readonly DiscussParticipantDraft[];
  readonly author: PromptedDraft;
  readonly aggregator: PromptedDraft;
  readonly profiles: readonly ProfileDraft[];
}

export function emptyDiscussParticipant(id = ''): DiscussParticipantDraft {
  return { ...participantDraftOf(undefined), id, focus: '' };
}

export function discussionDraftOf(document: Raw): DiscussionDraft {
  return {
    name: text(document.name),
    description: text(document.description),
    rounds: typeof document.rounds === 'number' ? document.rounds : DEFAULT_DISCUSS_ROUNDS,
    participants: ((document.participants ?? []) as Raw[]).map((participant) => ({
      ...participantDraftOf(participant),
      id: text(participant.id),
      focus: text(participant.focus),
    })),
    author: promptedDraftOf(document.author as Raw | undefined),
    aggregator: promptedDraftOf(document.aggregator as Raw | undefined),
    profiles: profileDraftsOf(document),
  };
}

export function emptyDiscussionDraft(name = ''): DiscussionDraft {
  return {
    name,
    description: '',
    rounds: DEFAULT_DISCUSS_ROUNDS,
    participants: [emptyDiscussParticipant('pragmatist'), emptyDiscussParticipant('skeptic')],
    author: promptedDraftOf(undefined),
    aggregator: promptedDraftOf(undefined),
    profiles: [],
  };
}

/**
 * Документ стратегии из черновика поверх прежнего. `rounds` по умолчанию в
 * файл не дописывается, пока ключа в нём не было, — нетронутая стратегия
 * остаётся нетронутой.
 */
export function discussionDocumentOf(draft: DiscussionDraft, original: Raw = {}): Record<string, unknown> {
  const document = baseDocumentOf('discussion-strategy', draft, original);
  document.participants = draft.participants.map((participant) => ({
    id: participant.id.trim(),
    ...participantValue(participant),
    ...(participant.focus.trim() === '' ? {} : { focus: participant.focus }),
  }));
  setRole(document, 'author', promptedValue(draft.author));
  setRole(document, 'aggregator', promptedValue(draft.aggregator));
  if (original.rounds !== undefined || draft.rounds !== DEFAULT_DISCUSS_ROUNDS) document.rounds = draft.rounds;
  else delete document.rounds;
  return document;
}

/** Схема хода обсуждения — фазы шага `discuss`. */
export function discussionCourse(rounds: number): readonly string[] {
  return [
    'Participants propose in parallel',
    'The author drafts one document with decision points',
    'Participants object point by point',
    `The author defends blocking objections ≤ ${rounds} round${rounds === 1 ? '' : 's'}`,
    'The aggregator writes the design document',
  ];
}

function RoleCard({ role, badge, description, draft, groups, tiers, problem, placeholder, onChange }: {
  readonly role: 'author' | 'aggregator';
  readonly badge: string;
  readonly description: string;
  readonly draft: PromptedDraft;
  readonly groups: AgentGroups;
  readonly tiers: readonly string[];
  readonly problem: StrategyProblem | undefined;
  readonly placeholder: string;
  readonly onChange: (next: PromptedDraft) => void;
}): JSX.Element {
  return (
    <Card className={`strategy-${role}`}>
      <CardHeader>
        <div className="agent-card-head">
          <CardTitle>{role}</CardTitle>
          <Badge variant="secondary">{badge}</Badge>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldError message={problem?.at === role ? problem.message : undefined} />
        <ParticipantFields id={role} draft={draft} groups={groups} tiers={tiers} problem={problem} at={role}
          onChange={(next) => onChange({ ...draft, ...next })} />
        <TextOrFile id={`${role}-prompt`} label="prompt" value={draft.prompt} problem={problem} at={`${role}.prompt`}
          placeholder={placeholder} onChange={(prompt) => onChange({ ...draft, prompt })} />
      </CardContent>
    </Card>
  );
}

export function DiscussionStrategyEditor({ draft, settings, strategy, problem, readOnly, navigate, onChange }: StrategyEditorBaseProps<DiscussionDraft>): JSX.Element {
  const groups = agentGroups(draft, settings);
  const tiers = settings?.modelTiers ?? [];
  const setParticipant = (index: number, next: DiscussParticipantDraft | undefined): void => {
    const participants = [...draft.participants];
    if (next === undefined) participants.splice(index, 1);
    else participants[index] = next;
    onChange({ ...draft, participants });
  };

  return (
    <fieldset className="strategy-editor" disabled={readOnly}>
      <Card className="strategy-mode">
        <CardHeader>
          <CardTitle>Course</CardTitle>
          <CardDescription>Proposals, one draft, objections, defense, then the document.</CardDescription>
        </CardHeader>
        <CardContent>
          <Field label="rounds" htmlFor="discussion-rounds" error={errorAt(problem, 'rounds')}>
            <div className="agent-field-row">
              <input type="range" aria-label="rounds slider" min={DISCUSS_ROUNDS_RANGE.min} max={DISCUSS_ROUNDS_RANGE.max}
                value={draft.rounds} onChange={(event) => onChange({ ...draft, rounds: Number(event.target.value) })} />
              <Input id="discussion-rounds" type="number" className="mono strategy-number"
                min={DISCUSS_ROUNDS_RANGE.min} max={DISCUSS_ROUNDS_RANGE.max} value={draft.rounds}
                onChange={(event) => onChange({ ...draft, rounds: Number(event.target.value) })} />
            </div>
            <span className="small dim">Rounds of one author answer to all open blocking objections, then the participants&apos; replies; objections still open after them go to the aggregator as contested.</span>
          </Field>
          <CourseList steps={discussionCourse(draft.rounds)} label="How the discussion runs" />
        </CardContent>
      </Card>

      <RoleCard role="author" badge="drafts" groups={groups} tiers={tiers} problem={problem} draft={draft.author}
        description="Does not propose: merges the proposals into one draft with decision points and diagrams, then defends it."
        placeholder="How to merge the proposals — optional"
        onChange={(author) => onChange({ ...draft, author })} />

      <RoleCard role="aggregator" badge="document" groups={groups} tiers={tiers} problem={problem} draft={draft.aggregator}
        description="Decides the contested points and writes the document by the step's output schema; says whether the result is agreed."
        placeholder="How to weigh the objections — optional"
        onChange={(aggregator) => onChange({ ...draft, aggregator })} />

      <h2 className="strategy-section">Participants</h2>
      <FieldError message={problem?.at === 'participants' ? problem.message : undefined} />
      <div className="agent-cards">
        {draft.participants.map((participant, index) => (
          <Card className="agent-card" key={index}>
            <CardHeader>
              <div className="agent-card-head">
                <CardTitle>{participant.id.trim() === '' ? 'New participant' : participant.id}</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setParticipant(index, undefined)} aria-label={`Remove participant ${participant.id}`}>
                  Remove
                </Button>
              </div>
              <FieldError message={problem?.at === `participants.${index}` ? problem.message : undefined} />
            </CardHeader>
            <CardContent>
              <Field label="id" htmlFor={`participant-${index}-id`} error={errorAt(problem, `participants.${index}.id`)}>
                <Input id={`participant-${index}-id`} className="mono" value={participant.id} placeholder="pragmatist"
                  onChange={(event) => setParticipant(index, { ...participant, id: event.target.value })} />
              </Field>
              <ParticipantFields id={`participant-${index}`} draft={participant} groups={groups} tiers={tiers} problem={problem}
                at={`participants.${index}`} onChange={(next) => setParticipant(index, { ...participant, ...next })} />
              <TextOrFile id={`participant-${index}-focus`} label="focus" value={participant.focus} problem={problem}
                at={`participants.${index}.focus`} placeholder="What this participant optimizes for"
                onChange={(focus) => setParticipant(index, { ...participant, focus })} />
            </CardContent>
          </Card>
        ))}
        <Card className="agent-card strategy-add">
          <CardContent>
            <Button variant="outline" onClick={() => onChange({ ...draft, participants: [...draft.participants, emptyDiscussParticipant()] })}>
              Add participant
            </Button>
          </CardContent>
        </Card>
      </div>

      <LocalProfiles draft={draft} settings={settings} strategy={strategy} problem={problem} onChange={onChange} />
      <UsedBy strategy={strategy} stepKind="discuss:" navigate={navigate} />
    </fieldset>
  );
}

export const DISCUSSION_STRATEGY_KIND: StrategyKindUi<DiscussionDraft> = {
  title: 'Discussion strategies',
  description: <>Who proposes, drafts and decides in a <code>discuss:</code> step, with which agent, and how many defense rounds. A project strategy wins over yours of the same name.</>,
  emptyTitle: 'No discussion strategies yet',
  layerDir: 'discussion-strategies',
  namePlaceholder: 'design-panel',
  api: '/api/discussion-strategies',
  summary: (document) => {
    const participants = Array.isArray(document.participants) ? document.participants.length : 0;
    const rounds = typeof document.rounds === 'number' ? document.rounds : DEFAULT_DISCUSS_ROUNDS;
    return `${participants} participant(s) · ${rounds} round${rounds === 1 ? '' : 's'}`;
  },
  draftOf: discussionDraftOf,
  emptyDraft: () => emptyDiscussionDraft(),
  documentOf: discussionDocumentOf,
  Editor: DiscussionStrategyEditor,
};

export type DiscussionStrategiesViewProps = StrategiesViewProps<DiscussionDraft>;

export function DiscussionStrategiesView(props: DiscussionStrategiesViewProps): JSX.Element {
  return <StrategiesView kind={DISCUSSION_STRATEGY_KIND} {...props} />;
}

export function DiscussionStrategies(props: {
  readonly name: string | undefined;
  readonly onSelectName: (name: string | undefined) => boolean;
  readonly navigate: (href: string) => void;
  readonly confirm?: (message: string) => boolean;
}): JSX.Element {
  return <StrategiesPage kind={DISCUSSION_STRATEGY_KIND} {...props} />;
}
