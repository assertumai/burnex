import { describeSource } from '../config/merge.js';
import { modelOwners } from '../config/modelTiers.js';
import type { ResolvedConfig } from '../config/resolve.js';
import type {
  AgentEntryReason,
  AgentOrigin,
  EffortOrigin,
  ExpandedPipeline,
  ModelOrigin,
  UnusedAgentEntry,
} from '../document/model.js';
import { backendsKnowingModel } from '../run/budget/priceCatalog.js';
import { formatColumns } from '../../../kernel/cli/output.js';

/**
 * Часть отчёта `burnex config --pipeline`: итоговый выбор агента, модели и
 * effort каждого агентского шага с источником каждого значения и список
 * записей пользователя, не повлиявших ни на один шаг
 * (`agent-policy-and-pipeline-agents`, design.md, решение 7).
 */

const LAYER_TITLES: Record<string, string> = {
  step: 'шаг',
  job: 'работа',
  pipeline: 'пайплайн',
};

/** Слой конфигурации (`config`) подписывается файлом, давшим `defaults.<поле>`. */
function configFile(resolved: ResolvedConfig, key: string): string {
  const source = resolved.provenance.get(key);
  return source === undefined ? 'встроенное умолчание' : describeSource(source);
}

function entryLabel(layer: 'pipeline_agents' | 'step_agents', file: string): string {
  return `${layer} (${file})`;
}

function describeAgentOrigin(origin: AgentOrigin | undefined, resolved: ResolvedConfig): string {
  if (origin === undefined) return '—';
  if (origin.layer === 'pipeline_agents' || origin.layer === 'step_agents') return entryLabel(origin.layer, origin.file);
  if (origin.layer === 'config') return `defaults.agent (${configFile(resolved, 'defaults.agent')})`;
  return LAYER_TITLES[origin.layer] ?? origin.layer;
}

function describeModelOrigin(origin: ModelOrigin | undefined, resolved: ResolvedConfig): string {
  if (origin === undefined || origin.layer === 'none') return '—';
  switch (origin.layer) {
    case 'pipeline_agents':
    case 'step_agents':
      return entryLabel(origin.layer, origin.file);
    case 'config':
      return `defaults.model (${configFile(resolved, 'defaults.model')})`;
    case 'backend':
      return `default_model бэкенда ${origin.backend}`;
    case 'tier': {
      const via = origin.tierLayer === 'pipeline_agents' || origin.tierLayer === 'step_agents'
        ? entryLabel(origin.tierLayer, origin.file ?? '')
        : (LAYER_TITLES[origin.tierLayer] ?? origin.tierLayer);
      return `tier ${origin.tier} (${via})${origin.fallback === true ? ', у агента не назначен' : ''}`;
    }
    default:
      return LAYER_TITLES[origin.layer] ?? origin.layer;
  }
}

function describeEffortOrigin(origin: EffortOrigin | undefined, resolved: ResolvedConfig): string {
  if (origin === undefined || origin.layer === 'none') return '—';
  switch (origin.layer) {
    case 'pipeline_agents':
    case 'step_agents':
      return entryLabel(origin.layer, origin.file);
    case 'config':
      return `defaults.effort (${configFile(resolved, 'defaults.effort')})`;
    case 'tier': {
      const via = origin.tierLayer === 'pipeline_agents' || origin.tierLayer === 'step_agents'
        ? entryLabel(origin.tierLayer, origin.file ?? '')
        : (LAYER_TITLES[origin.tierLayer] ?? origin.tierLayer);
      return `tier ${origin.tier} (${via})`;
    }
    default:
      return LAYER_TITLES[origin.layer] ?? origin.layer;
  }
}

const LOST_TO: Record<string, string> = {
  step: 'шагу',
  job: 'работе',
  pipeline: 'корню документа',
  config: 'defaults',
  pipeline_agents: 'записи pipeline_agents',
  step_agents: 'записи step_agents',
};

function describeReason(entry: UnusedAgentEntry): string {
  const reason: AgentEntryReason = entry.reason;
  switch (reason.kind) {
    case 'lost':
      return `проиграла ${LOST_TO[reason.to] ?? reason.to} (политика ${reason.policy})`;
    case 'no_job': {
      const job = entry.key.split('.')[2];
      return `шага нет в пайплайне (работы ${job ?? '?'} нет)`;
    }
    case 'no_step':
      return 'шага нет в пайплайне';
    case 'not_agent':
      return 'шаг не агентский';
    case 'no_agent_steps':
      return 'в пайплайне нет агентских шагов';
  }
}

export function renderAgentsReport(resolved: ResolvedConfig, expanded: ExpandedPipeline): string[] {
  const { config } = resolved;
  const lines = ['', `Политика выбора агента: ${config.agentPolicy} (${configFile(resolved, 'agent_policy')})`];

  const rows: string[][] = [];
  for (const job of expanded.pipeline.jobs) {
    for (const step of job.steps) {
      if (step.kind !== 'agent') continue;
      const id = `${job.id}/${step.id}`;
      rows.push([
        id,
        step.agent,
        describeAgentOrigin(expanded.agentOrigins.get(id), resolved),
        step.model ?? '—',
        describeModelOrigin(expanded.modelOrigins.get(id), resolved),
        step.effort ?? '—',
        describeEffortOrigin(expanded.effortOrigins.get(id), resolved),
      ]);
      const dropped = expanded.modelOrigins.get(id)?.dropped;
      if (dropped !== undefined) {
        const owners = [...modelOwners(dropped.model, config.backends, backendsKnowingModel(dropped.model))].sort();
        rows.push(['', '', '', `↳ отброшена ${dropped.model} (${dropped.layer}): модель бэкенда ${owners.join(', ')}`, '', '', '']);
      }
    }
  }

  lines.push('');
  if (rows.length === 0) {
    lines.push('Агентских шагов в пайплайне нет');
  } else {
    lines.push(...formatColumns([['шаг', 'агент', 'источник', 'модель', 'источник', 'effort', 'источник'], ...rows]));
  }

  if (expanded.unusedAgentEntries.length > 0) {
    lines.push('', 'Записи без действия:');
    const entries = expanded.unusedAgentEntries.map((entry) => [
      `  ${entry.key}`,
      `— ${describeReason(entry)}`,
      entry.files.length === 0 ? '' : `(${entry.files.join(', ')})`,
    ]);
    lines.push(...formatColumns(entries));
  }
  return lines;
}
