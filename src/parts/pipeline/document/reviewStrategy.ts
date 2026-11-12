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
import {
  AgentProfileSchema,
  EffortSchema,
  ModelNameSchema,
  ModelTierSchema,
  ProfileNameSchema,
  type RawAgentProfile,
} from '../config/schema.js';
import { AGGREGATOR_ID, DEFAULT_DEFEND_ROUNDS, DEFENDER_ID, REVIEW_MODES, type ReviewMode, type ReviewStrategyOrigin, type ReviewStrategyUnresolved } from './model.js';

/**
 * Стратегия ревью (`review-strategies`, design.md, решения 1 и 2): кто
 * ревьюит, с каким фокусом и кто сводит итог, — отдельным документом, на
 * который шаг `review:` ссылается файлом или именем. Модуль читает документ,
 * проверяет его и разрешает ссылку по слоям; участников в агентов раскрывает
 * разбор шага (`expand.ts`), тем же `resolveAgentChoice`, что агентский шаг.
 */

const ParticipantChoiceShape = {
  agent: z.string().trim().min(1).optional(),
  model: ModelNameSchema.optional(),
  model_tier: ModelTierSchema.optional(),
  effort: EffortSchema.optional(),
};

const BOTH_MODEL_FIELDS = 'участник называет и model, и model_tier: оставьте одно из двух';

const ReviewerSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'id ревьюера — строчная буква, затем строчные буквы, цифры, дефис и подчёркивание'),
    ...ParticipantChoiceShape,
    focus: z.string().optional(),
  })
  .strict()
  .refine((value) => value.model === undefined || value.model_tier === undefined, { message: BOTH_MODEL_FIELDS })
  .meta({ not: { required: ['model', 'model_tier'] } });

const AggregatorSchema = z
  .object({ ...ParticipantChoiceShape, prompt: z.string().optional() })
  .strict()
  .refine((value) => value.model === undefined || value.model_tier === undefined, { message: BOTH_MODEL_FIELDS })
  .meta({ not: { required: ['model', 'model_tier'] } });

const DefenderSchema = z
  .object({ ...ParticipantChoiceShape, prompt: z.string().optional() })
  .strict()
  .refine((value) => value.model === undefined || value.model_tier === undefined, { message: BOTH_MODEL_FIELDS })
  .meta({ not: { required: ['model', 'model_tier'] } });

const ROUNDS_RANGE = 'rounds — целое число от 1 до 5';

/**
 * Режим стратегии. Прежний `discussion` (`review-discussion`) заменён
 * режимом `defend` и отклоняется с подсказкой о замене (`review-defend`,
 * решение 1): автор старой стратегии должен узнать, на что её перевести.
 */
const ModeSchema = z.enum(REVIEW_MODES, {
  error: (issue) =>
    issue.input === 'discussion'
      ? `неизвестный режим: известны ${REVIEW_MODES.join(', ')} (discussion заменён режимом defend)`
      : `неизвестный режим: известны ${REVIEW_MODES.join(', ')}`,
});

export const ReviewStrategySchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('review-strategy'),
    name: ProfileNameSchema,
    description: z.string().optional(),
    profiles: z.record(ProfileNameSchema, AgentProfileSchema).optional(),
    reviewers: z.array(ReviewerSchema).min(1, 'стратегия объявляет хотя бы одного ревьюера'),
    aggregator: AggregatorSchema.optional(),
    mode: ModeSchema.optional(),
    defend: z
      .object({
        rounds: z.number().int(ROUNDS_RANGE).min(1, ROUNDS_RANGE).max(5, ROUNDS_RANGE).optional(),
      })
      .strict()
      .optional(),
    defender: DefenderSchema.optional(),
  })
  .strict()
  .meta({
    // То же, что проверяет `superRefine` ниже, — для подсказок редактора.
    if: { properties: { mode: { const: 'defend' } }, required: ['mode'] },
    then: {},
    else: { not: { anyOf: [{ required: ['defend'] }, { required: ['defender'] }] } },
  })
  .superRefine((value, ctx) => {
    // Блоки режима `defend` при другом режиме ничего бы не делали — ошибка
    // у ключа блока (`review-defend`, решение 1).
    if (value.mode !== 'defend') {
      for (const key of ['defend', 'defender'] as const) {
        if (value[key] === undefined) continue;
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `блок ${key} действует только при mode: defend, а режим — ${value.mode ?? 'independent'}`,
        });
      }
    }
    const seen = new Set<string>();
    for (const [index, reviewer] of value.reviewers.entries()) {
      if (reviewer.id === AGGREGATOR_ID || reviewer.id === DEFENDER_ID) {
        ctx.addIssue({
          code: 'custom',
          path: ['reviewers', index, 'id'],
          message:
            reviewer.id === AGGREGATOR_ID
              ? `id ${AGGREGATOR_ID} занят агрегатором: каталог журнала и адрес step_agents у них общие`
              : `id ${DEFENDER_ID} занят защитником: каталог журнала, адрес step_agents и учёт расхода у них общие`,
        });
      }
      if (seen.has(reviewer.id)) {
        ctx.addIssue({ code: 'custom', path: ['reviewers', index, 'id'], message: `повторный id ревьюера ${reviewer.id}` });
      }
      seen.add(reviewer.id);
    }
  });

export type RawReviewStrategy = z.infer<typeof ReviewStrategySchema>;

/** Выбор агента участника — поля слоя «шаг» для `resolveAgentChoice`. */
export interface StrategyChoice {
  readonly agent?: string;
  readonly model?: string;
  readonly tier?: ModelTier;
  readonly effort?: string;
}

export interface StrategyReviewer extends StrategyChoice {
  readonly id: string;
  readonly focus?: string;
}

export interface StrategyAggregator extends StrategyChoice {
  readonly prompt?: string;
}

/** Свежий защитник режима `defend`: выбор агента и дополнение к промпту. */
export interface StrategyDefender extends StrategyChoice {
  readonly prompt?: string;
}

/** Прочитанная и проверенная стратегия: тексты `file:` прочитаны, пути разрешены. */
export interface ReviewStrategy {
  readonly origin: Required<Pick<ReviewStrategyOrigin, 'name' | 'layer' | 'path' | 'fingerprint'>> & ReviewStrategyOrigin;
  readonly mode: ReviewMode;
  /** Раунды защиты — только в режиме `defend` (по умолчанию 2). */
  readonly rounds?: number;
  readonly reviewers: readonly StrategyReviewer[];
  /** Не объявлен — агрегатор исполняется профилем `default`. */
  readonly aggregator: StrategyAggregator;
  /** Только в режиме `defend`; без блока `defender` — профиль `default`. */
  readonly defender?: StrategyDefender;
  /** Локальные профили: видны только участникам этой стратегии. */
  readonly profiles: Readonly<Record<string, AgentProfile>>;
}

export type StrategyResolution =
  | { readonly strategy: ReviewStrategy }
  | { readonly origin: ReviewStrategyOrigin; readonly unresolved: ReviewStrategyUnresolved };

/** Корни слоёв: проект и домашний каталог, как у переиспользуемых шагов. */
export interface StrategyRoots {
  readonly project: string;
  readonly home: string;
}

const SUBDIR = 'review-strategies';

/** Значение `review` шага — путь к файлу, а не имя: слоёв не касается. */
export function isStrategyPath(ref: string): boolean {
  return ref.startsWith('./') || ref.startsWith('../') || isAbsolute(ref);
}

/** Каталоги слоёв стратегий в порядке поиска: проект, затем дом. */
export function strategyLayerDirs(roots: StrategyRoots): readonly { readonly layer: 'project' | 'home'; readonly dir: string }[] {
  return [
    { layer: 'project', dir: join(roots.project, '.burnex', SUBDIR) },
    { layer: 'home', dir: join(homeRoot(roots.home), SUBDIR) },
  ];
}

/**
 * Разрешить ссылку шага на стратегию: путь — от объявившего документа, имя —
 * проект, затем дом, первый найденный побеждает. Промах и дефект документа —
 * не исключение, а `unresolved` с диагностикой (design.md, решение 2).
 */
export function resolveReviewStrategy(
  ref: string,
  declaringFile: string,
  roots: StrategyRoots,
  backendNames: readonly string[],
): StrategyResolution {
  if (isStrategyPath(ref)) {
    const path = resolve(dirname(declaringFile), ref);
    if (!existsSync(path)) return { origin: { ref }, unresolved: { reason: 'not_found', name: ref, searched: [path] } };
    return loadReviewStrategy(ref, path, 'explicit', backendNames);
  }
  const searched: string[] = [];
  for (const { layer, dir } of strategyLayerDirs(roots)) {
    const path = join(dir, `${ref}.yml`);
    searched.push(path);
    if (!existsSync(path)) continue;
    return loadReviewStrategy(ref, path, layer, backendNames);
  }
  return { origin: { ref }, unresolved: { reason: 'not_found', name: ref, searched } };
}

/** Отказ разбора файла стратегии: путь ключа внутри документа, если он известен. */
class StrategyError extends Error {
  constructor(
    message: string,
    readonly at?: string,
  ) {
    super(message);
  }
}

/**
 * Прочитать стратегию по пути. Найденная по имени обязана называть себя тем
 * же `name`, что и файл: иначе перенос файла молча сменил бы смысл ссылки.
 */
export function loadReviewStrategy(
  ref: string,
  path: string,
  layer: 'project' | 'home' | 'explicit',
  backendNames: readonly string[],
): StrategyResolution {
  const located = { ref, layer, path } as const;
  try {
    const text = readText(path);
    const raw = parseStrategy(text, backendNames);
    if (layer !== 'explicit' && raw.name !== ref) {
      return { origin: { ...located, name: raw.name }, unresolved: { reason: 'name_mismatch', name: ref, declared: raw.name, path } };
    }
    return { strategy: buildStrategy(raw, text, located) };
  } catch (error) {
    if (!(error instanceof StrategyError)) throw error;
    return {
      origin: located,
      unresolved: { reason: 'invalid', path, ...(error.at === undefined ? {} : { at: error.at }), detail: error.message },
    };
  }
}

/**
 * Разобрать текст стратегии: YAML, схема, имена локальных профилей. Отказ
 * называет путь ключа — повторный `id` второго ревьюера, `model` рядом с
 * `model_tier`, незнакомое поле — и бросается `BurnexError` с файлом из
 * `parseReviewStrategyFile`, которым пользуются тесты и разбор.
 */
function parseStrategy(text: string, backendNames: readonly string[]): RawReviewStrategy {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new StrategyError(`документ не разбирается как YAML: ${(error as Error).message}`);
  }
  const parsed = ReviewStrategySchema.safeParse(document);
  if (!parsed.success) {
    // Прежний `mode: discussion` приходит вместе со своим блоком
    // `discussion`, и строгая схема первой назвала бы незнакомый ключ. Автору
    // нужен отказ у `mode` с подсказкой о замене (`review-defend`, решение 1).
    const mode = parsed.error.issues.find((issue) => issue.path.length === 1 && issue.path[0] === 'mode');
    if (mode !== undefined) throw new StrategyError(mode.message, 'mode');
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

/** Разобрать файл стратегии, отказав `BurnexError` с файлом и путём ключа. */
export function parseReviewStrategyFile(path: string, backendNames: readonly string[]): RawReviewStrategy {
  try {
    return parseStrategy(readText(path), backendNames);
  } catch (error) {
    if (!(error instanceof StrategyError)) throw error;
    throw new BurnexError(`Стратегия ревью не разбирается: ${error.message}`, {
      file: path,
      ...(error.at === undefined ? {} : { at: error.at }),
    });
  }
}

function readText(path: string, at?: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new StrategyError(`не удалось прочитать файл ${path}: ${(error as Error).message}`, at);
  }
}

type RawContextEntry = NonNullable<RawAgentProfile['context']>[number];

function expandPath(path: string, base: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : join(base, path);
}

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

function buildStrategy(
  raw: RawReviewStrategy,
  text: string,
  located: { readonly ref: string; readonly layer: 'project' | 'home' | 'explicit'; readonly path: string },
): ReviewStrategy {
  const base = dirname(located.path);
  // Файлы, на которые ссылается стратегия, входят в отпечаток путём
  // относительно её файла: перенос каталога стратегии между слоями отпечаток
  // не меняет, правка любого из файлов — меняет (design.md, решение 7).
  const referenced = new Set<string>();
  const readReference = (value: string | undefined, at: string): string | undefined => {
    if (value === undefined || !value.startsWith('file:')) return value;
    const path = expandPath(value.slice('file:'.length), base);
    referenced.add(path);
    return readText(path, at);
  };

  const profiles: Record<string, AgentProfile> = {};
  for (const [name, profile] of Object.entries(raw.profiles ?? {})) {
    const context = (profile.context ?? []).map((entry) => resolveEntry(entry, base));
    for (const entry of context) {
      const path = entryPath(entry);
      if (path === undefined) continue;
      for (const found of /[*?[]/.test(path) ? [...globSync(path)] : [path]) referenced.add(found);
    }
    profiles[name] = {
      name,
      backend: profile.backend,
      ...(profile.model === undefined ? {} : { model: profile.model }),
      ...(profile.model_tier === undefined ? {} : { modelTier: profile.model_tier as ModelTier }),
      ...(profile.effort === undefined ? {} : { effort: profile.effort }),
      context,
      file: located.path,
    };
  }

  const choice = (entry: {
    readonly agent?: string | undefined;
    readonly model?: string | undefined;
    readonly model_tier?: string | undefined;
    readonly effort?: string | undefined;
  }): StrategyChoice => ({
    ...(entry.agent === undefined ? {} : { agent: entry.agent }),
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.model_tier === undefined ? {} : { tier: entry.model_tier as ModelTier }),
    ...(entry.effort === undefined ? {} : { effort: entry.effort }),
  });

  const reviewers = raw.reviewers.map((reviewer, index): StrategyReviewer => {
    const focus = readReference(reviewer.focus, `reviewers.${index}.focus`);
    return { id: reviewer.id, ...choice(reviewer), ...(focus === undefined ? {} : { focus }) };
  });
  const aggregatorPrompt = readReference(raw.aggregator?.prompt, 'aggregator.prompt');
  const aggregator: StrategyAggregator = {
    ...choice(raw.aggregator ?? {}),
    ...(aggregatorPrompt === undefined ? {} : { prompt: aggregatorPrompt }),
  };
  const defenderPrompt = readReference(raw.defender?.prompt, 'defender.prompt');
  const defender: StrategyDefender = {
    ...choice(raw.defender ?? {}),
    ...(defenderPrompt === undefined ? {} : { prompt: defenderPrompt }),
  };
  const mode = raw.mode ?? 'independent';

  const hash = createHash('sha256').update(text).update('\0');
  for (const path of [...referenced].sort()) {
    hash.update(relative(base, path)).update('\0');
    try {
      hash.update(readFileSync(path));
    } catch {
      hash.update('missing');
    }
    hash.update('\0');
  }

  return {
    origin: { ...located, name: raw.name, fingerprint: `sha256:${hash.digest('hex')}` },
    mode,
    ...(mode === 'defend' ? { rounds: raw.defend?.rounds ?? DEFAULT_DEFEND_ROUNDS, defender } : {}),
    reviewers,
    aggregator,
    profiles,
  };
}

/** Текст промаха стратегии — для отказа прогона и подсказки линта. */
export function describeStrategyUnresolved(unresolved: ReviewStrategyUnresolved): string {
  switch (unresolved.reason) {
    case 'not_found':
      return `стратегия ревью ${unresolved.name} не найдена; искали: ${unresolved.searched.join(', ')}`;
    case 'invalid':
      return `стратегия ревью ${unresolved.path}${unresolved.at === undefined ? '' : ` (${unresolved.at})`}: ${unresolved.detail}`;
    case 'name_mismatch':
      return `стратегия ${unresolved.path} объявляет name: ${unresolved.declared}, а ищется по имени ${unresolved.name}`;
  }
}
