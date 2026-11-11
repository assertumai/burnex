import { readFileSync } from 'node:fs';

import { packagedSchemaPath } from '../../domain/package-schema.js';
import type { AgentStep, ReviewParticipant, ReviewStep } from '../../document/model.js';
import { participantSession } from './participants.js';

/**
 * Обсуждение ревьюеров (`review-discussion`): записи ленты, вычисление
 * консенсуса и промпты участников. Порядок раундов, параллельность и журнал —
 * в исполнении шага (`run/exec/reviewDiscussion.ts`); здесь — то, что от
 * исполнения не зависит и проверяется без бэкенда.
 */

export type Stance = 'propose' | 'agree' | 'disagree';

/** Предложение итога ревью: находки по схеме находок. */
export interface ProposalRecord {
  readonly kind: 'proposal';
  readonly id: string;
  readonly by: string;
  readonly round: number;
  readonly content: unknown;
}

/**
 * Реплика в форме A2A `Message` (`messageId`, `role`, `parts`) с метаданными
 * движка (design.md, решение 1). `seq` — порядковый номер реплики в её раунде,
 * с единицы; `invalid` — реплика дважды не прошла схему и засчитана
 * позицией `disagree` без текста.
 */
export interface MessageRecord {
  readonly kind: 'message';
  readonly messageId: string;
  readonly role: 'agent';
  readonly from: string;
  readonly round: number;
  readonly seq: number;
  readonly parts: readonly { readonly kind: 'text'; readonly text: string }[];
  readonly stance: Stance;
  readonly proposal?: string;
  readonly target?: string;
  readonly replyTo?: readonly string[];
  readonly invalid?: true;
}

/**
 * Почему обсуждение кончилось без согласия: исчерпан лимит у всех, раунд не
 * изменил позиций, кончился бюджет шага, либо участвует меньше двух ревьюеров
 * (остальные не дали находок) — обсуждать некому.
 */
export type NoConsensusReason = 'limit' | 'stalled' | 'budget' | 'participants';

export type OutcomeRecord =
  | { readonly kind: 'outcome'; readonly consensus: true; readonly proposal: string }
  | { readonly kind: 'outcome'; readonly consensus: false; readonly reason: NoConsensusReason };

export type DiscussionRecord = ProposalRecord | MessageRecord | OutcomeRecord;

/** Реплика ревьюера по схеме реплики — то, что вернул бэкенд. */
export interface ReplyPayload {
  readonly text: string;
  readonly stance: Stance;
  readonly proposal: unknown;
  readonly target: string | null;
  readonly reply_to: readonly string[] | null;
}

/** Встроенная схема реплики (`schema/review-message.schema.json`) — её получает бэкенд. */
export function reviewMessageSchemaPath(): string {
  return packagedSchemaPath('review-message');
}

/**
 * Схема проверки реплики: встроенная схема плюс то, что статической схемой
 * не выразить (бэкенды со строгим структурным выходом не принимают
 * условий): при `propose` — предложение, при `agree`/`disagree` — цель из
 * известных предложений, `reply_to` — из известных реплик. Невалидная
 * реплика получает повтор с этой ошибкой, как всякая ошибка схемы.
 */
export function replyCheckSchema(proposalIds: readonly string[], messageIds: readonly string[]): unknown {
  const base = JSON.parse(readFileSync(reviewMessageSchemaPath(), 'utf8')) as Record<string, unknown>;
  return {
    ...base,
    allOf: [
      {
        if: { properties: { stance: { const: 'propose' } } },
        then: { properties: { proposal: { type: 'object' } } },
        else: { properties: { target: { enum: [...proposalIds] } } },
      },
      { properties: { reply_to: { anyOf: [{ type: 'null' }, { type: 'array', items: { enum: [...messageIds] } }] } } },
    ],
  };
}

/** Действующая позиция как значение для сравнения раундов. */
export function positionKey(message: MessageRecord): string {
  return message.stance === 'propose' ? `propose:${message.proposal ?? ''}` : `${message.stance}:${message.target ?? ''}`;
}

/**
 * Консенсус по действующим позициям (design.md, решение 4): предложение, с
 * которым согласен каждый участник — его последняя реплика `agree` на него
 * либо он его автор и после него не высказывался. Модель не участвует.
 */
export function findConsensus(positions: ReadonlyMap<string, MessageRecord>): string | undefined {
  const supported = (message: MessageRecord): string | undefined =>
    message.stance === 'agree' ? message.target : message.stance === 'propose' ? message.proposal : undefined;
  const [first, ...rest] = [...positions.values()].map(supported);
  if (first === undefined || rest.some((proposal) => proposal !== first)) return undefined;
  return first;
}

function describeMessage(message: MessageRecord, proposals: ReadonlyMap<string, ProposalRecord>): string {
  const stance =
    message.invalid === true
      ? 'disagree (реплика не прошла схему и засчитана несогласием)'
      : message.stance === 'propose'
        ? `propose — предложение ${message.proposal ?? ''}`
        : `${message.stance} с ${message.target ?? ''}`;
  const head = `### ${message.messageId} — \`${message.from}\`, раунд ${message.round}: ${stance}`;
  const replyTo = message.replyTo === undefined || message.replyTo.length === 0 ? '' : `\n\nВ ответ на: ${message.replyTo.join(', ')}`;
  const text = message.parts.map((part) => part.text).join('\n').trim();
  const proposal = message.proposal === undefined ? undefined : proposals.get(message.proposal);
  const content =
    message.stance === 'propose' && proposal !== undefined
      ? `\n\nПредложение ${proposal.id}:\n\n\`\`\`json\n${JSON.stringify(proposal.content, null, 2)}\n\`\`\``
      : '';
  return `${head}${replyTo}${text === '' ? '' : `\n\n${text}`}${content}`;
}

function describeProposals(proposals: ReadonlyMap<string, ProposalRecord>): string {
  return [...proposals.values()].map((proposal) => `${proposal.id} (\`${proposal.by}\`, раунд ${proposal.round})`).join(', ');
}

const REPLY_INSTRUCTION = [
  '## Форма ответа',
  '',
  'Ответь ровно одной репликой по схеме реплики:',
  '- `text` — твой довод;',
  '- `stance` — `propose` (новое предложение итога), `agree` (согласен с предложением целиком) или `disagree`;',
  '- `proposal` — при `propose`: итог ревью по схеме находок (`summary` и `findings`), иначе null;',
  '- `target` — при `agree` и `disagree`: id предложения (p1, p2, …), иначе null;',
  '- `reply_to` — id реплик (m1, m2, …), на которые отвечаешь, либо null.',
  '',
  'Ссылайся только на предложения и реплики, названные в этом промпте и прежних: реплики других ревьюеров этого',
  'раунда пишутся одновременно с твоей, и их ты увидишь в следующем.',
  '',
  'Соглашайся только с конкретным предложением, каждую находку и серьёзность которого принимаешь: ложное согласие',
  'уводит в итог ошибку, которую никто уже не оспорит. Не согласен — предложи свой вариант или объясни несогласие.',
  'Файлы не правь.',
].join('\n');

/**
 * Промпт реплики (design.md, решение 3): сессия ревьюера возобновляется, и
 * он получает только новые реплики остальных — прежние уже в его сессии.
 */
export function discussionReplyPrompt(options: {
  readonly round: number;
  readonly fresh: readonly MessageRecord[];
  readonly proposals: ReadonlyMap<string, ProposalRecord>;
  readonly own?: MessageRecord;
  readonly remaining: number;
}): string {
  const fresh = options.fresh.map((message) => describeMessage(message, options.proposals));
  return [
    [
      `## Обсуждение ревью — раунд ${options.round}`,
      '',
      'Ты обсуждаешь итог ревью с другими ревьюерами. Цель — согласиться об одном предложении итога.',
      `Предложения: ${describeProposals(options.proposals)}.`,
      options.own === undefined ? undefined : `Твоя последняя реплика — ${options.own.messageId}: ${positionKey(options.own).replace(':', ' ')}.`,
      `Реплик у тебя осталось: ${options.remaining}, включая эту.`,
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n'),
    fresh.length === 0 ? '## Новых реплик нет' : `## Новые реплики\n\n${fresh.join('\n\n')}`,
    REPLY_INSTRUCTION,
  ].join('\n\n');
}

/**
 * Реплика ревьюера как агентский шаг: та же сессия `<шаг>/<ревьюер>`, что у
 * его независимого ревью; бэкенд получает встроенную схему реплики, проверка —
 * схему с целями (`checkSchemaPath`), и невалидная реплика получает один повтор
 * с ошибкой. Контекст шага уже в сессии и не повторяется.
 */
export function discussionReplyAgentStep(
  step: ReviewStep,
  reviewer: ReviewParticipant,
  prompt: string,
  checkSchemaPath: string,
): AgentStep {
  return {
    id: step.id,
    index: step.index,
    env: step.env,
    context: [],
    contextInherit: step.contextInherit,
    contextExclude: step.contextExclude,
    ...(step.contextMaxTokens === undefined ? {} : { contextMaxTokens: step.contextMaxTokens }),
    timeoutMs: step.timeoutMs,
    kind: 'agent',
    agent: reviewer.agent,
    ...(reviewer.model === undefined ? {} : { model: reviewer.model }),
    ...(reviewer.effort === undefined ? {} : { effort: reviewer.effort }),
    session: participantSession(step, reviewer.id),
    ...(step.permissions === undefined ? {} : { permissions: step.permissions }),
    prompt,
    outputSchemaPath: reviewMessageSchemaPath(),
    expect: [{ kind: 'schema', path: checkSchemaPath }],
    attempts: { max: 2, escalation: [{ includeFailure: true }] },
  };
}

const NO_CONSENSUS_REASON: Readonly<Record<NoConsensusReason, string>> = {
  limit: 'у всех ревьюеров исчерпан лимит реплик',
  stalled: 'раунд не изменил ни одной позиции',
  budget: 'кончился бюджет шага',
  participants: 'находки дал только один ревьюер — обсуждать было некому',
};

function strategyGuidance(step: ReviewStep): string | undefined {
  return step.aggregator?.prompt === undefined ? undefined : `## Указания стратегии\n\n${step.aggregator.prompt}`;
}

function joinParts(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join('\n\n');
}

/**
 * Промпт агрегатора при консенсусе (design.md, решение 5): согласованное
 * предложение и обязанность оформить его по схеме выхода, не меняя решения.
 */
export function consensusAggregatorPrompt(step: ReviewStep, proposal: ProposalRecord): string {
  return joinParts([
    step.prompt,
    `## Согласованное предложение ${proposal.id}\n\nРевьюеры пришли к консенсусу по предложению ${proposal.id} (автор \`${proposal.by}\`):\n\n\`\`\`json\n${JSON.stringify(proposal.content, null, 2)}\n\`\`\``,
    strategyGuidance(step),
    [
      '## Твоя роль',
      '',
      'Ты — агрегатор ревью. Ревьюеры согласовали итог, и права отклонить консенсус у тебя нет: оформи предложение',
      `${proposal.id} строго по схеме выхода шага, не меняя решения — не добавляй и не убирай находки, не меняй их`,
      'серьёзность. Файлы не правь.',
    ].join('\n'),
  ]);
}

/**
 * Промпт агрегатора без консенсуса: вся лента обсуждения, действующие
 * позиции ревьюеров и причина, по которой согласия нет; решение — за ним.
 */
export function noConsensusAggregatorPrompt(
  step: ReviewStep,
  reason: NoConsensusReason,
  records: readonly DiscussionRecord[],
  positions: ReadonlyMap<string, MessageRecord>,
  failures: readonly { readonly id: string; readonly failure: string }[],
): string {
  const proposals = new Map(
    records.flatMap((record) => (record.kind === 'proposal' ? [[record.id, record] as const] : [])),
  );
  const feed = records.flatMap((record) => (record.kind === 'message' ? [describeMessage(record, proposals)] : []));
  const standing = [...positions].map(([id, message]) => `- \`${id}\`: ${positionKey(message).replace(':', ' ')} (${message.messageId})`);
  return joinParts([
    step.prompt,
    `## Обсуждение ревьюеров\n\nСогласия нет: ${NO_CONSENSUS_REASON[reason]}.\n\n${feed.join('\n\n')}`,
    `## Действующие позиции\n\n${standing.join('\n')}`,
    failures.length === 0
      ? undefined
      : `## Ревьюеры без находок\n\n${failures.map((entry) => `- \`${entry.id}\`: ${entry.failure}`).join('\n')}`,
    strategyGuidance(step),
    [
      '## Твоя роль',
      '',
      'Ты — агрегатор ревью. Ревьюеры не пришли к согласию: взвесь предложения и доводы сторон, объедини повторы,',
      'отбрось необоснованное и вынеси итог сам, строго по схеме выхода шага. Файлы не правь.',
    ].join('\n'),
  ]);
}
