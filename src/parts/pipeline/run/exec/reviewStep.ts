import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  AGGREGATOR_ID,
  DEFAULT_DEFEND_ROUNDS,
  DEFENDER_ID,
  type AgentStep,
  type ReviewParticipant,
  type ReviewStep,
} from '../../document/model.js';
import {
  defendAggregatorPrompt,
  defenderCallBase,
  defenderPrompt,
  findingsOf,
  rebuttalPrompt,
  turnAgentStep,
  turnCheckSchema,
  type DefenseRecord,
} from '../../steps/review/defend.js';
import {
  aggregatorAgentStep,
  aggregatorPrompt,
  participantStep,
  reviewerAgentStep,
  reviewerTask,
  type ReviewerFindings,
} from '../../steps/review/participants.js';
import type { AttemptRecord, EventInput, ExpectReport, PredicateResult, StatusValue } from '../journal/schema.js';
import { pool, runDefense, type DefenderChoice } from './reviewDefense.js';

export type { DefenderChoice } from './reviewDefense.js';

/**
 * Исполнение шага `review` (`review-strategies`, design.md, решения 4–6):
 * ревьюеры параллельно, каждый в своей сессии, затем агрегатор, получающий все
 * находки. В режиме `defend` (`review-defend`) между ними идут общие раунды
 * защиты находок имплементатором (`reviewDefense.ts`), и агрегатор получает каждую
 * находку со статусом и перепиской. Каждый участник — агентский шаг
 * (`steps/review/participants.ts`, `steps/review/defend.ts`), запущенный тем
 * же исполнением, что и обычный агентский шаг прогона: вызывающий подаёт его
 * как `runParticipant`, и контекст, бюджет, отказы бэкенда и журнал попыток
 * участник получает оттуда же, а не копией.
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
   * Сколько ревьюеров идут одновременно, в том числе с ответами защите, —
   * `limits.concurrency`. Вызовы бэкенда сверх того подчиняются общему счёту
   * мест бэкенда прогона, который держит запуск агента, а не шаг.
   */
  readonly concurrency: number;
  /** Запустить участника как агентский шаг; `dir` — его каталог в журнале. */
  readonly runParticipant: (participant: ReviewParticipant, call: AgentStep, dir: string) => Promise<O>;
  /** Происхождение выбора агента участника — в его `step.json`. */
  readonly originOf?: (participant: string) => unknown;
  /**
   * Исход `budget_exceeded`, если бюджет шага уже перейдён, иначе ничего.
   * Первая попытка агентского шага запускается без проверки бюджета, поэтому
   * защита спрашивает перед каждым ходом и перед агрегатором
   * (`review-defend`, решение 5).
   */
  readonly budgetStop?: () => O | undefined;
  /** Возобновляется ли сессия агента — умеет ли его бэкенд сессии. Без значения — умеет. */
  readonly resumable?: (agent: string) => boolean;
  /**
   * Защитник режима `defend`, выбранный один раз до раундов
   * (`review-defend-shared-session`, решение 1): у вызывающего — записи шагов
   * прогона и адаптеры.
   */
  readonly chooseDefender?: () => DefenderChoice;
}

/** Журнал защиты в каталоге шага (`review-defend`, решение 7). */
export const DEFENSE_FILE = 'defense.ndjson';

/** Каталог участника внутри каталога шага. */
export function participantDir(stepDir: string, participant: string): string {
  return join(stepDir, 'participants', participant);
}

/** Каталог хода ревьюера в раунде защиты `round` ≥ 1. */
export function replyDir(stepDir: string, participant: string, round: number): string {
  return join(participantDir(stepDir, participant), 'rounds', String(round));
}

/** Каталог хода защитника в раунде `round` (`review-defend-shared-session`, решение 4). */
export function defenderTurnDir(stepDir: string, round: number): string {
  return replyDir(stepDir, DEFENDER_ID, round);
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

  const prompt = step.mode === 'defend' ? await defend(options, findings) : aggregatorPrompt(step, findings);
  if (typeof prompt !== 'string') return withoutSession(prompt);

  // Повтор шага — попытки агрегатора с теми же находками либо той же
  // защитой: это дорогая часть, и её форма уже проверена
  // (`review-strategies`, решение 5; `review-defend`, решение 6).
  const outcome = await runOne(
    options,
    aggregator,
    aggregatorAgentStep(step, prompt),
    participantDir(options.stepDir, AGGREGATOR_ID),
  );
  return withoutSession(outcome);
}

/**
 * Режим `defend`: выбор защитника, общие раунды защиты находок ревьюеров,
 * затем промпт агрегатора со статусами находок. Исход участника
 * вместо промпта — защиту оборвали отмена или бюджет, и агрегатора нет
 * (`review-defend`, решение 5).
 */
async function defend<O extends ParticipantOutcome>(
  options: ReviewStepOptions<O>,
  findings: readonly ReviewerFindings[],
): Promise<string | O> {
  const { step, journal } = options;
  if (options.chooseDefender === undefined) throw new Error('executeReviewStep: режиму defend не передан выбор защитника');
  const record = (entry: DefenseRecord): void => {
    journal.appendStepLine(options.stepDir, DEFENSE_FILE, entry);
  };

  const choice = options.chooseDefender();
  record(choice.record);
  journal.event({
    kind: 'review.defender',
    job: options.job,
    step: step.id,
    mode: choice.record.mode,
    ...(choice.record.implementer === undefined ? {} : { implementer: choice.record.implementer }),
    agent: choice.record.agent,
    ...(choice.record.model === undefined ? {} : { model: choice.record.model }),
    ...(choice.record.reason === undefined ? {} : { reason: choice.record.reason }),
  });

  // Ревьюер с пустым списком в защите не участвует.
  const branches = step.reviewers.flatMap((reviewer, index) => {
    const entry = findings[index];
    if (entry === undefined || 'failure' in entry) return [];
    const list = findingsOf(reviewer.id, entry.findings);
    return list.length === 0 ? [] : [{ reviewer, findings: list, summary: summaryOf(entry.findings) }];
  });
  for (const branch of branches) for (const finding of branch.findings) record(finding);

  // Без сессии ход доступен, но дороже и беднее: каждый ход — новый процесс
  // с заданием и всей перепиской.
  const resumable = (agent: string): boolean => options.resumable?.(agent) ?? true;
  const stateless = [
    ...(branches.length > 0 && !resumable(choice.participant.agent) ? [{ who: 'защитник', agent: choice.participant.agent }] : []),
    ...branches.filter(({ reviewer }) => !resumable(reviewer.agent)).map(({ reviewer }) => ({ who: `ревьюер ${reviewer.id}`, agent: reviewer.agent })),
  ];
  for (const { who, agent } of stateless) {
    journal.event({
      kind: 'backend.degraded',
      backend: agent,
      capability: 'sessions',
      detail: `${who} шага ${options.job}/${step.id} защищает находки без сессии: каждый ход несёт задание и всю переписку заново`,
    });
  }

  const defender = choice.record;
  const result = await runDefense<O>({
    job: options.job,
    step,
    rounds: step.rounds ?? DEFAULT_DEFEND_ROUNDS,
    defenderAgent: choice.participant.agent,
    defenderHasContext: defender.mode !== 'fresh',
    branches,
    concurrency: options.concurrency,
    resumable,
    budgetStop: () => options.budgetStop?.(),
    record,
    event: (input) => journal.event(input),
    dialect: {
      defenderPrompt: (turn) =>
        defenderPrompt({
          ...turn,
          step,
          defender,
          ...(choice.implementerText === undefined ? {} : { implementerText: choice.implementerText }),
          ...(choice.participant.prompt === undefined ? {} : { guidance: choice.participant.prompt }),
        }),
      rebuttalPrompt: (turn) => rebuttalPrompt({ ...turn, task: reviewerTask(step, turn.side.reviewer), defender }),
      defenseCheck: (ids) => turnCheckSchema('defense', ids),
      rebuttalCheck: (ids) => turnCheckSchema('rebuttal', ids),
    },
    defend: (round, prompt, check, carriesContext) => {
      const dir = defenderTurnDir(options.stepDir, round);
      mkdirSync(dir, { recursive: true });
      const checkPath = journal.writeStepJson(dir, 'turn-check.schema.json', check);
      const call = turnAgentStep(defenderCallBase(step, choice.participant), 'defense', prompt, checkPath, carriesContext);
      return runOne(options, choice.participant, choice.forkFrom === undefined ? call : { ...call, forkFrom: choice.forkFrom }, dir, round);
    },
    rebut: (reviewer, round, prompt, check, carriesContext) => {
      const dir = replyDir(options.stepDir, reviewer.id, round);
      mkdirSync(dir, { recursive: true });
      const checkPath = journal.writeStepJson(dir, 'turn-check.schema.json', check);
      const call = turnAgentStep(participantStep(step, reviewer), 'rebuttal', prompt, checkPath, carriesContext);
      return runOne(options, reviewer, call, dir, round);
    },
  });

  const counts = { accepted: 0, withdrawn: 0, contested: 0 };
  for (const state of result.settled.values()) counts[state.status] += 1;
  record({ kind: 'outcome', ...counts });
  journal.event({ kind: 'review.defense.finished', job: options.job, step: step.id, ...counts });

  if (result.stopped !== undefined) return result.stopped;
  // Последний ход мог перейти бюджет, а агрегатор — ещё один ход (решение 5).
  const exceeded = options.budgetStop?.();
  if (exceeded !== undefined) return exceeded;

  return defendAggregatorPrompt({
    step,
    defender: choice.record,
    reviewers: branches.map(({ reviewer, findings: list, summary }) => ({
      id: reviewer.id,
      ...(reviewer.focus === undefined ? {} : { focus: reviewer.focus }),
      ...(summary === undefined ? {} : { summary }),
      findings: list.map((finding) => {
        const state = result.settled.get(finding.id);
        return { finding, status: state?.status ?? 'contested', severity: state?.severity ?? finding.severity };
      }),
    })),
    without: findings.flatMap((entry) => {
      const focus = entry.focus === undefined ? {} : { focus: entry.focus };
      if ('failure' in entry) return [{ id: entry.id, ...focus, reason: `ревью сорвалось — ${entry.failure}` }];
      return branches.some((branch) => branch.reviewer.id === entry.id) ? [] : [{ id: entry.id, ...focus, reason: 'находок нет' }];
    }),
    messages: result.messages,
  });
}

function summaryOf(findings: unknown): string | undefined {
  const summary = (findings as { readonly summary?: unknown } | null)?.summary;
  return typeof summary === 'string' ? summary : undefined;
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
  const turnFields = round === undefined ? {} : { round };
  mkdirSync(dir, { recursive: true });
  journal.event({
    kind: 'review.participant.started',
    job,
    step: step.id,
    participant: participant.id,
    ...turnFields,
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
    role: participant.id === AGGREGATOR_ID ? 'aggregator' : participant.id === DEFENDER_ID ? 'defender' : 'reviewer',
    ...turnFields,
    agent: call.agent,
    ...(call.model === undefined ? {} : { model: call.model }),
    ...(call.effort === undefined ? {} : { effort: call.effort }),
    ...(participant.profile === undefined ? {} : { profile: participant.profile }),
    ...(participant.localProfile === true ? { local_profile: true } : {}),
    ...(origin === undefined ? {} : { origin }),
    ...(participant.focus === undefined ? {} : { focus: participant.focus }),
    session: call.session,
    ...(call.forkFrom === undefined ? {} : { fork_from: call.forkFrom }),
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
    ...turnFields,
    status: outcome.status,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  });
  return outcome;
}
