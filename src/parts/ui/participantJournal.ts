import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

import { findStepDir, readUsageSoft } from '../pipeline/run/journal/reader.js';
import { runPaths, type RunPaths } from '../pipeline/run/journal/paths.js';
import type { CostSource, StatusValue } from '../pipeline/run/journal/schema.js';
import { readJournalJson } from './file.js';
import type { JournalFileRef } from './snapshot.js';

/**
 * Чтение журнала участников шага с несколькими агентами — общее для лент
 * `review` (`reviewFeed.ts`) и `discuss` (`discussFeed.ts`): записи
 * `ndjson`, исход вызова участника, ссылки на поток, раунды, источник
 * переиспользованного шага и расход участника.
 *
 * Чтение остаётся чтением: ничего не пишет на диск, а отказ разбора файла
 * даёт пропуск, а не исключение — ленты опрашиваются, пока шаг идёт.
 */

/** Расход участника. `null` — сводка ещё не записана либо не называет его. */
export interface ParticipantUsage {
  readonly billableTokens: number | null;
  readonly costUsd: number | null;
  readonly costSource?: CostSource;
  /** Время всех вызовов участника — сумма отрезков попыток. */
  readonly wallclockMs: number;
}

/**
 * Расход участников шага из сводки прогона; время без сводки — по попыткам
 * вызовов, которое передаёт вызывающий.
 */
export function participantUsage(paths: RunPaths, jobId: string, stepId: string): (id: string, wallclockMs: number) => ParticipantUsage {
  const summary = readUsageSoft(paths).summary;
  const reported = summary?.jobs[jobId]?.steps[stepId]?.participants ?? {};
  return (id, wallclockMs) => {
    const entry = reported[id];
    return {
      billableTokens: entry?.billable_tokens ?? null,
      costUsd: entry?.cost_usd ?? null,
      ...(entry?.cost_source === undefined ? {} : { costSource: entry.cost_source }),
      wallclockMs: entry?.wallclock_ms ?? wallclockMs,
    };
  };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Записи журнала по строкам. Строка, не разобранная как JSON, пропускается:
 * последняя может быть дописана не целиком, пока шаг идёт.
 */
export function readNdjson(path: string): Record<string, unknown>[] | undefined {
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

export interface CallRecord {
  readonly status?: StatusValue;
  readonly reason?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly focus?: string;
  readonly wallclockMs: number;
}

/** `step.json` вызова участника: исход и время попыток. */
export function readCall(dir: string): CallRecord | undefined {
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

export function fileRef(runDir: string, path: string): JournalFileRef | undefined {
  try {
    return { name: basename(path), path: relative(runDir, path), bytes: statSync(path).size };
  } catch {
    return undefined;
  }
}

export function listRounds(dir: string): number[] {
  const rounds = join(dir, 'rounds');
  if (!existsSync(rounds)) return [];
  return readdirSync(rounds)
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);
}

export function listDirs(dir: string): string[] {
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

export function reusedFromOf(stepDir: string): string | undefined {
  return asString(asRecord(readJournalJson(join(stepDir, 'step.json')))?.reused_from);
}

/** Сколько переиспользований подряд прослеживается до исполнившего шаг прогона. */
export const MAX_REUSE_HOPS = 32;

/**
 * Откуда читать ленту переиспользованного шага: он в этом прогоне не
 * исполнялся, и его участники и `defense.ndjson` остались в исходном
 * прогоне — а тот мог и сам переиспользовать шаг. Без `paths` исходного шага
 * уже нет: прогон удалён или его каталог не найти.
 */
export function reusedSource(
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
