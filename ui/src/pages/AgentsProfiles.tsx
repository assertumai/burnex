import type { JSX } from 'react';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@burnex/ui';
import type {
  AgentProfileValue,
  PipelineView,
  ProfileContextEntry,
  ProfileView,
  ProjectProfileView,
  Settings,
} from '../api';

/**
 * Вкладка Profiles экрана «Agents» (`agent-profiles`, design.md, решение 7):
 * встроенный `default` ссылкой на вкладку Default, профили глобального файла —
 * формой, проектные — только для чтения. Черновик живёт в `Agents.tsx` рядом с
 * черновиками Default, Backends и Tiers: правки четырёх вкладок уходят одной
 * записью в глобальный файл и переживают смену вкладки.
 */

/** Запись контекста в черновике: `text` и `path` правятся, прочее сохраняется как объявлено. */
export type ContextDraft =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'path'; readonly value: string }
  | { readonly kind: 'raw'; readonly raw: ProfileContextEntry };

export interface ProfileDraft {
  /** Имя профиля в файле до правки; у нового профиля нет. */
  readonly original?: string;
  readonly name: string;
  readonly backend: string;
  readonly modelKind: 'tier' | 'model';
  readonly model: string;
  readonly tier: string;
  readonly effort: string;
  readonly context: readonly ContextDraft[];
}

function contextDraftOf(entry: ProfileContextEntry): ContextDraft {
  if (typeof entry === 'string') return { kind: 'path', value: entry };
  if ('text' in entry) return { kind: 'text', value: entry.text };
  if ('path' in entry && entry.mode === undefined && entry.required === undefined) return { kind: 'path', value: entry.path };
  return { kind: 'raw', raw: entry };
}

export function profileDraftOf(view: ProfileView): ProfileDraft {
  return {
    original: view.name,
    name: view.name,
    backend: view.profile.backend,
    modelKind: view.profile.model === undefined ? 'tier' : 'model',
    model: view.profile.model ?? '',
    tier: view.profile.model_tier ?? '',
    effort: view.profile.effort ?? '',
    context: (view.profile.context ?? []).map(contextDraftOf),
  };
}

export function emptyProfileDraft(backend: string): ProfileDraft {
  return { name: '', backend, modelKind: 'tier', model: '', tier: '', effort: '', context: [] };
}

/** Профиль в объявленном виде из черновика: пустое поле не пишется. */
export function profileValueOf(draft: ProfileDraft): AgentProfileValue {
  const model = draft.model.trim();
  const tier = draft.tier.trim();
  const effort = draft.effort.trim();
  const context = draft.context.flatMap((entry): ProfileContextEntry[] => {
    if (entry.kind === 'raw') return [entry.raw];
    if (entry.value.trim() === '') return [];
    return [entry.kind === 'text' ? { text: entry.value } : entry.value.trim()];
  });
  return {
    backend: draft.backend.trim(),
    ...(draft.modelKind === 'model' && model !== '' ? { model } : {}),
    ...(draft.modelKind === 'tier' && tier !== '' ? { model_tier: tier } : {}),
    ...(effort === '' ? {} : { effort }),
    ...(context.length === 0 ? {} : { context }),
  };
}

const PROFILE_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * Что мешает сохранить черновик ещё до отправки: форма имени и повтор. Отказы
 * на `default` и на имени бэкенда отдаёт демон — тем же текстом, что разбор
 * конфигурации (`checkProfileName`), чтобы два текста не разошлись.
 */
export function profileDraftProblem(drafts: readonly ProfileDraft[]): string | undefined {
  const seen = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!PROFILE_NAME.test(name)) {
      return `Profile name “${name}”: use lowercase letters, digits, hyphens or underscores; start with a letter`;
    }
    if (seen.has(name)) return `Profile ${name} is declared twice`;
    seen.add(name);
    if (draft.backend.trim() === '') return `Profile ${name} needs a backend`;
  }
  return undefined;
}

/**
 * Правка `profiles` для `PUT /api/settings`: удалённые и переименованные —
 * `null` под прежним именем, изменённые и новые — целиком под новым.
 * `undefined` — менять нечего.
 */
export function profilesPatch(
  original: readonly ProfileView[],
  drafts: readonly ProfileDraft[],
): Record<string, AgentProfileValue | null> | undefined {
  const patch: Record<string, AgentProfileValue | null> = {};
  const kept = new Set(drafts.flatMap((draft) => (draft.original === undefined ? [] : [draft.original])));
  for (const view of original) {
    if (!kept.has(view.name)) patch[view.name] = null;
  }
  for (const draft of drafts) {
    const value = profileValueOf(draft);
    const name = draft.name.trim();
    const before = original.find((view) => view.name === draft.original);
    if (before !== undefined && before.name !== name) patch[before.name] = null;
    // Сравнение через черновик: порядок ключей и короткая форма записи пути в
    // файле не делают нетронутый профиль изменённым.
    const unchanged = before !== undefined && JSON.stringify(profileValueOf(profileDraftOf(before))) === JSON.stringify(value);
    if (before === undefined || before.name !== name || !unchanged) {
      patch[name] = value;
    }
  }
  return Object.keys(patch).length === 0 ? undefined : patch;
}

/**
 * Где профиль исполняет шаги — по происхождению агента шага, которое уже
 * несёт ответ `/api/pipelines`: `<пайплайн>/<работа>/<шаг>`.
 */
export function profileUsage(pipelines: readonly PipelineView[] | undefined): ReadonlyMap<string, readonly string[]> {
  const usage = new Map<string, string[]>();
  for (const pipeline of pipelines ?? []) {
    for (const job of pipeline.jobs) {
      for (const step of job.steps) {
        const name = step.agentOrigin?.profile;
        if (name === undefined) continue;
        const list = usage.get(name) ?? [];
        list.push(`${pipeline.name}/${job.id}/${step.id}`);
        usage.set(name, list);
      }
    }
  }
  return usage;
}

/** Текст подтверждения удаления; `undefined` — профиль не используется, подтверждать нечего. */
export function removalConfirmation(name: string, usedBy: readonly string[] | undefined): string | undefined {
  if (usedBy === undefined || usedBy.length === 0) return undefined;
  return `Profile ${name} runs ${usedBy.length} step(s): ${usedBy.join(', ')}. Pipelines that name it will fail to expand after the deletion. Delete it?`;
}

function contextSummary(entry: ProfileContextEntry): string {
  if (typeof entry === 'string') return entry;
  if ('text' in entry) return `text: ${entry.text}`;
  if ('path' in entry) return entry.path;
  if ('item_refs' in entry) return `item_refs: ${entry.item_refs}`;
  return JSON.stringify(entry);
}

function UsageNote({ usedBy }: { readonly usedBy: readonly string[] | undefined }): JSX.Element {
  return (
    <div className="small dim">
      {usedBy === undefined || usedBy.length === 0 ? 'not used by any known pipeline' : `used by: ${usedBy.join(', ')}`}
    </div>
  );
}

function ProfileForm({
  draft,
  index,
  backends,
  tiers,
  usedBy,
  onChange,
  onRemove,
}: {
  readonly draft: ProfileDraft;
  readonly index: number;
  readonly backends: readonly string[];
  readonly tiers: readonly string[];
  readonly usedBy: readonly string[] | undefined;
  readonly onChange: (next: ProfileDraft) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const id = `profile-${index}`;
  const setContext = (position: number, next: ContextDraft | undefined): void => {
    const context = [...draft.context];
    if (next === undefined) context.splice(position, 1);
    else context[position] = next;
    onChange({ ...draft, context });
  };
  return (
    <Card className="agent-card">
      <CardHeader>
        <div className="agent-card-head">
          <CardTitle>{draft.name.trim() === '' ? 'New profile' : draft.name}</CardTitle>
          <Badge variant="secondary">global</Badge>
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Delete profile ${draft.name}`}>Delete</Button>
        </div>
        <UsageNote usedBy={usedBy} />
      </CardHeader>
      <CardContent>
        <div className="agent-field">
          <Label htmlFor={`${id}-name`} className="agent-field-label mono">name</Label>
          <div className="agent-field-body">
            <Input id={`${id}-name`} className="mono" value={draft.name} placeholder="reviewer-strict"
              onChange={(event) => onChange({ ...draft, name: event.target.value })} />
          </div>
        </div>
        <div className="agent-field">
          <Label htmlFor={`${id}-backend`} className="agent-field-label mono">backend</Label>
          <div className="agent-field-body">
            <select id={`${id}-backend`} value={draft.backend} onChange={(event) => onChange({ ...draft, backend: event.target.value })}>
              {[...new Set([draft.backend, ...backends])].filter((name) => name !== '').map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="agent-field">
          <span className="agent-field-label mono">model</span>
          <div className="agent-field-body">
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
                <select aria-label={`tier ${draft.name}`} value={draft.tier} onChange={(event) => onChange({ ...draft, tier: event.target.value })}>
                  <option value="">— not set —</option>
                  {[...new Set([draft.tier, ...tiers])].filter((name) => name !== '').map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              ) : (
                <Input aria-label={`model ${draft.name}`} className="mono" value={draft.model} placeholder="model name"
                  onChange={(event) => onChange({ ...draft, model: event.target.value })} />
              )}
            </div>
          </div>
        </div>
        <div className="agent-field">
          <Label htmlFor={`${id}-effort`} className="agent-field-label mono">effort</Label>
          <div className="agent-field-body">
            <Input id={`${id}-effort`} className="mono" value={draft.effort} placeholder="model default"
              onChange={(event) => onChange({ ...draft, effort: event.target.value })} />
          </div>
        </div>
        <div className="agent-field">
          <span className="agent-field-label mono">context</span>
          <div className="agent-field-body">
            <span className="small dim">Added to every agent step this profile runs, before the pipeline context.</span>
            {draft.context.map((entry, position) => (
              <div className="agent-field-row" key={position}>
                {entry.kind === 'raw' ? (
                  <span className="mono small">{contextSummary(entry.raw)} (kept as declared)</span>
                ) : entry.kind === 'text' ? (
                  <textarea aria-label={`context text ${position + 1}`} value={entry.value} rows={2}
                    onChange={(event) => setContext(position, { kind: 'text', value: event.target.value })} />
                ) : (
                  <Input aria-label={`context path ${position + 1}`} className="mono" value={entry.value}
                    placeholder="guides/security.md — relative to ~/.burnex/"
                    onChange={(event) => setContext(position, { kind: 'path', value: event.target.value })} />
                )}
                <Button variant="ghost" size="sm" onClick={() => setContext(position, undefined)}>Remove</Button>
              </div>
            ))}
            <div className="agent-field-row">
              <Button variant="outline" size="sm" onClick={() => onChange({ ...draft, context: [...draft.context, { kind: 'text', value: '' }] })}>
                Add text
              </Button>
              <Button variant="outline" size="sm" onClick={() => onChange({ ...draft, context: [...draft.context, { kind: 'path', value: '' }] })}>
                Add path
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectProfileCard({
  profile,
  usedBy,
}: {
  readonly profile: ProjectProfileView;
  readonly usedBy: readonly string[] | undefined;
}): JSX.Element {
  return (
    <Card className="agent-card">
      <CardHeader>
        <div className="agent-card-head">
          <CardTitle>{profile.name}</CardTitle>
          <Badge>project</Badge>
        </div>
        <CardDescription className="mono">{profile.file}</CardDescription>
        <UsageNote usedBy={usedBy} />
      </CardHeader>
      <CardContent>
        <div className="ctx">
          backend {profile.backend}
          {profile.model === undefined ? '' : ` · model ${profile.model}`}
          {profile.modelTier === undefined ? '' : ` · tier ${profile.modelTier}`}
          {profile.effort === undefined ? '' : ` · effort ${profile.effort}`}
        </div>
        {profile.context.map((entry, position) => (
          <div className="ctx dim" key={position}>{contextSummary(entry)}</div>
        ))}
        <div className="small dim">Read-only here: the project file lives in the repository — edit it there.</div>
      </CardContent>
    </Card>
  );
}

export function AgentsProfiles({
  settings,
  drafts,
  projectProfiles,
  pipelines,
  tiers,
  onDrafts,
  onOpenDefault,
  confirm,
}: {
  readonly settings: Settings;
  readonly drafts: readonly ProfileDraft[];
  readonly projectProfiles: readonly ProjectProfileView[];
  readonly pipelines: readonly PipelineView[] | undefined;
  readonly tiers: readonly string[];
  readonly onDrafts: (next: readonly ProfileDraft[]) => void;
  readonly onOpenDefault: () => void;
  /** Подтверждение удаления используемого профиля; в браузере — `window.confirm`. */
  readonly confirm: (message: string) => boolean;
}): JSX.Element {
  const usage = profileUsage(pipelines);
  const backends = settings.backends.map((backend) => backend.name);
  const remove = (index: number): void => {
    const draft = drafts[index]!;
    const message = removalConfirmation(draft.original ?? draft.name, usage.get(draft.original ?? draft.name));
    if (message !== undefined && !confirm(message)) return;
    onDrafts(drafts.filter((_, position) => position !== index));
  };

  return (
    <>
      <p className="small dim agent-note">
        A profile names a backend together with a model or tier, an effort and context added to every agent step it runs.
        Name a profile in <code>agent:</code> of a step, job or pipeline, in <code>pipeline_agents</code>, <code>step_agents</code>{' '}
        or with <code>--agent</code>. Every backend name is itself a profile with no model, effort or context.
      </p>
      <div className="agent-cards">
        <Card className="agent-card">
          <CardHeader>
            <div className="agent-card-head">
              <CardTitle>default</CardTitle>
              <Badge variant="success">built-in</Badge>
            </div>
            <CardDescription>
              The agent, model and effort of the Default tab: {settings.agent.value ?? '—'}
              {settings.model.value === undefined ? '' : ` · ${settings.model.value}`}
              {settings.effort.value === undefined ? '' : ` · effort ${settings.effort.value}`}
            </CardDescription>
            <UsageNote usedBy={usage.get('default')} />
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" onClick={onOpenDefault}>Open the Default tab</Button>
          </CardContent>
        </Card>
        {drafts.map((draft, index) => (
          <ProfileForm
            key={draft.original ?? `new-${index}`}
            draft={draft}
            index={index}
            backends={backends}
            tiers={tiers}
            usedBy={usage.get(draft.original ?? draft.name)}
            onChange={(next) => onDrafts(drafts.map((current, position) => (position === index ? next : current)))}
            onRemove={() => remove(index)}
          />
        ))}
        {[...projectProfiles]
          .sort((left, right) => left.name.localeCompare(right.name) || left.projectPath.localeCompare(right.projectPath))
          .map((profile) => (
            <ProjectProfileCard key={`${profile.projectKey}-${profile.name}`} profile={profile} usedBy={usage.get(profile.name)} />
          ))}
      </div>
      <div className="agent-field-row">
        <Button variant="outline" onClick={() => onDrafts([...drafts, emptyProfileDraft(settings.agent.value ?? backends[0] ?? '')])}>
          Add profile
        </Button>
      </div>
    </>
  );
}
