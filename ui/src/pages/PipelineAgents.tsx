import { useState, type JSX } from 'react';

import { Button, Combobox, Input } from '@stepcast/ui';
import type {
  AgentEntryView,
  PipelineAgentOrigin,
  PipelineAgentSelection,
  PipelineAgentTarget,
  PipelineEffortOrigin,
  PipelineModelOrigin,
  Settings,
} from '../api';

/**
 * Выбор агента, модели и effort пользователем на экране Pipelines
 * (`agent-policy-and-pipeline-agents`, design.md, решение 8): подписи слоёв,
 * варианты выбора и сам селектор. Запись идёт в глобальный файл через
 * `PUT /api/pipelines/agents`; что из записи вышло, показывает ответ демона.
 */

function tierLayerLabel(layer: string, file: string | undefined): string {
  return file === undefined ? layer : `${layer} · ${file}`;
}

/**
 * Слой модели словами: карточка не должна заставлять читателя сравнивать
 * значения самому, чтобы понять, что `opus` шага и `opus` настроек — не одно
 * и то же решение (design.md, «Экран пайплайна показывает значение, не
 * называя слоя»).
 */
export function modelOriginLabel(origin: PipelineModelOrigin): string {
  const label = ((): string => {
    switch (origin.layer) {
      case 'job':
        return 'job model';
      case 'tier':
        return `tier ${origin.tier} (${tierLayerLabel(origin.tierLayer, origin.file)}, ${origin.backend})${origin.fallback ? ' → agent default model' : ''}`;
      case 'step':
        return 'declared by the step';
      case 'pipeline':
        return 'pipeline default';
      case 'config':
        return `settings · ${origin.file}`;
      case 'pipeline_agents':
      case 'step_agents':
        return `${origin.layer} · ${origin.file}`;
      case 'backend':
        return `backend model ${origin.backend}`;
      case 'none':
        return 'no model set — the backend picks one';
    }
  })();
  // Отброшенная модель — часть ответа на «почему именно эта»: без неё выбор
  // агента выглядел бы необъяснимой подменой модели документа.
  return origin.dropped === undefined
    ? label
    : `${label} · dropped ${origin.dropped.model} from the ${origin.dropped.layer}: it belongs to another agent`;
}

export function effortOriginLabel(origin: PipelineEffortOrigin): string {
  switch (origin.layer) {
    case 'job':
      return 'job effort';
    case 'tier':
      return `tier ${origin.tier} effort (${tierLayerLabel(origin.tierLayer, origin.file)}, ${origin.backend})`;
    case 'step':
      return 'effort declared by the step';
    case 'pipeline':
      return 'pipeline effort';
    case 'config':
      return `effort settings · ${origin.file}`;
    case 'pipeline_agents':
    case 'step_agents':
      return `effort ${origin.layer} · ${origin.file}`;
    case 'none':
      return 'model default effort';
  }
}

export function agentOriginLabel(origin: PipelineAgentOrigin): string {
  switch (origin.layer) {
    case 'step':
      return 'agent declared by the step';
    case 'job':
      return 'job agent';
    case 'pipeline':
      return 'pipeline agent';
    case 'config':
      return 'default agent';
    case 'pipeline_agents':
    case 'step_agents':
      return `agent ${origin.layer} · ${origin.file}`;
  }
}

/** Почему правка с экрана может ничего не менять — словами карточки. */
export function entryMarkLabel(mark: NonNullable<AgentEntryView['mark']>, policy: string | undefined): string {
  return mark === 'loses_to_document'
    ? `this entry loses to the pipeline document under agent_policy: ${policy ?? 'force'} — it changes nothing here`
    : mark === 'no_agent_steps'
    ? 'this pipeline has no agent steps — the entry has nothing to apply to'
    : 'part of this entry comes from a project file — the screen writes only the global file, so editing here does not override it';
}

/** Варианты выбора: агенты, tier и имена моделей из настроек — без новой пробы CLI. */
export interface AgentChoices {
  readonly agents: readonly string[];
  readonly tiers: readonly string[];
  readonly models: readonly string[];
}

export function agentChoices(settings: Settings): AgentChoices {
  const models = new Set<string>();
  for (const backend of settings.backends) {
    if (backend.defaultModel !== undefined) models.add(backend.defaultModel);
    for (const selection of Object.values(backend.modelTiers)) models.add(selection.model);
  }
  return {
    agents: settings.backends.filter((backend) => backend.enabled && backend.available).map((backend) => backend.name),
    tiers: settings.modelTiers,
    models: [...models].sort(),
  };
}

/** Черновик полей записи: пустая строка — «не задано». */
export interface SelectionDraft {
  readonly agent: string;
  readonly model: string;
  readonly tier: string;
  readonly effort: string;
}

export function draftOf(entry: AgentEntryView | undefined): SelectionDraft {
  return {
    agent: entry?.agent?.value ?? '',
    model: entry?.model?.value ?? '',
    tier: entry?.modelTier?.value ?? '',
    effort: entry?.effort?.value ?? '',
  };
}

/**
 * Правка записи по разнице черновика и текущей записи. Изменённое пустое поле
 * снимается (`null`); не тронутое в правку не попадает. `undefined` — менять
 * нечего.
 */
export function selectionPatch(
  entry: AgentEntryView | undefined,
  draft: SelectionDraft,
): PipelineAgentSelection | undefined {
  const before = draftOf(entry);
  const patch: Record<string, string | null> = {};
  const diff = (key: string, now: string, was: string): void => {
    if (now.trim() !== was) patch[key] = now.trim() === '' ? null : now.trim();
  };
  diff('agent', draft.agent, before.agent);
  diff('model', draft.model, before.model);
  diff('model_tier', draft.tier, before.tier);
  diff('effort', draft.effort, before.effort);
  return Object.keys(patch).length === 0 ? undefined : patch;
}

export type ApplySelection = (target: PipelineAgentTarget, selection: PipelineAgentSelection | null) => void;

/**
 * Выбор агента, tier или модели и effort для пайплайна либо шага. Выбор tier
 * очищает поле модели и наоборот: слой выбирает модель целиком, и демон снимает
 * вторую половину пары в записи, так что черновик не обещает невозможного.
 */
export function AgentSelector({
  target,
  entry,
  choices,
  busy,
  onApply,
}: {
  readonly target: PipelineAgentTarget;
  readonly entry: AgentEntryView | undefined;
  readonly choices: AgentChoices;
  readonly busy: boolean;
  readonly onApply: ApplySelection;
}): JSX.Element {
  const [draft, setDraft] = useState<SelectionDraft>(draftOf(entry));
  const patch = selectionPatch(entry, draft);
  const id = [target.pipeline, target.job, target.step].filter((part) => part !== undefined).join('-');

  return (
    <div className="agent-select">
      <label className="agent-select-field">
        <span className="small dim">agent</span>
        <select
          aria-label={`agent ${id}`}
          value={draft.agent}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, agent: event.target.value })}
        >
          <option value="">— not set —</option>
          {choices.agents.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="agent-select-field">
        <span className="small dim">tier</span>
        <select
          aria-label={`tier ${id}`}
          value={draft.tier}
          disabled={busy}
          onChange={(event) =>
            setDraft({ ...draft, tier: event.target.value, model: event.target.value === '' ? draft.model : '' })
          }
        >
          <option value="">— not set —</option>
          {choices.tiers.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <div className="agent-select-field">
        <span className="small dim">model</span>
        <Combobox
          id={`model-${id}`}
          mono
          allowCustom
          value={draft.model}
          options={choices.models.map((value) => ({ value }))}
          placeholder="model name"
          emptyText="No known model matches — the typed name is used as is"
          disabled={busy}
          onChange={(value) => setDraft({ ...draft, model: value, tier: value.trim() === '' ? draft.tier : '' })}
        />
      </div>
      <label className="agent-select-field">
        <span className="small dim">effort</span>
        <Input
          aria-label={`effort ${id}`}
          value={draft.effort}
          placeholder="effort"
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, effort: event.target.value })}
        />
      </label>
      <Button size="sm" disabled={busy || patch === undefined} onClick={() => patch !== undefined && onApply(target, patch)}>
        Apply
      </Button>
      <Button size="sm" variant="ghost" disabled={busy || entry === undefined} onClick={() => onApply(target, null)}>
        Clear
      </Button>
    </div>
  );
}
