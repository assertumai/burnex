import { DEFENDER_ID, type ReviewParticipant, type ReviewStep } from '../../document/model.js';
import {
  defenderPrompt,
  rebuttalPrompt,
  turnCheckSchema,
  type DefenderRecord,
  type DefenseMessageRecord,
  type DefensePayload,
  type DefenseRecord,
  type FindingRecord,
  type FindingStatus,
  type RebuttalPayload,
  type Severity,
} from '../../steps/review/defend.js';
import type { EventInput } from '../journal/schema.js';
import type { ParticipantOutcome } from './reviewStep.js';

/**
 * Ветки защиты находок (`review-defend`, design.md, решения 3, 5 и 7).
 * Движок — посредник: в ветке каждого ревьюера по очереди возобновляет
 * сессию защитника и ревьюера и ждёт по одному ходу. Раунды, закрытия
 * находок, `contested` по лимиту и сбою, порядок записей и бюджет — его, а не
 * просьба в промпте. Ветки разных ревьюеров идут параллельно и друг друга не
 * видят.
 */

/** Кто защищает: решение принято один раз до веток (решение 3). */
export interface DefenderChoice {
  readonly record: DefenderRecord;
  /** Агент защитника: имплементатора при форке, `defender` стратегии при свежем. */
  readonly participant: ReviewParticipant;
  /** Идентификатор сессии имплементатора — у форка. */
  readonly forkFrom?: string;
  /** Текстовый выход шага имплементатора — свежему защитнику, если он есть. */
  readonly implementerText?: string;
}

export interface DefenseBranch {
  readonly reviewer: ReviewParticipant;
  readonly findings: readonly FindingRecord[];
}

export interface DefenseOptions<O extends ParticipantOutcome> {
  readonly job: string;
  readonly step: ReviewStep;
  readonly rounds: number;
  readonly defender: DefenderChoice;
  /** Ветки в порядке стратегии: ревьюеры, давшие хотя бы одну находку. */
  readonly branches: readonly DefenseBranch[];
  readonly concurrency: number;
  /** Возобновляется ли сессия агента — умеет ли его бэкенд сессии. */
  readonly resumable: (agent: string) => boolean;
  /** Исход `budget_exceeded`, если бюджет шага перейдён, иначе ничего. */
  readonly budgetStop: () => O | undefined;
  /** Записать строку `defense.ndjson`. */
  readonly record: (record: DefenseRecord) => void;
  readonly event: (input: EventInput) => void;
  /** Ход защитника ветки `reviewer` в раунде `round`. */
  readonly defend: (reviewer: ReviewParticipant, round: number, prompt: string, check: unknown, carriesContext: boolean) => Promise<O>;
  /** Ход ревьюера своей ветки в раунде `round`. */
  readonly rebut: (reviewer: ReviewParticipant, round: number, prompt: string, check: unknown, carriesContext: boolean) => Promise<O>;
}

/** Итог находки после защиты. */
export interface SettledState {
  readonly status: FindingStatus;
  readonly severity: Severity;
}

export interface DefenseResult<O extends ParticipantOutcome> {
  readonly messages: readonly DefenseMessageRecord[];
  readonly settled: ReadonlyMap<string, SettledState>;
  /** Защиту оборвали отмена или бюджет: исход того хода либо проверки. */
  readonly stopped?: O;
}

export async function runDefense<O extends ParticipantOutcome>(options: DefenseOptions<O>): Promise<DefenseResult<O>> {
  const messages: DefenseMessageRecord[] = [];
  const settled = new Map<string, SettledState>();
  let stopped: O | undefined;

  const addMessage = (message: Omit<DefenseMessageRecord, 'kind' | 'messageId' | 'role'>): DefenseMessageRecord => {
    // `messageId` сквозной по шагу: номер выдаётся в момент записи, порядок
    // внутри ветки строгий, записи разных веток перемежаются (решение 7).
    const record: DefenseMessageRecord = { kind: 'message', messageId: `m${messages.length + 1}`, role: 'agent', ...message };
    messages.push(record);
    options.record(record);
    options.event({
      kind: 'review.message',
      job: options.job,
      step: options.step.id,
      participant: record.from,
      thread: record.thread,
      round: record.round,
      message_id: record.messageId,
      ...(record.invalid === true ? { invalid: true as const } : {}),
      ...(record.failure === undefined ? {} : { failure: record.failure }),
    });
    return record;
  };
  const settle = (finding: string, status: FindingStatus, severity: Severity, round: number): void => {
    settled.set(finding, { status, severity });
    options.record({ kind: 'settled', finding, status, severity, round });
    options.event({ kind: 'review.settled', job: options.job, step: options.step.id, finding, status });
  };
  /** Ход оборвали отмена или бюджет — защита кончается для всех веток. */
  const halts = (outcome: O): boolean => {
    if (outcome.status !== 'canceled' && outcome.status !== 'budget_exceeded') return false;
    // Отмена важнее бюджета: шаг отменён, даже если соседняя ветка уже
    // упёрлась в потолок.
    if (stopped === undefined || (outcome.status === 'canceled' && stopped.status !== 'canceled')) stopped = outcome;
    return true;
  };
  const budgetHalts = (): boolean => {
    if (stopped !== undefined) return true;
    const stop = options.budgetStop();
    if (stop === undefined) return false;
    stopped = stop;
    return true;
  };

  const branch = async ({ reviewer, findings }: DefenseBranch): Promise<void> => {
    const thread = reviewer.id;
    const severities = new Map(findings.map((finding) => [finding.id, finding.severity]));
    let open = [...findings];
    const own: DefenseMessageRecord[] = [];
    let round = 1;
    const close = (id: string, status: FindingStatus): void => {
      open = open.filter((finding) => finding.id !== id);
      settle(id, status, severities.get(id) ?? 'info', round);
    };
    const write = (from: string, outcome: O, text: string | undefined, responses: DefenseMessageRecord['responses']): DefenseMessageRecord => {
      const record = addMessage({
        from,
        thread,
        round,
        parts: text === undefined ? [] : [{ kind: 'text', text }],
        responses,
        ...(text === undefined ? missingTurn(outcome) : {}),
      });
      own.push(record);
      return record;
    };
    const defenderResumes = options.resumable(options.defender.participant.agent);
    const reviewerResumes = options.resumable(reviewer.agent);
    const fork = options.defender.record.mode === 'fork';

    for (; round <= options.rounds; round += 1) {
      if (budgetHalts()) break;
      const ids = open.map((finding) => finding.id);
      const defense = await options.defend(
        reviewer,
        round,
        defenderPrompt({
          step: options.step,
          reviewer,
          round,
          resumed: round > 1 && defenderResumes,
          findings,
          open,
          severities,
          messages: own,
          mode: options.defender.record.mode,
          ...(options.defender.implementerText === undefined ? {} : { implementerText: options.defender.implementerText }),
          ...(options.defender.record.implementer === undefined ? {} : { implementer: options.defender.record.implementer }),
          ...(options.defender.participant.prompt === undefined ? {} : { guidance: options.defender.participant.prompt }),
        }),
        turnCheckSchema('defense', ids),
        // Форк помнит контекст у имплементатора; свежему — с первым ходом и
        // каждым ходом без сессии.
        !fork && (round === 1 || !defenderResumes),
      );
      if (halts(defense)) break;
      const payload = defense.status === 'success' ? (defense.structured as DefensePayload | undefined) : undefined;
      write(DEFENDER_ID, defense, payload?.text, payload?.responses ?? []);
      // Ход без ответа кончает ветку: её открытые находки — `contested`.
      if (payload === undefined) break;
      for (const response of payload.responses) {
        if (response.stance === 'accept' && open.some((finding) => finding.id === response.finding)) close(response.finding, 'accepted');
      }
      if (open.length === 0) break;

      if (budgetHalts()) break;
      const rebuttal = await options.rebut(
        reviewer,
        round,
        rebuttalPrompt({
          step: options.step,
          reviewer,
          round,
          resumed: reviewerResumes,
          findings,
          open,
          severities,
          messages: own,
        }),
        turnCheckSchema('rebuttal', open.map((finding) => finding.id)),
        !reviewerResumes,
      );
      if (halts(rebuttal)) break;
      const answer = rebuttal.status === 'success' ? (rebuttal.structured as RebuttalPayload | undefined) : undefined;
      write(reviewer.id, rebuttal, answer?.text, answer?.responses ?? []);
      if (answer === undefined) break;
      for (const response of answer.responses) {
        if (!open.some((finding) => finding.id === response.finding)) continue;
        if (response.stance === 'withdraw') close(response.finding, 'withdrawn');
        else if (response.stance === 'revise' && response.severity !== null) severities.set(response.finding, response.severity);
      }
      if (open.length === 0) break;
    }
    // Последнее слово за ревьюером: открытое после лимита, сбоя или обрыва —
    // `contested`, и строка `settled` пишется в конце ветки (решение 5).
    round = Math.min(round, options.rounds);
    for (const finding of [...open]) close(finding.id, 'contested');
  };

  await pool(options.branches, options.concurrency, branch);
  return { messages, settled, ...(stopped === undefined ? {} : { stopped }) };
}

/**
 * Почему хода нет: невалиден — последняя попытка отклонена только схемой
 * хода; иначе сбой вызова (таймаут, отказ бэкенда, неудачный форк) с его
 * причиной.
 */
function missingTurn(outcome: ParticipantOutcome): { readonly invalid: true } | { readonly failure: string } {
  const failed = (outcome.results.at(-1) ?? []).filter((result) => !result.passed && result.hard);
  return failed.length > 0 && failed.every((result) => result.predicate === 'schema')
    ? { invalid: true }
    : { failure: outcome.reason ?? `статус ${outcome.status}` };
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
