import { BurnexError } from '../../../kernel/errors.js';
import { DEFAULT_PROFILE, describeKnownAgents, type AgentProfile } from '../config/agentProfiles.js';
import type { AgentSelectionConfig, SelectionField } from '../config/agentSelections.js';
import { isForeignModel, modelOwners, type ModelTier } from '../config/modelTiers.js';
import type { Config } from '../config/resolve.js';
import type { AgentPolicy } from '../config/schema.js';
import { backendsKnowingModel } from '../run/budget/priceCatalog.js';
import type { AgentOrigin, EffortOrigin, ModelOrigin } from './model.js';

/**
 * Выбор агента, модели и effort агентского шага по слоям, упорядоченным
 * политикой (`agent-policy-and-pipeline-agents`, design.md, решения 3 и 4).
 * Функция чистая: не читает файлов и не запускает процессов — раскрытие
 * зовут линт, витрина и `burnex config`, и результат обязан зависеть только
 * от документа и конфигурации.
 */

export type ChoiceLayer = 'step' | 'job' | 'pipeline' | 'config' | 'pipeline_agents' | 'step_agents';

/**
 * Ранг слоя, от слабого к сильному. Ранги двух политик в одну шкалу не
 * сводятся — это два разных порядка, а не сдвиг одного.
 */
const RANK: Record<AgentPolicy, Record<ChoiceLayer, number>> = {
  force: { config: 1, pipeline_agents: 2, step_agents: 3, pipeline: 4, job: 5, step: 6 },
  fallback: { pipeline: 1, config: 2, pipeline_agents: 3, job: 4, step: 5, step_agents: 6 },
};

export function layerRank(policy: AgentPolicy, layer: ChoiceLayer): number {
  return RANK[policy][layer];
}

type DocumentLayer = 'step' | 'job' | 'pipeline';

/**
 * Профиль, названный полем `agent` слоя (`agent-profiles`, design.md,
 * решение 3), и какие поля он дописал в этот слой: только те, что слой не
 * объявил сам. Ранги и правила выбора к дописанному слою применяются без
 * изменений — профиль лишь «дописывает» слой.
 */
export interface ProfileUse {
  readonly profile: AgentProfile;
  /** Профиль дал слою выбор модели (`model` либо `model_tier`). */
  readonly model: boolean;
  /** Профиль дал слою `effort`. */
  readonly effort: boolean;
}

/**
 * Профиль по имени: объявленный в `agents`, встроенный `default` — те же
 * `defaults.agent/model/effort` — либо `undefined`, когда имя — бэкенд, то
 * есть неявный профиль `{ backend: <имя> }` без модели, effort и контекста.
 */
export function lookupProfile(config: Config, name: string): AgentProfile | undefined {
  if (name !== DEFAULT_PROFILE) return Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
  const base = config.defaults.agent === DEFAULT_PROFILE ? undefined : lookupProfile(config, config.defaults.agent);
  const model = config.defaults.model ?? base?.model;
  const modelTier = config.defaults.model === undefined ? base?.modelTier : undefined;
  const effort = config.defaults.effort ?? base?.effort;
  return {
    name: DEFAULT_PROFILE,
    backend: base?.backend ?? config.defaults.agent,
    ...(model === undefined ? {} : { model }),
    ...(modelTier === undefined ? {} : { modelTier }),
    ...(effort === undefined ? {} : { effort }),
    context: base?.context ?? [],
    file: base?.file ?? 'defaults.agent',
  };
}

/** Объявления одного слоя выбора, как их видит раскрытие профиля. */
export interface LayerDeclaration {
  readonly agent: string | undefined;
  readonly model: string | undefined;
  readonly tier: ModelTier | undefined;
  readonly effort: string | undefined;
}

/**
 * Раскрыть профиль, названный слоем: агент — `backend` профиля, его модель
 * или уровень и effort ложатся в поля, которые слой не объявил сам. Выбор
 * модели слоя — целое: объявленная слоем `model` закрывает и `model_tier`
 * профиля, и наоборот.
 */
export function applyProfile(
  config: Config,
  layer: LayerDeclaration,
): { readonly layer: LayerDeclaration; readonly use?: ProfileUse } {
  const profile = layer.agent === undefined ? undefined : lookupProfile(config, layer.agent);
  if (profile === undefined) return { layer };
  const fillModel = layer.model === undefined && layer.tier === undefined &&
    (profile.model !== undefined || profile.modelTier !== undefined);
  const fillEffort = layer.effort === undefined && profile.effort !== undefined;
  return {
    layer: {
      agent: profile.backend,
      model: fillModel ? profile.model : layer.model,
      tier: fillModel ? profile.modelTier : layer.tier,
      effort: fillEffort ? profile.effort : layer.effort,
    },
    use: { profile, model: fillModel, effort: fillEffort },
  };
}

/** То же для записи выбора пользователя: дописанные поля получают файл, назвавший профиль. */
function applyEntryProfile(
  config: Config,
  entry: AgentSelectionConfig | undefined,
): { readonly entry: AgentSelectionConfig | undefined; readonly use?: ProfileUse } {
  if (entry?.agent === undefined) return { entry };
  const { layer, use } = applyProfile(config, {
    agent: entry.agent.value,
    model: entry.model?.value,
    tier: entry.modelTier?.value as ModelTier | undefined,
    effort: entry.effort?.value,
  });
  if (use === undefined) return { entry };
  const file = entry.agent.file;
  const field = (value: string | undefined, own: SelectionField | undefined): SelectionField | undefined =>
    own ?? (value === undefined ? undefined : { value, file });
  const model = field(layer.model, entry.model);
  const modelTier = field(layer.tier, entry.modelTier);
  const effort = field(layer.effort, entry.effort);
  return {
    entry: {
      agent: { value: layer.agent as string, file },
      ...(model === undefined ? {} : { model }),
      ...(modelTier === undefined ? {} : { modelTier }),
      ...(effort === undefined ? {} : { effort }),
    },
    use,
  };
}

/** То, что документ объявил для шага на уровнях работы и корня (уровень шага — в `RawStepChoice`). */
export interface DocumentChoice {
  readonly agent: string | undefined;
  readonly agentLayer: 'job' | 'pipeline' | undefined;
  readonly model: string | undefined;
  readonly modelLayer: 'job' | 'pipeline' | undefined;
  readonly effort: string | undefined;
  readonly effortLayer: 'job' | 'pipeline' | undefined;
  readonly tier: ModelTier | undefined;
  readonly tierLayer: 'job' | 'pipeline';
  /** Работа сама объявила `model` либо `model_tier` — для уровня выбора документа. */
  readonly jobDeclaresModel: boolean;
  /**
   * Профили, названные работой и корнем документа. Поля выше уже раскрыты
   * (`applyProfile` по каждому слою до склейки): склеенное значение теряет,
   * какой слой что объявил сам.
   */
  readonly profiles?: { readonly job?: ProfileUse; readonly pipeline?: ProfileUse };
}

export interface StepLevelChoice {
  readonly agent: string | undefined;
  readonly model: string | undefined;
  readonly tier: ModelTier | undefined;
  readonly effort: string | undefined;
}

export type EntryField = 'agent' | 'model' | 'effort';
export type FieldOutcome = { readonly won: true } | { readonly won: false; readonly lostTo: ChoiceLayer };
export type EntryOutcome = Partial<Record<EntryField, FieldOutcome>>;

export interface AgentChoice {
  readonly agent: string;
  /** Профиль, давший агента шага, — его контекст становится уровнем «профиль». */
  readonly profile?: AgentProfile;
  readonly agentOrigin: AgentOrigin;
  readonly model: string | undefined;
  readonly modelOrigin: ModelOrigin;
  readonly effort: string | undefined;
  readonly effortOrigin: EffortOrigin;
  /** Чем кончилось каждое поле записей пользователя: победило или кому проиграло. */
  readonly outcomes: {
    readonly pipeline_agents: EntryOutcome;
    readonly step_agents: EntryOutcome;
  };
}

interface Candidate<T> {
  readonly layer: ChoiceLayer;
  readonly value: T;
  readonly file?: string;
}

function strongest<T>(policy: AgentPolicy, candidates: ReadonlyArray<Candidate<T> | undefined>): Candidate<T> | undefined {
  let best: Candidate<T> | undefined;
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    if (best === undefined || layerRank(policy, candidate.layer) > layerRank(policy, best.layer)) best = candidate;
  }
  return best;
}

function entryField<T extends string>(
  layer: 'pipeline_agents' | 'step_agents',
  field: { readonly value: T; readonly file: string } | undefined,
): Candidate<T> | undefined {
  return field === undefined ? undefined : { layer, value: field.value, file: field.file };
}

function agentOriginOf(candidate: Candidate<string>): AgentOrigin {
  return candidate.layer === 'pipeline_agents' || candidate.layer === 'step_agents'
    ? { layer: candidate.layer, file: candidate.file ?? '' }
    : { layer: candidate.layer as 'step' | 'job' | 'pipeline' | 'config' };
}

export interface ResolveAgentChoiceInput {
  readonly config: Config;
  readonly step: StepLevelChoice;
  readonly doc: DocumentChoice;
  readonly pipelineEntry: AgentSelectionConfig | undefined;
  readonly stepEntry: AgentSelectionConfig | undefined;
}

/** Tier, из которого пришла модель: его effort едет вместе с ней. */
interface TierBundle {
  readonly tier: ModelTier;
  readonly layer: ChoiceLayer;
  readonly file?: string;
  readonly effort: string | undefined;
}

interface Resolved {
  readonly model: string | undefined;
  readonly origin: ModelOrigin;
  readonly bundle: TierBundle | undefined;
}

/** Выбор модели, сделанный слоем: его `model`, а если её нет — `model_tier`. */
type ModelPick =
  | { readonly kind: 'model'; readonly value: string; readonly layer: ChoiceLayer; readonly file?: string }
  | { readonly kind: 'tier'; readonly value: ModelTier; readonly layer: ChoiceLayer; readonly file?: string };

export function resolveAgentChoice(input: ResolveAgentChoiceInput): AgentChoice {
  const { config, doc } = input;
  const policy = config.agentPolicy;
  const rank = (layer: ChoiceLayer): number => layerRank(policy, layer);

  // --- Профили. Каждый слой, назвавший профиль, раскрывается до выбора: дальше
  // работают прежние правила рангов и замены (design.md, решение 3).
  const stepProfile = applyProfile(config, input.step);
  const step = stepProfile.layer;
  const pipelineProfile = applyEntryProfile(config, input.pipelineEntry);
  const pipelineEntry = pipelineProfile.entry;
  const stepEntryProfile = applyEntryProfile(config, input.stepEntry);
  const stepEntry = stepEntryProfile.entry;
  // Слой `config` — объявленное пользователем `defaults.*`. Встроенное
  // `defaults.agent` — имя бэкенда и профилем не раскрывается.
  const configProfile = config.defaults.agentFromUser
    ? applyProfile(config, { agent: config.defaults.agent, model: config.defaults.model, tier: undefined, effort: config.defaults.effort })
    : { layer: { agent: undefined, model: config.defaults.model, tier: undefined, effort: config.defaults.effort } };
  const configLayer = configProfile.layer;
  const profiles: Partial<Record<ChoiceLayer, ProfileUse>> = {
    ...(stepProfile.use === undefined ? {} : { step: stepProfile.use }),
    ...(doc.profiles?.job === undefined ? {} : { job: doc.profiles.job }),
    ...(doc.profiles?.pipeline === undefined ? {} : { pipeline: doc.profiles.pipeline }),
    ...(configProfile.use === undefined ? {} : { config: configProfile.use }),
    ...(pipelineProfile.use === undefined ? {} : { pipeline_agents: pipelineProfile.use }),
    ...(stepEntryProfile.use === undefined ? {} : { step_agents: stepEntryProfile.use }),
  };

  // --- Агент. Встроенное умолчание `defaults.agent` — не выбор пользователя:
  // оно слабее всего, как и было, поэтому слоем `config` считается только
  // объявленное файлом или флагом.
  const agentWinner = strongest<string>(policy, [
    step.agent === undefined ? undefined : { layer: 'step', value: step.agent },
    doc.agent === undefined || doc.agentLayer === undefined ? undefined : { layer: doc.agentLayer, value: doc.agent },
    configLayer.agent === undefined ? undefined : { layer: 'config', value: configLayer.agent },
    entryField('pipeline_agents', pipelineEntry?.agent),
    entryField('step_agents', stepEntry?.agent),
  ]);
  const agent = agentWinner?.value ?? config.defaults.agent;
  const agentProfile = agentWinner === undefined ? undefined : profiles[agentWinner.layer];
  const agentOrigin: AgentOrigin = agentWinner === undefined
    ? { layer: 'config' }
    : { ...agentOriginOf(agentWinner), ...(agentProfile === undefined ? {} : { profile: agentProfile.profile.name }) };
  if (agentProfile !== undefined && !Object.hasOwn(config.backends, agentProfile.profile.backend)) {
    throw new BurnexError(
      `Профиль ${agentProfile.profile.name} называет бэкенд ${agentProfile.profile.backend}, которого нет среди бэкендов`,
      {
        file: agentProfile.profile.file,
        at: `agents.${agentProfile.profile.name}.backend`,
        hint: describeKnownAgents(config.agents, Object.keys(config.backends)),
      },
    );
  }
  const agentFromUser = agentWinner !== undefined && (
    agentWinner.layer === 'config' || agentWinner.layer === 'pipeline_agents' || agentWinner.layer === 'step_agents'
  );
  const backend = config.backends[agent];

  // --- Модель. Выбор документа — явная `model` (любого уровня бьёт tier
  // любого уровня, прежнее правило) либо tier; у него есть уровень — самый
  // близкий к шагу слой, объявивший то или другое.
  const documentModel: ModelPick | undefined =
    step.model !== undefined
      ? { kind: 'model', value: step.model, layer: 'step' }
      : doc.model !== undefined && doc.modelLayer !== undefined
        ? { kind: 'model', value: doc.model, layer: doc.modelLayer }
        : undefined;
  const documentTier: ModelPick | undefined =
    step.tier !== undefined
      ? { kind: 'tier', value: step.tier, layer: 'step' }
      : doc.tier !== undefined
        ? { kind: 'tier', value: doc.tier, layer: doc.tierLayer }
        : undefined;
  const documentChoice = documentModel ?? documentTier;
  const documentLevel: DocumentLayer | undefined = documentChoice === undefined
    ? undefined
    : step.model !== undefined || step.tier !== undefined
      ? 'step'
      : doc.jobDeclaresModel
        ? 'job'
        : 'pipeline';

  const pickOf = (layer: 'pipeline_agents' | 'step_agents', entry: AgentSelectionConfig | undefined): ModelPick | undefined => {
    if (entry?.model !== undefined) return { kind: 'model', value: entry.model.value, layer, file: entry.model.file };
    if (entry?.modelTier !== undefined) return { kind: 'tier', value: entry.modelTier.value, layer, file: entry.modelTier.file };
    return undefined;
  };
  const userPicks: ModelPick[] = [
    configLayer.model === undefined
      ? configLayer.tier === undefined ? undefined : ({ kind: 'tier', value: configLayer.tier, layer: 'config' } as const)
      : ({ kind: 'model', value: configLayer.model, layer: 'config' } as const),
    pickOf('pipeline_agents', pipelineEntry),
    pickOf('step_agents', stepEntry),
  ].filter((pick): pick is ModelPick => pick !== undefined);

  // Слой пользователя заменяет выбор документа целиком, но только если стоит
  // выше его уровня; без выбора документа побеждает сильнейший из них.
  const userWinner = userPicks
    .filter((pick) => documentLevel === undefined || rank(pick.layer) > rank(documentLevel))
    .reduce<ModelPick | undefined>((best, pick) => (best === undefined || rank(pick.layer) > rank(best.layer) ? pick : best), undefined);

  const viaTier = (pick: ModelPick & { kind: 'tier' }, dropped?: { model: string; layer: DocumentLayer }): Resolved => {
    const selection = backend?.modelTiers?.[pick.value];
    const origin = {
      layer: 'tier' as const, backend: agent, tier: pick.value,
      tierLayer: pick.layer as 'pipeline' | 'job' | 'step' | 'config' | 'pipeline_agents' | 'step_agents',
      ...(pick.file === undefined ? {} : { file: pick.file }),
    };
    if (selection === undefined) {
      return {
        model: backend?.defaultModel,
        origin: { ...origin, fallback: true, ...(dropped === undefined ? {} : { dropped }) },
        bundle: undefined,
      };
    }
    return {
      model: selection.model,
      origin: { ...origin, ...(dropped === undefined ? {} : { dropped }) },
      bundle: { tier: pick.value, layer: pick.layer, ...(pick.file === undefined ? {} : { file: pick.file }), effort: selection.effort },
    };
  };
  const viaModel = (pick: ModelPick & { kind: 'model' }): Resolved => ({
    model: pick.value,
    origin: pick.layer === 'pipeline_agents' || pick.layer === 'step_agents'
      ? { layer: pick.layer, file: pick.file ?? '' }
      : { layer: pick.layer as 'step' | 'job' | 'pipeline' | 'config' },
    bundle: undefined,
  });
  const viaBackendDefault = (dropped?: { model: string; layer: DocumentLayer }): Resolved => ({
    model: backend?.defaultModel,
    origin: {
      ...(backend?.defaultModel !== undefined ? { layer: 'backend' as const, backend: agent } : { layer: 'none' as const }),
      ...(dropped === undefined ? {} : { dropped }),
    },
    bundle: undefined,
  });

  const resolved = ((): Resolved => {
    if (userWinner !== undefined) return userWinner.kind === 'model' ? viaModel(userWinner) : viaTier(userWinner);
    if (documentModel !== undefined) {
      const owners = agentFromUser
        ? modelOwners(documentModel.value, config.backends, backendsKnowingModel(documentModel.value))
        : undefined;
      if (owners === undefined || !isForeignModel(agent, owners)) return viaModel(documentModel as ModelPick & { kind: 'model' });
      // Чужая агенту модель документа: цепочка идёт дальше — ближайший по
      // рангу tier, назначенный у этого агента, затем умолчание бэкенда.
      const dropped = { model: documentModel.value, layer: documentModel.layer as DocumentLayer };
      const assigned = [
        step.tier === undefined ? undefined : ({ kind: 'tier', value: step.tier, layer: 'step' } as const),
        doc.tier === undefined ? undefined : ({ kind: 'tier', value: doc.tier, layer: doc.tierLayer } as const),
        configLayer.tier === undefined ? undefined : ({ kind: 'tier', value: configLayer.tier, layer: 'config' } as const),
        pickOf('pipeline_agents', pipelineEntry),
        pickOf('step_agents', stepEntry),
      ]
        .filter((pick): pick is ModelPick & { kind: 'tier' } => pick !== undefined && pick.kind === 'tier')
        .sort((x, y) => rank(y.layer) - rank(x.layer))
        .find((pick) => backend?.modelTiers?.[pick.value] !== undefined);
      return assigned === undefined ? viaBackendDefault(dropped) : viaTier(assigned, dropped);
    }
    if (documentTier !== undefined && documentTier.kind === 'tier') {
      // Устаревшее и сохранённое: `defaults.model` конфигурации бьёт tier
      // документа при `force` (docs/pipeline-format.md). При `fallback` оно —
      // обычный слой пользователя и до сюда не доходит.
      if (policy === 'force' && configLayer.model !== undefined) {
        return viaModel({ kind: 'model', value: configLayer.model, layer: 'config' });
      }
      return viaTier(documentTier);
    }
    return viaBackendDefault();
  })();
  const { model, bundle } = resolved;
  // Происхождение модели называет профиль, если выбор модели слою дописал он.
  const modelLayerOf = (origin: ModelOrigin | EffortOrigin): ChoiceLayer | undefined =>
    origin.layer === 'tier' ? origin.tierLayer : origin.layer === 'backend' || origin.layer === 'none' ? undefined : origin.layer;
  const modelProfile = ((): ProfileUse | undefined => {
    const layer = modelLayerOf(resolved.origin);
    const use = layer === undefined ? undefined : profiles[layer];
    return use?.model === true ? use : undefined;
  })();
  const modelOrigin: ModelOrigin = modelProfile === undefined
    ? resolved.origin
    : { ...resolved.origin, profile: modelProfile.profile.name };

  // --- Effort. Явный effort побеждает по рангу; effort tier едет вместе с
  // моделью: у tier документа он слабее любого явного (прежнее правило), у
  // tier записи пользователя стоит на ранге его слоя.
  const effortWinner = strongest<string>(policy, [
    step.effort === undefined ? undefined : { layer: 'step', value: step.effort },
    doc.effort === undefined || doc.effortLayer === undefined ? undefined : { layer: doc.effortLayer, value: doc.effort },
    configLayer.effort === undefined ? undefined : { layer: 'config', value: configLayer.effort },
    entryField('pipeline_agents', pipelineEntry?.effort),
    entryField('step_agents', stepEntry?.effort),
  ]);
  const bundleRank = bundle === undefined
    ? undefined
    : bundle.layer === 'pipeline_agents' || bundle.layer === 'step_agents' || bundle.layer === 'config'
      ? rank(bundle.layer)
      : 0;
  const bundleWins = bundle !== undefined && bundle.effort !== undefined && bundleRank !== undefined &&
    (effortWinner === undefined || rank(effortWinner.layer) < bundleRank);

  let effort: string | undefined;
  let effortOrigin: EffortOrigin;
  if (bundleWins && bundle !== undefined) {
    effort = bundle.effort;
    effortOrigin = {
      layer: 'tier', backend: agent, tier: bundle.tier,
      tierLayer: bundle.layer as 'pipeline' | 'job' | 'step' | 'config' | 'pipeline_agents' | 'step_agents',
      ...(bundle.file === undefined ? {} : { file: bundle.file }),
      ...(profiles[bundle.layer]?.model === true ? { profile: profiles[bundle.layer]!.profile.name } : {}),
    };
  } else if (effortWinner !== undefined) {
    effort = effortWinner.value;
    const via = profiles[effortWinner.layer]?.effort === true ? { profile: profiles[effortWinner.layer]!.profile.name } : {};
    effortOrigin = effortWinner.layer === 'pipeline_agents' || effortWinner.layer === 'step_agents'
      ? { layer: effortWinner.layer, file: effortWinner.file ?? '', ...via }
      : { layer: effortWinner.layer as 'step' | 'job' | 'pipeline' | 'config', ...via };
  } else {
    effort = undefined;
    effortOrigin = { layer: 'none' };
  }

  // --- Что стало с записями пользователя: победило поле или кому проиграло.
  const finalModelLayer: ChoiceLayer | undefined = modelLayerOf(modelOrigin);
  const finalEffortLayer: ChoiceLayer | undefined = effortOrigin.layer === 'tier'
    ? effortOrigin.tierLayer
    : effortOrigin.layer === 'none' ? undefined : effortOrigin.layer;

  const outcomeFor = (layer: 'pipeline_agents' | 'step_agents', entry: AgentSelectionConfig | undefined): EntryOutcome => {
    if (entry === undefined) return {};
    const out: Partial<Record<EntryField, FieldOutcome>> = {};
    const judge = (winner: ChoiceLayer | undefined): FieldOutcome =>
      winner === layer ? { won: true } : { won: false, lostTo: winner ?? 'config' };
    if (entry.agent !== undefined) out.agent = judge(agentOrigin.layer);
    if (entry.model !== undefined || entry.modelTier !== undefined) {
      // Замена отброшенной модели чужим tier этой же записи — её победа.
      out.model = judge(finalModelLayer);
    }
    if (entry.effort !== undefined) out.effort = judge(finalEffortLayer);
    return out;
  };

  return {
    agent,
    ...(agentProfile === undefined ? {} : { profile: agentProfile.profile }),
    agentOrigin,
    model,
    modelOrigin,
    effort,
    effortOrigin,
    outcomes: {
      pipeline_agents: outcomeFor('pipeline_agents', pipelineEntry),
      step_agents: outcomeFor('step_agents', stepEntry),
    },
  };
}
