import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { readLockJobs, type LockReview, type LockReviewParticipant } from '../pipeline/document/lockRead.js';
import { AGGREGATOR_ID } from '../pipeline/document/model.js';
import { DISCUSSION_FILE, participantDir, replyDir } from '../pipeline/run/exec/reviewStep.js';
import { findStepDir, isRunAlive, listLoopPasses, readUsageSoft } from '../pipeline/run/journal/reader.js';
import { type RunPaths } from '../pipeline/run/journal/paths.js';
import type { CostSource, StatusValue } from '../pipeline/run/journal/schema.js';
import type {
  DiscussionRecord,
  MessageRecord,
  NoConsensusReason,
  ProposalRecord,
  Stance,
} from '../pipeline/steps/review/discussion.js';
import { readJournalJson } from './file.js';
import type { JournalFileRef } from './snapshot.js';

/**
 * Лента шага `review` для деталей прогона (`ui-review-discussion`).
 *
 * Строится из журнала шага, а не из потока бэкенда (design.md, Решение 1):
 * `discussion.ndjson` — реплики и исход, `participants/<id>/step.json` и
 * `rounds/<N>/step.json` — кто участвовал, чем и с каким исходом, их
 * `output.json` — находки независимого ревью и вердикт агрегатора. Порядок и
 * лимит реплик — из замка прогона: каталоги участников порядка не хранят, а
 * цвет участника задаётся его позицией в стратегии.
 *
 * Чтение остаётся чтением: модуль ничего не пишет на диск. Ленту читает
 * опрос витрины раз в секунду, пока шаг идёт, поэтому отказ разбора любой
 * строки или файла даёт пропуск записи, а не исключение.
 */

/** Расход участника. `null` — сводка ещё не записана либо не называет его. */
export interface ReviewFeedUsage {
  readonly billableTokens: number | null;
  readonly costUsd: number | null;
  readonly costSource?: CostSource;
  /** Время всех вызовов участника — сумма отрезков попыток. */
  readonly wallclockMs: number;
}

/** Один вызов участника: находки, реплика раунда или вердикт. Открывается разобранным ходом. */
export interface ReviewFeedSession {
  /** Раунд реплики; нет — первый вызов (находки ревьюера, вердикт агрегатора). */
  readonly round?: number;
  readonly status?: StatusValue;
  readonly reason?: string;
  readonly running: boolean;
  /** Сырой `stdout.log` вызова — путь относительно каталога прогона. */
  readonly stdout?: JournalFileRef;
}

export interface ReviewFeedParticipant {
  readonly id: string;
  readonly role: 'reviewer' | 'aggregator';
  readonly agent?: string;
  readonly model?: string;
  readonly focus?: string;
  /** Позиция в стратегии: ревьюеры по порядку с нуля, агрегатор — следующий. */
  readonly color: number;
  /** Исход первого вызова: находки ревьюера либо вердикт агрегатора. */
  readonly status?: StatusValue;
  readonly reason?: string;
  /** Участник исполняется прямо сейчас — его вызов начат и не записан. */
  readonly running: boolean;
  /** Реплики обсуждения, отправленные ревьюером (раунды ≥ 1). */
  readonly messages: number;
  readonly sessions: readonly ReviewFeedSession[];
  readonly usage: ReviewFeedUsage;
}

/** Предложение, на которое ссылается реплика: id, автор и краткое содержание. */
export interface ReviewFeedQuote {
  readonly id: string;
  readonly by?: string;
  readonly summary: string;
}

export interface ReviewFinding {
  readonly severity?: string;
  readonly title?: string;
  readonly location?: string;
  readonly detail?: string;
  readonly suggestion?: string;
}

export type ReviewFeedEntry =
  | {
      /** Независимые находки ревьюера — первое его сообщение. */
      readonly kind: 'findings';
      readonly participant: string;
      readonly messageId?: string;
      readonly proposal?: string;
      readonly summary: string;
      readonly findings: readonly ReviewFinding[];
    }
  | {
      readonly kind: 'message';
      readonly participant: string;
      readonly messageId: string;
      readonly round: number;
      readonly seq: number;
      readonly stance: Stance;
      readonly text: string;
      /** Порядковый номер реплики ревьюера — счётчик `n/лимит`. */
      readonly count: number;
      /** Предложение, которое реплика вносит (позиция «предлагает»). */
      readonly proposal?: ReviewFeedQuote;
      /** Предложение, с которым реплика соглашается или спорит. */
      readonly target?: ReviewFeedQuote;
      /** Реплики, на которые она отвечает. */
      readonly replyTo?: readonly ReviewFeedQuote[];
      readonly invalid?: true;
    }
  | { readonly kind: 'round'; readonly round: number }
  | { readonly kind: 'failure'; readonly participant: string; readonly reason: string }
  | { readonly kind: 'outcome'; readonly consensus: true; readonly proposal: string }
  | { readonly kind: 'outcome'; readonly consensus: false; readonly reason: NoConsensusReason }
  | {
      readonly kind: 'verdict';
      readonly participant: string;
      readonly status?: StatusValue;
      readonly reason?: string;
      /** Краткий вердикт — поля `verdict` и `summary` выхода, когда они строки. */
      readonly verdict?: string;
      readonly summary?: string;
      /** Выход агрегатора целиком. */
      readonly output?: unknown;
    };

export interface ReviewFeedProposal {
  readonly id: string;
  readonly by: string;
  readonly round: number;
  readonly summary: string;
  /** Действующее, принято консенсусом либо без поддержки. */
  readonly status: 'active' | 'accepted' | 'unsupported';
}

export interface ReviewFeed {
  readonly mode?: 'independent' | 'discussion';
  /** Лимит реплик ревьюера — только у обсуждения. */
  readonly maxMessages?: number;
  readonly participants: readonly ReviewFeedParticipant[];
  readonly entries: readonly ReviewFeedEntry[];
  readonly proposals: readonly ReviewFeedProposal[];
  /**
   * Журнал без ленты: шаг не в режиме `independent`, а `discussion.ndjson`
   * нет. Показ — список участников и выход агрегатора.
   */
  readonly legacy: boolean;
  /** Дописывать больше нечего: шаг записан, прогон не жив либо проход прошлый. */
  readonly done: boolean;
}

export interface ReviewFeedQuery {
  readonly pass?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function summaryOf(content: unknown): string {
  return asString(asRecord(content)?.summary) ?? '';
}

function findingsOf(content: unknown): ReviewFinding[] {
  const list = asRecord(content)?.findings;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const record = asRecord(item);
    if (record === undefined) return [];
    const finding: Record<string, string> = {};
    for (const key of ['severity', 'title', 'location', 'detail', 'suggestion'] as const) {
      const value = asString(record[key]);
      if (value !== undefined) finding[key] = value;
    }
    return [finding as ReviewFinding];
  });
}

/**
 * Записи ленты по строкам. Строка, не разобранная как JSON, пропускается:
 * последняя может быть дописана не целиком, пока шаг идёт.
 */
function readDiscussion(path: string): DiscussionRecord[] | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return [];
    try {
      const record = asRecord(JSON.parse(line));
      return record !== undefined && typeof record.kind === 'string' ? [record as unknown as DiscussionRecord] : [];
    } catch {
      return [];
    }
  });
}

interface CallRecord {
  readonly status?: StatusValue;
  readonly reason?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly focus?: string;
  readonly role?: string;
  readonly wallclockMs: number;
}

/** `step.json` вызова участника: исход и время попыток. */
function readCall(dir: string): CallRecord | undefined {
  const record = asRecord(readJournalJson(join(dir, 'step.json')));
  if (record === undefined) return undefined;
  let wallclockMs = 0;
  if (Array.isArray(record.attempts)) {
    for (const attempt of record.attempts) {
      const entry = asRecord(attempt);
      const started = Date.parse(asString(entry?.started_at) ?? '');
      const finished = Date.parse(asString(entry?.finished_at) ?? '');
      if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) wallclockMs += finished - started;
    }
  }
  const pick = (key: string): string | undefined => asString(record[key]);
  const status = pick('status') as StatusValue | undefined;
  const reason = pick('reason');
  const agent = pick('agent');
  const model = pick('model');
  const focus = pick('focus');
  const role = pick('role');
  return {
    wallclockMs,
    ...(status === undefined ? {} : { status }),
    ...(reason === undefined ? {} : { reason }),
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(focus === undefined ? {} : { focus }),
    ...(role === undefined ? {} : { role }),
  };
}

function fileRef(runDir: string, path: string): JournalFileRef | undefined {
  try {
    return { name: 'stdout.log', path: relative(runDir, path), bytes: statSync(path).size };
  } catch {
    return undefined;
  }
}

function listRounds(dir: string): number[] {
  const rounds = join(dir, 'rounds');
  if (!existsSync(rounds)) return [];
  return readdirSync(rounds)
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);
}

/** Участники журнала, о которых замок не знает, — по каталогам, агрегатор последним. */
function journalParticipants(stepDir: string): LockReviewParticipant[] {
  const root = join(stepDir, 'participants');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name !== AGGREGATOR_ID)
    .sort()
    .map((id) => ({ id }));
}

function lockReview(paths: RunPaths, jobId: string, stepId: string): LockReview | undefined {
  try {
    return readLockJobs(paths.lock)
      .find((job) => job.id === jobId)
      ?.steps.find((step) => step.id === stepId)?.review;
  } catch {
    return undefined;
  }
}

export function readReviewFeed(
  paths: RunPaths,
  jobId: string,
  stepId: string,
  query: ReviewFeedQuery = {},
): ReviewFeed | undefined {
  const passes = listLoopPasses(paths, jobId);
  const lastPass = passes.at(-1);
  const pastPass = query.pass !== undefined && lastPass !== undefined && query.pass < lastPass;
  const stepDir = findStepDir(paths, jobId, stepId, undefined, undefined, query.pass);
  const strategy = lockReview(paths, jobId, stepId);
  if (stepDir === undefined && strategy === undefined) return undefined;

  const alive = !pastPass && isRunAlive(paths);
  const stepFinished = stepDir !== undefined && existsSync(join(stepDir, 'step.json'));
  const done = !alive || stepFinished;

  const reviewers = strategy !== undefined && strategy.reviewers.length > 0
    ? strategy.reviewers
    : stepDir === undefined
      ? []
      : journalParticipants(stepDir);
  const aggregator = strategy?.aggregator ?? { id: AGGREGATOR_ID };
  const mode = strategy?.mode === 'independent' || strategy?.mode === 'discussion' ? strategy.mode : undefined;
  const records = stepDir === undefined ? undefined : readDiscussion(join(stepDir, DISCUSSION_FILE));
  const summary = readUsageSoft(paths).summary;
  const usageOf = summary?.jobs[jobId]?.steps[stepId]?.participants ?? {};

  const messages = (records ?? []).filter((record): record is MessageRecord => record.kind === 'message');
  const proposalRecords = (records ?? []).filter((record): record is ProposalRecord => record.kind === 'proposal');
  const proposalIndex = new Map(proposalRecords.map((record) => [record.id, record]));
  const outcome = records?.find((record) => record.kind === 'outcome');

  const participants: ReviewFeedParticipant[] = [...reviewers, aggregator].map((declared, index) => {
    const role = index === reviewers.length ? 'aggregator' : 'reviewer';
    const dir = stepDir === undefined ? undefined : participantDir(stepDir, declared.id);
    const first = dir === undefined ? undefined : readCall(dir);
    const firstRunning = dir !== undefined && existsSync(dir) && first === undefined && alive;
    const sessions: ReviewFeedSession[] = [];
    if (dir !== undefined && existsSync(dir)) {
      const stdout = fileRef(paths.dir, join(dir, 'stdout.log'));
      sessions.push({
        running: firstRunning,
        ...(first?.status === undefined ? {} : { status: first.status }),
        ...(first?.reason === undefined ? {} : { reason: first.reason }),
        ...(stdout === undefined ? {} : { stdout }),
      });
    }
    let wallclockMs = first?.wallclockMs ?? 0;
    let running = firstRunning;
    if (dir !== undefined && stepDir !== undefined) {
      for (const round of listRounds(dir)) {
        const callDir = replyDir(stepDir, declared.id, round);
        const call = readCall(callDir);
        const callRunning = call === undefined && alive;
        running ||= callRunning;
        wallclockMs += call?.wallclockMs ?? 0;
        const stdout = fileRef(paths.dir, join(callDir, 'stdout.log'));
        sessions.push({
          round,
          running: callRunning,
          ...(call?.status === undefined ? {} : { status: call.status }),
          ...(call?.reason === undefined ? {} : { reason: call.reason }),
          ...(stdout === undefined ? {} : { stdout }),
        });
      }
    }
    const reported = usageOf[declared.id];
    const agent = declared.agent ?? first?.agent;
    const model = declared.model ?? first?.model;
    const focus = declared.focus ?? first?.focus;
    return {
      id: declared.id,
      role,
      ...(agent === undefined ? {} : { agent }),
      ...(model === undefined ? {} : { model }),
      ...(focus === undefined ? {} : { focus }),
      color: index,
      ...(first?.status === undefined ? {} : { status: first.status }),
      ...(first?.reason === undefined ? {} : { reason: first.reason }),
      running,
      messages: messages.filter((message) => message.from === declared.id && message.round > 0).length,
      sessions,
      usage: {
        billableTokens: reported?.billable_tokens ?? null,
        costUsd: reported?.cost_usd ?? null,
        ...(reported?.cost_source === undefined ? {} : { costSource: reported.cost_source }),
        wallclockMs: reported?.wallclock_ms ?? wallclockMs,
      },
    };
  });

  const reviewerParticipants = participants.filter((participant) => participant.role === 'reviewer');
  // Режим неизвестен (замка нет или он прежней формы) и ленты нет: ни
  // находки, ни обсуждение восстановить не из чего.
  const legacy = records === undefined && mode === undefined && done;
  const entries: ReviewFeedEntry[] = [];

  const quote = (id: string | undefined): ReviewFeedQuote | undefined => {
    if (id === undefined) return undefined;
    const proposal = proposalIndex.get(id);
    return proposal === undefined
      ? { id, summary: '' }
      : { id, by: proposal.by, summary: summaryOf(proposal.content) };
  };
  const messageIndex = new Map(messages.map((message) => [message.messageId, message]));

  if (!legacy) {
    if (records !== undefined) {
      for (const message of messages.filter((entry) => entry.round === 0)) {
        const proposal = message.proposal === undefined ? undefined : proposalIndex.get(message.proposal);
        entries.push({
          kind: 'findings',
          participant: message.from,
          messageId: message.messageId,
          ...(message.proposal === undefined ? {} : { proposal: message.proposal }),
          summary: proposal === undefined ? textOf(message) : summaryOf(proposal.content),
          findings: proposal === undefined ? [] : findingsOf(proposal.content),
        });
      }
    } else {
      // Находки независимого ревью (и обсуждения, чей раунд 0 ещё идёт) — из
      // выходов ревьюеров, в порядке стратегии.
      for (const reviewer of reviewerParticipants) {
        if (reviewer.status !== 'success' || stepDir === undefined) continue;
        const output = readJournalJson(join(participantDir(stepDir, reviewer.id), 'output.json'));
        if (output === undefined) continue;
        entries.push({ kind: 'findings', participant: reviewer.id, summary: summaryOf(output), findings: findingsOf(output) });
      }
    }

    // Ревьюер без находок — тем же правилом, что движок: отказ либо успех без выхода.
    for (const reviewer of reviewerParticipants) {
      if (reviewer.status === undefined || reviewer.running) continue;
      const hasFindings = entries.some((entry) => entry.kind === 'findings' && entry.participant === reviewer.id);
      if (hasFindings) continue;
      entries.push({ kind: 'failure', participant: reviewer.id, reason: reviewer.reason ?? `status ${reviewer.status}` });
    }

    const counts = new Map<string, number>();
    let round = 0;
    for (const message of messages) {
      if (message.round === 0) continue;
      if (message.round !== round) {
        round = message.round;
        entries.push({ kind: 'round', round });
      }
      const count = (counts.get(message.from) ?? 0) + 1;
      counts.set(message.from, count);
      const proposal = quote(message.proposal);
      const target = quote(message.target);
      const replyTo = (message.replyTo ?? []).flatMap((id) => {
        const replied = messageIndex.get(id);
        return replied === undefined ? [] : [{ id, by: replied.from, summary: textOf(replied) }];
      });
      entries.push({
        kind: 'message',
        participant: message.from,
        messageId: message.messageId,
        round: message.round,
        seq: message.seq,
        stance: message.stance,
        text: textOf(message),
        count,
        ...(proposal === undefined ? {} : { proposal }),
        ...(target === undefined ? {} : { target }),
        ...(replyTo.length === 0 ? {} : { replyTo }),
        ...(message.invalid === true ? { invalid: true as const } : {}),
      });
    }

    if (outcome !== undefined && outcome.kind === 'outcome') {
      entries.push(
        outcome.consensus
          ? { kind: 'outcome', consensus: true, proposal: outcome.proposal }
          : { kind: 'outcome', consensus: false, reason: outcome.reason },
      );
    }
  }

  const judge = participants.find((participant) => participant.role === 'aggregator');
  if (judge !== undefined && judge.status !== undefined && stepDir !== undefined) {
    const output = readJournalJson(join(participantDir(stepDir, judge.id), 'output.json'));
    const record = asRecord(output);
    const verdict = asString(record?.verdict);
    const summaryText = asString(record?.summary);
    entries.push({
      kind: 'verdict',
      participant: judge.id,
      status: judge.status,
      ...(judge.reason === undefined ? {} : { reason: judge.reason }),
      ...(verdict === undefined ? {} : { verdict }),
      ...(summaryText === undefined ? {} : { summary: summaryText }),
      ...(output === undefined ? {} : { output }),
    });
  }

  return {
    ...(mode === undefined ? {} : { mode }),
    ...(mode === 'discussion' && strategy?.maxMessages !== undefined ? { maxMessages: strategy.maxMessages } : {}),
    participants,
    entries,
    proposals: proposalStatuses(proposalRecords, outcome),
    legacy,
    done,
  };
}

function textOf(message: MessageRecord): string {
  return message.parts.map((part) => part.text).join('\n');
}

/**
 * Статус предложения. Принято — названо исходом с консенсусом. Действующее —
 * последнее предложение своего автора, пока обсуждение не кончилось. Прочие —
 * без поддержки: их автор внёс новое, или обсуждение кончилось не на них.
 */
function proposalStatuses(
  proposals: readonly ProposalRecord[],
  outcome: DiscussionRecord | undefined,
): ReviewFeedProposal[] {
  const latest = new Map<string, string>();
  for (const proposal of proposals) latest.set(proposal.by, proposal.id);
  const accepted = outcome?.kind === 'outcome' && outcome.consensus ? outcome.proposal : undefined;
  return proposals.map((proposal) => ({
    id: proposal.id,
    by: proposal.by,
    round: proposal.round,
    summary: summaryOf(proposal.content),
    status:
      proposal.id === accepted
        ? 'accepted'
        : outcome === undefined && latest.get(proposal.by) === proposal.id
          ? 'active'
          : 'unsupported',
  }));
}
