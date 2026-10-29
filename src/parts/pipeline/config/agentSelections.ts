import { describeSource, type Layer, type Source } from './merge.js';

/** Значение записи выбора вместе с файлом, который его дал. */
export interface SelectionField {
  readonly value: string;
  /** Файл конфигурации; для слоя не из файла — его описание (`describeSource`). */
  readonly file: string;
}

/**
 * Действующая запись выбора пользователя (`pipeline_agents`, `step_agents`):
 * слои слиты по листьям, и у каждого листа свой файл — запись глобального
 * файла может быть частично перекрыта проектным.
 */
export interface AgentSelectionConfig {
  readonly agent?: SelectionField;
  readonly model?: SelectionField;
  readonly modelTier?: SelectionField;
  readonly effort?: SelectionField;
}

export type PipelineAgents = Readonly<Record<string, AgentSelectionConfig>>;
/** Пайплайн → работа → шаг. */
export type StepAgents = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, AgentSelectionConfig>>>>>>;

const FIELDS = { agent: 'agent', model: 'model', model_tier: 'modelTier', effort: 'effort' } as const;
type RawField = keyof typeof FIELDS;

interface Leaf {
  readonly value: string;
  readonly source: Source;
}

function fileOf(source: Source): string {
  return source.kind === 'file' ? source.path : describeSource(source);
}

/**
 * Свернуть листья одной записи. `model` и `model_tier` по отдельности законны
 * в каждом файле, но слои могут развести их: глобальный выбрал `model`, а
 * проектный — `model_tier`. Выбор модели слоя — целое (design.md, решение 3),
 * поэтому побеждает пара ближнего слоя, а дальняя снимается.
 */
function collapse(leaves: ReadonlyMap<RawField, Leaf>, rank: ReadonlyMap<Source, number>): AgentSelectionConfig {
  const out: Record<string, SelectionField> = {};
  const model = leaves.get('model');
  const tier = leaves.get('model_tier');
  const dropModel = model !== undefined && tier !== undefined && (rank.get(tier.source) ?? 0) > (rank.get(model.source) ?? 0);
  const dropTier = model !== undefined && tier !== undefined && !dropModel;

  for (const [field, leaf] of leaves) {
    if ((field === 'model' && dropModel) || (field === 'model_tier' && dropTier)) continue;
    out[FIELDS[field]] = { value: leaf.value, file: fileOf(leaf.source) };
  }
  return out;
}

/**
 * Собрать записи `pipeline_agents` и `step_agents` из слитых значений. Ключи
 * записей не содержат точек (схема отказывает), поэтому путь разбирается по
 * сегментам без неоднозначности.
 */
export function buildAgentSelections(
  values: ReadonlyMap<string, unknown>,
  provenance: ReadonlyMap<string, Source>,
  layers: readonly Layer[],
): { readonly pipelineAgents: PipelineAgents; readonly stepAgents: StepAgents } {
  const rank = new Map<Source, number>();
  layers.forEach((layer, index) => rank.set(layer.source, index));

  const pipelineLeaves = new Map<string, Map<RawField, Leaf>>();
  const stepLeaves = new Map<string, { readonly path: readonly [string, string, string]; readonly leaves: Map<RawField, Leaf> }>();

  for (const [path, value] of values) {
    const segments = path.split('.');
    const root = segments[0];
    if (root !== 'pipeline_agents' && root !== 'step_agents') continue;
    const source = provenance.get(path);
    const field = segments[segments.length - 1] as RawField;
    if (typeof value !== 'string' || source === undefined || !(field in FIELDS)) continue;

    if (root === 'pipeline_agents' && segments.length === 3) {
      const key = segments[1] as string;
      const leaves = pipelineLeaves.get(key) ?? new Map<RawField, Leaf>();
      leaves.set(field, { value, source });
      pipelineLeaves.set(key, leaves);
    } else if (root === 'step_agents' && segments.length === 5) {
      const key = segments.slice(1, 4).join('.');
      const entry = stepLeaves.get(key) ?? {
        path: [segments[1], segments[2], segments[3]] as [string, string, string],
        leaves: new Map<RawField, Leaf>(),
      };
      entry.leaves.set(field, { value, source });
      stepLeaves.set(key, entry);
    }
  }

  const pipelineAgents: Record<string, AgentSelectionConfig> = {};
  for (const [name, leaves] of pipelineLeaves) pipelineAgents[name] = collapse(leaves, rank);

  const stepAgents: Record<string, Record<string, Record<string, AgentSelectionConfig>>> = {};
  for (const { path: [pipeline, job, step], leaves } of stepLeaves.values()) {
    const jobs = (stepAgents[pipeline] ??= {});
    const steps = (jobs[job] ??= {});
    steps[step] = collapse(leaves, rank);
  }

  return { pipelineAgents, stepAgents };
}
