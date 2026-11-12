import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

import { readLockJobs, type LockReview, type LockReviewParticipant } from '../pipeline/document/lockRead.js';
import { AGGREGATOR_ID } from '../pipeline/document/model.js';
import { findStepDir, isRunAlive, listLoopPasses, readUsageSoft } from '../pipeline/run/journal/reader.js';
import { runPaths, type RunPaths } from '../pipeline/run/journal/paths.js';
import type { CostSource, StatusValue } from '../pipeline/run/journal/schema.js';
import { readJournalJson } from './file.js';
import { DEFENDER_ID, DEFENSE_FILE, DISCUSSION_FILE, participantDir, replyDir, threadTurnDir } from './reviewLayout.js';
import type { JournalFileRef } from './snapshot.js';

/**
 * Лента шага `review` для деталей прогона (`review-defend`, design.md,
 * решение 8).
 *
 * Строится из журнала шага, а не из потока бэкенда: `defense.ndjson` —
 * защитник, находки, реплики веток, закрытия и исход;
 * `participants/<id>/step.json`, `participants/<id>/rounds/<r>/step.json` и
 * `participants/defender/<ревьюер>/rounds/<r>/step.json` — кто участвовал,
 * чем и с каким исходом; `output.json` — находки независимого ревью и вердикт
 * агрегатора. Порядок участников и лимит раундов — из замка прогона: каталоги
 * участников порядка не хранят, а цвет участника задаётся его позицией в
 * стратегии.
 *
 * Журнал прежнего режима `discussion` не разбирается: от него остаются
 * участники и вердикт (`legacy`).
 *
 * Чтение остаётся чтением: модуль ничего не пишет на диск. Ленту читает
 * опрос витрины раз в секунду, пока шаг идёт, поэтому отказ разбора любой
 * строки или файла даёт пропуск записи, а не исключение.
 */

/** Раундов ветки по умолчанию — `defend.rounds` стратегии без значения. */
export const DEFAULT_DEFEND_ROUNDS = 2;

/** Расход участника. `null` — сводка ещё не записана либо не называет его. */
export interface ReviewFeedUsage {
  readonly billableTokens: number | null;
  readonly costUsd: number | null;
  readonly costSource?: CostSource;
  /** Время всех вызовов участника — сумма отрезков попыток. */
  readonly wallclockMs: number;
}

/** Один вызов участника: находки, ответ раунда, ход защитника или вердикт. Открывается разобранным ходом. */
export interface ReviewFeedSession {
  /** Раунд ветки; нет — первый вызов (находки ревьюера, вердикт агрегатора). */
  readonly round?: number;
  /** Ветка ревьюера — только у ходов защитника. */
  readonly thread?: string;
  readonly status?: StatusValue;
  readonly reason?: string;
  readonly running: boolean;
  /** Сырой `stdout.log` вызова — путь относительно каталога прогона. */
  readonly stdout?: JournalFileRef;
}

export interface ReviewFeedParticipant {
  readonly id: string;
  readonly role: 'reviewer' | 'aggregator' | 'defender';
  readonly agent?: string;
  readonly model?: string;
  readonly focus?: string;
  /** Позиция в стратегии: ревьюеры по порядку с нуля, затем агрегатор, затем защитник. */
  readonly color: number;
  /** Исход первого вызова: находки ревьюера либо вердикт агрегатора. У защитника нет. */
  readonly status?: StatusValue;
  readonly reason?: string;
  /** Участник исполняется прямо сейчас — его вызов начат и не записан. */
  readonly running: boolean;
  readonly sessions: readonly ReviewFeedSession[];
  readonly usage: ReviewFeedUsage;
}

export type ReviewFindingStatus = 'open' | 'accepted' | 'withdrawn' | 'contested';
export type DefenderStance = 'accept' | 'dispute' | 'clarify';
export type RebuttalStance = 'maintain' | 'withdraw' | 'revise';

export interface ReviewFinding {
  /** Id находки `<ревьюер>.<n>` — в режиме `defend`. */
  readonly id?: string;
  /** Итоговая серьёзность: после пересмотра ревьюером — новая. */
  readonly severity?: string;
  readonly title?: string;
  readonly location?: string;
  readonly detail?: string;
  readonly suggestion?: string;
  /** Статус защиты — в режиме `defend`; `open` — пока находка не закрыта. */
  readonly status?: ReviewFindingStatus;
  /** Заявленная серьёзность, когда итоговая от неё отличается. */
  readonly revisedFrom?: string;
}

/** Кто защищает: форк сессии имплементатора или свежий агент с причиной. */
export interface ReviewFeedDefender {
  readonly mode: 'fork' | 'fresh';
  readonly implementer?: string;
  readonly agent?: string;
  readonly model?: string;
  /** `no_implementer`, `no_session`, `no_fork` или `other_tree` — у свежего агента. */
  readonly reason?: string;
}

/** Ответ реплики по одной находке. */
export interface ReviewFeedResponse {
  readonly finding: string;
  readonly stance: DefenderStance | RebuttalStance;
  readonly text: string;
  /** Доказательство защитника. */
  readonly evidence?: string;
  /** Новая серьёзность у `revise`. */
  readonly severity?: string;
}

export type ReviewFeedEntry =
  | ({ readonly kind: 'defender' } & ReviewFeedDefender)
  | {
      /** Независимые находки ревьюера — первое его сообщение. */
      readonly kind: 'findings';
      readonly participant: string;
      readonly summary: string;
      readonly findings: readonly ReviewFinding[];
    }
  | {
      /** Реплика ветки: ход защитника либо ответ ревьюера. */
      readonly kind: 'reply';
      readonly participant: string;
      readonly side: 'defender' | 'reviewer';
      /** Ветка — id ревьюера. */
      readonly thread: string;
      readonly round: number;
      readonly messageId: string;
      readonly text: string;
      readonly responses: readonly ReviewFeedResponse[];
      /** Ответа нет: дважды не прошёл схему. */
      readonly invalid?: true;
      /** Ответа нет: вызов сорвался — таймаут, отказ бэкенда, неудачный форк. */
      readonly failure?: string;
    }
  | { readonly kind: 'failure'; readonly participant: string; readonly reason: string }
  | { readonly kind: 'outcome'; readonly accepted: number; readonly withdrawn: number; readonly contested: number }
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

/** Находка в боковой панели: статус и итоговая серьёзность. */
export interface ReviewFeedFinding {
  readonly id: string;
  readonly by: string;
  readonly title?: string;
  readonly severity?: string;
  readonly revisedFrom?: string;
  readonly status: ReviewFindingStatus;
}

/** Ветка защиты ревьюера: прошедшие раунды из лимита. */
export interface ReviewFeedThread {
  readonly reviewer: string;
  readonly rounds: number;
  /** Все находки ветки закрыты. */
  readonly settled: boolean;
}

export interface ReviewFeed {
  readonly mode?: 'independent' | 'defend';
  /** Лимит раундов ветки — только у `defend`. */
  readonly rounds?: number;
  readonly defender?: ReviewFeedDefender;
  readonly participants: readonly ReviewFeedParticipant[];
  readonly entries: readonly ReviewFeedEntry[];
  /** Находки защиты по порядку записи — только у `defend`. */
  readonly findings: readonly ReviewFeedFinding[];
  readonly threads: readonly ReviewFeedThread[];
  /**
   * Журнал без ленты: шаг прежнего режима `discussion` либо режима, которого
   * замок не называет, без журнала защиты. Показ — список участников и выход
   * агрегатора.
   */
  readonly legacy: boolean;
  /** Прежний режим, чей журнал лента не разбирает. */
  readonly legacyMode?: 'discussion';
  /** Дописывать больше нечего: шаг записан, прогон не жив либо проход прошлый. */
  readonly done: boolean;
  /**
   * Шаг переиспользован при возобновлении и в этом прогоне не исполнялся:
   * лента прочитана из исходного прогона `runId`. `available: false` —
   * исходного прогона (или шага в нём) больше нет, и от ленты остался вердикт.
   */
  readonly reusedFrom?: { readonly runId: string; readonly available: boolean };
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

const FINDING_KEYS = ['severity', 'title', 'location', 'detail', 'suggestion'] as const;

function findingOf(item: unknown): Record<string, string> | undefined {
  const record = asRecord(item);
  if (record === undefined) return undefined;
  const finding: Record<string, string> = {};
  for (const key of FINDING_KEYS) {
    const value = asString(record[key]);
    if (value !== undefined) finding[key] = value;
  }
  return finding;
}

function findingsOf(content: unknown): Record<string, string>[] {
  const list = asRecord(content)?.findings;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const finding = findingOf(item);
    return finding === undefined ? [] : [finding];
  });
}

/**
 * Записи журнала по строкам. Строка, не разобранная как JSON, пропускается:
 * последняя может быть дописана не целиком, пока шаг идёт.
 */
function readNdjson(path: string): Record<string, unknown>[] | undefined {
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
      return record !== undefined && typeof record.kind === 'string' ? [record] : [];
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
  return {
    wallclockMs,
    ...(status === undefined ? {} : { status }),
    ...(reason === undefined ? {} : { reason }),
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(focus === undefined ? {} : { focus }),
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

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Участники журнала, о которых замок не знает, — по каталогам; агрегатор и защитник отдельно. */
function journalParticipants(stepDir: string): LockReviewParticipant[] {
  return listDirs(join(stepDir, 'participants'))
    .filter((name) => name !== AGGREGATOR_ID && name !== DEFENDER_ID)
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

function reusedFromOf(stepDir: string): string | undefined {
  return asString(asRecord(readJournalJson(join(stepDir, 'step.json')))?.reused_from);
}

/** Сколько переиспользований подряд прослеживается до исполнившего шаг прогона. */
const MAX_REUSE_HOPS = 32;

/**
 * Откуда читать ленту переиспользованного шага: он в этом прогоне не
 * исполнялся, и его участники и `defense.ndjson` остались в исходном
 * прогоне — а тот мог и сам переиспользовать шаг. Без `paths` исходного шага
 * уже нет: прогон удалён или его каталог не найти.
 */
function reusedSource(
  paths: RunPaths,
  jobId: string,
  stepId: string,
  stepDir: string,
): { readonly runId: string; readonly paths?: RunPaths; readonly stepDir?: string } | undefined {
  const first = reusedFromOf(stepDir);
  if (first === undefined) return undefined;
  let runId = first;
  for (let hop = 0; hop < MAX_REUSE_HOPS; hop += 1) {
    const source = runPaths(dirname(paths.projectDir), basename(paths.projectDir), runId);
    const sourceDir = findStepDir(source, jobId, stepId);
    if (sourceDir === undefined) break;
    const next = reusedFromOf(sourceDir);
    if (next === undefined) return { runId: first, paths: source, stepDir: sourceDir };
    runId = next;
  }
  return { runId: first };
}

const FINDING_STATUSES: ReadonlySet<string> = new Set(['accepted', 'withdrawn', 'contested']);
const STANCES: ReadonlySet<string> = new Set(['accept', 'dispute', 'clarify', 'maintain', 'withdraw', 'revise']);

function defenderOf(record: Record<string, unknown> | undefined): ReviewFeedDefender | undefined {
  if (record === undefined || (record.mode !== 'fork' && record.mode !== 'fresh')) return undefined;
  const implementer = asString(record.implementer);
  const agent = asString(record.agent);
  const model = asString(record.model);
  const reason = asString(record.reason);
  return {
    mode: record.mode,
    ...(implementer === undefined ? {} : { implementer }),
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function responsesOf(value: unknown): ReviewFeedResponse[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const finding = asString(record?.finding);
    const stance = asString(record?.stance);
    if (record === undefined || finding === undefined || stance === undefined || !STANCES.has(stance)) return [];
    const evidence = asString(record.evidence);
    const severity = asString(record.severity);
    return [
      {
        finding,
        stance: stance as ReviewFeedResponse['stance'],
        text: asString(record.text) ?? '',
        ...(evidence === undefined || evidence === '' ? {} : { evidence }),
        ...(severity === undefined ? {} : { severity }),
      },
    ];
  });
}

function textOf(record: Record<string, unknown>): string {
  if (!Array.isArray(record.parts)) return '';
  return record.parts.flatMap((part) => {
    const text = asString(asRecord(part)?.text);
    return text === undefined ? [] : [text];
  }).join('\n');
}

interface DefenseLog {
  readonly defender?: ReviewFeedDefender;
  /** Находки по порядку записи, с применёнными пересмотрами и закрытиями. */
  readonly findings: readonly (ReviewFeedFinding & { readonly finding: Record<string, string> })[];
  readonly replies: readonly Extract<ReviewFeedEntry, { kind: 'reply' }>[];
  readonly outcome?: Extract<ReviewFeedEntry, { kind: 'outcome' }>;
}

/** Разбор `defense.ndjson`: статус находки — `open`, пока её не закрыла строка `settled`. */
function readDefense(records: readonly Record<string, unknown>[]): DefenseLog {
  let defender: ReviewFeedDefender | undefined;
  const order: string[] = [];
  const findings = new Map<string, { by: string; finding: Record<string, string>; declared?: string; severity?: string; status: ReviewFindingStatus }>();
  const replies: Extract<ReviewFeedEntry, { kind: 'reply' }>[] = [];
  let outcome: Extract<ReviewFeedEntry, { kind: 'outcome' }> | undefined;
  for (const record of records) {
    switch (record.kind) {
      case 'defender':
        defender = defenderOf(record) ?? defender;
        break;
      case 'finding': {
        const id = asString(record.id);
        const by = asString(record.by);
        if (id === undefined || by === undefined || findings.has(id)) break;
        const finding = findingOf(record) ?? {};
        order.push(id);
        findings.set(id, {
          by,
          finding,
          status: 'open',
          ...(finding.severity === undefined ? {} : { declared: finding.severity, severity: finding.severity }),
        });
        break;
      }
      case 'message': {
        const from = asString(record.from);
        const messageId = asString(record.messageId);
        const thread = asString(record.thread);
        const round = record.round;
        if (from === undefined || messageId === undefined || thread === undefined || typeof round !== 'number') break;
        const side = from === DEFENDER_ID ? 'defender' : 'reviewer';
        const responses = responsesOf(record.responses);
        // Пересмотр серьёзности ревьюером — до закрытия: `settled` несёт итог.
        if (side === 'reviewer') {
          for (const response of responses) {
            const entry = findings.get(response.finding);
            if (response.stance === 'revise' && response.severity !== undefined && entry !== undefined) entry.severity = response.severity;
          }
        }
        const failure = asString(record.failure);
        replies.push({
          kind: 'reply',
          participant: from,
          side,
          thread,
          round,
          messageId,
          text: textOf(record),
          responses,
          ...(record.invalid === true ? { invalid: true as const } : {}),
          ...(failure === undefined ? {} : { failure }),
        });
        break;
      }
      case 'settled': {
        const entry = findings.get(asString(record.finding) ?? '');
        const status = asString(record.status);
        if (entry === undefined || status === undefined || !FINDING_STATUSES.has(status)) break;
        entry.status = status as ReviewFindingStatus;
        const severity = asString(record.severity);
        if (severity !== undefined) entry.severity = severity;
        break;
      }
      case 'outcome': {
        const count = (key: string): number => (typeof record[key] === 'number' ? (record[key] as number) : 0);
        outcome = { kind: 'outcome', accepted: count('accepted'), withdrawn: count('withdrawn'), contested: count('contested') };
        break;
      }
      default:
        break;
    }
  }
  return {
    ...(defender === undefined ? {} : { defender }),
    findings: order.map((id) => {
      const entry = findings.get(id)!;
      const revised = entry.declared !== undefined && entry.severity !== undefined && entry.severity !== entry.declared;
      return {
        id,
        by: entry.by,
        status: entry.status,
        finding: entry.finding,
        ...(entry.finding.title === undefined ? {} : { title: entry.finding.title }),
        ...(entry.severity === undefined ? {} : { severity: entry.severity }),
        ...(revised ? { revisedFrom: entry.declared } : {}),
      };
    }),
    replies,
    ...(outcome === undefined ? {} : { outcome }),
  };
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
  const ownDir = findStepDir(paths, jobId, stepId, undefined, undefined, query.pass);
  const strategy = lockReview(paths, jobId, stepId);
  if (ownDir === undefined && strategy === undefined) return undefined;

  const alive = !pastPass && isRunAlive(paths);
  const stepFinished = ownDir !== undefined && existsSync(join(ownDir, 'step.json'));
  const done = !alive || stepFinished;
  const reused = ownDir === undefined ? undefined : reusedSource(paths, jobId, stepId, ownDir);
  const stepDir = reused === undefined ? ownDir : reused.stepDir;
  // Сырой поток вызова открывается по пути в каталоге этого прогона; файлы
  // исходного прогона так не адресовать.
  const stdoutOf = (path: string): JournalFileRef | undefined => (reused === undefined ? fileRef(paths.dir, path) : undefined);

  const reviewers = strategy !== undefined && strategy.reviewers.length > 0
    ? strategy.reviewers
    : stepDir === undefined
      ? []
      : journalParticipants(stepDir);
  const aggregator = strategy?.aggregator ?? { id: AGGREGATOR_ID };
  const records = stepDir === undefined ? undefined : readNdjson(join(stepDir, DEFENSE_FILE));
  const legacyMode =
    strategy?.mode === 'discussion' || (stepDir !== undefined && existsSync(join(stepDir, DISCUSSION_FILE)))
      ? ('discussion' as const)
      : undefined;
  const mode =
    legacyMode !== undefined
      ? undefined
      : strategy?.mode === 'independent' || strategy?.mode === 'defend'
        ? strategy.mode
        : records !== undefined
          ? ('defend' as const)
          : undefined;
  const defense = mode === 'defend' ? readDefense(records ?? []) : undefined;
  const summary = readUsageSoft(reused?.paths ?? paths).summary;
  const usageOf = summary?.jobs[jobId]?.steps[stepId]?.participants ?? {};
  const usage = (id: string, wallclockMs: number): ReviewFeedUsage => {
    const reported = usageOf[id];
    return {
      billableTokens: reported?.billable_tokens ?? null,
      costUsd: reported?.cost_usd ?? null,
      ...(reported?.cost_source === undefined ? {} : { costSource: reported.cost_source }),
      wallclockMs: reported?.wallclock_ms ?? wallclockMs,
    };
  };

  const participants: ReviewFeedParticipant[] = [...reviewers, aggregator].map((declared, index) => {
    const role = index === reviewers.length ? 'aggregator' : 'reviewer';
    const dir = stepDir === undefined ? undefined : participantDir(stepDir, declared.id);
    const first = dir === undefined ? undefined : readCall(dir);
    const firstRunning = dir !== undefined && existsSync(dir) && first === undefined && alive;
    const sessions: ReviewFeedSession[] = [];
    if (dir !== undefined && existsSync(dir)) {
      const stdout = stdoutOf(join(dir, 'stdout.log'));
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
        const stdout = stdoutOf(join(callDir, 'stdout.log'));
        sessions.push({
          round,
          running: callRunning,
          ...(call?.status === undefined ? {} : { status: call.status }),
          ...(call?.reason === undefined ? {} : { reason: call.reason }),
          ...(stdout === undefined ? {} : { stdout }),
        });
      }
    }
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
      sessions,
      usage: usage(declared.id, wallclockMs),
    };
  });

  // Защитник — один участник на все ветки: его ходы лежат по ревьюерам, расход
  // ведётся под `defender` (design.md, решение 7).
  if (mode === 'defend') {
    const sessions: ReviewFeedSession[] = [];
    let wallclockMs = 0;
    let running = false;
    let seen: CallRecord | undefined;
    if (stepDir !== undefined) {
      const root = participantDir(stepDir, DEFENDER_ID);
      const declaredOrder = reviewers.map((reviewer) => reviewer.id);
      const threads = listDirs(root).sort((left, right) => {
        const a = declaredOrder.indexOf(left);
        const b = declaredOrder.indexOf(right);
        return (a === -1 ? Infinity : a) - (b === -1 ? Infinity : b) || left.localeCompare(right);
      });
      for (const thread of threads) {
        for (const round of listRounds(join(root, thread))) {
          const callDir = threadTurnDir(stepDir, DEFENDER_ID, thread, round);
          const call = readCall(callDir);
          seen ??= call;
          const callRunning = call === undefined && alive;
          running ||= callRunning;
          wallclockMs += call?.wallclockMs ?? 0;
          const stdout = stdoutOf(join(callDir, 'stdout.log'));
          sessions.push({
            thread,
            round,
            running: callRunning,
            ...(call?.status === undefined ? {} : { status: call.status }),
            ...(call?.reason === undefined ? {} : { reason: call.reason }),
            ...(stdout === undefined ? {} : { stdout }),
          });
        }
      }
    }
    const agent = defense?.defender?.agent ?? seen?.agent;
    const model = defense?.defender?.model ?? seen?.model;
    // Перед агрегатором: в панели и списке участников защитник — между
    // ревьюерами и вердиктом, как в ходе шага; цвет — следующий за агрегатором.
    participants.splice(reviewers.length, 0, {
      id: DEFENDER_ID,
      role: 'defender',
      ...(agent === undefined ? {} : { agent }),
      ...(model === undefined ? {} : { model }),
      color: reviewers.length + 1,
      running,
      sessions,
      usage: usage(DEFENDER_ID, wallclockMs),
    });
  }

  const reviewerParticipants = participants.filter((participant) => participant.role === 'reviewer');
  // Прежний режим либо режим неизвестен (замка нет или он прежней формы) и
  // журнала защиты нет: ленту восстановить не из чего.
  const legacy = legacyMode !== undefined || (mode === undefined && done);
  const entries: ReviewFeedEntry[] = [];

  if (!legacy) {
    if (defense?.defender !== undefined) entries.push({ kind: 'defender', ...defense.defender });
    for (const reviewer of reviewerParticipants) {
      if (reviewer.running || reviewer.status === undefined) continue;
      const output = reviewer.status === 'success' && stepDir !== undefined
        ? readJournalJson(join(participantDir(stepDir, reviewer.id), 'output.json'))
        : undefined;
      if (output === undefined) {
        // Ревьюер без находок — тем же правилом, что движок: отказ либо успех без выхода.
        entries.push({ kind: 'failure', participant: reviewer.id, reason: reviewer.reason ?? `status ${reviewer.status}` });
        continue;
      }
      entries.push({ kind: 'findings', participant: reviewer.id, summary: summaryOf(output), findings: reviewerFindings(reviewer.id, output, defense) });
      for (const reply of defense?.replies ?? []) {
        if (reply.thread === reviewer.id) entries.push(reply);
      }
    }
    if (defense?.outcome !== undefined) entries.push(defense.outcome);
  }

  const judge = participants.find((participant) => participant.role === 'aggregator');
  if (judge !== undefined && judge.status !== undefined && stepDir !== undefined) {
    entries.push(verdictEntry(judge.id, judge.status, judge.reason, readJournalJson(join(participantDir(stepDir, judge.id), 'output.json'))));
  } else if (reused !== undefined && stepDir === undefined && ownDir !== undefined) {
    // Исходного прогона нет: вердикт — выход шага, перенесённый при
    // переиспользовании, исход — его запись в этом прогоне.
    const record = asRecord(readJournalJson(join(ownDir, 'step.json')));
    entries.push(
      verdictEntry(
        aggregator.id,
        asString(record?.status) as StatusValue | undefined,
        asString(record?.reason),
        readJournalJson(join(ownDir, 'output.json')),
      ),
    );
  }

  const rounds = mode === 'defend' ? (strategy?.rounds ?? DEFAULT_DEFEND_ROUNDS) : undefined;
  const findings: ReviewFeedFinding[] = (defense?.findings ?? []).map(({ finding: _finding, ...rest }) => rest);
  const threads: ReviewFeedThread[] = mode === 'defend'
    ? reviewerParticipants.flatMap((reviewer) => {
        const own = findings.filter((finding) => finding.by === reviewer.id);
        if (own.length === 0) return [];
        const passed = Math.max(0, ...(defense?.replies ?? []).filter((reply) => reply.thread === reviewer.id).map((reply) => reply.round));
        return [{ reviewer: reviewer.id, rounds: passed, settled: own.every((finding) => finding.status !== 'open') }];
      })
    : [];

  return {
    ...(mode === undefined ? {} : { mode }),
    ...(rounds === undefined ? {} : { rounds }),
    ...(defense?.defender === undefined ? {} : { defender: defense.defender }),
    participants,
    entries,
    findings,
    threads,
    legacy,
    ...(legacyMode === undefined ? {} : { legacyMode }),
    done,
    ...(reused === undefined ? {} : { reusedFrom: { runId: reused.runId, available: stepDir !== undefined } }),
  };
}

/**
 * Находки ревьюера для его сообщения. В режиме `defend` — из журнала защиты:
 * id, итоговая серьёзность и статус. Пока строки находок ревьюера не
 * записаны (защита ещё не началась), — из его выхода с id по порядку и
 * статусом `open`, тем же правилом нумерации, что у движка.
 */
function reviewerFindings(reviewer: string, output: unknown, defense: DefenseLog | undefined): ReviewFinding[] {
  const declared = findingsOf(output);
  if (defense === undefined) return declared;
  const logged = defense.findings.filter((finding) => finding.by === reviewer);
  if (logged.length === 0) {
    return declared.map((finding, index) => ({ ...finding, id: `${reviewer}.${index + 1}`, status: 'open' as const }));
  }
  return logged.map((entry) => ({
    ...entry.finding,
    id: entry.id,
    status: entry.status,
    ...(entry.severity === undefined ? {} : { severity: entry.severity }),
    ...(entry.revisedFrom === undefined ? {} : { revisedFrom: entry.revisedFrom }),
  }));
}

function verdictEntry(participant: string, status: StatusValue | undefined, reason: string | undefined, output: unknown): ReviewFeedEntry {
  const record = asRecord(output);
  const verdict = asString(record?.verdict);
  const summary = asString(record?.summary);
  return {
    kind: 'verdict',
    participant,
    ...(status === undefined ? {} : { status }),
    ...(reason === undefined ? {} : { reason }),
    ...(verdict === undefined ? {} : { verdict }),
    ...(summary === undefined ? {} : { summary }),
    ...(output === undefined ? {} : { output }),
  };
}
