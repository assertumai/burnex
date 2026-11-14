import type { JSX } from 'react';

import type { Settings, StrategyProblem, StrategyView } from '../api';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@burnex/ui';
import { type ProfileDraft } from './AgentsProfiles';
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
  sameValue,
  setRole,
  text,
  UsedBy,
  type PromptedDraft,
  type ParticipantDraft,
  type Raw,
  type StrategiesViewProps,
  type StrategyKindUi,
} from './StrategyScreen';

export {
  agentGroups,
  errorAt,
  PIPELINES_TARGET,
  selectStrategy,
  strategyDraftProblem,
  strategyRemovalConfirmation,
  StrategyList,
  usageLabel,
  type AgentGroups,
  type NewStrategy,
  type ParticipantDraft,
} from './StrategyScreen';

/**
 * Экран «Review strategies» (`ui-review-strategies`): стратегии ревью проекта
 * демона и домашнего каталога, редактор выбранной и её использование шагами
 * `review:`. Каркас экрана — общий со стратегиями обсуждения
 * (`StrategyScreen.tsx`); здесь — черновик, документ и редактор вида ревью.
 */

export type ReviewModeChoice = 'independent' | 'defend';

/** Раунды ветки защиты — тот же диапазон и умолчание, что у разбора `defend.rounds`. */
export const ROUNDS_RANGE = { min: 1, max: 5 } as const;
export const DEFAULT_ROUNDS = 2;

export interface ReviewerDraft extends ParticipantDraft {
  readonly id: string;
  /** Текст либо `file:<путь>` — второй экран показывает путём и не правит. */
  readonly focus: string;
}

export type AggregatorDraft = PromptedDraft;

/** Свежий защитник режима `defend`: тот же выбор агента, что у агрегатора, и промпт. */
export type DefenderDraft = AggregatorDraft;

export interface StrategyDraft {
  readonly name: string;
  readonly description: string;
  readonly mode: ReviewModeChoice;
  readonly rounds: number;
  readonly aggregator: AggregatorDraft;
  readonly defender: DefenderDraft;
  readonly reviewers: readonly ReviewerDraft[];
  readonly profiles: readonly ProfileDraft[];
}

export function emptyReviewer(id = ''): ReviewerDraft {
  return { ...participantDraftOf(undefined), id, focus: '' };
}

export function strategyDraftOf(document: Raw): StrategyDraft {
  const defend = document.defend as Raw | undefined;
  return {
    name: text(document.name),
    description: text(document.description),
    mode: document.mode === 'defend' ? 'defend' : 'independent',
    rounds: typeof defend?.rounds === 'number' ? defend.rounds : DEFAULT_ROUNDS,
    aggregator: promptedDraftOf(document.aggregator as Raw | undefined),
    defender: promptedDraftOf(document.defender as Raw | undefined),
    reviewers: ((document.reviewers ?? []) as Raw[]).map((reviewer) => ({
      ...participantDraftOf(reviewer),
      id: text(reviewer.id),
      focus: text(reviewer.focus),
    })),
    profiles: profileDraftsOf(document),
  };
}

export function emptyStrategyDraft(name = ''): StrategyDraft {
  return {
    name,
    description: '',
    mode: 'independent',
    rounds: DEFAULT_ROUNDS,
    aggregator: promptedDraftOf(undefined),
    defender: promptedDraftOf(undefined),
    reviewers: [emptyReviewer('reviewer')],
    profiles: [],
  };
}

/**
 * Документ стратегии из черновика поверх прежнего: ключи, которых форма не
 * знает, и нетронутые профили уходят как были (`baseDocumentOf`).
 */
export function strategyDocumentOf(draft: StrategyDraft, original: Raw = {}): Record<string, unknown> {
  const document = baseDocumentOf('review-strategy', draft, original);

  document.reviewers = draft.reviewers.map((reviewer) => ({
    id: reviewer.id.trim(),
    ...participantValue(reviewer),
    ...(reviewer.focus.trim() === '' ? {} : { focus: reviewer.focus }),
  }));

  setRole(document, 'aggregator', promptedValue(draft.aggregator));

  if (original.mode !== undefined || draft.mode !== 'independent') document.mode = draft.mode;
  // Блоки `defend` и `defender` при другом режиме разбор отклоняет: уходят
  // вместе с режимом. Раунды по умолчанию в файл не дописываются, пока блока
  // в нём не было, — нетронутая стратегия остаётся нетронутой.
  if (draft.mode === 'defend') {
    const defend = original.defend as Raw | undefined;
    if (defend !== undefined || draft.rounds !== DEFAULT_ROUNDS) document.defend = { ...(defend ?? {}), rounds: draft.rounds };
    else delete document.defend;
    setRole(document, 'defender', promptedValue(draft.defender));
  } else {
    delete document.defend;
    delete document.defender;
  }
  return document;
}

/**
 * Есть ли в черновике несохранённые правки. Сравнение структурное: документ из
 * черновика собирает ключи ревьюеров и агрегатора в своём порядке, и
 * нетронутый файл с другим порядком ключей правкой не считается. Новая
 * стратегия (`original` нет) — всегда правка.
 */
export function strategyChanged(draft: StrategyDraft, original: Raw | undefined): boolean {
  return original === undefined || !sameValue(strategyDocumentOf(draft, original), original);
}

/** Схема хода ревью — этапы выбранного режима. */
export function courseSteps(mode: ReviewModeChoice, rounds: number): readonly string[] {
  if (mode === 'defend') {
    return ['Reviewers in parallel', `Defend with implementer ≤ ${rounds} rounds`, 'Aggregator decides contested'];
  }
  return ['Reviewers work in parallel', 'The aggregator consolidates the findings', 'Verdict'];
}

export function CourseScheme({ mode, rounds }: { readonly mode: ReviewModeChoice; readonly rounds: number }): JSX.Element {
  return <CourseList steps={courseSteps(mode, rounds)} label="How the review runs" />;
}

export interface StrategyEditorProps {
  readonly draft: StrategyDraft;
  readonly settings: Settings | undefined;
  /** Стратегия из списка; у новой нет. */
  readonly strategy?: StrategyView;
  readonly problem: StrategyProblem | undefined;
  readonly readOnly: boolean;
  readonly navigate: (href: string) => void;
  readonly onChange: (next: StrategyDraft) => void;
}

export function StrategyEditor({ draft, settings, strategy, problem, readOnly, navigate, onChange }: StrategyEditorProps): JSX.Element {
  const groups = agentGroups(draft, settings);
  const tiers = settings?.modelTiers ?? [];
  const setReviewer = (index: number, next: ReviewerDraft | undefined): void => {
    const reviewers = [...draft.reviewers];
    if (next === undefined) reviewers.splice(index, 1);
    else reviewers[index] = next;
    onChange({ ...draft, reviewers });
  };

  return (
    <fieldset className="strategy-editor" disabled={readOnly}>
      <Card className="strategy-mode">
        <CardHeader>
          <CardTitle>Mode</CardTitle>
          <CardDescription>How the reviewers work together.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="strategy-segmented" role="radiogroup" aria-label="Review mode">
            {(['independent', 'defend'] as const).map((mode) => (
              <button key={mode} type="button" role="radio" aria-checked={draft.mode === mode}
                className={draft.mode === mode ? 'active' : undefined}
                onClick={() => onChange({ ...draft, mode })}>
                {mode === 'independent' ? 'Independent' : 'Defend'}
              </button>
            ))}
          </div>
          <FieldError message={errorAt(problem, 'mode', 'defend')} />
          {draft.mode === 'defend' ? (
            <Field label="rounds" htmlFor="strategy-rounds">
              <div className="agent-field-row">
                <input type="range" aria-label="rounds slider" min={ROUNDS_RANGE.min} max={ROUNDS_RANGE.max}
                  value={draft.rounds} onChange={(event) => onChange({ ...draft, rounds: Number(event.target.value) })} />
                <Input id="strategy-rounds" type="number" className="mono strategy-number"
                  min={ROUNDS_RANGE.min} max={ROUNDS_RANGE.max} value={draft.rounds}
                  onChange={(event) => onChange({ ...draft, rounds: Number(event.target.value) })} />
              </div>
              <span className="small dim">Rounds of one defender answer to all reviewers, then their replies; findings still open after them are contested.</span>
            </Field>
          ) : null}
          <CourseScheme mode={draft.mode} rounds={draft.rounds} />
        </CardContent>
      </Card>

      {draft.mode === 'defend' ? (
        <Card className="strategy-defender">
          <CardHeader>
            <div className="agent-card-head">
              <CardTitle>defender</CardTitle>
              <Badge variant="secondary">defends</Badge>
            </div>
            <CardDescription>
              Answers the reviewers&apos; findings on behalf of the implementation. When the <code>review:</code> step names
              an <code>implementer</code> with a session, that session defends itself (or its fork, when another step may
              continue it) and these settings are not used; when it has none, a fresh agent with them defends.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldError message={problem?.at === 'defender' ? problem.message : undefined} />
            <ParticipantFields id="defender" draft={draft.defender} groups={groups} tiers={tiers} problem={problem} at="defender"
              onChange={(next) => onChange({ ...draft, defender: { ...draft.defender, ...next } })} />
            <TextOrFile id="defender-prompt" label="prompt" value={draft.defender.prompt} problem={problem} at="defender.prompt"
              placeholder="How to defend the implementation — optional"
              onChange={(prompt) => onChange({ ...draft, defender: { ...draft.defender, prompt } })} />
          </CardContent>
        </Card>
      ) : null}

      <Card className="strategy-aggregator">
        <CardHeader>
          <div className="agent-card-head">
            <CardTitle>aggregator</CardTitle>
            <Badge variant="secondary">verdict</Badge>
          </div>
          <CardDescription>Consolidates the findings and gives the verdict; in Defend mode decides the contested ones.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldError message={problem?.at === 'aggregator' ? problem.message : undefined} />
          <ParticipantFields id="aggregator" draft={draft.aggregator} groups={groups} tiers={tiers} problem={problem} at="aggregator"
            onChange={(next) => onChange({ ...draft, aggregator: { ...draft.aggregator, ...next } })} />
          <TextOrFile id="aggregator-prompt" label="prompt" value={draft.aggregator.prompt} problem={problem} at="aggregator.prompt"
            placeholder="How to weigh the findings — optional"
            onChange={(prompt) => onChange({ ...draft, aggregator: { ...draft.aggregator, prompt } })} />
        </CardContent>
      </Card>

      <h2 className="strategy-section">Reviewers</h2>
      <FieldError message={problem?.at === 'reviewers' ? problem.message : undefined} />
      <div className="agent-cards">
        {draft.reviewers.map((reviewer, index) => (
          <Card className="agent-card" key={index}>
            <CardHeader>
              <div className="agent-card-head">
                <CardTitle>{reviewer.id.trim() === '' ? 'New reviewer' : reviewer.id}</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setReviewer(index, undefined)} aria-label={`Remove reviewer ${reviewer.id}`}>
                  Remove
                </Button>
              </div>
              <FieldError message={problem?.at === `reviewers.${index}` ? problem.message : undefined} />
            </CardHeader>
            <CardContent>
              <Field label="id" htmlFor={`reviewer-${index}-id`} error={errorAt(problem, `reviewers.${index}.id`)}>
                <Input id={`reviewer-${index}-id`} className="mono" value={reviewer.id} placeholder="security"
                  onChange={(event) => setReviewer(index, { ...reviewer, id: event.target.value })} />
              </Field>
              <ParticipantFields id={`reviewer-${index}`} draft={reviewer} groups={groups} tiers={tiers} problem={problem} at={`reviewers.${index}`}
                onChange={(next) => setReviewer(index, { ...reviewer, ...next })} />
              <TextOrFile id={`reviewer-${index}-focus`} label="focus" value={reviewer.focus} problem={problem} at={`reviewers.${index}.focus`}
                placeholder="What this reviewer looks for"
                onChange={(focus) => setReviewer(index, { ...reviewer, focus })} />
            </CardContent>
          </Card>
        ))}
        <Card className="agent-card strategy-add">
          <CardContent>
            <Button variant="outline" onClick={() => onChange({ ...draft, reviewers: [...draft.reviewers, emptyReviewer()] })}>
              Add reviewer
            </Button>
          </CardContent>
        </Card>
      </div>

      <LocalProfiles draft={draft} settings={settings} strategy={strategy} problem={problem} onChange={onChange} />

      <UsedBy strategy={strategy} stepKind="review:" navigate={navigate} />
    </fieldset>
  );
}

export const REVIEW_STRATEGY_KIND: StrategyKindUi<StrategyDraft> = {
  title: 'Review strategies',
  description: <>Who reviews a <code>review:</code> step, with which agent, and how the verdict is reached. A project strategy wins over yours of the same name.</>,
  emptyTitle: 'No review strategies yet',
  layerDir: 'review-strategies',
  namePlaceholder: 'panel',
  api: '/api/review-strategies',
  summary: (document) => {
    const reviewers = Array.isArray(document.reviewers) ? document.reviewers.length : 0;
    return `${reviewers} reviewer(s) · ${document.mode === 'defend' ? 'defend' : 'independent'}`;
  },
  draftOf: strategyDraftOf,
  emptyDraft: () => emptyStrategyDraft(),
  documentOf: strategyDocumentOf,
  Editor: StrategyEditor,
};

export type ReviewStrategiesViewProps = StrategiesViewProps<StrategyDraft>;

export function ReviewStrategiesView(props: ReviewStrategiesViewProps): JSX.Element {
  return <StrategiesView kind={REVIEW_STRATEGY_KIND} {...props} />;
}

/** Страница с состоянием — общий каркас с видом ревью. */
export function ReviewStrategies(props: {
  readonly name: string | undefined;
  /** Сменить стратегию в адресе; `false` — маршрута нет, выбор держится только на экране. */
  readonly onSelectName: (name: string | undefined) => boolean;
  readonly navigate: (href: string) => void;
  readonly confirm?: (message: string) => boolean;
}): JSX.Element {
  return <StrategiesPage kind={REVIEW_STRATEGY_KIND} {...props} />;
}
