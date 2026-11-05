import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseDocument, type Document } from 'yaml';
import { z } from 'zod';

import { BUNDLED_BACKENDS, bundledByBackend } from '../backends/bundled.js';
import { describeSource, type Source } from '../pipeline/config/merge.js';
import { MODEL_TIERS, type ModelTiers } from '../pipeline/config/modelTiers.js';
import type { ResolvedConfig } from '../pipeline/config/resolve.js';
import { EffortSchema, ModelNameSchema, ModelTierSchema, RawConfigSchema } from '../pipeline/config/schema.js';
import { BurnexError } from '../../kernel/errors.js';
import { currentDaemonKernel } from './daemon/kernel.js';
import type { KernelCache } from './pipelines.js';
import { homeRoot } from '../../kernel/dirs.js';

export interface SettingsValue {
  readonly value: string | undefined;
  readonly source: string;
}

export interface BackendView {
  readonly name: string;
  readonly command: string;
  readonly enabled: boolean;
  /** Есть адаптер; настройки неподключённого поставляемого бэкенда можно заполнить заранее. */
  readonly available: boolean;
  /** Строка для `plugins:`, если бэкенд поставляется с Burnex и ещё не подключён. */
  readonly plugin?: string;
  readonly defaultModel: string | undefined;
  readonly defaultModelSource: string;
  readonly modelTiers: ModelTiers;
  readonly modelTierSources: Readonly<Record<string, string>>;
  readonly modelTierEffortSources: Readonly<Record<string, string>>;
}

export interface Settings {
  readonly agent: SettingsValue;
  /** Старое общее переопределение модели сохраняется для совместимости. */
  readonly model: SettingsValue;
  readonly effort: SettingsValue;
  /** Общие семантические имена tier: встроенные, затем кастомные по алфавиту. */
  readonly modelTiers: readonly string[];
  readonly backends: readonly BackendView[];
  readonly file: string;
}

const TierPatchSchema = z.object({
  model: ModelNameSchema.nullable(),
  effort: EffortSchema.nullable().optional(),
}).strict();

const BackendPatchSchema = z.object({
  defaultModel: ModelNameSchema.nullable().optional(),
  modelTiers: z.record(ModelTierSchema, TierPatchSchema).optional(),
}).strict();

const SettingsPatchSchema = z.object({
  agent: ModelNameSchema.optional(),
  model: z.string().trim().nullable().optional(),
  effort: EffortSchema.nullable().optional(),
  backends: z.record(z.string(), BackendPatchSchema).optional(),
  removeModelTiers: z.array(ModelTierSchema).optional(),
  /** Явное подключение адаптеров из поставки (имена бэкендов), без установки внешнего пакета. */
  connect: z.array(ModelNameSchema).optional(),
  /** Прежняя форма `connect: ['codex']`: оставлена, чтобы старые клиенты не ломались. */
  connectCodex: z.literal(true).optional(),
}).strict();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export function globalConfigPath(home: string = homedir()): string {
  return join(homeRoot(home), 'config.yml');
}

/**
 * Происхождение значения словами витрины — по-английски, в отличие от
 * `describeSource`, чей текст печатает CLI (`burnex config`) и держат его
 * тесты: файл и плагин называются так же, встроенное умолчание и флаг — своими
 * словами.
 */
export function describeSettingSource(source: Source | undefined): string {
  if (source === undefined || source.kind === 'builtin') return 'built-in default';
  if (source.kind === 'flag') return `${source.name} (flag)`;
  return describeSource(source);
}

function valueOf(resolved: ResolvedConfig, path: string, value: string | undefined): SettingsValue {
  return { value, source: describeSettingSource(resolved.provenance.get(path)) };
}

function tierSource(resolved: ResolvedConfig, base: string, leaf: 'model' | 'effort'): string {
  return describeSettingSource(resolved.provenance.get(`${base}.${leaf}`) ?? resolved.provenance.get(base));
}

function sharedModelTiers(backends: readonly BackendView[]): readonly string[] {
  const custom = new Set<string>();
  for (const backend of backends) {
    for (const tier of Object.keys(backend.modelTiers)) {
      if (!(MODEL_TIERS as readonly string[]).includes(tier)) custom.add(tier);
    }
  }
  return [...MODEL_TIERS, ...[...custom].sort((left, right) => left.localeCompare(right))];
}

function readDeclaredPlugins(home: string): readonly string[] {
  let text = '';
  try {
    text = readFileSync(globalConfigPath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const plugins = (parseDocument(text).toJS() as { plugins?: unknown } | null)?.plugins;
  return Array.isArray(plugins) ? plugins.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Витрина правит глобальный файл; проектный слой отключён независимо от cwd.
 *
 * `kernelCache` — кеш ядра демона (`src/parts/ui/daemon/server.ts`, `createUiServer`):
 * ядро переживает отдельный запрос тем же правилом, каким кеш проверяет ключ
 * проекта (design.md, Решение 6) — свежая правка настроек, добавившая плагин
 * (`connect`), меняет объявления, и следующий вызов поднимает ядро
 * заново, а не читает устаревшее. Без кеша, как и при прямом вызове вне
 * сервера (тесты), плагины загружаются заново на каждый вызов.
 */
export async function readSettings(home: string = homedir(), kernelCache?: KernelCache): Promise<Settings> {
  // Единая точка получения действующего ядра демона (`src/parts/ui/daemon/kernel.ts`,
  // design.md Решение 6): ключ кеша `home:<home>`, строки поставки витрины —
  // тот же вызов, что использует диспетчер маршрутов.
  const { resolved, registry, fallback, buildError } = await currentDaemonKernel(kernelCache, home);
  // Запасной встроенный состав держит витрину открытой, чтобы та назвала
  // причину отказа (`ui-screens`, «Отказ сборки состава не гасит витрину»), но
  // конфигурации пользователя в нём нет: ни домашнего слоя, ни проектного.
  // Отдать его значения за настройки значило бы показать правдоподобные и
  // неверные — и на них же проверить правку, которая пишется в настоящий файл.
  if (fallback) {
    throw new BurnexError(`Settings cannot be read: ${buildError ?? 'the configuration does not build'}`, {
      file: globalConfigPath(home),
      hint: 'Fix the files the plugin composition is built from — the dashboard shows the same reason in the bar above the screen',
    });
  }
  const { config } = resolved;
  const backends: BackendView[] = Object.entries(config.backends).map(([name, backend]) => ({
    name,
    command: backend.command,
    enabled: backend.enabled,
    available: registry.backends.has(name),
    defaultModel: backend.defaultModel,
    defaultModelSource: valueOf(resolved, `backends.${name}.default_model`, backend.defaultModel).source,
    modelTiers: backend.modelTiers ?? {},
    modelTierSources: Object.fromEntries(Object.keys(backend.modelTiers ?? {}).map((tier) => {
      const base = `backends.${name}.model_tiers.${tier}`;
      return [tier, tierSource(resolved, base, 'model')];
    })),
    modelTierEffortSources: Object.fromEntries(Object.entries(backend.modelTiers ?? {})
      .filter(([, selection]) => selection.effort !== undefined)
      .map(([tier]) => {
        const base = `backends.${name}.model_tiers.${tier}`;
        return [tier, tierSource(resolved, base, 'effort')];
      })),
  }));

  // Поставляемые адаптеры (`BUNDLED_BACKENDS`) — opt-in плагины: карточка видна
  // и до подключения, но агентом по умолчанию бэкенд может стать только вместе
  // с адаптером. Уже подключённый попадает в список обычным путём и `plugin`
  // не несёт — подключать нечего. Не несёт его и адаптер, уже объявленный в
  // `plugins:`, но не поднявшийся (сборка состава отказала, демон живёт на
  // прежнем ядре): строка в файле есть, дописывать нечего, а причину называет
  // полоса отказа сборки.
  const declared = new Set(readDeclaredPlugins(home));
  const offered = (specifier: string): { plugin?: string } => (declared.has(specifier) ? {} : { plugin: specifier });
  for (const [index, backend] of backends.entries()) {
    const entry = backend.available ? undefined : bundledByBackend(backend.name);
    if (entry === undefined) continue;
    const fallbackModel = backend.defaultModel === undefined
      ? entry.plugin.backends![backend.name]!.defaults?.default_model
      : undefined;
    backends[index] = {
      ...backend, ...offered(entry.specifier),
      ...(fallbackModel === undefined ? {} : { defaultModel: fallbackModel, defaultModelSource: `plugin:${entry.plugin.name}` }),
    };
  }
  for (const entry of BUNDLED_BACKENDS) {
    for (const [name, definition] of Object.entries(entry.plugin.backends ?? {})) {
      if (backends.some((backend) => backend.name === name)) continue;
      backends.push({
        name, command: definition.defaults?.command ?? name, enabled: true, available: false,
        ...offered(entry.specifier),
        defaultModel: definition.defaults?.default_model,
        defaultModelSource: `plugin:${entry.plugin.name}`,
        modelTiers: {}, modelTierSources: {}, modelTierEffortSources: {},
      });
    }
  }

  return {
    agent: valueOf(resolved, 'defaults.agent', config.defaults.agent),
    model: valueOf(resolved, 'defaults.model', config.defaults.model),
    effort: valueOf(resolved, 'defaults.effort', config.defaults.effort),
    modelTiers: sharedModelTiers(backends),
    backends, file: globalConfigPath(home),
  };
}

/**
 * Единственный путь записи глобального файла из витрины: открыть его как
 * документ `yaml` (комментарии сохраняются), применить правки, проверить
 * результат схемой конфигурации и подменить файл через временный — читатель
 * не увидит полузаписанное. Им пользуются экран настроек и экран Pipelines;
 * второй писатель разошёлся бы с первым в том, что считать допустимым файлом.
 * Правка, не прошедшая схему, файла не трогает.
 */
export function editGlobalConfig(home: string, edit: (document: Document) => void): void {
  const file = globalConfigPath(home);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const document = parseDocument(text);
  edit(document);

  const next = document.toString();
  const parsed = RawConfigSchema.safeParse(parseDocument(next).toJS() ?? {});
  if (!parsed.success) {
    throw new BurnexError(`The patch does not pass the configuration schema: ${parsed.error.issues[0]?.message ?? 'unknown error'}`, { file });
  }

  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, next);
  renameSync(temporary, file);
}

/** Проверить всю правку до записи; менять YAML-документ, сохраняя комментарии. */
export async function writeSettings(
  input: unknown,
  home: string = homedir(),
  kernelCache?: KernelCache,
): Promise<Settings> {
  const parsedPatch = SettingsPatchSchema.safeParse(input);
  if (!parsedPatch.success) {
    const issue = parsedPatch.error.issues[0]!;
    throw new BurnexError(`Invalid settings patch ${issue.path.join('.')}: ${issue.message}`);
  }
  const patch = parsedPatch.data;
  const current = await readSettings(home, kernelCache);
  const known = new Map(current.backends.map((backend) => [backend.name, backend]));
  const connect = new Set([...(patch.connect ?? []), ...(patch.connectCodex === true ? ['codex'] : [])]);
  const specifiers = new Map<string, string>();
  for (const name of connect) {
    const entry = bundledByBackend(name);
    if (entry === undefined) throw new BurnexError(`Agent ${name} cannot be connected from the dashboard`);
    specifiers.set(name, entry.specifier);
  }
  const declared = new Set(readDeclaredPlugins(home));
  // Адаптер уже объявлен, но не поднялся: строка в `plugins:` его не лечит, и
  // молча принять такое подключение значило бы снять отметку, ничего не
  // изменив. Подключённый же бэкенд — повтор без последствий.
  for (const [name, specifier] of specifiers) {
    if (declared.has(specifier) && known.get(name)?.available !== true) {
      throw new BurnexError(`Agent ${name} is already declared in plugins (${specifier}) but did not load: fix the reason shown in the bar above the screen`);
    }
  }
  for (const name of Object.keys(patch.backends ?? {})) {
    if (!known.has(name)) throw new BurnexError(`Unknown agent ${name}`);
  }
  if (patch.agent !== undefined) {
    const backend = known.get(patch.agent);
    if (backend === undefined) throw new BurnexError(`Unknown agent ${patch.agent}`);
    if (!backend.enabled) throw new BurnexError(`Agent ${patch.agent} is disabled`);
    // Неподключённый бэкенд можно выбрать только той же правкой, что его
    // подключает (объявленный, но не поднявшийся отклонён выше).
    if (!backend.available && !connect.has(patch.agent)) {
      throw new BurnexError(`Agent ${patch.agent} is not connected: connect its plugin first`);
    }
  }
  for (const tier of patch.removeModelTiers ?? []) {
    if ((MODEL_TIERS as readonly string[]).includes(tier)) {
      throw new BurnexError(`Cannot remove built-in tier ${tier}`);
    }
  }

  editGlobalConfig(home, (document) => {
    const plugins = (document.toJS() as { plugins?: string[] } | null)?.plugins ?? [];
    for (const specifier of new Set(specifiers.values())) {
      if (plugins.includes(specifier)) continue;
      if (!document.has('plugins')) document.set('plugins', document.createNode([]));
      document.addIn(['plugins'], specifier);
    }
    if (patch.agent !== undefined) document.setIn(['defaults', 'agent'], patch.agent);
    if (patch.model !== undefined) {
      if (patch.model === null || patch.model === '') document.deleteIn(['defaults', 'model']);
      else document.setIn(['defaults', 'model'], patch.model);
    }
    if (patch.effort !== undefined) {
      if (patch.effort === null) document.deleteIn(['defaults', 'effort']);
      else document.setIn(['defaults', 'effort'], patch.effort);
    }
    for (const [name, backend] of Object.entries(patch.backends ?? {})) {
      const path = ['backends', name];
      if (backend.defaultModel !== undefined) {
        if (backend.defaultModel === null) document.deleteIn([...path, 'default_model']);
        else document.setIn([...path, 'default_model'], backend.defaultModel);
      }
      for (const [tier, selection] of Object.entries(backend.modelTiers ?? {})) {
        if (selection.model === null) document.deleteIn([...path, 'model_tiers', tier]);
        else if (selection.effort === undefined || selection.effort === null) {
          document.setIn([...path, 'model_tiers', tier], selection.model);
        } else {
          document.setIn([...path, 'model_tiers', tier], {
            model: selection.model,
            effort: selection.effort,
          });
        }
      }
    }
    const documentBackends = (document.toJS() as { backends?: Record<string, unknown> } | null)?.backends ?? {};
    for (const tier of patch.removeModelTiers ?? []) {
      for (const name of new Set([...Object.keys(documentBackends), ...current.backends.map((backend) => backend.name)])) {
        // Карточки неподключённых бэкендов в файле могут отсутствовать вовсе, а
        // `deleteIn` по несуществующему промежуточному узлу бросает.
        if (document.hasIn(['backends', name, 'model_tiers'])) document.deleteIn(['backends', name, 'model_tiers', tier]);
      }
    }
  });
  // Кеш перечитывает объявления плагинов заново при каждом обращении: правка,
  // добавившая plugins (`connect`), обязана быть видна тут же, без
  // перезапуска демона.
  return readSettings(home, kernelCache);
}
