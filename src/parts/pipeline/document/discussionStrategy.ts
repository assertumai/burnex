import { z } from 'zod';

import type { AgentProfile } from '../config/agentProfiles.js';
import { AgentProfileSchema, ProfileNameSchema } from '../config/schema.js';
import { AGGREGATOR_ID, AUTHOR_ID, DEFAULT_DISCUSS_ROUNDS, type ReviewStrategyOrigin } from './model.js';
import {
  BOTH_MODEL_FIELDS,
  ParticipantChoiceShape,
  PromptedParticipantSchema,
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

/**
 * Стратегия обсуждения (`discuss-step`, design.md, решение 1): кто предлагает,
 * кто сводит черновик и кто выносит итог, — отдельным документом
 * `kind: discussion-strategy`, на который шаг `discuss:` ссылается файлом или
 * именем. Слои, профили и отпечаток — те же, что у стратегии ревью
 * (`strategyDocument.ts`); роли и их имена — свои.
 */

const ParticipantSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'id участника — строчная буква, затем строчные буквы, цифры, дефис и подчёркивание'),
    ...ParticipantChoiceShape,
    focus: z.string().optional(),
  })
  .strict()
  .refine((value) => value.model === undefined || value.model_tier === undefined, { message: BOTH_MODEL_FIELDS })
  .meta({ not: { required: ['model', 'model_tier'] } });

const ROUNDS_RANGE = 'rounds — целое число от 1 до 5';

export const DiscussionStrategySchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('discussion-strategy'),
    name: ProfileNameSchema,
    description: z.string().optional(),
    profiles: z.record(ProfileNameSchema, AgentProfileSchema).optional(),
    participants: z.array(ParticipantSchema).min(1, 'стратегия объявляет хотя бы одного участника'),
    author: PromptedParticipantSchema.optional(),
    aggregator: PromptedParticipantSchema.optional(),
    rounds: z.number().int(ROUNDS_RANGE).min(1, ROUNDS_RANGE).max(5, ROUNDS_RANGE).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, participant] of value.participants.entries()) {
      if (participant.id === AUTHOR_ID || participant.id === AGGREGATOR_ID) {
        ctx.addIssue({
          code: 'custom',
          path: ['participants', index, 'id'],
          message: `id ${participant.id} занят ролью ${participant.id}: каталог журнала и адрес step_agents у них общие`,
        });
      }
      if (seen.has(participant.id)) {
        ctx.addIssue({ code: 'custom', path: ['participants', index, 'id'], message: `повторный id участника ${participant.id}` });
      }
      seen.add(participant.id);
    }
  });

export type RawDiscussionStrategy = z.infer<typeof DiscussionStrategySchema>;

export interface StrategyParticipant extends StrategyChoice {
  readonly id: string;
  readonly focus?: string;
}

/** Автор или агрегатор: выбор агента и дополнение к промпту. */
export interface StrategyPromptedRole extends StrategyChoice {
  readonly prompt?: string;
}

/** Прочитанная и проверенная стратегия обсуждения. */
export interface DiscussionStrategy {
  readonly origin: Required<Pick<ReviewStrategyOrigin, 'name' | 'layer' | 'path' | 'fingerprint'>> & ReviewStrategyOrigin;
  readonly rounds: number;
  readonly participants: readonly StrategyParticipant[];
  /** Не объявлен — профиль `default`. */
  readonly author: StrategyPromptedRole;
  /** Не объявлен — профиль `default`. */
  readonly aggregator: StrategyPromptedRole;
  readonly profiles: Readonly<Record<string, AgentProfile>>;
}

export type DiscussionStrategyResolution = StrategyLoad<DiscussionStrategy>;

const SUBDIR = 'discussion-strategies';

/** Каталоги слоёв стратегий обсуждения в порядке поиска: проект, затем дом. */
export function discussionLayerDirs(roots: StrategyRoots): readonly { readonly layer: 'project' | 'home'; readonly dir: string }[] {
  return layerDirsOf(SUBDIR, roots);
}

/** Разрешить ссылку шага `discuss` по слоям; промах — `unresolved` с диагностикой. */
export function resolveDiscussionStrategy(
  ref: string,
  declaringFile: string,
  roots: StrategyRoots,
  backendNames: readonly string[],
): DiscussionStrategyResolution {
  return resolveStrategyRef(ref, declaringFile, SUBDIR, roots, (located) =>
    loadDiscussionStrategy(located.ref, located.path, located.layer, backendNames),
  );
}

/** Прочитать стратегию по пути; найденная по имени обязана называть себя так же. */
export function loadDiscussionStrategy(
  ref: string,
  path: string,
  layer: 'project' | 'home' | 'explicit',
  backendNames: readonly string[],
): DiscussionStrategyResolution {
  return loadStrategyDocument({ ref, layer, path }, (text) => parseStrategyText(text, DiscussionStrategySchema, backendNames), buildStrategy);
}

/** Разобрать файл стратегии обсуждения, отказав `BurnexError` с файлом и путём ключа. */
export function parseDiscussionStrategyFile(path: string, backendNames: readonly string[]): RawDiscussionStrategy {
  return parseStrategyFileOrThrow(path, 'Стратегия обсуждения', (text) => parseStrategyText(text, DiscussionStrategySchema, backendNames));
}

function buildStrategy(
  raw: RawDiscussionStrategy,
  text: string,
  located: { readonly ref: string; readonly layer: 'project' | 'home' | 'explicit'; readonly path: string },
): DiscussionStrategy {
  const reader = new StrategyReader(text, located.path);
  const profiles = reader.profiles(raw.profiles, located.path);
  const participants = raw.participants.map((participant, index): StrategyParticipant => {
    const focus = reader.read(participant.focus, `participants.${index}.focus`);
    return { id: participant.id, ...choiceOf(participant), ...(focus === undefined ? {} : { focus }) };
  });
  const role = (entry: RawDiscussionStrategy['author'], at: string): StrategyPromptedRole => {
    const prompt = reader.read(entry?.prompt, `${at}.prompt`);
    return { ...choiceOf(entry ?? {}), ...(prompt === undefined ? {} : { prompt }) };
  };
  return {
    origin: { ...located, name: raw.name, fingerprint: reader.fingerprint() },
    rounds: raw.rounds ?? DEFAULT_DISCUSS_ROUNDS,
    participants,
    author: role(raw.author, 'author'),
    aggregator: role(raw.aggregator, 'aggregator'),
    profiles,
  };
}
