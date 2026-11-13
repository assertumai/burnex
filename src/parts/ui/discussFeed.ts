import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readLockJobs, type LockDiscuss, type LockReviewParticipant } from '../pipeline/document/lockRead.js';
import { AGGREGATOR_ID, AUTHOR_ID, DEFAULT_DISCUSS_ROUNDS } from '../pipeline/document/model.js';
import { parseDesignDocument, type DesignDocument } from '../pipeline/render/designDoc.js';
import { findStepDir, isRunAlive, listLoopPasses } from '../pipeline/run/journal/reader.js';
import type { RunPaths } from '../pipeline/run/journal/paths.js';
import type { StatusValue } from '../pipeline/run/journal/schema.js';
import { DISCUSS_FILE } from '../pipeline/steps/discuss/discuss.js';
import { readJournalJson } from './file.js';
import {
  asRecord,
  asString,
  fileRef,
  listDirs,
  listRounds,
  participantUsage,
  readCall,
  readNdjson,
  reusedSource,
  type ParticipantUsage,
} from './participantJournal.js';
import type { JournalFileRef } from './snapshot.js';

/**
 * Лента шага `discuss` для деталей прогона (`render-design`, design.md,
 * решение 6).
 *
 * Строится из журнала шага: `discuss.ndjson` — предложения, черновик,
 * возражения, реплики раундов защиты, закрытия и исход; каталоги
 * `participants/<id>/…` — вызовы участников, автора и агрегатора с исходом
 * и потоком; `output.json` шага — итоговый документ. Порядок участников и
 * лимит раундов — из замка: каталоги порядка не хранят.
 *
 * Чтение остаётся чтением: модуль ничего не пишет на диск, а отказ разбора
 * строки или файла даёт пропуск записи — ленту опрашивают раз в секунду,
 * пока шаг идёт.
 */

export const DISCUSS_PHASES = ['proposals', 'draft', 'objections', 'defense', 'aggregate'] as const;
export type DiscussPhaseName = (typeof DISCUSS_PHASES)[number];
export type DiscussPhaseState = 'pending' | 'running' | 'done' | 'skipped';

export interface DiscussFeedPhase {
  readonly name: DiscussPhaseName;
  readonly state: DiscussPhaseState;
}

/** Один вызов участника: предложение, возражения, ход раунда, черновик или итог. */
export interface DiscussFeedCall {
  readonly phase: DiscussPhaseName;
  readonly round?: number;
  /** Повтор черновика автора после отказа проверки. */
  readonly retry?: true;
  readonly status?: StatusValue;
  readonly reason?: string;
  readonly running: boolean;
  /** Сырой `stdout.log` вызова — путь относительно каталога прогона. */
  readonly stdout?: JournalFileRef;
  /** Разобранный ход вызова — `output.json`. */
  readonly output?: JournalFileRef;
}

export interface DiscussFeedParticipant {
  readonly id: string;
  readonly role: 'participant' | 'author' | 'aggregator';
  readonly agent?: string;
  readonly model?: string;
  readonly focus?: string;
  /** Позиция в стратегии — цвет участника в ленте. */
  readonly color: number;
  readonly running: boolean;
  readonly calls: readonly DiscussFeedCall[];
  readonly usage: ParticipantUsage;
}

export interface DiscussFeedProposal {
  readonly participant: string;
  readonly status?: StatusValue;
  readonly reason?: string;
  readonly summary?: string;
  readonly approach?: string;
}

export interface DiscussFeedOption {
  readonly by: string;
  readonly summary: string;
}

export interface DiscussFeedDraftDecision {
  readonly id: string;
  readonly question: string;
  readonly choice: string;
  readonly rationale: string;
  readonly options: readonly DiscussFeedOption[];
}

export interface DiscussFeedDiagram {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly decisions: readonly string[];
}

export interface DiscussFeedDraft {
  readonly summary: string;
  readonly decisions: readonly DiscussFeedDraftDecision[];
  readonly diagrams: readonly DiscussFeedDiagram[];
  readonly risks: readonly { readonly risk: string; readonly mitigation: string }[];
}

/**
 * Возражение и его исход. `note` — пожелание (`preference`): в раунды не
 * идёт и уходит агрегатору заметкой. `open` — блокирующее, ещё не закрытое.
 */
export type DiscussObjectionStatus = 'open' | 'accepted' | 'withdrawn' | 'contested' | 'note';

export interface DiscussFeedObjection {
  readonly id: string;
  readonly by: string;
  readonly target: string;
  readonly weight: 'blocking' | 'preference';
  readonly title: string;
  readonly breaks?: string;
  readonly alternative?: string;
  readonly status: DiscussObjectionStatus;
  /** Раунд закрытия. */
  readonly round?: number;
}

export interface DiscussFeedResponse {
  readonly objection: string;
  readonly stance: string;
  readonly text: string;
  readonly evidence?: string;
  readonly change?: { readonly choice: string; readonly rationale: string };
}

/** Реплика раунда защиты: ход автора на все открытые возражения или ответ участника. */
export interface DiscussFeedMessage {
  readonly id: string;
  readonly from: string;
  readonly round: number;
  readonly text: string;
  readonly responses: readonly DiscussFeedResponse[];
  readonly invalid?: true;
  readonly failure?: string;
}

export interface DiscussFeedOutcome {
  readonly accepted: number;
  readonly withdrawn: number;
  readonly contested: number;
  readonly preference: number;
}

export interface DiscussFeed {
  /** Лимит раундов защиты. */
  readonly rounds: number;
  readonly phases: readonly DiscussFeedPhase[];
  readonly participants: readonly DiscussFeedParticipant[];
  readonly proposals: readonly DiscussFeedProposal[];
  readonly draft?: DiscussFeedDraft;
  readonly objections: readonly DiscussFeedObjection[];
  readonly messages: readonly DiscussFeedMessage[];
  readonly outcome?: DiscussFeedOutcome;
  /** Итог шага формы `burnex:design-doc` — рендерится и скачивается. */
  readonly document?: DesignDocument;
  /** Итог шага другой формы — сырым значением, с причиной в `documentError`. */
  readonly output?: unknown;
  readonly documentError?: string;
  /** Дописывать больше нечего: шаг записан, прогон не жив либо проход прошлый. */
  readonly done: boolean;
  /** Шаг переиспользован при возобновлении — лента читается из исходного прогона. */
  readonly reusedFrom?: { readonly runId: string; readonly available: boolean };
}

export interface DiscussFeedQuery {
  readonly pass?: number;
}

function lockDiscuss(paths: RunPaths, jobId: string, stepId: string): LockDiscuss | undefined {
  try {
    return readLockJobs(paths.lock)
      .find((job) => job.id === jobId)
      ?.steps.find((step) => step.id === stepId)?.discuss;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function optionalString(value: unknown): string | undefined {
  const text = asString(value);
  return text === undefined || text === '' ? undefined : text;
}

function draftOf(record: Record<string, unknown>): DiscussFeedDraft {
  const decisions = Array.isArray(record.decisions) ? record.decisions : [];
  const diagrams = Array.isArray(record.diagrams) ? record.diagrams : [];
  const risks = Array.isArray(record.risks) ? record.risks : [];
  return {
    summary: asString(record.summary) ?? '',
    decisions: decisions.flatMap((item) => {
      const entry = asRecord(item);
      const id = asString(entry?.id);
      if (entry === undefined || id === undefined) return [];
      const options = Array.isArray(entry.options) ? entry.options : [];
      return [
        {
          id,
          question: asString(entry.question) ?? '',
          choice: asString(entry.choice) ?? '',
          rationale: asString(entry.rationale) ?? '',
          options: options.flatMap((option) => {
            const value = asRecord(option);
            const by = asString(value?.by);
            return by === undefined ? [] : [{ by, summary: asString(value?.summary) ?? '' }];
          }),
        },
      ];
    }),
    diagrams: diagrams.flatMap((item) => {
      const entry = asRecord(item);
      const id = asString(entry?.id);
      const source = asString(entry?.source);
      if (entry === undefined || id === undefined || source === undefined) return [];
      return [{ id, title: asString(entry.title) ?? '', source, decisions: stringList(entry.decisions) }];
    }),
    risks: risks.flatMap((item) => {
      const entry = asRecord(item);
      const risk = asString(entry?.risk);
      return risk === undefined ? [] : [{ risk, mitigation: asString(entry?.mitigation) ?? '' }];
    }),
  };
}

function responsesOf(value: unknown): DiscussFeedResponse[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const objection = asString(record?.finding);
    const stance = asString(record?.stance);
    if (record === undefined || objection === undefined || stance === undefined) return [];
    const evidence = optionalString(record.evidence);
    const change = asRecord(record.change);
    const choice = asString(change?.choice);
    return [
      {
        objection,
        stance,
        text: asString(record.text) ?? '',
        ...(evidence === undefined ? {} : { evidence }),
        ...(choice === undefined ? {} : { change: { choice, rationale: asString(change?.rationale) ?? '' } }),
      },
    ];
  });
}

function textOf(record: Record<string, unknown>): string {
  if (!Array.isArray(record.parts)) return '';
  return record.parts
    .map((part) => asString(asRecord(part)?.text))
    .filter((text): text is string => text !== undefined)
    .join('\n');
}

interface DiscussLog {
  readonly proposals: DiscussFeedProposal[];
  readonly draft?: DiscussFeedDraft;
  readonly objections: Omit<DiscussFeedObjection, 'status' | 'round'>[];
  readonly settled: Map<string, { readonly status: 'accepted' | 'withdrawn' | 'contested'; readonly round: number }>;
  readonly messages: DiscussFeedMessage[];
  readonly outcome?: DiscussFeedOutcome;
}

const SETTLED: ReadonlySet<string> = new Set(['accepted', 'withdrawn', 'contested']);

function readLog(records: readonly Record<string, unknown>[]): DiscussLog {
  const proposals: DiscussFeedProposal[] = [];
  const objections: Omit<DiscussFeedObjection, 'status' | 'round'>[] = [];
  const settled = new Map<string, { readonly status: 'accepted' | 'withdrawn' | 'contested'; readonly round: number }>();
  const messages: DiscussFeedMessage[] = [];
  let draft: DiscussFeedDraft | undefined;
  let outcome: DiscussFeedOutcome | undefined;
  for (const record of records) {
    switch (record.kind) {
      case 'proposal': {
        const participant = asString(record.participant);
        if (participant === undefined) break;
        const status = asString(record.status) as StatusValue | undefined;
        const reason = asString(record.reason);
        proposals.push({ participant, ...(status === undefined ? {} : { status }), ...(reason === undefined ? {} : { reason }) });
        break;
      }
      case 'draft':
        draft = draftOf(record);
        break;
      case 'objection': {
        const id = asString(record.id);
        const by = asString(record.by);
        const target = asString(record.target);
        const weight = record.weight;
        if (id === undefined || by === undefined || target === undefined || (weight !== 'blocking' && weight !== 'preference')) break;
        const breaks = optionalString(record.breaks);
        const alternative = optionalString(record.alternative);
        objections.push({
          id,
          by,
          target,
          weight,
          title: asString(record.title) ?? '',
          ...(breaks === undefined ? {} : { breaks }),
          ...(alternative === undefined ? {} : { alternative }),
        });
        break;
      }
      case 'settled': {
        const id = asString(record.finding);
        const status = asString(record.status);
        if (id === undefined || status === undefined || !SETTLED.has(status)) break;
        settled.set(id, { status: status as 'accepted' | 'withdrawn' | 'contested', round: typeof record.round === 'number' ? record.round : 0 });
        break;
      }
      case 'message': {
        const id = asString(record.messageId);
        const from = asString(record.from);
        if (id === undefined || from === undefined) break;
        const failure = asString(record.failure);
        messages.push({
          id,
          from,
          round: typeof record.round === 'number' ? record.round : 0,
          text: textOf(record),
          responses: responsesOf(record.responses),
          ...(record.invalid === true ? { invalid: true as const } : {}),
          ...(failure === undefined ? {} : { failure }),
        });
        break;
      }
      case 'outcome': {
        const count = (key: string): number => (typeof record[key] === 'number' ? (record[key] as number) : 0);
        outcome = { accepted: count('accepted'), withdrawn: count('withdrawn'), contested: count('contested'), preference: count('preference') };
        break;
      }
      default:
        break;
    }
  }
  return { proposals, ...(draft === undefined ? {} : { draft }), objections, settled, messages, ...(outcome === undefined ? {} : { outcome }) };
}

/** Участники журнала, о которых замок не знает, — по каталогам; автор и агрегатор отдельно. */
function journalParticipants(stepDir: string): LockReviewParticipant[] {
  return listDirs(join(stepDir, 'participants'))
    .filter((name) => name !== AGGREGATOR_ID && name !== AUTHOR_ID)
    .map((id) => ({ id }));
}

/**
 * Состояние фаз по журналу: запись следующей фазы означает, что прежняя
 * кончилась. Шаг кончился — недошедшие фазы `skipped`.
 */
function phasesOf(log: DiscussLog, started: boolean, participants: number, aggregated: boolean, done: boolean): DiscussFeedPhase[] {
  const proposalsDone = log.draft !== undefined || log.proposals.length >= Math.max(participants, 1);
  const draftDone = log.draft !== undefined;
  const objectionsDone = log.objections.length > 0 || log.outcome !== undefined;
  const blocking = log.objections.some((objection) => objection.weight === 'blocking');
  const defenseDone = log.outcome !== undefined;
  const finished: Record<DiscussPhaseName, boolean> = {
    proposals: proposalsDone,
    draft: draftDone,
    objections: objectionsDone,
    defense: defenseDone && blocking,
    aggregate: aggregated,
  };
  const skipped: Record<DiscussPhaseName, boolean> = {
    proposals: false,
    draft: false,
    objections: false,
    defense: objectionsDone && !blocking,
    aggregate: false,
  };
  let reachedRunning = !started;
  return DISCUSS_PHASES.map((name) => {
    if (finished[name]) return { name, state: 'done' as const };
    if (skipped[name]) return { name, state: 'skipped' as const };
    if (done) return { name, state: 'skipped' as const };
    if (!reachedRunning) {
      reachedRunning = true;
      return { name, state: 'running' as const };
    }
    return { name, state: 'pending' as const };
  });
}

export function readDiscussFeed(paths: RunPaths, jobId: string, stepId: string, query: DiscussFeedQuery = {}): DiscussFeed | undefined {
  const passes = listLoopPasses(paths, jobId);
  const lastPass = passes.at(-1);
  const pastPass = query.pass !== undefined && lastPass !== undefined && query.pass < lastPass;
  const ownDir = findStepDir(paths, jobId, stepId, undefined, undefined, query.pass);
  const strategy = lockDiscuss(paths, jobId, stepId);
  if (ownDir === undefined && strategy === undefined) return undefined;

  const alive = !pastPass && isRunAlive(paths);
  const stepFinished = ownDir !== undefined && existsSync(join(ownDir, 'step.json'));
  const done = !alive || stepFinished;
  const reused = ownDir === undefined ? undefined : reusedSource(paths, jobId, stepId, ownDir);
  const stepDir = reused === undefined ? ownDir : reused.stepDir;
  // Файлы вызова открываются по пути в каталоге этого прогона; файлы
  // исходного прогона так не адресовать.
  const refOf = (path: string): JournalFileRef | undefined => (reused === undefined && existsSync(path) ? fileRef(paths.dir, path) : undefined);
  const usage = participantUsage(reused?.paths ?? paths, jobId, stepId);

  const log = readLog(stepDir === undefined ? [] : (readNdjson(join(stepDir, DISCUSS_FILE)) ?? []));
  const declared =
    strategy !== undefined && strategy.participants.length > 0
      ? strategy.participants
      : stepDir === undefined
        ? []
        : journalParticipants(stepDir);
  const participantDir = (id: string): string | undefined => (stepDir === undefined ? undefined : join(stepDir, 'participants', id));

  const callAt = (dir: string, phase: DiscussPhaseName, extra: { round?: number; retry?: true } = {}): DiscussFeedCall | undefined => {
    if (!existsSync(dir)) return undefined;
    const call = readCall(dir);
    const stdout = refOf(join(dir, 'stdout.log'));
    const output = refOf(join(dir, 'output.json'));
    return {
      phase,
      ...extra,
      ...(call?.status === undefined ? {} : { status: call.status }),
      ...(call?.reason === undefined ? {} : { reason: call.reason }),
      running: call === undefined && alive,
      ...(stdout === undefined ? {} : { stdout }),
      ...(output === undefined ? {} : { output }),
    };
  };
  const roundCalls = (dir: string): DiscussFeedCall[] =>
    listRounds(dir).flatMap((round) => {
      const call = callAt(join(dir, 'rounds', String(round)), 'defense', { round });
      return call === undefined ? [] : [call];
    });
  const wallclock = (calls: readonly string[]): number => calls.reduce((sum, dir) => sum + (readCall(dir)?.wallclockMs ?? 0), 0);

  const participant = (
    entry: LockReviewParticipant,
    role: DiscussFeedParticipant['role'],
    color: number,
    calls: DiscussFeedCall[],
    dirs: readonly string[],
  ): DiscussFeedParticipant => {
    const first = dirs.map((dir) => readCall(dir)).find((call) => call !== undefined);
    const agent = entry.agent ?? first?.agent;
    const model = entry.model ?? first?.model;
    const focus = entry.focus ?? first?.focus;
    return {
      id: entry.id,
      role,
      ...(agent === undefined ? {} : { agent }),
      ...(model === undefined ? {} : { model }),
      ...(focus === undefined ? {} : { focus }),
      color,
      running: calls.some((call) => call.running),
      calls,
      usage: usage(entry.id, wallclock(dirs)),
    };
  };

  const participants: DiscussFeedParticipant[] = declared.map((entry, index) => {
    const dir = participantDir(entry.id);
    if (dir === undefined) return participant(entry, 'participant', index, [], []);
    const own = [callAt(dir, 'proposals'), callAt(join(dir, 'objections'), 'objections')].filter(
      (call): call is DiscussFeedCall => call !== undefined,
    );
    const rounds = listRounds(dir).map((round) => join(dir, 'rounds', String(round)));
    return participant(entry, 'participant', index, [...own, ...roundCalls(dir)], [dir, join(dir, 'objections'), ...rounds]);
  });

  const authorDir = participantDir(AUTHOR_ID);
  const authorCalls: DiscussFeedCall[] = [];
  const authorDirs: string[] = [];
  if (authorDir !== undefined) {
    const draftDir = join(authorDir, 'draft');
    const retryDir = join(draftDir, 'retry');
    for (const [dir, extra] of [[draftDir, {}], [retryDir, { retry: true as const }]] as const) {
      const call = callAt(dir, 'draft', extra);
      if (call !== undefined) {
        authorCalls.push(call);
        authorDirs.push(dir);
      }
    }
    authorCalls.push(...roundCalls(authorDir));
    authorDirs.push(...listRounds(authorDir).map((round) => join(authorDir, 'rounds', String(round))));
  }
  participants.push(participant(strategy?.author ?? { id: AUTHOR_ID }, 'author', declared.length, authorCalls, authorDirs));

  const aggregatorDir = participantDir(AGGREGATOR_ID);
  const aggregatorCall = aggregatorDir === undefined ? undefined : callAt(aggregatorDir, 'aggregate');
  participants.push(
    participant(
      strategy?.aggregator ?? { id: AGGREGATOR_ID },
      'aggregator',
      declared.length + 1,
      aggregatorCall === undefined ? [] : [aggregatorCall],
      aggregatorDir === undefined ? [] : [aggregatorDir],
    ),
  );

  const proposals = log.proposals.map((proposal) => {
    const dir = participantDir(proposal.participant);
    const content = dir === undefined || proposal.status !== 'success' ? undefined : asRecord(readJournalJson(join(dir, 'output.json')));
    const summary = asString(content?.summary);
    const approach = asString(content?.approach);
    return { ...proposal, ...(summary === undefined ? {} : { summary }), ...(approach === undefined ? {} : { approach }) };
  });

  const objections: DiscussFeedObjection[] = log.objections.map((objection) => {
    if (objection.weight === 'preference') return { ...objection, status: 'note' };
    const closed = log.settled.get(objection.id);
    if (closed !== undefined) return { ...objection, status: closed.status, round: closed.round };
    // Защита кончилась, а закрытия нет — агрегатор решает пункт как спорный.
    return { ...objection, status: log.outcome !== undefined ? 'contested' : 'open' };
  });

  const output = stepDir === undefined ? undefined : readJournalJson(join(stepDir, 'output.json'));
  const aggregated = output !== undefined || (aggregatorCall !== undefined && aggregatorCall.status !== undefined);
  let document: DesignDocument | undefined;
  let documentError: string | undefined;
  if (output !== undefined) {
    try {
      document = parseDesignDocument(output);
    } catch (error) {
      documentError = `${(error as Error).message}${(error as { at?: string }).at === undefined ? '' : ` (${(error as { at?: string }).at})`}`;
    }
  }

  return {
    rounds: strategy?.rounds ?? DEFAULT_DISCUSS_ROUNDS,
    phases: phasesOf(log, stepDir !== undefined, declared.length, aggregated, done),
    participants,
    proposals,
    ...(log.draft === undefined ? {} : { draft: log.draft }),
    objections,
    messages: log.messages,
    ...(log.outcome === undefined ? {} : { outcome: log.outcome }),
    ...(document === undefined ? {} : { document }),
    ...(output !== undefined && document === undefined ? { output, documentError: documentError ?? 'вывод не разобран' } : {}),
    done,
    ...(reused === undefined ? {} : { reusedFrom: { runId: reused.runId, available: reused.stepDir !== undefined } }),
  };
}
