import { BurnexError } from '../../../kernel/errors.js';
import { contributionOwner, type Registry } from '../../../kernel/registry.js';
import { DEFAULT_PROFILE, describeKnownAgents } from './agentProfiles.js';
import { resolveConfig, type Config } from './resolve.js';

/** Умолчания бэкендов из реестра — тем же слоем, что и при разрешении в точке входа. */
export function pluginDefaultsOf(registry: Registry | undefined): {
  pluginDefaults?: readonly { plugin: string; values: Record<string, unknown> }[];
} {
  if (registry === undefined) return {};
  const layers = registry.plugins.flatMap((plugin) => {
    const backends: Record<string, unknown> = {};
    for (const [name, contribution] of registry.backends) {
      if (contribution.defaults === undefined) continue;
      if (contributionOwner(registry, 'backends', name) !== plugin.name) continue;
      backends[name] = contribution.defaults;
    }
    return Object.keys(backends).length === 0 ? [] : [{ plugin: plugin.name, values: { backends } }];
  });
  return layers.length === 0 ? {} : { pluginDefaults: layers };
}

/**
 * Конфигурация со слоем флага `defaults.agent` (`run --agent`, `resume` по
 * `agent_override` манифеста). Слой тот же, что у `burnex config --agent`:
 * агент шага и работы документа, `pipeline_agents` и `step_agents` его
 * сильнее, поэтому шаги с явным агентом остаются при своём. Агент корня
 * документа сильнее только под `agent_policy: force`: под `fallback` он
 * уступает `defaults.agent` из любого источника, флагу тоже. Имя профиля
 * принимается наравне с именем бэкенда (`agent-profiles`).
 *
 * Конфигурация разрешается заново, а не правится в готовой: источник значения
 * (`flag`) и `agentFromUser` выводятся только из слоёв. Неизвестное имя —
 * отказ с перечнем бэкендов, чтобы он случился до каталога прогона, а не на
 * первом агентском шаге.
 */
export function resolveConfigWithAgent(options: {
  readonly cwd: string;
  readonly agent: string;
  readonly registry?: Registry;
}): Config {
  const resolved = resolveConfig({
    cwd: options.cwd,
    // `--agent default` — сам встроенный профиль, то есть `defaults.*` как
    // они есть: слой флага ему нечего добавить.
    ...(options.agent === DEFAULT_PROFILE ? {} : { flags: { 'defaults.agent': options.agent } }),
    ...pluginDefaultsOf(options.registry),
  });
  const { config } = resolved;
  const backends = Object.keys(config.backends);
  if (options.agent !== DEFAULT_PROFILE && !backends.includes(options.agent) && !Object.hasOwn(config.agents, options.agent)) {
    throw new BurnexError(`Неизвестный агент ${options.agent}: --agent принимает имя профиля или бэкенда`, {
      hint: describeKnownAgents(config.agents, backends),
    });
  }
  return config;
}
