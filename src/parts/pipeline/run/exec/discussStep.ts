import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AGGREGATOR_ID, AUTHOR_ID, type AgentStep, type DiscussStep, type ReviewParticipant } from '../../document/model.js';
import {
  DISCUSS_FILE,
  aggregateCall,
  aggregateCheckSchema,
  aggregatePrompt,
  authorDefensePrompt,
  discussTurn,
  discussTurnCheckSchema,
  draftCheckSchema,
  draftProblems,
  draftPrompt,
  objectionsCheckSchema,
  objectionsOf,
  objectionsPrompt,
  participantRebuttalPrompt,
  proposalPrompt,
  schemaPathOf,
  withEngineFields,
  type DiscussPhase,
  type DiscussRecord,
  type Draft,
  type ObjectionRecord,
  type Proposal,
} from '../../steps/discuss/discuss.js';
import type { DefenseMessageRecord, SettledRecord } from '../../steps/review/defend.js';
import { pool, runDefense, type DefenseBranch } from './reviewDefense.js';
import type { ParticipantOutcome, ReviewJournal } from './reviewStep.js';

/**
 * Исполнение шага `discuss` (`discuss-step`, design.md, решения 2–9):
 * предложения участников параллельно, черновик автора, возражения участников,
 * общие раунды защиты черновика (`runDefense` с автором на месте защитника) и
 * итог агрегатора по `output_schema` шага с полями движка. Каждый участник —
 * агентский шаг, запущенный тем же исполнением, что обычный агентский шаг
 * прогона (`runParticipant`): контекст, бюджет, отказы бэкенда и журнал
 * попыток он получает оттуда же.
 */

export interface DiscussStepOptions<O extends ParticipantOutcome> {
  readonly step: DiscussStep;
  readonly job: string;
  readonly stepDir: string;
  readonly journal: ReviewJournal;
  /** Сколько участников идут одновременно — `limits.concurrency`. */
  readonly concurrency: number;
  /** Запустить участника как агентский шаг; `dir` — его каталог в журнале. */
  readonly runParticipant: (participant: ReviewParticipant, call: AgentStep, dir: string) => Promise<O>;
  /** Происхождение выбора агента участника — в его `step.json`. */
  readonly originOf?: (participant: string) => unknown;
  /** Исход `budget_exceeded`, если бюджет шага уже перейдён, иначе ничего. */
  readonly budgetStop?: () => O | undefined;
  /** Возобновляется ли сессия агента — умеет ли его бэкенд сессии. Без значения — умеет. */
  readonly resumable?: (agent: string) => boolean;
}

/** Каталог участника внутри каталога шага. */
export function discussParticipantDir(stepDir: string, participant: string): string {
  return join(stepDir, 'participants', participant);
}

/**
 * Исполнить шаг. Исход шага — исход агрегатора. Шаг проваливается без
 * агрегатора, если не дошло ни одного предложения или черновика, и
 * останавливается, если ход оборвали бюджет или отмена.
 */
export async function executeDiscussStep<O extends ParticipantOutcome>(options: DiscussStepOptions<O>): Promise<O | ParticipantOutcome> {
  const { step, journal } = options;
  const author = step.author;
  const aggregator = step.aggregator;
  if (author === undefined || aggregator === undefined) throw new Error('executeDiscussStep: стратегия шага не разрешена');
  const record = (entry: DiscussRecord | DefenseMessageRecord | SettledRecord): void => {
    journal.appendStepLine(options.stepDir, DISCUSS_FILE, entry);
  };
  const phase = (name: DiscussPhase, boundary: 'started' | 'finished'): void => {
    journal.event({ kind: 'discuss.phase', job: options.job, step: step.id, phase: name, boundary });
  };
  const resumable = (agent: string): boolean => options.resumable?.(agent) ?? true;
  const stopped = (outcome: ParticipantOutcome): boolean => outcome.status === 'canceled' || outcome.status === 'budget_exceeded';
  const dirOf = (participant: string, ...rest: string[]): string => join(discussParticipantDir(options.stepDir, participant), ...rest);
  const checkFile = (dir: string, schema: unknown): string => {
    mkdirSync(dir, { recursive: true });
    return journal.writeStepJson(dir, 'turn-check.schema.json', schema);
  };

  for (const participant of [...step.participants, author].filter((entry) => !resumable(entry.agent))) {
    journal.event({
      kind: 'backend.degraded',
      backend: participant.agent,
      capability: 'sessions',
      detail: `${participant.id === AUTHOR_ID ? 'автор' : `участник ${participant.id}`} шага ${options.job}/${step.id} обсуждает без сессии: каждый ход несёт задание и переписку заново`,
    });
  }

  // 1. Предложения — независимо и параллельно (решение 3).
  phase('proposals', 'started');
  const proposalOutcomes = await pool(step.participants, options.concurrency, (participant) =>
    runOne(options, participant, 'proposals', discussTurn(step, participant, 'discuss-proposal', proposalPrompt(step, participant), schemaPathOf('discuss-proposal')), dirOf(participant.id)),
  );
  const halted = proposalOutcomes.find(stopped);
  if (halted !== undefined) return withoutSession(halted);
  const proposals: { participant: ReviewParticipant; proposal: Proposal }[] = [];
  const failed: { id: string; reason: string }[] = [];
  step.participants.forEach((participant, index) => {
    const outcome = proposalOutcomes[index] as O;
    const ok = outcome.status === 'success' && outcome.structured !== undefined;
    const reason = ok ? undefined : (outcome.reason ?? `статус ${outcome.status}`);
    record({ kind: 'proposal', participant: participant.id, status: outcome.status, ...(reason === undefined ? {} : { reason }) });
    if (ok) proposals.push({ participant, proposal: outcome.structured as Proposal });
    else failed.push({ id: participant.id, reason: reason ?? '' });
  });
  phase('proposals', 'finished');
  if (proposals.length === 0) {
    return { status: 'failed', reason: `ни один участник не дал предложения — ${failed.map((entry) => `${entry.id}: ${entry.reason}`).join('; ')}`, attempts: [], results: [] };
  }

  // 2. Черновик автора с проверками движка и одним повтором (решение 4).
  const beforeDraft = options.budgetStop?.();
  if (beforeDraft !== undefined) return beforeDraft;
  phase('draft', 'started');
  const proposers = proposals.map(({ participant }) => participant.id);
  const draftDir = dirOf(AUTHOR_ID, 'draft');
  const firstPrompt = draftPrompt({ step, proposals, failed });
  let draftOutcome = await runOne(options, author, 'draft', discussTurn(step, author, 'discuss-draft', firstPrompt, checkFile(draftDir, draftCheckSchema(proposers))), draftDir);
  if (stopped(draftOutcome)) return withoutSession(draftOutcome);
  let draft = draftOutcome.status === 'success' ? (draftOutcome.structured as Draft | undefined) : undefined;
  let problems = draft === undefined ? [] : draftProblems(draft);
  if (draft !== undefined && problems.length > 0) {
    const retryDir = join(draftDir, 'retry');
    const retryPrompt = [
      resumable(author.agent) ? '' : `${firstPrompt}\n\n`,
      `## Прошлый черновик не прошёл проверку\n\n${problems.map((problem) => `- ${problem}`).join('\n')}\n\nОтветь исправленным черновиком целиком.`,
    ].join('');
    draftOutcome = await runOne(
      options,
      author,
      'draft',
      discussTurn(step, author, 'discuss-draft', retryPrompt, checkFile(retryDir, draftCheckSchema(proposers)), !resumable(author.agent)),
      retryDir,
    );
    if (stopped(draftOutcome)) return withoutSession(draftOutcome);
    draft = draftOutcome.status === 'success' ? (draftOutcome.structured as Draft | undefined) : undefined;
    problems = draft === undefined ? [] : draftProblems(draft);
  }
  if (draft === undefined || problems.length > 0) {
    const reason = draft === undefined ? (draftOutcome.reason ?? `статус ${draftOutcome.status}`) : problems.join('; ');
    return { status: 'failed', reason: `автор не дал годного черновика — ${reason}`, attempts: [], results: [] };
  }
  record({ kind: 'draft', ...draft });
  phase('draft', 'finished');
  const finalDraft = draft;

  // 3. Возражения по точкам черновика (решение 5).
  const beforeObjections = options.budgetStop?.();
  if (beforeObjections !== undefined) return beforeObjections;
  phase('objections', 'started');
  const objectionOutcomes = await pool(proposals, options.concurrency, ({ participant, proposal }) => {
    const dir = dirOf(participant.id, 'objections');
    const resumed = resumable(participant.agent);
    return runOne(
      options,
      participant,
      'objections',
      discussTurn(step, participant, 'discuss-objections', objectionsPrompt({ step, participant, draft: finalDraft, resumed, proposal }), checkFile(dir, objectionsCheckSchema(finalDraft)), !resumed),
      dir,
    );
  });
  const haltedObjections = objectionOutcomes.find(stopped);
  if (haltedObjections !== undefined) return withoutSession(haltedObjections);
  const objections: ObjectionRecord[] = [];
  const without = [...failed.map((entry) => ({ id: entry.id, reason: `предложения нет — ${entry.reason}` }))];
  proposals.forEach(({ participant }, index) => {
    const outcome = objectionOutcomes[index] as O;
    if (outcome.status !== 'success' || outcome.structured === undefined) {
      without.push({ id: participant.id, reason: `возражений нет — ${outcome.reason ?? `статус ${outcome.status}`}` });
      return;
    }
    for (const objection of objectionsOf(participant.id, outcome.structured)) {
      objections.push(objection);
      record(objection);
    }
  });
  phase('objections', 'finished');

  // 4. Общие раунды защиты блокирующих возражений (решение 6).
  const blocking = objections.filter((objection) => objection.weight === 'blocking');
  const preferences = objections.filter((objection) => objection.weight === 'preference');
  const branches: DefenseBranch<ObjectionRecord>[] = proposals.flatMap(({ participant }) => {
    const own = blocking.filter((objection) => objection.by === participant.id);
    return own.length === 0 ? [] : [{ reviewer: participant, findings: own }];
  });
  let messages: readonly DefenseMessageRecord[] = [];
  const statuses = new Map<string, 'accepted' | 'withdrawn' | 'contested'>();
  if (branches.length > 0) {
    phase('defense', 'started');
    const result = await runDefense<O, ObjectionRecord>({
      job: options.job,
      step,
      events: 'discuss',
      defenderId: AUTHOR_ID,
      rounds: step.rounds,
      defenderAgent: author.agent,
      // Сессия автора уже видела задание и контекст шага в ходе черновика.
      defenderHasContext: resumable(author.agent),
      branches,
      concurrency: options.concurrency,
      resumable,
      budgetStop: () => options.budgetStop?.(),
      record,
      event: (input) => journal.event(input),
      dialect: {
        defenderPrompt: (turn) => authorDefensePrompt({ step, draft: finalDraft, round: turn.round, resumed: turn.resumed, sides: turn.sides, messages: turn.messages }),
        rebuttalPrompt: (turn) => participantRebuttalPrompt({ step, draft: finalDraft, round: turn.round, resumed: turn.resumed, side: turn.side, messages: turn.messages }),
        defenseCheck: (ids) => discussTurnCheckSchema('defense', ids),
        rebuttalCheck: (ids) => discussTurnCheckSchema('rebuttal', ids),
      },
      defend: (round, prompt, check, carriesContext) => {
        const dir = dirOf(AUTHOR_ID, 'rounds', String(round));
        return runOne(options, author, 'defense', discussTurn(step, author, 'discuss-defense', prompt, checkFile(dir, check), carriesContext), dir, round);
      },
      rebut: (participant, round, prompt, check, carriesContext) => {
        const dir = dirOf(participant.id, 'rounds', String(round));
        return runOne(options, participant, 'defense', discussTurn(step, participant, 'discuss-rebuttal', prompt, checkFile(dir, check), carriesContext), dir, round);
      },
    });
    messages = result.messages;
    for (const [id, state] of result.settled) statuses.set(id, state.status);
    phase('defense', 'finished');
    if (result.stopped !== undefined) return result.stopped;
  }
  const counts = { accepted: 0, withdrawn: 0, contested: 0, preference: preferences.length };
  for (const status of statuses.values()) counts[status] += 1;
  record({ kind: 'outcome', ...counts });

  // 5. Итог агрегатора по схеме шага с полями движка (решение 7).
  const beforeAggregate = options.budgetStop?.();
  if (beforeAggregate !== undefined) return beforeAggregate;
  phase('aggregate', 'started');
  const aggregatorDir = dirOf(AGGREGATOR_ID);
  mkdirSync(aggregatorDir, { recursive: true });
  const merged = withEngineFields(JSON.parse(readFileSync(step.outputSchemaPath, 'utf8')) as Record<string, unknown>);
  const mergedPath = journal.writeStepJson(aggregatorDir, 'output.schema.json', merged);
  const checkPath = journal.writeStepJson(aggregatorDir, 'turn-check.schema.json', aggregateCheckSchema(merged, finalDraft.decisions.map((decision) => decision.id)));
  const prompt = aggregatePrompt({
    step,
    draft: finalDraft,
    blocking: blocking.map((objection) => ({ objection, status: statuses.get(objection.id) ?? 'contested' })),
    preferences,
    messages,
    without,
  });
  const outcome = await runOne(options, aggregator, 'aggregate', aggregateCall(step, prompt, mergedPath, checkPath), aggregatorDir);
  phase('aggregate', 'finished');
  const agreed = (outcome.structured as { readonly agreed?: unknown } | undefined)?.agreed;
  journal.event({
    kind: 'discuss.finished',
    job: options.job,
    step: step.id,
    ...counts,
    ...(typeof agreed === 'boolean' ? { agreed } : {}),
  });
  return withoutSession(outcome);
}

/** Сессии участников живут внутри шага: продолжать их следующему шагу нечего. */
function withoutSession<T extends ParticipantOutcome>(outcome: T): T {
  if (outcome.session === undefined) return outcome;
  const { session: _session, ...rest } = outcome;
  return rest as T;
}

async function runOne<O extends ParticipantOutcome>(
  options: DiscussStepOptions<O>,
  participant: ReviewParticipant,
  phase: DiscussPhase,
  call: AgentStep,
  dir: string,
  round?: number,
): Promise<O> {
  const { journal, job, step } = options;
  const roundField = round === undefined ? {} : { round };
  mkdirSync(dir, { recursive: true });
  journal.event({
    kind: 'discuss.participant.started',
    job,
    step: step.id,
    participant: participant.id,
    phase,
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
    role: participant.id === AGGREGATOR_ID ? 'aggregator' : participant.id === AUTHOR_ID ? 'author' : 'participant',
    phase,
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
    kind: 'discuss.participant.finished',
    job,
    step: step.id,
    participant: participant.id,
    phase,
    ...roundField,
    status: outcome.status,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  });
  return outcome;
}
