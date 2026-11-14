import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react';

import {
  deleteStrategy,
  fetchSettings,
  fetchStrategies,
  saveStrategy,
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
 * Общий каркас экранов стратегий — «Review strategies»
 * (`ui-review-strategies`) и «Discussion strategies»
 * (`ui-discussion-strategies`): список обоих слоёв, шапка, создание в
 * выбранном слое, сохранение и удаление через демон, показ отказа разбора у
 * поля. Вид стратегии задаёт описание `StrategyKindUi`: подписи, черновик ↔
 * документ и редактор. Поля участника, локальные профили и «Used by» общие.
 */

export const PIPELINES_TARGET: RouteTarget = { kind: 'screen', id: 'screen-pipelines' };

export type Raw = Readonly<Record<string, unknown>>;

export const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export interface ParticipantDraft {
  /** Профиль или бэкенд; пусто — профиль `default`. */
  readonly agent: string;
  readonly modelKind: 'tier' | 'model';
  readonly tier: string;
  readonly model: string;
  readonly effort: string;
}

/** Роль с выбором агента и дополнением к промпту: агрегатор, защитник, автор. */
export interface PromptedDraft extends ParticipantDraft {
  readonly prompt: string;
}

/** Общее у черновиков всех видов: имя файла, описание и локальные профили. */
export interface BaseStrategyDraft {
  readonly name: string;
  readonly description: string;
  readonly profiles: readonly ProfileDraft[];
}

export function participantDraftOf(raw: Raw | undefined): ParticipantDraft {
  return {
    agent: text(raw?.agent),
    modelKind: raw?.model === undefined ? 'tier' : 'model',
    tier: text(raw?.model_tier),
    model: text(raw?.model),
    effort: text(raw?.effort),
  };
}

export function promptedDraftOf(raw: Raw | undefined): PromptedDraft {
  return { ...participantDraftOf(raw), prompt: text(raw?.prompt) };
}

export function participantValue(draft: ParticipantDraft): Record<string, string> {
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

export function promptedValue(draft: PromptedDraft): Record<string, string> {
  return { ...participantValue(draft), ...(draft.prompt.trim() === '' ? {} : { prompt: draft.prompt }) };
}

/** Профили из документа — черновиками формы. */
export function profileDraftsOf(document: Raw): ProfileDraft[] {
  const profiles = (document.profiles ?? {}) as Readonly<Record<string, AgentProfileValue>>;
  return Object.entries(profiles).map(([name, profile]) => profileDraftOf({ name, profile, file: '' }));
}

/**
 * Основа документа из черновика поверх прежнего: `version`, `kind`, имя,
 * описание и профили. Ключи, которых форма не знает, и нетронутые профили
 * уходят как были — демон правит файл через `Document`, и неизменное
 * значение не трогает узел с его комментарием.
 */
export function baseDocumentOf(kind: string, draft: BaseStrategyDraft, original: Raw): Record<string, unknown> {
  const document: Record<string, unknown> = { version: 1, kind, ...original, name: draft.name.trim() };
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
  return document;
}

/** Роль с выбором агента: пустая убирается из документа, иначе пишется. */
export function setRole(document: Record<string, unknown>, key: string, value: Record<string, string>): void {
  if (Object.keys(value).length === 0) delete document[key];
  else document[key] = value;
}

export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  const a = left as Raw;
  const b = right as Raw;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
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

/** Отказ относится к полю, если путь ключа — само поле или лежит внутри него. */
export function errorAt(problem: StrategyProblem | undefined, ...fields: readonly string[]): string | undefined {
  const at = problem?.at;
  if (at === undefined) return undefined;
  return fields.some((field) => at === field || at.startsWith(`${field}.`)) ? problem!.message : undefined;
}

/** Что мешает сохранить ещё до отправки: только то, что форма знает сама (имя файла, черновики профилей). */
export function strategyDraftProblem(draft: BaseStrategyDraft): string | undefined {
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

export function agentGroups(draft: Pick<BaseStrategyDraft, 'profiles'>, settings: Settings | undefined): AgentGroups {
  const strategy = draft.profiles.map((profile) => profile.name.trim()).filter((name) => name !== '');
  return {
    strategy,
    settings: ['default', ...(settings?.profiles ?? []).map((profile) => profile.name)],
    backends: (settings?.backends ?? []).map((backend) => backend.name),
  };
}

export function FieldError({ message }: { readonly message: string | undefined }): JSX.Element | null {
  return message === undefined ? null : <span className="strategy-field-error" role="alert">{message}</span>;
}

export function Field({ label, htmlFor, error, children }: {
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

export function ParticipantFields({ id, draft, groups, tiers, problem, at, onChange }: {
  readonly id: string;
  readonly draft: ParticipantDraft;
  readonly groups: AgentGroups;
  readonly tiers: readonly string[];
  readonly problem: StrategyProblem | undefined;
  /** Путь участника в документе: `aggregator`, `reviewers.<n>`, `participants.<n>`. */
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
export function TextOrFile({ id, label, value, problem, at, placeholder, onChange }: {
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

/** Блок локальных профилей стратегии тем же редактором, что вкладка Profiles. */
export function LocalProfiles<D extends BaseStrategyDraft>({ draft, settings, strategy, problem, onChange }: {
  readonly draft: D;
  readonly settings: Settings | undefined;
  readonly strategy: StrategyView | undefined;
  readonly problem: StrategyProblem | undefined;
  readonly onChange: (next: D) => void;
}): JSX.Element {
  const backends = (settings?.backends ?? []).map((backend) => backend.name);
  const tiers = settings?.modelTiers ?? [];
  const contextBase = strategy === undefined ? 'the strategy file' : strategy.path.replace(/[^/\\]+$/, '');
  return (
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
  );
}

/** Шаги пайплайнов проекта, чья ссылка разрешилась в этот файл. */
export function UsedBy({ strategy, stepKind, navigate }: {
  readonly strategy: StrategyView | undefined;
  /** Ключ вида шага: `review:` или `discuss:`. */
  readonly stepKind: string;
  readonly navigate: (href: string) => void;
}): JSX.Element | null {
  if (strategy === undefined) return null;
  return (
    <>
      <h2 className="strategy-section">Used by</h2>
      {strategy.usage.length === 0 ? (
        <p className="small dim">No {stepKind} step of the project pipelines resolves to this file.</p>
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
  );
}

/** Схема хода — этапы списком. */
export function CourseList({ steps, label }: { readonly steps: readonly string[]; readonly label: string }): JSX.Element {
  return (
    <ol className="strategy-course" aria-label={label}>
      {steps.map((step) => <li key={step}>{step}</li>)}
    </ol>
  );
}

export function layerLabel(layer: StrategyLayer): string {
  return layer === 'project' ? 'project' : 'mine';
}

/** Выбранная стратегия: по имени из адреса и слою, если пользователь открыл перекрытую. */
export function selectStrategy(strategies: readonly StrategyView[], name: string | undefined, layer: StrategyLayer | undefined): StrategyView | undefined {
  if (name === undefined || name === '') return strategies[0];
  return strategies.find((strategy) => strategy.name === name && (layer === undefined || strategy.layer === layer))
    ?? strategies.find((strategy) => strategy.name === name);
}

export interface StrategyEditorBaseProps<D> {
  readonly draft: D;
  readonly settings: Settings | undefined;
  /** Стратегия из списка; у новой нет. */
  readonly strategy?: StrategyView;
  readonly problem: StrategyProblem | undefined;
  readonly readOnly: boolean;
  readonly navigate: (href: string) => void;
  readonly onChange: (next: D) => void;
}

/** Вид стратегии для общего экрана. */
export interface StrategyKindUi<D extends BaseStrategyDraft> {
  /** Заголовок экрана: «Review strategies». */
  readonly title: string;
  readonly description: ReactNode;
  /** Пустое состояние: «No review strategies yet». */
  readonly emptyTitle: string;
  /** Каталог слоя в подсказке пустого состояния: `review-strategies`. */
  readonly layerDir: string;
  readonly namePlaceholder: string;
  /** Адрес API демона. */
  readonly api: string;
  /** Подпись стратегии в списке под именем. */
  readonly summary: (document: Raw) => string;
  readonly draftOf: (document: Raw) => D;
  readonly emptyDraft: () => D;
  readonly documentOf: (draft: D, original?: Raw) => Record<string, unknown>;
  readonly Editor: (props: StrategyEditorBaseProps<D>) => JSX.Element;
}

export function StrategyList({ strategies, selected, label, summary, onSelect }: {
  readonly strategies: readonly StrategyView[];
  readonly selected: StrategyView | undefined;
  readonly label: string;
  readonly summary: (document: Raw) => string;
  readonly onSelect: (strategy: StrategyView) => void;
}): JSX.Element {
  return (
    <ul className="strategy-list" aria-label={label}>
      {strategies.map((strategy) => {
        const active = selected?.layer === strategy.layer && selected.name === strategy.name;
        return (
          <li key={`${strategy.layer}/${strategy.name}`} className={strategy.shadowed === true ? 'shadowed' : undefined}>
            <button type="button" className={active ? 'active' : undefined} aria-current={active ? 'true' : undefined} onClick={() => onSelect(strategy)}>
              <span className="strategy-list-head">
                <span className="mono">{strategy.name}</span>
                <Badge variant={strategy.layer === 'project' ? 'default' : 'secondary'}>{layerLabel(strategy.layer)}</Badge>
              </span>
              <span className="small dim">
                {strategy.error !== undefined || strategy.document === undefined ? 'does not parse' : summary(strategy.document)}
                {strategy.shadowed === true ? ' · shadowed by the project' : ''}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export interface NewStrategy {
  readonly layer: StrategyLayer;
}

export interface StrategiesViewProps<D> {
  readonly overview: ReviewStrategiesOverview | undefined;
  readonly settings: Settings | undefined;
  readonly loadError?: string;
  readonly selected: StrategyView | undefined;
  /** Создание новой стратегии: черновик идёт в выбранный слой. */
  readonly creating: NewStrategy | undefined;
  readonly draft: D | undefined;
  readonly problem: StrategyProblem | undefined;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly notice?: string;
  readonly navigate: (href: string) => void;
  readonly onSelect: (strategy: StrategyView) => void;
  readonly onCreate: () => void;
  readonly onCreateLayer: (layer: StrategyLayer) => void;
  readonly onDraft: (next: D) => void;
  readonly onSave: () => void;
  readonly onDelete: () => void;
}

export function StrategiesView<D extends BaseStrategyDraft>({ kind, ...props }: StrategiesViewProps<D> & { readonly kind: StrategyKindUi<D> }): JSX.Element {
  const { overview, settings, selected, creating, draft, problem } = props;
  const header = (
    <PageHeader
      title={kind.title}
      description={kind.description}
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
          <Input id="strategy-name" className="mono" value={draft?.name ?? ''} placeholder={kind.namePlaceholder}
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

  const Editor = kind.Editor;
  let body: JSX.Element;
  if (creating === undefined && selected === undefined) {
    body = (
      <EmptyState
        title={kind.emptyTitle}
        description={<>A strategy lives in <code>.burnex/{kind.layerDir}/</code> of the project or in <code>{overview.homeDir}</code>.</>}
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
          <Editor draft={draft} settings={settings} {...(selected === undefined || creating !== undefined ? {} : { strategy: selected })}
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
            : <StrategyList strategies={overview.strategies} selected={creating === undefined ? selected : undefined}
              label={kind.title} summary={kind.summary} onSelect={props.onSelect} />}
        </nav>
        <section className="strategy-main">{body}</section>
      </div>
    </div>
  );
}

/**
 * Страница с состоянием: читает стратегии вида и настройки (профили, бэкенды,
 * уровни), держит черновик выбранной и пишет его через демон.
 */
export function StrategiesPage<D extends BaseStrategyDraft>({ kind, name, onSelectName, navigate, confirm = (message) => window.confirm(message) }: {
  readonly kind: StrategyKindUi<D>;
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
  const [draft, setDraft] = useState<D | undefined>();
  const [problem, setProblem] = useState<StrategyProblem | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  const reload = useCallback(async (): Promise<void> => {
    try {
      setOverview(await fetchStrategies(kind.api));
      setLoadError(undefined);
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, [kind.api]);

  useEffect(() => {
    void reload();
    fetchSettings().then(setSettings, () => setSettings(undefined));
  }, [reload]);
  useEffect(() => setLocalName(name), [name]);

  const selected = overview === undefined ? undefined : selectStrategy(overview.strategies, localName, layer);
  const selectedKey = selected === undefined ? undefined : `${selected.layer}/${selected.name}/${overview?.generatedAt ?? ''}`;
  useEffect(() => {
    if (creating !== undefined) return;
    setDraft(selected?.document === undefined ? undefined : kind.draftOf(selected.document));
    setProblem(undefined);
    // Черновик пересобирается только при смене выбранной стратегии или новом ответе демона.
  }, [selectedKey, creating]);

  const original = creating === undefined ? selected?.document : undefined;
  // Новая стратегия (`original` нет) — всегда правка; иначе структурное сравнение документов.
  const dirty = draft !== undefined && (original === undefined || !sameValue(kind.documentOf(draft, original), original));

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
    setDraft(kind.emptyDraft());
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
      await saveStrategy(kind.api, {
        layer: target.layer,
        name: strategyName,
        document: kind.documentOf(draft, original),
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
      await deleteStrategy(kind.api, selected.layer, selected.name);
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
    <StrategiesView
      kind={kind}
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
