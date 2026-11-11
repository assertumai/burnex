import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react';

import {
  deleteReviewStrategy,
  fetchReviewStrategies,
  fetchSettings,
  saveReviewStrategy,
  StrategySaveError,
  type AgentProfileValue,
  type ReviewStrategiesOverview,
  type Settings,
  type StrategyLayer,
  type StrategyProblem,
  type StrategyView,
} from '../api';
import type { RouteTarget } from '../../../src/parts/ui/routes.ts';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  PageHeader,
} from '@burnex/ui';
import { TargetLink } from '../routeLink';
import { ProfileForm, emptyProfileDraft, profileDraftOf, profileDraftProblem, profileValueOf, type ProfileDraft } from './AgentsProfiles';
import './agents.css';
import './reviewStrategies.css';

/**
 * Экран «Review strategies» (`ui-review-strategies`): стратегии ревью проекта
 * демона и домашнего каталога, редактор выбранной и её использование шагами
 * `review:`. Разбор и запись — на демоне тем же разбором, что у движка; форма
 * показывает его отказ у поля по пути ключа и сама допустимого не решает.
 */

export const PIPELINES_TARGET: RouteTarget = { kind: 'screen', id: 'screen-pipelines' };

export type ReviewModeChoice = 'independent' | 'discussion';

/** Лимит реплик обсуждения — тот же диапазон, что у разбора `discussion.max_messages`. */
export const MAX_MESSAGES_RANGE = { min: 1, max: 50 } as const;
const DEFAULT_MAX_MESSAGES = 10;

export interface ParticipantDraft {
  /** Профиль или бэкенд; пусто — профиль `default`. */
  readonly agent: string;
  readonly modelKind: 'tier' | 'model';
  readonly tier: string;
  readonly model: string;
  readonly effort: string;
}

export interface ReviewerDraft extends ParticipantDraft {
  readonly id: string;
  /** Текст либо `file:<путь>` — второй экран показывает путём и не правит. */
  readonly focus: string;
}

export interface AggregatorDraft extends ParticipantDraft {
  readonly prompt: string;
}

export interface StrategyDraft {
  readonly name: string;
  readonly description: string;
  readonly mode: ReviewModeChoice;
  readonly maxMessages: number;
  readonly aggregator: AggregatorDraft;
  readonly reviewers: readonly ReviewerDraft[];
  readonly profiles: readonly ProfileDraft[];
}

type Raw = Readonly<Record<string, unknown>>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function participantDraftOf(raw: Raw | undefined): ParticipantDraft {
  return {
    agent: text(raw?.agent),
    modelKind: raw?.model === undefined ? 'tier' : 'model',
    tier: text(raw?.model_tier),
    model: text(raw?.model),
    effort: text(raw?.effort),
  };
}

export function emptyReviewer(id = ''): ReviewerDraft {
  return { ...participantDraftOf(undefined), id, focus: '' };
}

export function strategyDraftOf(document: Raw): StrategyDraft {
  const discussion = document.discussion as Raw | undefined;
  const profiles = (document.profiles ?? {}) as Readonly<Record<string, AgentProfileValue>>;
  return {
    name: text(document.name),
    description: text(document.description),
    mode: document.mode === 'discussion' ? 'discussion' : 'independent',
    maxMessages: typeof discussion?.max_messages === 'number' ? discussion.max_messages : DEFAULT_MAX_MESSAGES,
    aggregator: { ...participantDraftOf(document.aggregator as Raw | undefined), prompt: text((document.aggregator as Raw | undefined)?.prompt) },
    reviewers: ((document.reviewers ?? []) as Raw[]).map((reviewer) => ({
      ...participantDraftOf(reviewer),
      id: text(reviewer.id),
      focus: text(reviewer.focus),
    })),
    profiles: Object.entries(profiles).map(([name, profile]) => profileDraftOf({ name, profile, file: '' })),
  };
}

export function emptyStrategyDraft(name = ''): StrategyDraft {
  return {
    name,
    description: '',
    mode: 'independent',
    maxMessages: DEFAULT_MAX_MESSAGES,
    aggregator: { ...participantDraftOf(undefined), prompt: '' },
    reviewers: [emptyReviewer('reviewer')],
    profiles: [],
  };
}

function participantValue(draft: ParticipantDraft): Record<string, string> {
  const agent = draft.agent.trim();
  const model = draft.model.trim();
  const tier = draft.tier.trim();
  const effort = draft.effort.trim();
  return {
    ...(agent === '' ? {} : { agent }),
    ...(draft.modelKind === 'model' && model !== '' ? { model } : {}),
    ...(draft.modelKind === 'tier' && tier !== '' ? { model_tier: tier } : {}),
    ...(effort === '' ? {} : { effort }),
  };
}

/**
 * Документ стратегии из черновика поверх прежнего: ключи, которых форма не
 * знает, и нетронутые профили уходят как были — демон правит файл через
 * `Document`, и неизменное значение не трогает узел с его комментарием.
 */
export function strategyDocumentOf(draft: StrategyDraft, original: Raw = {}): Record<string, unknown> {
  const document: Record<string, unknown> = { version: 1, kind: 'review-strategy', ...original, name: draft.name.trim() };
  const description = draft.description.trim();
  if (description === '') delete document.description;
  else document.description = draft.description;

  const before = (original.profiles ?? {}) as Readonly<Record<string, AgentProfileValue>>;
  const profiles: Record<string, AgentProfileValue> = {};
  for (const profile of draft.profiles) {
    const value = profileValueOf(profile);
    const name = profile.name.trim();
    const kept = before[name];
    // Сравнение через черновик: короткая форма пути контекста в файле не
    // делает нетронутый профиль изменённым.
    const unchanged = kept !== undefined && JSON.stringify(profileValueOf(profileDraftOf({ name, profile: kept, file: '' }))) === JSON.stringify(value);
    profiles[name] = unchanged ? kept : value;
  }
  if (draft.profiles.length === 0) delete document.profiles;
  else document.profiles = profiles;

  document.reviewers = draft.reviewers.map((reviewer) => ({
    id: reviewer.id.trim(),
    ...participantValue(reviewer),
    ...(reviewer.focus.trim() === '' ? {} : { focus: reviewer.focus }),
  }));

  const aggregator = { ...participantValue(draft.aggregator), ...(draft.aggregator.prompt.trim() === '' ? {} : { prompt: draft.aggregator.prompt }) };
  if (Object.keys(aggregator).length === 0) delete document.aggregator;
  else document.aggregator = aggregator;

  if (original.mode !== undefined || draft.mode !== 'independent') document.mode = draft.mode;
  if (draft.mode === 'discussion') {
    document.discussion = { ...((original.discussion ?? {}) as Raw), max_messages: draft.maxMessages };
  } else {
    delete document.discussion;
  }
  return document;
}

/** Схема хода ревью — этапы выбранного режима. */
export function courseSteps(mode: ReviewModeChoice, maxMessages: number): readonly string[] {
  if (mode === 'discussion') {
    return [
      'Reviewers work in parallel',
      `Discussion: ≤ ${maxMessages} message(s) per reviewer`,
      'Consensus?',
      'yes — the aggregator accepts it / no — the aggregator decides',
    ];
  }
  return ['Reviewers work in parallel', 'The aggregator consolidates the findings', 'Verdict'];
}

export function usageLabel(usage: StrategyView['usage'][number]): string {
  return `${usage.pipeline} / ${usage.job} / ${usage.step}`;
}

/** Текст подтверждения удаления; используемая стратегия называет шаги, которые после удаления откажут. */
export function strategyRemovalConfirmation(strategy: Pick<StrategyView, 'name' | 'path' | 'usage'>): string {
  if (strategy.usage.length === 0) return `Delete strategy ${strategy.name} (${strategy.path})?`;
  return `Strategy ${strategy.name} is used by ${strategy.usage.length} step(s): ${strategy.usage.map(usageLabel).join(', ')}. `
    + 'These steps will fail to resolve it after the deletion. Delete it?';
}

/**
 * Отказ относится к полю, если путь ключа — само поле или лежит внутри него.
 * Лимит обсуждения живёт рядом с режимом: `discussion.*` показывается там же.
 */
export function errorAt(problem: StrategyProblem | undefined, ...fields: readonly string[]): string | undefined {
  const at = problem?.at;
  if (at === undefined) return undefined;
  return fields.some((field) => at === field || at.startsWith(`${field}.`)) ? problem!.message : undefined;
}

/** Что мешает сохранить ещё до отправки: только то, что форма знает сама (имя файла, черновики профилей). */
export function strategyDraftProblem(draft: StrategyDraft): string | undefined {
  if (!/^[a-z][a-z0-9_-]*$/.test(draft.name.trim())) {
    return `Strategy name “${draft.name.trim()}”: use lowercase letters, digits, hyphens or underscores; start with a letter`;
  }
  return profileDraftProblem(draft.profiles);
}

export interface AgentGroups {
  readonly strategy: readonly string[];
  readonly settings: readonly string[];
  readonly backends: readonly string[];
}

export function agentGroups(draft: StrategyDraft, settings: Settings | undefined): AgentGroups {
  const strategy = draft.profiles.map((profile) => profile.name.trim()).filter((name) => name !== '');
  return {
    strategy,
    settings: ['default', ...(settings?.profiles ?? []).map((profile) => profile.name)],
    backends: (settings?.backends ?? []).map((backend) => backend.name),
  };
}

function FieldError({ message }: { readonly message: string | undefined }): JSX.Element | null {
  return message === undefined ? null : <span className="strategy-field-error" role="alert">{message}</span>;
}

function Field({ label, htmlFor, error, children }: {
  readonly label: string;
  readonly htmlFor?: string | undefined;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="agent-field">
      {htmlFor === undefined
        ? <span className="agent-field-label mono">{label}</span>
        : <Label htmlFor={htmlFor} className="agent-field-label mono">{label}</Label>}
      <div className="agent-field-body">
        {children}
        <FieldError message={error} />
      </div>
    </div>
  );
}

function ParticipantFields({ id, draft, groups, tiers, problem, at, onChange }: {
  readonly id: string;
  readonly draft: ParticipantDraft;
  readonly groups: AgentGroups;
  readonly tiers: readonly string[];
  readonly problem: StrategyProblem | undefined;
  /** Путь участника в документе: `aggregator` или `reviewers.<n>`. */
  readonly at: string;
  readonly onChange: (next: ParticipantDraft) => void;
}): JSX.Element {
  const known = new Set([...groups.strategy, ...groups.settings, ...groups.backends]);
  return (
    <>
      <Field label="agent" htmlFor={`${id}-agent`} error={errorAt(problem, `${at}.agent`)}>
        <select id={`${id}-agent`} className="agent-select" value={draft.agent} onChange={(event) => onChange({ ...draft, agent: event.target.value })}>
          <option value="">— profile default —</option>
          {draft.agent !== '' && !known.has(draft.agent) ? <option value={draft.agent}>{draft.agent} (unknown)</option> : null}
          {groups.strategy.length === 0 ? null : (
            <optgroup label="Strategy profiles">
              {groups.strategy.map((name) => <option key={name} value={name}>{name}</option>)}
            </optgroup>
          )}
          <optgroup label="Settings profiles">
            {groups.settings.map((name) => <option key={name} value={name}>{name}</option>)}
          </optgroup>
          <optgroup label="Backends">
            {groups.backends.map((name) => <option key={name} value={name}>{name}</option>)}
          </optgroup>
        </select>
      </Field>
      <Field label="model" error={errorAt(problem, `${at}.model`, `${at}.model_tier`)}>
        <div className="agent-field-row">
          <label className="check">
            <input type="radio" name={`${id}-model-kind`} checked={draft.modelKind === 'tier'}
              onChange={() => onChange({ ...draft, modelKind: 'tier' })} /> tier
          </label>
          <label className="check">
            <input type="radio" name={`${id}-model-kind`} checked={draft.modelKind === 'model'}
              onChange={() => onChange({ ...draft, modelKind: 'model' })} /> model
          </label>
          {draft.modelKind === 'tier' ? (
            <select aria-label={`tier ${id}`} value={draft.tier} onChange={(event) => onChange({ ...draft, tier: event.target.value })}>
              <option value="">— from the agent —</option>
              {[...new Set([draft.tier, ...tiers])].filter((name) => name !== '').map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          ) : (
            <Input aria-label={`model ${id}`} className="mono" value={draft.model} placeholder="model name"
              onChange={(event) => onChange({ ...draft, model: event.target.value })} />
          )}
        </div>
      </Field>
      <Field label="effort" htmlFor={`${id}-effort`} error={errorAt(problem, `${at}.effort`)}>
        <Input id={`${id}-effort`} className="mono" value={draft.effort} placeholder="from the agent"
          onChange={(event) => onChange({ ...draft, effort: event.target.value })} />
      </Field>
    </>
  );
}

/** Текст или ссылка `file:`: ссылку экран показывает путём и не правит (Non-Goals). */
function TextOrFile({ id, label, value, problem, at, placeholder, onChange }: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly problem: StrategyProblem | undefined;
  readonly at: string;
  readonly placeholder: string;
  readonly onChange: (next: string) => void;
}): JSX.Element {
  return (
    <Field label={label} htmlFor={value.startsWith('file:') ? undefined : id} error={errorAt(problem, at)}>
      {value.startsWith('file:') ? (
        <span className="mono small">{value.slice('file:'.length)} <span className="dim">(file, relative to the strategy — edit it there)</span></span>
      ) : (
        <textarea id={id} rows={2} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      )}
    </Field>
  );
}

export function CourseScheme({ mode, maxMessages }: { readonly mode: ReviewModeChoice; readonly maxMessages: number }): JSX.Element {
  return (
    <ol className="strategy-course" aria-label="How the review runs">
      {courseSteps(mode, maxMessages).map((step) => <li key={step}>{step}</li>)}
    </ol>
  );
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
  const backends = groups.backends;
  const setReviewer = (index: number, next: ReviewerDraft | undefined): void => {
    const reviewers = [...draft.reviewers];
    if (next === undefined) reviewers.splice(index, 1);
    else reviewers[index] = next;
    onChange({ ...draft, reviewers });
  };
  const contextBase = strategy === undefined ? 'the strategy file' : strategy.path.replace(/[^/\\]+$/, '');

  return (
    <fieldset className="strategy-editor" disabled={readOnly}>
      <Card className="strategy-mode">
        <CardHeader>
          <CardTitle>Mode</CardTitle>
          <CardDescription>How the reviewers work together.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="strategy-segmented" role="radiogroup" aria-label="Review mode">
            {(['independent', 'discussion'] as const).map((mode) => (
              <button key={mode} type="button" role="radio" aria-checked={draft.mode === mode}
                className={draft.mode === mode ? 'active' : undefined}
                onClick={() => onChange({ ...draft, mode })}>
                {mode === 'independent' ? 'Independent' : 'Discussion'}
              </button>
            ))}
          </div>
          <FieldError message={errorAt(problem, 'mode', 'discussion')} />
          {draft.mode === 'discussion' ? (
            <Field label="max messages" htmlFor="strategy-max-messages">
              <div className="agent-field-row">
                <input type="range" aria-label="max messages slider" min={MAX_MESSAGES_RANGE.min} max={MAX_MESSAGES_RANGE.max}
                  value={draft.maxMessages} onChange={(event) => onChange({ ...draft, maxMessages: Number(event.target.value) })} />
                <Input id="strategy-max-messages" type="number" className="mono strategy-number"
                  min={MAX_MESSAGES_RANGE.min} max={MAX_MESSAGES_RANGE.max} value={draft.maxMessages}
                  onChange={(event) => onChange({ ...draft, maxMessages: Number(event.target.value) })} />
              </div>
              <span className="small dim">Messages each reviewer may send after the independent review.</span>
            </Field>
          ) : null}
          <CourseScheme mode={draft.mode} maxMessages={draft.maxMessages} />
        </CardContent>
      </Card>

      <Card className="strategy-aggregator">
        <CardHeader>
          <div className="agent-card-head">
            <CardTitle>aggregator</CardTitle>
            <Badge variant="secondary">verdict</Badge>
          </div>
          <CardDescription>Consolidates the findings and gives the verdict; accepts the consensus when there is one.</CardDescription>
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

      <details className="strategy-profiles" open={draft.profiles.length > 0 || errorAt(problem, 'profiles') !== undefined}>
        <summary>
          <h2 className="strategy-section">Local profiles ({draft.profiles.length})</h2>
        </summary>
        <p className="small dim agent-note">Visible only to the participants of this strategy; a local profile overrides a settings profile of the same name.</p>
        <FieldError message={errorAt(problem, 'profiles')} />
        <div className="agent-cards">
          {draft.profiles.map((profile, index) => (
            <ProfileForm
              key={index}
              draft={profile}
              index={index}
              backends={backends}
              tiers={tiers}
              usedBy={undefined}
              showUsage={false}
              badge="strategy"
              contextBase={contextBase}
              idPrefix="strategy-profile"
              onChange={(next) => onChange({ ...draft, profiles: draft.profiles.map((current, position) => (position === index ? next : current)) })}
              onRemove={() => onChange({ ...draft, profiles: draft.profiles.filter((_, position) => position !== index) })}
            />
          ))}
        </div>
        <div className="agent-field-row">
          <Button variant="outline" onClick={() => onChange({ ...draft, profiles: [...draft.profiles, emptyProfileDraft(backends[0] ?? '')] })}>
            Add local profile
          </Button>
        </div>
      </details>

      {strategy === undefined ? null : (
        <>
          <h2 className="strategy-section">Used by</h2>
          {strategy.usage.length === 0 ? (
            <p className="small dim">No review: step of the project pipelines resolves to this file.</p>
          ) : (
            <ul className="strategy-usage">
              {strategy.usage.map((usage) => (
                <li key={`${usage.file}/${usage.job}/${usage.step}`}>
                  <TargetLink target={PIPELINES_TARGET} navigate={navigate}>{usageLabel(usage)}</TargetLink>{' '}
                  <span className="mono small dim">{usage.file}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </fieldset>
  );
}

function layerLabel(layer: StrategyLayer): string {
  return layer === 'project' ? 'project' : 'mine';
}

export function StrategyList({ strategies, selected, onSelect }: {
  readonly strategies: readonly StrategyView[];
  readonly selected: StrategyView | undefined;
  readonly onSelect: (strategy: StrategyView) => void;
}): JSX.Element {
  return (
    <ul className="strategy-list" aria-label="Review strategies">
      {strategies.map((strategy) => {
        const document = strategy.document;
        const reviewers = Array.isArray(document?.reviewers) ? document.reviewers.length : undefined;
        const mode = document === undefined ? undefined : document.mode === 'discussion' ? 'discussion' : 'independent';
        const active = selected?.layer === strategy.layer && selected.name === strategy.name;
        return (
          <li key={`${strategy.layer}/${strategy.name}`} className={strategy.shadowed === true ? 'shadowed' : undefined}>
            <button type="button" className={active ? 'active' : undefined} aria-current={active ? 'true' : undefined} onClick={() => onSelect(strategy)}>
              <span className="strategy-list-head">
                <span className="mono">{strategy.name}</span>
                <Badge variant={strategy.layer === 'project' ? 'default' : 'secondary'}>{layerLabel(strategy.layer)}</Badge>
              </span>
              <span className="small dim">
                {strategy.error !== undefined
                  ? 'does not parse'
                  : `${reviewers ?? 0} reviewer(s) · ${mode ?? 'independent'}`}
                {strategy.shadowed === true ? ' · shadowed by the project' : ''}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Выбранная стратегия: по имени из адреса и слою, если пользователь открыл перекрытую. */
export function selectStrategy(strategies: readonly StrategyView[], name: string | undefined, layer: StrategyLayer | undefined): StrategyView | undefined {
  if (name === undefined || name === '') return strategies[0];
  return strategies.find((strategy) => strategy.name === name && (layer === undefined || strategy.layer === layer))
    ?? strategies.find((strategy) => strategy.name === name);
}

export interface NewStrategy {
  readonly layer: StrategyLayer;
}

export interface ReviewStrategiesViewProps {
  readonly overview: ReviewStrategiesOverview | undefined;
  readonly settings: Settings | undefined;
  readonly loadError?: string;
  readonly selected: StrategyView | undefined;
  /** Создание новой стратегии: черновик идёт в выбранный слой. */
  readonly creating: NewStrategy | undefined;
  readonly draft: StrategyDraft | undefined;
  readonly problem: StrategyProblem | undefined;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly notice?: string;
  readonly navigate: (href: string) => void;
  readonly onSelect: (strategy: StrategyView) => void;
  readonly onCreate: () => void;
  readonly onCreateLayer: (layer: StrategyLayer) => void;
  readonly onDraft: (next: StrategyDraft) => void;
  readonly onSave: () => void;
  readonly onDelete: () => void;
}

export function ReviewStrategiesView(props: ReviewStrategiesViewProps): JSX.Element {
  const { overview, settings, selected, creating, draft, problem } = props;
  const header = (
    <PageHeader
      title="Review strategies"
      description={<>Who reviews a <code>review:</code> step, with which agent, and how the verdict is reached. A project strategy wins over yours of the same name.</>}
      actions={<Button variant="outline" onClick={props.onCreate} disabled={props.busy}>Create strategy</Button>}
    />
  );
  if (props.loadError !== undefined) {
    return <div className="review-strategies">{header}<Alert variant="destructive"><AlertDescription>{props.loadError}</AlertDescription></Alert></div>;
  }
  if (overview === undefined) return <div className="review-strategies">{header}<p className="dim">Loading…</p></div>;

  const readOnly = creating === undefined && selected?.shadowed === true;
  const used = selected?.usage.length ?? 0;
  const editorHead = creating !== undefined ? (
    <div className="strategy-head">
      <div className="agent-field">
        <Label htmlFor="strategy-name" className="agent-field-label mono">name</Label>
        <div className="agent-field-body">
          <Input id="strategy-name" className="mono" value={draft?.name ?? ''} placeholder="panel"
            onChange={(event) => draft !== undefined && props.onDraft({ ...draft, name: event.target.value })} />
          <FieldError message={errorAt(problem, 'name')} />
        </div>
      </div>
      <div className="agent-field">
        <span className="agent-field-label mono">layer</span>
        <div className="agent-field-body">
          <div className="strategy-layers">
            {(['project', 'home'] as const).map((layer) => (
              <label className="check" key={layer}>
                <input type="radio" name="strategy-layer" checked={creating.layer === layer}
                  disabled={layer === 'project' && overview.projectDir === undefined}
                  onChange={() => props.onCreateLayer(layer)} />{' '}
                {layer === 'project' ? `project — ${overview.projectDir ?? 'the daemon knows no project'}` : `mine — ${overview.homeDir}`}
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  ) : selected === undefined ? null : (
    <div className="strategy-head">
      <div className="agent-card-head">
        <h2 className="strategy-title mono">{selected.name}</h2>
        <Badge variant={selected.layer === 'project' ? 'default' : 'secondary'}>{layerLabel(selected.layer)}</Badge>
        {selected.shadowed === true ? <Badge variant="outline">shadowed by the project</Badge> : null}
        <span className="small dim">{used === 0 ? 'not used' : `used in ${used} step(s)`}</span>
      </div>
      <div className="mono small dim">{selected.path}</div>
      <FieldError message={errorAt(problem, 'name')} />
    </div>
  );

  const actions = (
    <div className="agent-actions">
      {readOnly ? (
        <span className="small dim">Read-only: the project strategy of the same name wins — steps never resolve to this file.</span>
      ) : (
        <>
          {draft !== undefined ? (
            <Button onClick={props.onSave} disabled={props.busy || (!props.dirty && creating === undefined)}>
              {creating !== undefined ? 'Create' : 'Save'}
            </Button>
          ) : null}
          {creating === undefined && selected !== undefined ? (
            <Button variant="outline" onClick={props.onDelete} disabled={props.busy}>Delete</Button>
          ) : null}
        </>
      )}
      {props.notice === undefined ? null : <span className="small dim">{props.notice}</span>}
    </div>
  );

  let body: JSX.Element;
  if (creating === undefined && selected === undefined) {
    body = (
      <EmptyState
        title="No review strategies yet"
        description={<>A strategy lives in <code>.burnex/review-strategies/</code> of the project or in <code>{overview.homeDir}</code>.</>}
        action={<Button onClick={props.onCreate}>Create strategy</Button>}
      />
    );
  } else if (creating === undefined && selected?.error !== undefined) {
    body = (
      <>
        {editorHead}
        <Alert variant="destructive">
          <AlertTitle>The file does not parse{selected.error.at === undefined ? '' : ` at ${selected.error.at}`}</AlertTitle>
          <AlertDescription>{selected.error.message}</AlertDescription>
        </Alert>
        <pre className="strategy-text">{selected.text}</pre>
        {actions}
      </>
    );
  } else {
    body = (
      <>
        {editorHead}
        {problem === undefined ? null : (
          <Alert variant="destructive">
            <AlertTitle>Not saved{problem.at === undefined ? '' : ` — ${problem.at}`}</AlertTitle>
            <AlertDescription>{problem.message}</AlertDescription>
          </Alert>
        )}
        {draft === undefined ? null : (
          <StrategyEditor draft={draft} settings={settings} {...(selected === undefined || creating !== undefined ? {} : { strategy: selected })}
            problem={problem} readOnly={readOnly} navigate={props.navigate} onChange={props.onDraft} />
        )}
        {actions}
      </>
    );
  }

  return (
    <div className="review-strategies">
      {header}
      <div className="strategy-layout">
        <nav className="strategy-sidebar">
          {overview.strategies.length === 0
            ? <p className="small dim">No strategies in either layer.</p>
            : <StrategyList strategies={overview.strategies} selected={creating === undefined ? selected : undefined} onSelect={props.onSelect} />}
        </nav>
        <section className="strategy-main">{body}</section>
      </div>
    </div>
  );
}

/**
 * Страница с состоянием: читает стратегии и настройки (профили, бэкенды,
 * уровни), держит черновик выбранной и пишет его через демон.
 */
export function ReviewStrategies({ name, onSelectName, navigate, confirm = (message) => window.confirm(message) }: {
  readonly name: string | undefined;
  /** Сменить стратегию в адресе; `false` — маршрута нет, выбор держится только на экране. */
  readonly onSelectName: (name: string | undefined) => boolean;
  readonly navigate: (href: string) => void;
  readonly confirm?: (message: string) => boolean;
}): JSX.Element {
  const [overview, setOverview] = useState<ReviewStrategiesOverview | undefined>();
  const [settings, setSettings] = useState<Settings | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [localName, setLocalName] = useState<string | undefined>(name);
  const [layer, setLayer] = useState<StrategyLayer | undefined>();
  const [creating, setCreating] = useState<NewStrategy | undefined>();
  const [draft, setDraft] = useState<StrategyDraft | undefined>();
  const [problem, setProblem] = useState<StrategyProblem | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  const reload = useCallback(async (): Promise<void> => {
    try {
      setOverview(await fetchReviewStrategies());
      setLoadError(undefined);
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    fetchSettings().then(setSettings, () => setSettings(undefined));
  }, [reload]);
  useEffect(() => setLocalName(name), [name]);

  const selected = overview === undefined ? undefined : selectStrategy(overview.strategies, localName, layer);
  const selectedKey = selected === undefined ? undefined : `${selected.layer}/${selected.name}/${overview?.generatedAt ?? ''}`;
  useEffect(() => {
    if (creating !== undefined) return;
    setDraft(selected?.document === undefined ? undefined : strategyDraftOf(selected.document));
    setProblem(undefined);
    // Черновик пересобирается только при смене выбранной стратегии или новом ответе демона.
  }, [selectedKey, creating]);

  const original = creating === undefined ? selected?.document : undefined;
  const dirty = draft !== undefined && (original === undefined || JSON.stringify(strategyDocumentOf(draft, original)) !== JSON.stringify(original));

  const select = (strategy: StrategyView): void => {
    if (dirty && !confirm('Discard the unsaved changes?')) return;
    setCreating(undefined);
    setLayer(strategy.layer);
    setNotice(undefined);
    if (!onSelectName(strategy.name)) setLocalName(strategy.name);
  };

  const create = (): void => {
    if (dirty && !confirm('Discard the unsaved changes?')) return;
    setCreating({ layer: overview?.projectDir === undefined ? 'home' : 'project' });
    setDraft(emptyStrategyDraft());
    setProblem(undefined);
    setNotice(undefined);
  };

  const save = async (): Promise<void> => {
    if (draft === undefined) return;
    const local = strategyDraftProblem(draft);
    if (local !== undefined) {
      setProblem({ message: local });
      return;
    }
    const target = creating ?? (selected === undefined ? undefined : { layer: selected.layer });
    if (target === undefined) return;
    const strategyName = creating !== undefined ? draft.name.trim() : selected!.name;
    setBusy(true);
    try {
      await saveReviewStrategy({
        layer: target.layer,
        name: strategyName,
        document: strategyDocumentOf(draft, original),
        ...(creating === undefined ? {} : { create: true }),
      });
      setProblem(undefined);
      setCreating(undefined);
      setLayer(target.layer);
      setNotice('Saved');
      await reload();
      if (!onSelectName(strategyName)) setLocalName(strategyName);
    } catch (error) {
      setProblem(error instanceof StrategySaveError ? { message: error.message, ...(error.at === undefined ? {} : { at: error.at }) } : { message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (selected === undefined || !confirm(strategyRemovalConfirmation(selected))) return;
    setBusy(true);
    try {
      await deleteReviewStrategy(selected.layer, selected.name);
      setLayer(undefined);
      setNotice(`Deleted ${selected.path}`);
      await reload();
      if (!onSelectName(undefined)) setLocalName(undefined);
    } catch (error) {
      setProblem({ message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ReviewStrategiesView
      overview={overview}
      settings={settings}
      {...(loadError === undefined ? {} : { loadError })}
      selected={selected}
      creating={creating}
      draft={draft}
      problem={problem}
      dirty={dirty}
      busy={busy}
      {...(notice === undefined ? {} : { notice })}
      navigate={navigate}
      onSelect={select}
      onCreate={create}
      onCreateLayer={(next) => setCreating({ layer: next })}
      onDraft={(next) => {
        setDraft(next);
        setNotice(undefined);
      }}
      onSave={() => void save()}
      onDelete={() => void remove()}
    />
  );
}
