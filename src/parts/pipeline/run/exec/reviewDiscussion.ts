import type { ReviewParticipant } from '../../document/model.js';
import {
  discussionReplyPrompt,
  findConsensus,
  positionKey,
  replyCheckSchema,
  type DiscussionRecord,
  type MessageRecord,
  type NoConsensusReason,
  type OutcomeRecord,
  type ProposalRecord,
  type ReplyPayload,
} from '../../steps/review/discussion.js';
import type { EventInput } from '../journal/schema.js';
import type { ParticipantOutcome } from './reviewStep.js';

/**
 * Раунды обсуждения ревьюеров (`review-discussion`, design.md, решения 1–4).
 * Движок — посредник: возобновляет сессию каждого ревьюера с новыми репликами
 * остальных и ждёт одну реплику. Лимит, порядок записей и консенсус — его, а
 * не просьба в промпте.
 */

export interface DiscussionParticipant {
  readonly reviewer: ReviewParticipant;
  /** Находки независимого ревью — первое предложение ревьюера. */
  readonly findings: unknown;
}

export interface DiscussionOptions<O extends ParticipantOutcome> {
  readonly job: string;
  readonly step: string;
  readonly maxMessages: number;
  /** Участники в порядке стратегии: ревьюеры, давшие находки. */
  readonly participants: readonly DiscussionParticipant[];
  readonly concurrency: number;
  /** Позволяет ли бюджет шага новый раунд. */
  readonly budgetLeft: () => boolean;
  /** Записать запись ленты (`discussion.ndjson`). */
  readonly record: (record: DiscussionRecord) => void;
  readonly event: (input: EventInput) => void;
  /** Получить реплику ревьюера: промпт и схема проверки реплики. */
  readonly reply: (reviewer: ReviewParticipant, round: number, prompt: string, check: unknown) => Promise<O>;
}

export interface DiscussionResult<O extends ParticipantOutcome> {
  readonly records: readonly DiscussionRecord[];
  readonly outcome: OutcomeRecord;
  /** Действующие позиции участников к концу обсуждения. */
  readonly positions: ReadonlyMap<string, MessageRecord>;
  /** Исход реплики, оборванной бюджетом посреди раунда. */
  readonly interrupted?: O;
}

/** Обсуждение оборвала отмена прогона: исхода нет, шаг отменён. */
export interface DiscussionCanceled<O extends ParticipantOutcome> {
  readonly canceled: O;
}

export async function runDiscussion<O extends ParticipantOutcome>(
  options: DiscussionOptions<O>,
): Promise<DiscussionResult<O> | DiscussionCanceled<O>> {
  const records: DiscussionRecord[] = [];
  const messages: MessageRecord[] = [];
  const proposals = new Map<string, ProposalRecord>();
  const positions = new Map<string, MessageRecord>();
  const remaining = new Map(options.participants.map(({ reviewer }) => [reviewer.id, options.maxMessages]));
  // Сколько реплик ленты ревьюер уже получил: реплики своего же раунда шли
  // параллельно с его собственной, и он их ещё не видел.
  const delivered = new Map(options.participants.map(({ reviewer }) => [reviewer.id, 0]));

  const write = (record: DiscussionRecord): void => {
    records.push(record);
    options.record(record);
  };
  const addProposal = (by: string, round: number, content: unknown): string => {
    const id = `p${proposals.size + 1}`;
    const proposal: ProposalRecord = { kind: 'proposal', id, by, round, content };
    proposals.set(id, proposal);
    write(proposal);
    return id;
  };
  const addMessage = (message: Omit<MessageRecord, 'kind' | 'messageId' | 'role'>): MessageRecord => {
    const record: MessageRecord = { kind: 'message', messageId: `m${messages.length + 1}`, role: 'agent', ...message };
    messages.push(record);
    positions.set(record.from, record);
    write(record);
    options.event({
      kind: 'review.message',
      job: options.job,
      step: options.step,
      participant: record.from,
      round: record.round,
      message_id: record.messageId,
      stance: record.stance,
      ...(record.proposal === undefined ? {} : { proposal: record.proposal }),
      ...(record.target === undefined ? {} : { target: record.target }),
      ...(record.invalid === true ? { invalid: true as const } : {}),
    });
    return record;
  };
  const finish = (outcome: OutcomeRecord, interrupted?: O): DiscussionResult<O> => {
    write(outcome);
    options.event(
      outcome.consensus
        ? { kind: 'review.consensus', job: options.job, step: options.step, proposal: outcome.proposal }
        : { kind: 'review.no_consensus', job: options.job, step: options.step, reason: outcome.reason },
    );
    return { records, outcome, positions, ...(interrupted === undefined ? {} : { interrupted }) };
  };
  const noConsensus = (reason: NoConsensusReason, interrupted?: O): DiscussionResult<O> =>
    finish({ kind: 'outcome', consensus: false, reason }, interrupted);

  // Раунд 0: находки независимого ревью — первые предложения, лимит не тратят.
  for (const [index, { reviewer, findings }] of options.participants.entries()) {
    const proposal = addProposal(reviewer.id, 0, findings);
    addMessage({ from: reviewer.id, round: 0, seq: index + 1, parts: [{ kind: 'text', text: summaryOf(findings) }], stance: 'propose', proposal });
  }
  if (options.participants.length < 2) return noConsensus('participants');

  for (let round = 1; ; round += 1) {
    const speakers = options.participants.filter(({ reviewer }) => (remaining.get(reviewer.id) ?? 0) > 0);
    if (speakers.length === 0) return noConsensus('limit');
    if (!options.budgetLeft()) return noConsensus('budget');

    const check = replyCheckSchema([...proposals.keys()], messages.map((message) => message.messageId));
    const prompts = speakers.map(({ reviewer }) => {
      const fresh = messages.slice(delivered.get(reviewer.id) ?? 0).filter((message) => message.from !== reviewer.id);
      delivered.set(reviewer.id, messages.length);
      const own = positions.get(reviewer.id);
      return discussionReplyPrompt({
        round,
        fresh,
        proposals,
        ...(own === undefined ? {} : { own }),
        remaining: remaining.get(reviewer.id) ?? 0,
      });
    });
    const outcomes = await pool(speakers, options.concurrency, (speaker, index) =>
      options.reply(speaker.reviewer, round, prompts[index] as string, check),
    );

    const canceled = outcomes.find((outcome) => outcome.status === 'canceled');
    if (canceled !== undefined) return { canceled };

    // Записи раунда — в порядке ревьюеров стратегии, как бы ни легли ответы.
    let changed = false;
    let budget: O | undefined;
    let seq = 0;
    for (const [index, { reviewer }] of speakers.entries()) {
      const outcome = outcomes[index] as O;
      if (outcome.status === 'budget_exceeded') {
        budget ??= outcome;
        continue;
      }
      seq += 1;
      remaining.set(reviewer.id, (remaining.get(reviewer.id) ?? 0) - 1);
      const before = positions.get(reviewer.id);
      const payload = outcome.status === 'success' ? (outcome.structured as ReplyPayload | undefined) : undefined;
      const message =
        payload === undefined
          ? addMessage({ from: reviewer.id, round, seq, parts: [], stance: 'disagree', invalid: true })
          : addMessage({
              from: reviewer.id,
              round,
              seq,
              parts: [{ kind: 'text', text: payload.text }],
              stance: payload.stance,
              ...(payload.stance === 'propose'
                ? { proposal: addProposal(reviewer.id, round, payload.proposal) }
                : payload.target === null
                  ? {}
                  : { target: payload.target }),
              ...(payload.reply_to === null || payload.reply_to.length === 0 ? {} : { replyTo: [...payload.reply_to] }),
            });
      if (before === undefined || positionKey(before) !== positionKey(message)) changed = true;
    }

    const consensus = findConsensus(positions);
    if (consensus !== undefined) return finish({ kind: 'outcome', consensus: true, proposal: consensus });
    if (budget !== undefined) return noConsensus('budget', budget);
    if ([...remaining.values()].every((left) => left <= 0)) return noConsensus('limit');
    if (!changed) return noConsensus('stalled');
  }
}

function summaryOf(findings: unknown): string {
  const summary = (findings as { readonly summary?: unknown } | null)?.summary;
  return typeof summary === 'string' ? summary : '';
}

/** Исполнить задачи не более чем по `limit` одновременно, сохранив порядок исходов. */
export async function pool<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(limit), items.length)) }, worker));
  return results;
}
