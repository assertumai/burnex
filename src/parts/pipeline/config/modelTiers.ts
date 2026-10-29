export const MODEL_TIERS = ['max', 'deep', 'balance', 'fast', 'mini'] as const;
export type ModelTier = string;

export interface ModelTierSelection {
  readonly model: string;
  readonly effort?: string;
}

export type ModelTiers = Readonly<Record<ModelTier, ModelTierSelection>>;

/** Что о бэкенде знает конфигурация: достаточно двух полей `BackendConfig`. */
export interface BackendModelKnowledge {
  readonly defaultModel: string | undefined;
  readonly modelTiers?: ModelTiers | undefined;
}

/**
 * Бэкенды, которым принадлежит модель: названные в `default_model` или
 * `model_tiers` конфигурации либо известные каталогу цен (`catalogOwners`).
 * Статическое знание — процессов CLI не запускает
 * (`agent-policy-and-pipeline-agents`, решение 4).
 */
export function modelOwners(
  model: string,
  backends: Readonly<Record<string, BackendModelKnowledge>>,
  catalogOwners: ReadonlySet<string>,
): ReadonlySet<string> {
  const owners = new Set(catalogOwners);
  for (const [name, backend] of Object.entries(backends)) {
    if (backend.defaultModel === model) owners.add(name);
    for (const selection of Object.values(backend.modelTiers ?? {})) {
      if (selection.model === model) owners.add(name);
    }
  }
  return owners;
}

/**
 * Модель чужая агенту, если она принадлежит какому-то другому бэкенду и не
 * принадлежит самому агенту. Неизвестная модель не принадлежит никому и
 * чужой не считается: без положительного знания движок не вправе звать её
 * ошибкой — у пользователя может быть модель, о которой каталог не знает.
 */
export function isForeignModel(agent: string, owners: ReadonlySet<string>): boolean {
  return owners.size > 0 && !owners.has(agent);
}
