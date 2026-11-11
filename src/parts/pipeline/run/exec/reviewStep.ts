import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { AGGREGATOR_ID, type AgentStep, type ReviewParticipant, type ReviewStep } from '../../document/model.js';
import {
  consensusAggregatorPrompt,
  discussionReplyAgentStep,
  noConsensusAggregatorPrompt,
  type DiscussionRecord,
  type ProposalRecord,
} from '../../steps/review/discussion.js';
import {
  aggregatorAgentStep,
  aggregatorPrompt,
  reviewerAgentStep,
  type ReviewerFindings,
} from '../../steps/review/participants.js';
import type { AttemptRecord, EventInput, ExpectReport, PredicateResult, StatusValue } from '../journal/schema.js';
import { pool, runDiscussion } from './reviewDiscussion.js';

/**
 * Исполнение шага `review` (`review-strategies`, design.md, решения 4–6):
 * ревьюеры параллельно, каждый в своей сессии, затем агрегатор, получающий все
 * находки. В режиме `discussion` (`review-discussion`) между ними идут раунды
 * обсуждения (`reviewDiscussion.ts`), и агрегатор получает согласованное
 * предложение либо всю ленту. Каждый участник — агентский шаг
 * (`steps/review/participants.ts`), запущенный тем же исполнением, что и
 * обычный агентский шаг прогона: вызывающий подаёт его как `runParticipant`,
 * и контекст, бюджет, отказы бэкенда и журнал попыток участник получает оттуда
 * же, а не копией.
 */

/** Исход участника — то, что отдаёт исполнение агентского шага прогона. */
export interface ParticipantOutcome {
  readonly status: StatusValue;
  readonly reason?: string;
  readonly attempts: readonly AttemptRecord[];
  readonly results: readonly (readonly PredicateResult[])[];
  readonly structured?: unknown;
  readonly session?: string;
}

/** Часть журнала прогона, которой пользуется шаг. */
export interface ReviewJournal {
  event(input: EventInput): void;
  writeStepJson(dir: string, name: string, value: unknown): string;
  writeExpectReport(dir: string, report: ExpectReport): string;
  appendStepLine(dir: string, name: string, value: unknown): string;
}

export interface ReviewStepOptions<O extends ParticipantOutcome> {
  readonly step: ReviewStep;
  readonly job: string;
  readonly stepDir: string;
  readonly journal: ReviewJournal;
  /**
   * Сколько ревьюеров идут одновременно — `limits.concurrency`. Вызовы
   * бэкенда сверх того подчиняются общему счёту мест бэкенда прогона, который
   * держит запуск агента, а не шаг.
   */
  readonly concurrency: number;
  /** Запустить участника как агентский шаг; `dir` — его каталог в журнале. */
  readonly runParticipant: (participant: ReviewParticipant, call: AgentStep, dir: string) => Promise<O>;
  /** Происхождение выбора агента участника — в его `step.json`. */
  readonly originOf?: (participant: string) => unknown;
  /**
   * Исход `budget_exceeded`, если бюджет шага уже перейдён, иначе ничего.
   * Первая попытка агентского шага запускается без проверки бюджета, поэтому
   * обсуждение спрашивает перед каждым раундом, а оборванное бюджетом —
   * перед агрегатором (`review-discussion`, решение 6).
   */
  readonly budgetStop?: () => O | undefined;
}

/** Лента обсуждения в каталоге шага (`review-discussion`, решение 1). */
export const DISCUSSION_FILE = 'discussion.ndjson';

/** Каталог участника внутри каталога шага. */
export function participantDir(stepDir: string, participant: string): string {
  return join(stepDir, 'participants', participant);
}

/** Каталог реплики ревьюера в раунде обсуждения `round` ≥ 1. */
export function replyDir(stepDir: string, participant: string, round: number): string {
  return join(participantDir(stepDir, participant), 'rounds', String(round));
}

/**
 * Исполнить шаг. Исход шага — исход агрегатора: его выход, попытки и
 * результаты `expect`. Отказ ревьюера шага не роняет — агрегатор получает
 * отметку и причину. Шаг проваливается без агрегатора, если находок не дал
 * ни один ревьюер, и останавливается, если ревьюера оборвали бюджет или
 * отмена: бюджет шага общий, и следующий участник упёрся бы в тот же потолок.
 */
export async function executeReviewStep<O extends ParticipantOutcome>(
  options: ReviewStepOptions<O>,
): Promise<O | ParticipantOutcome> {
  const { step } = options;
  const aggregator = step.aggregator;
  if (aggregator === undefined) throw new Error('executeReviewStep: стратегия шага не разрешена');

  const reviewerOutcomes = await pool(step.reviewers, options.concurrency, (reviewer) =>
    runOne(options, reviewer, reviewerAgentStep(step, reviewer), participantDir(options.stepDir, reviewer.id)),
  );

  const stopped = reviewerOutcomes.find((outcome) => outcome.status === 'canceled' || outcome.status === 'budget_exceeded');
  if (stopped !== undefined) return withoutSession(stopped);

  const findings: ReviewerFindings[] = step.reviewers.map((reviewer, index) => {
    const outcome = reviewerOutcomes[index] as O;
    const focus = reviewer.focus === undefined ? {} : { focus: reviewer.focus };
    return outcome.status === 'success' && outcome.structured !== undefined
      ? { id: reviewer.id, ...focus, findings: outcome.structured }
      : { id: reviewer.id, ...focus, failure: outcome.reason ?? `статус ${outcome.status}` };
  });

  if (findings.every((entry) => 'failure' in entry)) {
    const named = findings.map((entry) => `${entry.id}: ${'failure' in entry ? entry.failure : ''}`).join('; ');
    return { status: 'failed', reason: `ни один ревьюер не дал находок — ${named}`, attempts: [], results: [] };
  }

  const prompt =
    step.mode === 'discussion' ? await discuss(options, findings) : aggregatorPrompt(step, findings);
  if (typeof prompt !== 'string') return withoutSession(prompt);

  // Повтор шага — попытки агрегатора с теми же находками либо тем же
  // обсуждением: это дорогая часть, и её форма уже проверена
  // (`review-strategies`, решение 5; `review-discussion`, решение 6).
  const outcome = await runOne(
    options,
    aggregator,
    aggregatorAgentStep(step, prompt),
    participantDir(options.stepDir, AGGREGATOR_ID),
  );
  return withoutSession(outcome);
}

/**
 * Режим `discussion`: раунды обсуждения ревьюеров, давших находки, затем
 * промпт агрегатора — согласованное предложение либо вся лента. Исход
 * участника вместо промпта — обсуждение оборвали отмена или бюджет, на
 * агрегатора которого уже не хватает.
 */
async function discuss<O extends ParticipantOutcome>(
  options: ReviewStepOptions<O>,
  findings: readonly ReviewerFindings[],
): Promise<string | O> {
  const { step, journal } = options;
  const participants = step.reviewers.flatMap((reviewer, index) => {
    const entry = findings[index];
    return entry === undefined || 'failure' in entry ? [] : [{ reviewer, findings: entry.findings }];
  });
  const failures = findings.flatMap((entry) => ('failure' in entry ? [{ id: entry.id, failure: entry.failure }] : []));

  const result = await runDiscussion<O>({
    job: options.job,
    step: step.id,
    maxMessages: step.maxMessages ?? 1,
    participants,
    concurrency: options.concurrency,
    budgetLeft: () => options.budgetStop?.() === undefined,
    record: (record: DiscussionRecord) => journal.appendStepLine(options.stepDir, DISCUSSION_FILE, record),
    event: (input) => journal.event(input),
    reply: (reviewer, round, prompt, check) => {
      const dir = replyDir(options.stepDir, reviewer.id, round);
      mkdirSync(dir, { recursive: true });
      const checkPath = journal.writeStepJson(dir, 'reply-check.schema.json', check);
      return runOne(options, reviewer, discussionReplyAgentStep(step, reviewer, prompt, checkPath), dir, round);
    },
  });
  if ('canceled' in result) return result.canceled;
  const { outcome } = result;
  if (!outcome.consensus && outcome.reason === 'budget') {
    const stop = options.budgetStop?.() ?? result.interrupted;
    if (stop !== undefined) return stop;
  }

  if (!outcome.consensus) return noConsensusAggregatorPrompt(step, outcome.reason, result.records, result.positions, failures);
  const proposal = result.records.find(
    (record): record is ProposalRecord => record.kind === 'proposal' && record.id === outcome.proposal,
  );
  if (proposal === undefined) throw new Error(`discuss: согласованное предложение ${outcome.proposal} не записано`);
  return consensusAggregatorPrompt(step, proposal);
}

/** Сессии участников живут внутри шага: продолжать их следующему шагу нечего. */
function withoutSession<T extends ParticipantOutcome>(outcome: T): T {
  if (outcome.session === undefined) return outcome;
  const { session: _session, ...rest } = outcome;
  return rest as T;
}

async function runOne<O extends ParticipantOutcome>(
  options: ReviewStepOptions<O>,
  participant: ReviewParticipant,
  call: AgentStep,
  dir: string,
  round?: number,
): Promise<O> {
  const { journal, job, step } = options;
  const roundField = round === undefined ? {} : { round };
  mkdirSync(dir, { recursive: true });
  journal.event({
    kind: 'review.participant.started',
    job,
    step: step.id,
    participant: participant.id,
    ...roundField,
    agent: call.agent,
    ...(call.model === undefined ? {} : { model: call.model }),
  });

  const outcome = await options.runParticipant(participant, call, dir);

  for (const [index, results] of outcome.results.entries()) {
    journal.writeExpectReport(dir, { attempt: index + 1, results: [...results] });
  }
  const origin = options.originOf?.(participant.id);
  journal.writeStepJson(dir, 'step.json', {
    participant: participant.id,
    role: participant.id === AGGREGATOR_ID ? 'aggregator' : 'reviewer',
    ...roundField,
    agent: call.agent,
    ...(call.model === undefined ? {} : { model: call.model }),
    ...(call.effort === undefined ? {} : { effort: call.effort }),
    ...(participant.profile === undefined ? {} : { profile: participant.profile }),
    ...(participant.localProfile === true ? { local_profile: true } : {}),
    ...(origin === undefined ? {} : { origin }),
    ...(participant.focus === undefined ? {} : { focus: participant.focus }),
    session: call.session,
    ...(outcome.session === undefined ? {} : { session_id: outcome.session }),
    status: outcome.status,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    attempts: outcome.attempts,
  });
  if (outcome.structured !== undefined) journal.writeStepJson(dir, 'output.json', outcome.structured);

  journal.event({
    kind: 'review.participant.finished',
    job,
    step: step.id,
    participant: participant.id,
    ...roundField,
    status: outcome.status,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  });
  return outcome;
}
