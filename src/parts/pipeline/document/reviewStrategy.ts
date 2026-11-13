import { z } from 'zod';

import type { AgentProfile } from '../config/agentProfiles.js';
import { AgentProfileSchema, ProfileNameSchema } from '../config/schema.js';
import { AGGREGATOR_ID, DEFAULT_DEFEND_ROUNDS, DEFENDER_ID, REVIEW_MODES, type ReviewStrategyOrigin, type ReviewMode, type ReviewStrategyUnresolved } from './model.js';
import {
  BOTH_MODEL_FIELDS,
  ParticipantChoiceShape,
  PromptedParticipantSchema,
  StrategyError,
  StrategyReader,
  choiceOf,
  layerDirsOf,
  loadStrategyDocument,
  parseStrategyFileOrThrow,
  parseStrategyText,
  resolveStrategyRef,
  type StrategyChoice,
  type StrategyLoad,
  type StrategyRoots,
} from './strategyDocument.js';

export { isStrategyPath, type StrategyChoice, type StrategyRoots } from './strategyDocument.js';

/**
 * Стратегия ревью (`review-strategies`, design.md, решения 1 и 2): кто
 * ревьюит, с каким фокусом и кто сводит итог, — отдельным документом, на
 * который шаг `review:` ссылается файлом или именем. Модуль читает документ,
 * проверяет его и разрешает ссылку по слоям; участников в агентов раскрывает
 * разбор шага (`expand.ts`), тем же `resolveAgentChoice`, что агентский шаг.
 */

const ReviewerSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'id ревьюера — строчная буква, затем строчные буквы, цифры, дефис и подчёркивание'),
    ...ParticipantChoiceShape,
    focus: z.string().optional(),
  })
  .strict()
  .refine((value) => value.model === undefined || value.model_tier === undefined, { message: BOTH_MODEL_FIELDS })
  .meta({ not: { required: ['model', 'model_tier'] } });

const AggregatorSchema = PromptedParticipantSchema;

const DefenderSchema = PromptedParticipantSchema;

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

export type StrategyResolution = StrategyLoad<ReviewStrategy>;

const SUBDIR = 'review-strategies';

/** Каталоги слоёв стратегий в порядке поиска: проект, затем дом. */
export function strategyLayerDirs(roots: StrategyRoots): readonly { readonly layer: 'project' | 'home'; readonly dir: string }[] {
  return layerDirsOf(SUBDIR, roots);
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
  return resolveStrategyRef(ref, declaringFile, SUBDIR, roots, (located) =>
    loadReviewStrategy(located.ref, located.path, located.layer, backendNames),
  );
}

/** Прочитать стратегию по пути; найденная по имени обязана называть себя так же. */
export function loadReviewStrategy(
  ref: string,
  path: string,
  layer: 'project' | 'home' | 'explicit',
  backendNames: readonly string[],
): StrategyResolution {
  return loadStrategyDocument({ ref, layer, path }, (text) => parseStrategy(text, backendNames), buildStrategy);
}

/**
 * Разобрать текст стратегии. Прежний `mode: discussion` приходит вместе со
 * своим блоком `discussion`, и строгая схема первой назвала бы незнакомый
 * ключ. Автору нужен отказ у `mode` с подсказкой о замене (`review-defend`,
 * решение 1).
 */
function parseStrategy(text: string, backendNames: readonly string[]): RawReviewStrategy {
  return parseStrategyText(text, ReviewStrategySchema, backendNames, (issues) => {
    const mode = issues.find((issue) => issue.path.length === 1 && issue.path[0] === 'mode');
    return mode === undefined ? undefined : new StrategyError(mode.message, 'mode');
  });
}

/** Разобрать файл стратегии, отказав `BurnexError` с файлом и путём ключа. */
export function parseReviewStrategyFile(path: string, backendNames: readonly string[]): RawReviewStrategy {
  return parseStrategyFileOrThrow(path, 'Стратегия ревью', (text) => parseStrategy(text, backendNames));
}

function buildStrategy(
  raw: RawReviewStrategy,
  text: string,
  located: { readonly ref: string; readonly layer: 'project' | 'home' | 'explicit'; readonly path: string },
): ReviewStrategy {
  const reader = new StrategyReader(text, located.path);
  const profiles = reader.profiles(raw.profiles, located.path);
  const reviewers = raw.reviewers.map((reviewer, index): StrategyReviewer => {
    const focus = reader.read(reviewer.focus, `reviewers.${index}.focus`);
    return { id: reviewer.id, ...choiceOf(reviewer), ...(focus === undefined ? {} : { focus }) };
  });
  const aggregatorPrompt = reader.read(raw.aggregator?.prompt, 'aggregator.prompt');
  const aggregator: StrategyAggregator = {
    ...choiceOf(raw.aggregator ?? {}),
    ...(aggregatorPrompt === undefined ? {} : { prompt: aggregatorPrompt }),
  };
  const defenderPrompt = reader.read(raw.defender?.prompt, 'defender.prompt');
  const defender: StrategyDefender = {
    ...choiceOf(raw.defender ?? {}),
    ...(defenderPrompt === undefined ? {} : { prompt: defenderPrompt }),
  };
  const mode = raw.mode ?? 'independent';
  return {
    origin: { ...located, name: raw.name, fingerprint: reader.fingerprint() },
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
