import { createHash } from 'node:crypto';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { BurnexError } from '../../../kernel/errors.js';
import { homeRoot } from '../../../kernel/dirs.js';
import { describeSchemaFailure } from '../../../kernel/schema-failure.js';
import { checkProfileName, type AgentProfile } from '../config/agentProfiles.js';
import type { ModelTier } from '../config/modelTiers.js';
import { EffortSchema, ModelNameSchema, ModelTierSchema, type RawAgentProfile } from '../config/schema.js';
import type { ReviewStrategyOrigin, ReviewStrategyUnresolved } from './model.js';

/**
 * Общее у документов, объявляющих участников многоагентного шага, — стратегии
 * ревью (`review-strategies`) и стратегии обсуждения (`discuss-step`,
 * design.md, решение 1): выбор агента участника, локальные профили,
 * разрешение ссылки по слоям, чтение `file:` и отпечаток. Форма документа и
 * то, что из него строится, у каждого вида своё.
 */

/** Поля выбора агента участника — те же, что у агентского шага. */
export const ParticipantChoiceShape = {
  agent: z.string().trim().min(1).optional(),
  model: ModelNameSchema.optional(),
  model_tier: ModelTierSchema.optional(),
  effort: EffortSchema.optional(),
};

export const BOTH_MODEL_FIELDS = 'участник называет и model, и model_tier: оставьте одно из двух';

/** Участник с выбором агента и дополнением к промпту: агрегатор, защитник, автор. */
export const PromptedParticipantSchema = z
  .object({ ...ParticipantChoiceShape, prompt: z.string().optional() })
  .strict()
  .refine((value) => value.model === undefined || value.model_tier === undefined, { message: BOTH_MODEL_FIELDS })
  .meta({ not: { required: ['model', 'model_tier'] } });

/** Выбор агента участника — поля слоя «шаг» для `resolveAgentChoice`. */
export interface StrategyChoice {
  readonly agent?: string;
  readonly model?: string;
  readonly tier?: ModelTier;
  readonly effort?: string;
}

export function choiceOf(entry: {
  readonly agent?: string | undefined;
  readonly model?: string | undefined;
  readonly model_tier?: string | undefined;
  readonly effort?: string | undefined;
}): StrategyChoice {
  return {
    ...(entry.agent === undefined ? {} : { agent: entry.agent }),
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.model_tier === undefined ? {} : { tier: entry.model_tier as ModelTier }),
    ...(entry.effort === undefined ? {} : { effort: entry.effort }),
  };
}

/** Корни слоёв: проект и домашний каталог, как у переиспользуемых шагов. */
export interface StrategyRoots {
  readonly project: string;
  readonly home: string;
}

/** Значение ключа шага — путь к файлу, а не имя: слоёв не касается. */
export function isStrategyPath(ref: string): boolean {
  return ref.startsWith('./') || ref.startsWith('../') || isAbsolute(ref);
}

/** Каталоги слоёв в порядке поиска: проект, затем дом. */
export function layerDirsOf(
  subdir: string,
  roots: StrategyRoots,
): readonly { readonly layer: 'project' | 'home'; readonly dir: string }[] {
  return [
    { layer: 'project', dir: join(roots.project, '.burnex', subdir) },
    { layer: 'home', dir: join(homeRoot(roots.home), subdir) },
  ];
}

/** Отказ разбора файла стратегии: путь ключа внутри документа, если он известен. */
export class StrategyError extends Error {
  constructor(
    message: string,
    readonly at?: string,
  ) {
    super(message);
  }
}

export function readText(path: string, at?: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new StrategyError(`не удалось прочитать файл ${path}: ${(error as Error).message}`, at);
  }
}

export function expandPath(path: string, base: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : join(base, path);
}

/**
 * Разобрать текст документа: YAML, схема, имена локальных профилей. Отказ
 * называет путь ключа. `rejectFirst` — отказ, который нужно назвать раньше
 * общего описания провала схемы (прежний режим у стратегии ревью).
 */
export function parseStrategyText<S extends z.ZodType<{ readonly profiles?: Record<string, unknown> | undefined }>>(
  text: string,
  schema: S,
  backendNames: readonly string[],
  rejectFirst?: (issues: readonly z.core.$ZodIssue[]) => StrategyError | undefined,
): z.infer<S> {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new StrategyError(`документ не разбирается как YAML: ${(error as Error).message}`);
  }
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    const first = rejectFirst?.(parsed.error.issues);
    if (first !== undefined) throw first;
    const failure = describeSchemaFailure(parsed.error);
    throw new StrategyError(failure.message, failure.at);
  }
  for (const name of Object.keys(parsed.data.profiles ?? {})) {
    try {
      checkProfileName(name, backendNames);
    } catch (error) {
      throw new StrategyError((error as Error).message, `profiles.${name}`);
    }
  }
  return parsed.data;
}

/** Обёртка разбора файла для тестов и редактора: отказ — `BurnexError` с файлом и путём ключа. */
export function parseStrategyFileOrThrow<T>(path: string, title: string, parse: (text: string) => T): T {
  try {
    return parse(readText(path));
  } catch (error) {
    if (!(error instanceof StrategyError)) throw error;
    throw new BurnexError(`${title} не разбирается: ${error.message}`, {
      file: path,
      ...(error.at === undefined ? {} : { at: error.at }),
    });
  }
}

export type StrategyLoad<S> =
  | { readonly strategy: S }
  | { readonly origin: ReviewStrategyOrigin; readonly unresolved: ReviewStrategyUnresolved };

type Located = { readonly ref: string; readonly layer: 'project' | 'home' | 'explicit'; readonly path: string };

/**
 * Прочитать документ по пути. Найденный по имени обязан называть себя тем же
 * `name`, что и файл: иначе перенос файла молча сменил бы смысл ссылки.
 * Дефект документа — не исключение, а `unresolved` с диагностикой.
 */
export function loadStrategyDocument<R extends { readonly name: string }, S>(
  located: Located,
  parse: (text: string) => R,
  build: (raw: R, text: string, located: Located) => S,
): StrategyLoad<S> {
  try {
    const text = readText(located.path);
    const raw = parse(text);
    if (located.layer !== 'explicit' && raw.name !== located.ref) {
      return {
        origin: { ...located, name: raw.name },
        unresolved: { reason: 'name_mismatch', name: located.ref, declared: raw.name, path: located.path },
      };
    }
    return { strategy: build(raw, text, located) };
  } catch (error) {
    if (!(error instanceof StrategyError)) throw error;
    return {
      origin: located,
      unresolved: { reason: 'invalid', path: located.path, ...(error.at === undefined ? {} : { at: error.at }), detail: error.message },
    };
  }
}

/**
 * Разрешить ссылку шага: путь — от объявившего документа, имя — проект,
 * затем дом, первый найденный побеждает.
 */
export function resolveStrategyRef<S>(
  ref: string,
  declaringFile: string,
  subdir: string,
  roots: StrategyRoots,
  load: (located: Located) => StrategyLoad<S>,
): StrategyLoad<S> {
  if (isStrategyPath(ref)) {
    const path = resolve(dirname(declaringFile), ref);
    if (!existsSync(path)) return { origin: { ref }, unresolved: { reason: 'not_found', name: ref, searched: [path] } };
    return load({ ref, layer: 'explicit', path });
  }
  const searched: string[] = [];
  for (const { layer, dir } of layerDirsOf(subdir, roots)) {
    const path = join(dir, `${ref}.yml`);
    searched.push(path);
    if (!existsSync(path)) continue;
    return load({ ref, layer, path });
  }
  return { origin: { ref }, unresolved: { reason: 'not_found', name: ref, searched } };
}

type RawContextEntry = NonNullable<RawAgentProfile['context']>[number];

function resolveEntry(entry: RawContextEntry, base: string): RawContextEntry {
  if (typeof entry === 'string') return expandPath(entry, base);
  if ('path' in entry) return { ...entry, path: expandPath(entry.path, base) };
  if ('item_refs' in entry) return { ...entry, item_refs: expandPath(entry.item_refs, base) };
  return entry;
}

function entryPath(entry: RawContextEntry): string | undefined {
  if (typeof entry === 'string') return entry;
  if ('path' in entry) return entry.path;
  if ('item_refs' in entry) return entry.item_refs;
  return undefined;
}

/**
 * Чтение документа с учётом файлов, на которые он ссылается: `file:` у
 * текстовых полей и `context` локальных профилей. Отпечаток — текст плюс эти
 * файлы путём относительно файла стратегии: перенос каталога стратегии между
 * слоями отпечаток не меняет, правка любого из файлов — меняет.
 */
export class StrategyReader {
  private readonly referenced = new Set<string>();
  readonly base: string;

  constructor(
    private readonly text: string,
    path: string,
  ) {
    this.base = dirname(path);
  }

  /** Значение `file:<путь>` — текст файла, иначе — как есть. */
  read(value: string | undefined, at: string): string | undefined {
    if (value === undefined || !value.startsWith('file:')) return value;
    const path = expandPath(value.slice('file:'.length), this.base);
    this.referenced.add(path);
    return readText(path, at);
  }

  /** Локальные профили с путями контекста, разрешёнными от файла стратегии. */
  profiles(raw: Readonly<Record<string, RawAgentProfile>> | undefined, file: string): Record<string, AgentProfile> {
    const profiles: Record<string, AgentProfile> = {};
    for (const [name, profile] of Object.entries(raw ?? {})) {
      const context = (profile.context ?? []).map((entry) => resolveEntry(entry, this.base));
      for (const entry of context) {
        const path = entryPath(entry);
        if (path === undefined) continue;
        for (const found of /[*?[]/.test(path) ? [...globSync(path)] : [path]) this.referenced.add(found);
      }
      profiles[name] = {
        name,
        backend: profile.backend,
        ...(profile.model === undefined ? {} : { model: profile.model }),
        ...(profile.model_tier === undefined ? {} : { modelTier: profile.model_tier as ModelTier }),
        ...(profile.effort === undefined ? {} : { effort: profile.effort }),
        context,
        file,
      };
    }
    return profiles;
  }

  fingerprint(): string {
    const hash = createHash('sha256').update(this.text).update('\0');
    for (const path of [...this.referenced].sort()) {
      hash.update(relative(this.base, path)).update('\0');
      try {
        hash.update(readFileSync(path));
      } catch {
        hash.update('missing');
      }
      hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
  }
}
