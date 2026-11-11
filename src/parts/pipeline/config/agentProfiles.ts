import { dirname, isAbsolute, join } from 'node:path';

import { BurnexError } from '../../../kernel/errors.js';
import { describeSource, unflatten, type Source } from './merge.js';
import type { ModelTier } from './modelTiers.js';
import type { RawAgentProfile } from './schema.js';

type RawContextEntry = NonNullable<RawAgentProfile['context']>[number];

/**
 * Действующий профиль агента (`agent-profiles`): запись `agents.<имя>`
 * ближнего слоя целиком. Пути записей контекста уже разрешены от слоя
 * объявления (design.md, решение 5): глобальный профиль — от каталога
 * глобального конфига, абсолютным путём; проектный оставляет относительный
 * путь относительным — он читается от рабочего дерева шага, то есть от корня
 * репозитория, и остаётся частью отпечатка входов работы.
 */
export interface AgentProfile {
  readonly name: string;
  readonly backend: string;
  readonly model?: string;
  readonly modelTier?: ModelTier;
  readonly effort?: string;
  readonly context: readonly RawContextEntry[];
  /** Файл, объявивший профиль; для слоя не из файла — его описание. */
  readonly file: string;
}

/** Имя встроенного профиля — представления `defaults.agent/model/effort`. */
export const DEFAULT_PROFILE = 'default';

export interface BuildAgentProfilesOptions {
  readonly home: string;
  readonly globalPath: string;
  /** Имена подключённых и поставляемых бэкендов: каждое — неявный профиль. */
  readonly backendNames: readonly string[];
}

function expandPath(path: string, base: string | undefined, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  if (isAbsolute(path) || base === undefined) return path;
  return join(base, path);
}

function resolveEntry(entry: RawContextEntry, base: string | undefined, home: string): RawContextEntry {
  if (typeof entry === 'string') return expandPath(entry, base, home);
  if ('path' in entry) return { ...entry, path: expandPath(entry.path, base, home) };
  if ('item_refs' in entry) return { ...entry, item_refs: expandPath(entry.item_refs, base, home) };
  return entry;
}

/**
 * Имя профиля, которое разбор конфигурации отклоняет: `default` встроен, имя
 * бэкенда — уже неявный профиль. Одна проверка для разбора и для формы
 * витрины: форма обязана отказывать тем же текстом.
 */
export function checkProfileName(name: string, backendNames: readonly string[], file?: string): void {
  if (name === DEFAULT_PROFILE) {
    throw new BurnexError('Профиль default встроен и не объявляется в agents', {
      ...(file === undefined ? {} : { file }),
      at: 'agents.default',
      hint: 'Агента, модель и effort по умолчанию задают ключи defaults.agent, defaults.model и defaults.effort',
    });
  }
  if (backendNames.includes(name)) {
    throw new BurnexError(`Профиль ${name} назван именем бэкенда`, {
      ...(file === undefined ? {} : { file }),
      at: `agents.${name}`,
      hint: `Имя бэкенда ${name} уже является неявным профилем { backend: ${name} } — назовите профиль иначе`,
    });
  }
}

/**
 * Собрать профили из слитых значений и проверить имена: `default` встроен,
 * имя бэкенда — уже неявный профиль. Оба отказа — разбора конфигурации, с
 * файлом и путём ключа: иначе `agent: claude` молча сменил бы смысл после
 * чьей-то правки (design.md, решение 2).
 */
export function buildAgentProfiles(
  values: ReadonlyMap<string, unknown>,
  provenance: ReadonlyMap<string, Source>,
  options: BuildAgentProfilesOptions,
): Readonly<Record<string, AgentProfile>> {
  const raw = (unflatten(new Map([...values].filter(([path]) => path.startsWith('agents.')))).agents ?? {}) as Record<
    string,
    RawAgentProfile
  >;
  const out: Record<string, AgentProfile> = {};
  for (const [name, profile] of Object.entries(raw)) {
    const source = provenance.get(`agents.${name}.backend`);
    const file = source === undefined ? undefined : source.kind === 'file' ? source.path : describeSource(source);
    checkProfileName(name, options.backendNames, file);
    const base = source?.kind === 'file' && source.path === options.globalPath ? dirname(options.globalPath) : undefined;
    out[name] = {
      name,
      backend: profile.backend,
      ...(profile.model === undefined ? {} : { model: profile.model }),
      ...(profile.model_tier === undefined ? {} : { modelTier: profile.model_tier }),
      ...(profile.effort === undefined ? {} : { effort: profile.effort }),
      context: (profile.context ?? []).map((entry) => resolveEntry(entry, base, options.home)),
      file: file ?? 'встроенное умолчание',
    };
  }
  return out;
}

/** Текст подсказки отказа на неизвестном имени: профили и бэкенды раздельно. */
export function describeKnownAgents(
  profiles: Readonly<Record<string, AgentProfile>>,
  backends: readonly string[],
): string {
  const names = [DEFAULT_PROFILE, ...Object.keys(profiles).sort()];
  return `Профили: ${names.join(', ')}. Бэкенды: ${[...new Set(backends)].sort().join(', ')}`;
}
