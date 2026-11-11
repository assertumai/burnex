import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { AGGREGATOR_ID, type AgentStep, type ReviewParticipant, type ReviewStep } from '../../document/model.js';
import {
  aggregatorAgentStep,
  aggregatorPrompt,
  reviewerAgentStep,
  type ReviewerFindings,
} from '../../steps/review/participants.js';
import type { AttemptRecord, EventInput, ExpectReport, PredicateResult, StatusValue } from '../journal/schema.js';

/**
 * Исполнение шага `review` в режиме `independent` (`review-strategies`,
 * design.md, решения 4–6): ревьюеры параллельно, каждый в своей сессии, затем
 * агрегатор, получающий все находки. Каждый участник — агентский шаг
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
}

/** Каталог участника внутри каталога шага. */
export function participantDir(stepDir: string, participant: string): string {
  return join(stepDir, 'participants', participant);
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
    runOne(options, reviewer, reviewerAgentStep(step, reviewer)),
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

  // Повтор шага — попытки агрегатора с теми же находками: находки — дорогая
  // часть, и их форма уже проверена (design.md, решение 5).
  const outcome = await runOne(options, aggregator, aggregatorAgentStep(step, aggregatorPrompt(step, findings)));
  return withoutSession(outcome);
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
): Promise<O> {
  const { journal, job, step } = options;
  const dir = participantDir(options.stepDir, participant.id);
  mkdirSync(dir, { recursive: true });
  journal.event({
    kind: 'review.participant.started',
    job,
    step: step.id,
    participant: participant.id,
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
    status: outcome.status,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  });
  return outcome;
}

/** Исполнить задачи не более чем по `limit` одновременно, сохранив порядок исходов. */
async function pool<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(limit), items.length)) }, worker));
  return results;
}
