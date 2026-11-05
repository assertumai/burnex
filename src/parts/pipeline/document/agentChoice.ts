import type { AgentSelectionConfig } from '../config/agentSelections.js';
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
  const { config, step, doc, pipelineEntry, stepEntry } = input;
  const policy = config.agentPolicy;
  const rank = (layer: ChoiceLayer): number => layerRank(policy, layer);

  // --- Агент. Встроенное умолчание `defaults.agent` — не выбор пользователя:
  // оно слабее всего, как и было, поэтому слоем `config` считается только
  // объявленное файлом или флагом.
  const agentWinner = strongest<string>(policy, [
    step.agent === undefined ? undefined : { layer: 'step', value: step.agent },
    doc.agent === undefined || doc.agentLayer === undefined ? undefined : { layer: doc.agentLayer, value: doc.agent },
    config.defaults.agentFromUser ? { layer: 'config', value: config.defaults.agent } : undefined,
    entryField('pipeline_agents', pipelineEntry?.agent),
    entryField('step_agents', stepEntry?.agent),
  ]);
  const agent = agentWinner?.value ?? config.defaults.agent;
  const agentOrigin: AgentOrigin = agentWinner === undefined ? { layer: 'config' } : agentOriginOf(agentWinner);
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
    config.defaults.model === undefined ? undefined : ({ kind: 'model', value: config.defaults.model, layer: 'config' } as const),
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
      tierLayer: pick.layer as 'pipeline' | 'job' | 'step' | 'pipeline_agents' | 'step_agents',
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
      if (policy === 'force' && config.defaults.model !== undefined) {
        return viaModel({ kind: 'model', value: config.defaults.model, layer: 'config' });
      }
      return viaTier(documentTier);
    }
    return viaBackendDefault();
  })();
  const { model, bundle } = resolved;
  const modelOrigin = resolved.origin;

  // --- Effort. Явный effort побеждает по рангу; effort tier едет вместе с
  // моделью: у tier документа он слабее любого явного (прежнее правило), у
  // tier записи пользователя стоит на ранге его слоя.
  const effortWinner = strongest<string>(policy, [
    step.effort === undefined ? undefined : { layer: 'step', value: step.effort },
    doc.effort === undefined || doc.effortLayer === undefined ? undefined : { layer: doc.effortLayer, value: doc.effort },
    config.defaults.effort === undefined ? undefined : { layer: 'config', value: config.defaults.effort },
    entryField('pipeline_agents', pipelineEntry?.effort),
    entryField('step_agents', stepEntry?.effort),
  ]);
  const bundleRank = bundle === undefined
    ? undefined
    : bundle.layer === 'pipeline_agents' || bundle.layer === 'step_agents'
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
      tierLayer: bundle.layer as 'pipeline' | 'job' | 'step' | 'pipeline_agents' | 'step_agents',
      ...(bundle.file === undefined ? {} : { file: bundle.file }),
    };
  } else if (effortWinner !== undefined) {
    effort = effortWinner.value;
    effortOrigin = effortWinner.layer === 'pipeline_agents' || effortWinner.layer === 'step_agents'
      ? { layer: effortWinner.layer, file: effortWinner.file ?? '' }
      : { layer: effortWinner.layer as 'step' | 'job' | 'pipeline' | 'config' };
  } else {
    effort = undefined;
    effortOrigin = { layer: 'none' };
  }

  // --- Что стало с записями пользователя: победило поле или кому проиграло.
  const finalModelLayer: ChoiceLayer | undefined = (() => {
    const origin = modelOrigin;
    if (origin.layer === 'tier') return origin.tierLayer;
    if (origin.layer === 'backend' || origin.layer === 'none') return undefined;
    return origin.layer;
  })();
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
