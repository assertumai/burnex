import { DEFENDER_ID, type ReviewParticipant } from '../../document/model.js';
import type {
  DefenderRecord,
  DefenseMessageRecord,
  DefensePayload,
  FindingStatus,
  RebuttalPayload,
  SettledRecord,
  Severity,
} from '../../steps/review/defend.js';
import type { EventInput } from '../journal/schema.js';
import type { ParticipantOutcome } from './reviewStep.js';

/**
 * Общие раунды защиты (`review-defend-shared-session`, решение 2). Движок —
 * посредник: в раунде один ход защитника на открытые пункты всех сторон,
 * затем стороны с открытыми пунктами параллельно отвечают в своих сессиях.
 * Раунды, закрытия, `contested` по лимиту и сбою, порядок записей и бюджет —
 * его, а не просьба в промпте. Слова ходов — промпты и проверочные схемы —
 * приходят параметром (`DefenseDialect`): механика одна для ревью и для
 * других шагов со спором по пунктам.
 */

/**
 * Кто защищает: решение принято один раз до раундов
 * (`review-defend-shared-session`, решение 1).
 */
export interface DefenderChoice {
  readonly record: DefenderRecord;
  /** Агент защитника: имплементатора у `resume` и `fork`, `defender` стратегии у `fresh`. */
  readonly participant: ReviewParticipant;
  /** Идентификатор сессии имплементатора — у форка. */
  readonly forkFrom?: string;
  /**
   * Идентификатор сессии имплементатора — у `resume`: им засевается
   * псевдоним защитника, и ходы продолжают саму эту сессию.
   */
  readonly resumeSession?: string;
  /** Текстовый выход шага имплементатора — свежему защитнику, если он есть. */
  readonly implementerText?: string;
}

/**
 * Пункт спора: находка ревьюера либо возражение участника обсуждения. `by` —
 * сторона, которой пункт принадлежит; серьёзность есть только у находок.
 */
export interface DefenseItem {
  readonly id: string;
  readonly by: string;
  readonly severity?: Severity;
}

/** Сторона защиты: участник и его пункты в порядке выхода. */
export interface DefenseBranch<I extends DefenseItem = DefenseItem> {
  readonly reviewer: ReviewParticipant;
  readonly findings: readonly I[];
}

/** Сторона в ходе: её пункты и те, что ещё открыты. */
export interface DefenseSideOf<I extends DefenseItem> {
  readonly reviewer: ReviewParticipant;
  readonly findings: readonly I[];
  readonly open: readonly I[];
}

/** Ход защитника: открытые пункты всех сторон и переписка до него. */
export interface DefenderTurn<I extends DefenseItem> {
  readonly round: number;
  /** Сессия защитника возобновляется: прежние ходы уже в ней. */
  readonly resumed: boolean;
  readonly sides: readonly DefenseSideOf<I>[];
  readonly severities: ReadonlyMap<string, Severity>;
  readonly messages: readonly DefenseMessageRecord[];
}

/** Ход стороны: её открытые пункты и переписка, включая ход защитника раунда. */
export interface SideTurn<I extends DefenseItem> {
  readonly round: number;
  readonly resumed: boolean;
  readonly side: DefenseSideOf<I>;
  readonly severities: ReadonlyMap<string, Severity>;
  readonly messages: readonly DefenseMessageRecord[];
}

/** Слова защиты: промпты ходов и проверочные схемы по открытым id. */
export interface DefenseDialect<I extends DefenseItem> {
  defenderPrompt(turn: DefenderTurn<I>): string;
  rebuttalPrompt(turn: SideTurn<I>): string;
  defenseCheck(openIds: readonly string[]): unknown;
  rebuttalCheck(openIds: readonly string[]): unknown;
}

/** Записи защиты, которые пишет сама механика раундов. */
export type DefenseLogRecord = DefenseMessageRecord | SettledRecord;

export interface DefenseOptions<O extends ParticipantOutcome, I extends DefenseItem> {
  readonly job: string;
  readonly step: { readonly id: string };
  /**
   * Семейство событий: `review.message|settled` у шага `review`,
   * `discuss.message|settled` у шага `discuss`.
   */
  readonly events?: 'review' | 'discuss';
  /** Id защитника в репликах и событиях: `defender` у ревью, `author` у обсуждения. */
  readonly defenderId?: string;
  readonly rounds: number;
  /** Агент защитника: возобновляется ли его сессия. */
  readonly defenderAgent: string;
  /**
   * Сессия защитника уже несёт контекст шага — это сессия имплементатора или
   * её форк. Иначе контекст уходит с первым ходом и с каждым ходом без сессии.
   */
  readonly defenderHasContext: boolean;
  /** Стороны в порядке стратегии: участники, давшие хотя бы один пункт. */
  readonly branches: readonly DefenseBranch<I>[];
  readonly concurrency: number;
  /** Возобновляется ли сессия агента — умеет ли его бэкенд сессии. */
  readonly resumable: (agent: string) => boolean;
  /** Исход `budget_exceeded`, если бюджет шага перейдён, иначе ничего. */
  readonly budgetStop: () => O | undefined;
  /** Записать строку журнала защиты. */
  readonly record: (record: DefenseLogRecord) => void;
  readonly event: (input: EventInput) => void;
  readonly dialect: DefenseDialect<I>;
  /** Ход защитника в раунде `round`. */
  readonly defend: (round: number, prompt: string, check: unknown, carriesContext: boolean) => Promise<O>;
  /** Ход стороны `reviewer` в раунде `round`. */
  readonly rebut: (reviewer: ReviewParticipant, round: number, prompt: string, check: unknown, carriesContext: boolean) => Promise<O>;
}

/** Итог пункта после защиты; серьёзность — только у находок. */
export interface SettledState {
  readonly status: FindingStatus;
  readonly severity?: Severity;
}

export interface DefenseResult<O extends ParticipantOutcome> {
  readonly messages: readonly DefenseMessageRecord[];
  readonly settled: ReadonlyMap<string, SettledState>;
  /** Защиту оборвали отмена или бюджет: исход того хода либо проверки. */
  readonly stopped?: O;
}

export async function runDefense<O extends ParticipantOutcome, I extends DefenseItem>(options: DefenseOptions<O, I>): Promise<DefenseResult<O>> {
  const messages: DefenseMessageRecord[] = [];
  const settled = new Map<string, SettledState>();
  const discuss = options.events === 'discuss';
  const defenderId = options.defenderId ?? DEFENDER_ID;
  const severities = new Map<string, Severity>(
    options.branches.flatMap(({ findings }) => findings.flatMap((finding) => (finding.severity === undefined ? [] : [[finding.id, finding.severity] as const]))),
  );
  /** Открытые пункты стороны; выбывшая сторона из карты удаляется. */
  const open = new Map(options.branches.map((branch) => [branch.reviewer.id, [...branch.findings]]));
  let stopped: O | undefined;
  let round = 1;

  const addMessage = (message: Omit<DefenseMessageRecord, 'kind' | 'messageId' | 'role'>): void => {
    // `messageId` сквозной по шагу: номер выдаётся в момент записи, ответы
    // сторон одного раунда перемежаются в порядке завершения.
    const record: DefenseMessageRecord = { kind: 'message', messageId: `m${messages.length + 1}`, role: 'agent', ...message };
    messages.push(record);
    options.record(record);
    options.event({
      kind: discuss ? 'discuss.message' : 'review.message',
      job: options.job,
      step: options.step.id,
      participant: record.from,
      ...(record.thread === undefined ? {} : { thread: record.thread }),
      round: record.round,
      message_id: record.messageId,
      ...(record.invalid === true ? { invalid: true as const } : {}),
      ...(record.failure === undefined ? {} : { failure: record.failure }),
    });
  };
  const write = (from: string, thread: string | undefined, outcome: O, text: string | undefined, responses: DefenseMessageRecord['responses']): void => {
    addMessage({
      from,
      ...(thread === undefined ? {} : { thread }),
      round,
      parts: text === undefined ? [] : [{ kind: 'text', text }],
      responses,
      ...(text === undefined ? missingTurn(outcome) : {}),
    });
  };
  const close = (side: string, id: string, status: FindingStatus): void => {
    const list = open.get(side);
    if (list === undefined || !list.some((finding) => finding.id === id)) return;
    open.set(side, list.filter((finding) => finding.id !== id));
    const severity = severities.get(id);
    settled.set(id, { status, ...(severity === undefined ? {} : { severity }) });
    options.record({ kind: 'settled', finding: id, status, ...(severity === undefined ? {} : { severity }), round });
    options.event({ kind: discuss ? 'discuss.settled' : 'review.settled', job: options.job, step: options.step.id, finding: id, status });
  };
  /** Последнее слово за стороной: её открытые — `contested`, и она выбывает. */
  const contest = (side: string): void => {
    for (const finding of [...(open.get(side) ?? [])]) close(side, finding.id, 'contested');
    open.delete(side);
  };
  /** Ход оборвали отмена или бюджет — защита кончается для всех. */
  const halts = (outcome: O): boolean => {
    if (outcome.status !== 'canceled' && outcome.status !== 'budget_exceeded') return false;
    // Отмена важнее бюджета: шаг отменён, даже если соседний ход уже
    // упёрся в потолок.
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
  const sides = (): DefenseSideOf<I>[] =>
    options.branches.flatMap(({ reviewer, findings }) => {
      const list = open.get(reviewer.id) ?? [];
      return list.length === 0 ? [] : [{ reviewer, findings, open: list }];
    });
  const sideOf = (finding: string): string | undefined => {
    for (const [side, list] of open) if (list.some((entry) => entry.id === finding)) return side;
    return undefined;
  };

  const defenderResumes = options.resumable(options.defenderAgent);

  for (; round <= options.rounds; round += 1) {
    const current = sides();
    if (current.length === 0 || budgetHalts()) break;
    const ids = current.flatMap((side) => side.open.map((finding) => finding.id));
    const resumed = round > 1 && defenderResumes;
    const defense = await options.defend(
      round,
      options.dialect.defenderPrompt({ round, resumed, sides: current, severities, messages }),
      options.dialect.defenseCheck(ids),
      !options.defenderHasContext && (round === 1 || !defenderResumes),
    );
    if (halts(defense)) break;
    const payload = defense.status === 'success' ? (defense.structured as DefensePayload | undefined) : undefined;
    write(defenderId, undefined, defense, payload?.text, payload?.responses ?? []);
    // Ход защитника без ответа кончает защиту: открытые всех — `contested`.
    if (payload === undefined) break;
    for (const response of payload.responses) {
      if (response.stance !== 'accept') continue;
      const side = sideOf(response.finding);
      if (side !== undefined) close(side, response.finding, 'accepted');
    }

    const answering = sides();
    await pool(answering, options.concurrency, async (side) => {
      if (budgetHalts()) return;
      const reviewerResumes = options.resumable(side.reviewer.agent);
      const rebuttal = await options.rebut(
        side.reviewer,
        round,
        options.dialect.rebuttalPrompt({ round, resumed: reviewerResumes, side, severities, messages: [...messages] }),
        options.dialect.rebuttalCheck(side.open.map((finding) => finding.id)),
        !reviewerResumes,
      );
      if (halts(rebuttal)) return;
      const answer = rebuttal.status === 'success' ? (rebuttal.structured as RebuttalPayload | undefined) : undefined;
      write(side.reviewer.id, side.reviewer.id, rebuttal, answer?.text, answer?.responses ?? []);
      // Ход стороны без ответа: её открытые — `contested`, дальше она не идёт.
      if (answer === undefined) {
        contest(side.reviewer.id);
        return;
      }
      for (const response of answer.responses) {
        if (response.stance === 'withdraw') close(side.reviewer.id, response.finding, 'withdrawn');
        else if (response.stance === 'revise' && response.severity !== null) severities.set(response.finding, response.severity);
      }
    });
    if (stopped !== undefined) break;
  }
  // Последнее слово за стороной: открытое после лимита, сбоя защитника или
  // обрыва — `contested`, строка `settled` пишется в конце защиты.
  round = Math.min(round, options.rounds);
  for (const side of [...open.keys()]) contest(side);
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
