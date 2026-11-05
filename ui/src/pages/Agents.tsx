import { useEffect, useState, type JSX } from 'react';

import { MODEL_TIERS, type ModelTier, type ModelTierSelection } from '../../../src/parts/pipeline/config/modelTiers';
import {
  fetchModels, fetchPipelines, fetchSettings, saveSettings,
  type ModelOption, type ModelsForBackend, type ModelsResult, type PipelineView, type Settings, type SettingsPatch,
} from '../api';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Combobox,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type ComboboxOption,
} from '@stepcast/ui';
import { AgentsPolicy } from './AgentsPolicy';
import './agents.css';

export type TierDraft = { model: string; effort: string };
export type AgentDraft = { defaultModel: string; modelTiers: Record<ModelTier, TierDraft> };

const TIER_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * Вкладки экрана — тот же закрытый перечень, что `values.tab` маршрута
 * `screen-agents` в `src/builtin/routes.yml` (`ui-agents-settings-merge`,
 * design.md Решение 1). Порядок — порядок кнопок.
 */
export const AGENT_TABS = ['default', 'backends', 'tiers', 'policy'] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

/** Вкладка по параметру маршрута: пустое или неизвестное значение — Default. */
export function tabOf(param: string | undefined): AgentTab {
  return (AGENT_TABS as readonly string[]).includes(param ?? '') ? (param as AgentTab) : 'default';
}

export function orderedTierNames(names: readonly string[]): readonly string[] {
  const custom = [...new Set(names.filter((name) => !(MODEL_TIERS as readonly string[]).includes(name)))].sort(
    (left, right) => left.localeCompare(right),
  );
  return [...MODEL_TIERS, ...custom];
}

/** Четыре числа для области действия `defaults.model`, посчитанные по известным витрине пайплайнам. */
export interface ModelScope {
  /** Агентские шаги, которым модель назначит именно правка этого экрана. */
  readonly affected: number;
  /** Агентские шаги, объявившие модель сами (слой step/job/pipeline) — их правка не коснётся. */
  readonly unaffected: number;
  /** Агентские шаги, чью модель задаёт другой файл: проектный `.stepcast/config.yml` либо плагин. */
  readonly overridden: number;
  /** Пайплайны, которые не разбираются: их шаги не сосчитаны ни в одну из групп. */
  readonly unparsed: number;
}

/**
 * Счёт складывается здесь, из ответа `/api/pipelines`, а не в `readSettings`
 * (`ui-effective-model`, design.md Решение 3): `defaults.model` — вопрос
 * конфигурации, размер области действия — вопрос пайплайнов.
 *
 * Слоя `config` для счёта мало: экран пишет только глобальный файл
 * (`src/parts/ui/settings.ts`), а значение того же слоя может прийти из
 * проектного `.stepcast/config.yml` или от плагина — и там правка отсюда
 * проиграет ближнему слою. Различает их файл, победивший в проекте: карточка
 * шага несёт его, и сравнить с файлом настроек — единственный способ не
 * посчитать чужой шаг своим (docs/config.md, «Разрешение»).
 */
export function scopeOf(pipelines: readonly PipelineView[], settingsFile: string): ModelScope {
  let affected = 0;
  let unaffected = 0;
  let overridden = 0;
  let unparsed = 0;
  for (const pipeline of pipelines) {
    if (pipeline.error !== undefined) {
      unparsed += 1;
      continue;
    }
    for (const job of pipeline.jobs) {
      for (const step of job.steps) {
        const origin = step.modelOrigin;
        if (origin === undefined) continue;
        if (origin.layer === 'step' || origin.layer === 'job' || origin.layer === 'pipeline') unaffected += 1;
        else if (origin.layer !== 'config') affected += 1;
        else if (origin.file === settingsFile) affected += 1;
        else overridden += 1;
      }
    }
  }
  return { affected, unaffected, overridden, unparsed };
}

/** Бэкенд можно выбрать агентом: включён и либо подключён, либо отмечен к подключению этой же правкой. */
export function selectableAgent(
  backend: { readonly name: string; readonly enabled: boolean; readonly available: boolean },
  connect: ReadonlySet<string>,
): boolean {
  return backend.enabled && (backend.available || connect.has(backend.name));
}

/** У карточки есть действие «Connect»: бэкенд не подключён, а его адаптер поставляется с Burnex. */
export function connectOffered(backend: { readonly available: boolean; readonly plugin?: string }): boolean {
  return !backend.available && backend.plugin !== undefined;
}

/** Часть правки настроек про подключение: `connect` только при непустом множестве, прежнего `connectCodex` витрина не шлёт. */
export function connectPatch(connect: ReadonlySet<string>): Pick<SettingsPatch, 'connect'> {
  return connect.size === 0 ? {} : { connect: [...connect] };
}

/**
 * Причина недоступности распознавания — словами, как её видит пользователь.
 *
 * Текст CLI и текст исключения идут при подписи, а не голыми: без неё
 * непонятно, чей это текст и о чём он, а CLI, отказавший молча (ненулевой код
 * без единого байта вывода), оставил бы в карточке пустую строку — ни списка,
 * ни причины, ни следа того, что проба вообще была.
 */
export function unavailableReason(result: ModelsForBackend): string | undefined {
  switch (result.status) {
    case 'ok': return undefined;
    case 'unsupported': return 'This agent cannot list its models — type a model name';
    case 'not_installed': return `Command “${result.command}” not found`;
    case 'timeout': return 'The agent did not answer in time';
    case 'failed': return withText('The agent failed', result.message, 'without saying why');
    case 'unparsed': return 'The agent’s answer could not be parsed';
    case 'probe_error': return withText('Listing crashed', result.message, 'without explanation');
  }
}

/** Подпись причины и текст, который прислал не браузер: пустой текст не оставляет подпись голой. */
function withText(label: string, text: string, whenEmpty: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? `${label} ${whenEmpty}` : `${label}: ${trimmed}`;
}

/**
 * Варианты поля модели: перечисленные CLI плюс те имена, которые уже стоят в
 * конфигурации, — модель по умолчанию и модели тиров. Перечень CLI заведомо
 * неполон (design.md, решение 4), и сохранённое значение обязано оставаться
 * выбираемым, а не только «custom».
 */
export function modelOptions(listed: readonly ModelOption[], configured: readonly (string | undefined)[]): readonly ComboboxOption[] {
  const options: ComboboxOption[] = listed.map((option) => ({
    value: option.name,
    ...(option.label === undefined ? {} : { label: option.label }),
    ...(
      option.title === undefined && option.defaultEffort === undefined
        ? {}
        : {
            description: [option.title, option.defaultEffort === undefined ? undefined : `default effort: ${option.defaultEffort}`]
              .filter((part): part is string => part !== undefined)
              .join(' · '),
          }
    ),
  }));
  const seen = new Set(options.map((option) => option.value));
  for (const name of configured) {
    const trimmed = name?.trim() ?? '';
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    options.push({ value: trimmed, description: 'from configuration' });
  }
  return options;
}

export function effortOptions(
  listed: readonly ModelOption[],
  model: string,
  configured: string | undefined,
): readonly ComboboxOption[] {
  const selected = listed.find((option) => option.name === model.trim());
  const options: ComboboxOption[] = (selected?.efforts ?? []).map((effort) => ({
    value: effort.name,
    ...(effort.description === undefined ? {} : { description: effort.description }),
  }));
  const current = configured?.trim() ?? '';
  if (current !== '' && !options.some((option) => option.value === current)) {
    options.push({ value: current, description: 'from configuration' });
  }
  return options;
}

/** Значение не входит в перечень, который CLI сообщил для выбранной модели. */
export function isCustomValue(value: string, knownValues: readonly string[]): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && !knownValues.includes(trimmed);
}

/** Доступ к пользовательским именам tier без наследования свойств Object.prototype. */
function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export function tierSelectionPatch(
  original: ModelTierSelection | undefined,
  draft: TierDraft,
): { readonly model: string | null; readonly effort?: string | null } | undefined {
  const model = draft.model.trim();
  const effort = draft.effort.trim();
  if (model === '') return original === undefined ? undefined : { model: null };
  if (model === original?.model && effort === (original.effort ?? '')) return undefined;
  return { model, effort: effort || null };
}

export function tierDraftProblem(
  tierNames: readonly string[],
  originalTierNames: readonly string[],
  draft: Readonly<Record<string, AgentDraft>>,
): string | undefined {
  for (const tier of tierNames) {
    for (const agent of Object.values(draft)) {
      const selection = ownValue(agent.modelTiers, tier);
      if (selection !== undefined && selection.model.trim() === '' && selection.effort.trim() !== '') {
        return `Tier ${tier} needs a model before effort can be set`;
      }
    }
    if (!originalTierNames.includes(tier) &&
      !Object.values(draft).some((agent) => ownValue(agent.modelTiers, tier)?.model.trim())) {
      return `New tier ${tier} needs a model for at least one agent`;
    }
  }
  return undefined;
}

interface ModelFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly sourceNote: string;
  readonly options: readonly ComboboxOption[];
  readonly knownValues?: readonly string[];
  readonly onChange: (value: string) => void;
}

/**
 * Поле модели — Combobox со свободным вводом, а не закрытый список: перечень
 * неполон по устройству (design.md, решение 4), и запирать в нём выбор
 * значило бы сделать распознавание хуже свободного ввода (решение 8).
 * Набранное имя вне списка — обычное состояние, отмеченное бейджем `custom`.
 */
function ModelField({ id, label, value, placeholder, sourceNote, options, knownValues, onChange }: ModelFieldProps): JSX.Element {
  const trimmed = value.trim();
  const custom = isCustomValue(trimmed, knownValues ?? options.map((option) => option.value));

  return (
    <div className="agent-field">
      <Label htmlFor={id} className="agent-field-label mono">{label}</Label>
      <div className="agent-field-body">
        <div className="agent-field-row">
          <Combobox
            id={id}
            mono
            allowCustom
            value={value}
            options={options}
            placeholder={placeholder}
            emptyText="No listed model matches — the typed name is used as is"
            onChange={onChange}
          />
          {custom ? <Badge variant="secondary">custom</Badge> : null}
        </div>
        <span className="small dim">{sourceNote}</span>
      </div>
    </div>
  );
}

/** Размер области действия `defaults.model` словами — по счёту `scopeOf`. */
function ScopeNote({
  pipelines,
  error,
  settingsFile,
}: {
  readonly pipelines: readonly PipelineView[] | undefined;
  readonly error: string | undefined;
  readonly settingsFile: string;
}): JSX.Element {
  // Отказ или пустой список — «пайплайнов не известно», а не ноль: ноль здесь
  // был бы неправдой, а не фактом (`ui-effective-model`, design.md Решение 3).
  if (error === undefined && pipelines === undefined) return <>The scope is still being counted…</>;
  if (error !== undefined || pipelines === undefined || pipelines.length === 0) {
    return <>No pipelines are known — there is nothing to count the scope from.</>;
  }
  const scope = scopeOf(pipelines, settingsFile);
  return (
    <>
      Across the pipelines known to the dashboard it affects <b>{scope.affected}</b> step(s) and leaves{' '}
      <b>{scope.unaffected}</b> alone — they already declare a model
      {scope.overridden === 0 ? null : (
        <>
          ; <b>{scope.overridden}</b> more take the model from a closer file — the project or a plugin — and editing
          here does not change them
        </>
      )}
      {scope.unparsed === 0 ? null : (
        <>
          ; <b>{scope.unparsed}</b> pipeline(s) could not be parsed, their steps are not counted
        </>
      )}
      .
    </>
  );
}

/**
 * Экран «Agents» — все настройки агентов одним экраном с четырьмя вкладками
 * (`ui-agents-settings-merge`): Default — агент, модель и effort по умолчанию;
 * Backends — бэкенды и исход перечисления их моделей; Tiers — общие уровни и
 * модели по агентам; Policy — `agent_policy` и выбор агента на пайплайн и шаг.
 *
 * Default, Backends и Tiers правят один глобальный файл одним `PUT
 * /api/settings`, поэтому черновик, `Save` и `Discard` у них общие и живут в
 * этом компоненте: смена вкладки меняет адрес, а не компонент, и черновик
 * переживает её (design.md Решение 4). Policy пишет другой маршрут и своими
 * кнопками на запись — общего `Save` на ней нет. Отправляются только
 * изменённые поля.
 */
export function Agents({
  tab,
  onSelectTab,
}: {
  readonly tab: AgentTab;
  /** Смена вкладки через адрес; `false` — маршрута к цели нет, и экран переключает вкладку сам. */
  readonly onSelectTab: (tab: AgentTab) => boolean;
}): JSX.Element {
  const [settings, setSettings] = useState<Settings>();
  const [draft, setDraft] = useState<Record<string, AgentDraft>>({});
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [tierNames, setTierNames] = useState<readonly string[]>(MODEL_TIERS);
  const [removedTiers, setRemovedTiers] = useState<readonly string[]>([]);
  const [newTier, setNewTier] = useState('');
  const [tierError, setTierError] = useState<string>();
  const [connect, setConnect] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [models, setModels] = useState<ModelsResult>();
  const [modelsError, setModelsError] = useState<string>();
  const [modelsBusy, setModelsBusy] = useState(true);
  const [pipelines, setPipelines] = useState<readonly PipelineView[]>();
  const [pipelinesError, setPipelinesError] = useState<string>();
  // Вкладка без маршрута к цели: адрес не меняется, а экран всё же переключается.
  const [localTab, setLocalTab] = useState<AgentTab | undefined>(undefined);
  const activeTab = localTab ?? tab;

  const adopt = (data: Settings): void => {
    setSettings(data);
    setAgent(data.agent.value ?? '');
    setModel(data.model.value ?? '');
    setEffort(data.effort.value ?? '');
    setTierNames(orderedTierNames(data.modelTiers));
    setRemovedTiers([]);
    setConnect(new Set());
    setNewTier('');
    setTierError(undefined);
    setDraft(Object.fromEntries(data.backends.map((backend) => [backend.name, {
      defaultModel: backend.defaultModel ?? '',
      modelTiers: Object.fromEntries(orderedTierNames(data.modelTiers).map((tier) => {
        const selection = ownValue(backend.modelTiers, tier);
        return [tier, { model: selection?.model ?? '', effort: selection?.effort ?? '' }];
      })),
    }])));
  };

  useEffect(() => {
    fetchSettings().then(adopt).catch((failure: Error) => setError(failure.message));
    // Один запрос на экран: Default считает по нему область действия модели,
    // Policy показывает по нему политику и записи выбора.
    fetchPipelines()
      .then((data) => setPipelines(data.pipelines))
      .catch((failure: Error) => setPipelinesError(failure.message));
  }, []);

  // Списки — отдельным запросом (design.md, решение 5): пробы поднимают
  // дочерние процессы демона и могут занять секунды на агента, а страница уже
  // отрисована и правима по одним настройкам.
  //
  // `refresh` — не украшение: демон держит ответ пробы, пока жив, и держит его
  // одинаково для списка и для отказа. Без явного «перечислить заново»
  // пользователь, починивший причину (поставил агента, поправил `command`,
  // авторизовался), видел бы прежний отказ до перезапуска `burnex up`.
  const loadModels = (refresh = false): void => {
    setModelsBusy(true);
    setModelsError(undefined);
    if (refresh) setModels(undefined);
    fetchModels(refresh)
      .then(setModels)
      .catch((failure: Error) => setModelsError(failure.message))
      .finally(() => setModelsBusy(false));
  };

  // Один запрос на открытие страницы; дальше — только по кнопке.
  useEffect(() => loadModels(), []);

  const selectTab = (value: string): void => {
    const next = tabOf(value);
    setLocalTab(onSelectTab(next) ? undefined : next);
  };

  const header = (
    <PageHeader
      title="Agents"
      description="Who runs the agent steps and with which model: defaults, backends, tiers and per-pipeline policy. Written to the global config file; project settings may override these values."
      actions={
        <Button variant="outline" size="sm" onClick={() => loadModels(true)} disabled={modelsBusy}>
          {modelsBusy ? 'Listing models…' : 'Reload models'}
        </Button>
      }
    />
  );

  if (settings === undefined) {
    return (
      <>
        {header}
        {error === undefined ? <EmptyState title="Loading…" /> : <Alert variant="destructive">{error}</Alert>}
      </>
    );
  }

  const backendPatch: NonNullable<SettingsPatch['backends']> = Object.fromEntries(
    settings.backends.flatMap((backend) => {
      const next = draft[backend.name]!;
      const modelTiers = Object.fromEntries(tierNames.flatMap((tier) => {
        const change = tierSelectionPatch(
          ownValue(backend.modelTiers, tier),
          ownValue(next.modelTiers, tier) ?? { model: '', effort: '' },
        );
        return change === undefined ? [] : [[tier, change]];
      }));
      const defaultChanged = next.defaultModel.trim() !== (backend.defaultModel ?? '');
      if (!defaultChanged && Object.keys(modelTiers).length === 0) return [];
      return [[backend.name, {
        ...(defaultChanged ? { defaultModel: next.defaultModel.trim() || null } : {}),
        ...(Object.keys(modelTiers).length === 0 ? {} : { modelTiers }),
      }]];
    }),
  );
  const modelChanged = model.trim() !== (settings.model.value ?? '');
  const effortChanged = effort.trim() !== (settings.effort.value ?? '');
  const addedTiers = tierNames.filter((tier) => !settings.modelTiers.includes(tier));
  const dirty = agent !== settings.agent.value || modelChanged || effortChanged || connect.size > 0 || removedTiers.length > 0 ||
    addedTiers.length > 0 || Object.keys(backendPatch).length > 0;
  const selected = settings.backends.find((backend) => backend.name === agent);
  const canSelect = selected !== undefined && selectableAgent(selected, connect);
  const draftProblem = tierDraftProblem(tierNames, settings.modelTiers, draft);
  const selectedDiscovery = models?.backends[agent];
  const selectedModels = selectedDiscovery?.status === 'ok' ? selectedDiscovery.models : [];
  const selectedModel = model.trim() || draft[agent]?.defaultModel.trim() || selected?.defaultModel || '';
  const selectedModelDefaultEffort = selectedModels.find((option) => option.name === selectedModel)?.defaultEffort;
  const globalEffortOptions = effortOptions(selectedModels, selectedModel, effort);

  const updateModel = (name: string, value: string, tier?: ModelTier, field: keyof TierDraft = 'model'): void => {
    setSaved(false);
    setDraft((previous) => {
      const current = previous[name]!;
      return { ...previous, [name]: tier === undefined
        ? { ...current, defaultModel: value }
        : {
            ...current,
            modelTiers: {
              ...current.modelTiers,
              [tier]: { ...(ownValue(current.modelTiers, tier) ?? { model: '', effort: '' }), [field]: value },
            },
          } };
    });
  };

  const addTier = (): void => {
    const name = newTier.trim();
    if (!TIER_NAME.test(name)) {
      setTierError('Use lowercase letters, digits, hyphens or underscores; start with a letter.');
      return;
    }
    if (tierNames.includes(name)) {
      setTierError(`Tier ${name} already exists.`);
      return;
    }
    setTierNames(orderedTierNames([...tierNames, name]));
    setRemovedTiers((current) => current.filter((tier) => tier !== name));
    setDraft((previous) => Object.fromEntries(Object.entries(previous).map(([backend, value]) => [backend, {
      ...value,
      modelTiers: { ...value.modelTiers, [name]: ownValue(value.modelTiers, name) ?? { model: '', effort: '' } },
    }])));
    setNewTier('');
    setTierError(undefined);
    setSaved(false);
  };

  const removeTier = (tier: string): void => {
    setTierNames((current) => current.filter((name) => name !== tier));
    if (settings.modelTiers.includes(tier)) {
      setRemovedTiers((current) => [...new Set([...current, tier])]);
    }
    setSaved(false);
  };

  const submit = (): void => {
    setSaving(true);
    setSaved(false);
    setError(undefined);
    saveSettings({
      ...(agent === settings.agent.value ? {} : { agent }),
      // Пустая модель — снятие значения (`null`), а не пустая строка: модель
      // тогда берётся у бэкенда, и записать вместо неё пустоту значило бы
      // сломать следующий прогон вместо возврата к умолчанию.
      ...(modelChanged ? { model: model.trim() || null } : {}),
      ...(effortChanged ? { effort: effort.trim() || null } : {}),
      ...connectPatch(connect),
      ...(removedTiers.length === 0 ? {} : { removeModelTiers: removedTiers }),
      ...(Object.keys(backendPatch).length === 0 ? {} : { backends: backendPatch }),
    }).then((data) => { adopt(data); setSaved(true); })
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setSaving(false));
  };

  const toggleConnect = (name: string, on: boolean): void => {
    const next = new Set(connect);
    if (on) next.add(name);
    else next.delete(name);
    setConnect(next);
    setSaved(false);
  };

  const defaultTab = (
    <Card>
      <CardHeader>
        <CardTitle>Defaults for all projects</CardTitle>
        <CardDescription>
          Used when a pipeline, job or step does not set <code>agent</code>, <code>model</code> or <code>effort</code>.
          Written to <span className="mono">{settings.file}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="agent-field">
          <Label htmlFor="default-agent" className="agent-field-label">agent</Label>
          <div className="agent-field-body">
            {/* Пустого пункта в списке нет: `defaults.agent` снятию не подлежит. */}
            <Select value={agent} onValueChange={(value) => { setAgent(value); setSaved(false); }}>
              <SelectTrigger id="default-agent" className="agent-select">
                <SelectValue placeholder="not set" />
              </SelectTrigger>
              <SelectContent>
                {settings.backends.map((backend) => (
                  <SelectItem key={backend.name} value={backend.name}
                    disabled={!selectableAgent(backend, connect)}>
                    {backend.name}{!backend.available ? ' — plugin not connected' : !backend.enabled ? ' — disabled' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="small dim">{settings.agent.source}</span>
          </div>
        </div>

        <div className="agent-field">
          <Label htmlFor="default-model" className="agent-field-label mono">model</Label>
          <div className="agent-field-body">
            <Input
              id="default-model"
              className="mono"
              value={model}
              placeholder={selected?.defaultModel ?? 'backend model'}
              onChange={(event) => { setModel(event.target.value); setSaved(false); }}
            />
            <span className="small dim">
              {settings.model.value === undefined
                ? `not set — a step without its own model gets the backend model${selected?.defaultModel === undefined ? '' : `: ${selected.defaultModel}`}`
                : settings.model.source}
            </span>
            <p className="note dim">
              The value applies only to steps that do not declare a model themselves — neither in the step, nor in
              the job, nor in the pipeline defaults.{' '}
              <ScopeNote pipelines={pipelines} error={pipelinesError} settingsFile={settings.file} />
            </p>
          </div>
        </div>

        <ModelField
          id="default-effort"
          label="effort"
          value={effort}
          placeholder={selectedModelDefaultEffort === undefined ? 'model default' : `model default: ${selectedModelDefaultEffort}`}
          sourceNote={`${settings.effort.source}. An empty field lets the selected model and CLI choose.`}
          options={globalEffortOptions}
          knownValues={selectedModels.find((option) => option.name === selectedModel)?.efforts?.map((item) => item.name) ?? []}
          onChange={(value) => { setEffort(value); setSaved(false); }}
        />

        {settings.model.value === undefined ? null : (
          <Alert variant="warning" className="agent-model-warning">
            A global <code>model</code> override <span className="mono">{settings.model.value}</span> ({settings.model.source}) takes
            precedence over tiers and per-agent models. Clear the model field above and save to remove it.
          </Alert>
        )}
      </CardContent>
    </Card>
  );

  const backendsTab = (
    <div className="agent-cards">
      {settings.backends.map((backend) => {
        const discovery = models?.backends[backend.name];
        const reason = discovery === undefined
          ? (modelsError ?? 'Listing models…')
          : unavailableReason(discovery);
        return (
          <Card key={backend.name} className="agent-card">
            <CardHeader>
              <div className="agent-card-head">
                <CardTitle>{backend.name}</CardTitle>
                {backend.name === settings.agent.value ? <Badge variant="success">default</Badge> : null}
                {!backend.available ? <Badge>plugin not connected</Badge> : !backend.enabled ? <Badge>disabled</Badge> : null}
                {discovery?.status === 'ok' ? <Badge variant="success">{discovery.models.length} models listed</Badge> : null}
              </div>
              {reason === undefined ? null : <CardDescription>{reason}</CardDescription>}
            </CardHeader>
            <CardContent>
              <div className="ctx">$ {backend.command}</div>
              <div className="ctx">
                {backend.defaultModel === undefined
                  ? 'backend model: the agent’s built-in model'
                  : `backend model: ${backend.defaultModel} (${backend.defaultModelSource})`}
              </div>
              {connectOffered(backend) ? (
                <label className="check agent-connect">
                  <input type="checkbox" checked={connect.has(backend.name)} onChange={(event) => toggleConnect(backend.name, event.target.checked)} />
                  {' '}Connect {backend.name}
                  <span className="small dim">— adds the adapter shipped with Burnex; the CLI (<code>{backend.command}</code>) must be installed and signed in separately</span>
                </label>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );

  const tiersTab = (
    <>
      <p className="small dim agent-note">
        <code>agent</code>, <code>model</code>, <code>effort</code> and <code>model_tier</code> are inherited independently: step → job → pipeline → settings.
        A tier selects its model and optional effort together. An explicit <code>model</code> disconnects the tier effort; an explicit <code>effort</code> wins.
        The dropdown lists what the agent’s CLI reports and is not exhaustive — a typed name is saved as is.
        Lists are read once and kept while the daemon runs; after installing an agent or changing its command, reload them.
      </p>

      <Card className="tier-manager">
        <CardHeader>
          <CardTitle>Shared tiers</CardTitle>
          <CardDescription>
            One ordered set is shown for every agent. A custom tier may be mapped for only the agents that need it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="tier-list">
            {tierNames.map((tier) => (
              <span className="tier-chip" key={tier}>
                <Badge variant={(MODEL_TIERS as readonly string[]).includes(tier) ? 'secondary' : 'default'}>{tier}</Badge>
                {(MODEL_TIERS as readonly string[]).includes(tier) ? null : (
                  <Button variant="ghost" size="sm" onClick={() => removeTier(tier)} aria-label={`Remove tier ${tier}`}>Remove</Button>
                )}
              </span>
            ))}
          </div>
          <div className="tier-add">
            <Input
              value={newTier}
              placeholder="review"
              aria-label="New tier name"
              onChange={(event) => { setNewTier(event.target.value); setTierError(undefined); }}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTier(); } }}
            />
            <Button type="button" variant="outline" onClick={addTier}>Add tier</Button>
          </div>
          {tierError === undefined ? null : <span className="small tier-error">{tierError}</span>}
        </CardContent>
      </Card>

      <div className="agent-cards">
        {settings.backends.map((backend) => {
          const discovery = models?.backends[backend.name];
          const listed: readonly ModelOption[] = discovery?.status === 'ok' ? discovery.models : [];
          const current = draft[backend.name]!;
          const options = modelOptions(listed, [
            backend.defaultModel,
            current.defaultModel,
            ...tierNames.map((tier) => ownValue(backend.modelTiers, tier)?.model),
          ]);

          return (
            <Card key={backend.name} className="agent-card">
              <CardHeader>
                <div className="agent-card-head">
                  <CardTitle>{backend.name}</CardTitle>
                  {!backend.available ? <Badge>plugin not connected</Badge> : !backend.enabled ? <Badge>disabled</Badge> : null}
                </div>
              </CardHeader>
              <CardContent>
                <ModelField
                  id={`agent-${backend.name}-model`}
                  label="default model"
                  value={current.defaultModel}
                  placeholder="agent’s built-in model"
                  sourceNote={`${backend.defaultModelSource}. An empty field removes the override.`}
                  options={options}
                  knownValues={listed.map((option) => option.name)}
                  onChange={(value) => updateModel(backend.name, value)}
                />
                {tierNames.map((tier) => {
                  const selection = ownValue(current.modelTiers, tier) ?? { model: '', effort: '' };
                  const listedModel = listed.find((option) => option.name === selection.model.trim());
                  return (
                    <div className="tier-config" key={tier}>
                      <ModelField
                        id={`agent-${backend.name}-${tier}-model`}
                        label={`${tier} model`}
                        value={selection.model}
                        placeholder={current.defaultModel.trim() || 'default model'}
                        sourceNote={ownValue(backend.modelTierSources, tier) ?? 'not set — falls back to the default model'}
                        options={options}
                        knownValues={listed.map((option) => option.name)}
                        onChange={(value) => updateModel(backend.name, value, tier, 'model')}
                      />
                      <ModelField
                        id={`agent-${backend.name}-${tier}-effort`}
                        label="effort"
                        value={selection.effort}
                        placeholder={listedModel?.defaultEffort === undefined ? 'model default' : `model default: ${listedModel.defaultEffort}`}
                        sourceNote={ownValue(backend.modelTierEffortSources, tier) ?? 'not set — the selected model chooses its default'}
                        options={effortOptions(listed, selection.model, selection.effort)}
                        knownValues={listedModel?.efforts?.map((item) => item.name) ?? []}
                        onChange={(value) => updateModel(backend.name, value, tier, 'effort')}
                      />
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );

  return (
    <>
      {header}
      <Tabs value={activeTab} onValueChange={selectTab}>
        <TabsList aria-label="Agent settings">
          <TabsTrigger value="default">Default</TabsTrigger>
          <TabsTrigger value="backends">Backends</TabsTrigger>
          <TabsTrigger value="tiers">Tiers</TabsTrigger>
          <TabsTrigger value="policy">Policy</TabsTrigger>
        </TabsList>

        {/* Один `fieldset` на три вкладки одного файла: `disabled` на время записи
            гасит поля всех трёх разом, а черновик живёт выше вкладок. */}
        <fieldset className="agent-settings" disabled={saving}>
          <TabsContent value="default">{defaultTab}</TabsContent>
          <TabsContent value="backends">{backendsTab}</TabsContent>
          <TabsContent value="tiers">{tiersTab}</TabsContent>
          {activeTab === 'policy' ? null : (
            <>
              <div className="agent-actions">
                <Button disabled={!dirty || !canSelect || draftProblem !== undefined} onClick={submit}>{saving ? 'Saving…' : 'Save'}</Button>
                {dirty ? <Button variant="ghost" size="sm" onClick={() => { adopt(settings); setSaved(false); setError(undefined); }}>Discard changes</Button> : null}
                {saved && !dirty ? <span role="status" className="small dim">Saved</span> : null}
                {dirty && activeTab !== 'tiers' && (removedTiers.length > 0 || addedTiers.length > 0 || Object.keys(backendPatch).length > 0) ? (
                  <span className="small dim">includes unsaved changes on the Tiers tab</span>
                ) : null}
              </div>
              {draftProblem === undefined ? null : <Alert variant="warning">{draftProblem}</Alert>}
              {error === undefined ? null : <Alert variant="destructive">{error}</Alert>}
            </>
          )}
        </fieldset>

        <TabsContent value="policy">
          <AgentsPolicy settings={settings} pipelines={pipelines} error={pipelinesError} onPipelines={setPipelines} />
        </TabsContent>
      </Tabs>
    </>
  );
}
