import { USAGE_STORE_FORMAT } from './format.js';
import { runPaths, usageDatabasePath } from './paths.js';
import { isRunAlive, listProjects, listRunsByKey, readManifest, readStatus, readUsageSoft } from './reader.js';
import {
  isFailure,
  type RunManifest,
  type RunStatus,
  type UsageRecord,
  type UsageReport,
} from './schema.js';
import { breakdownReport } from './usageSpread.js';

import { appendUsageRecord, readUsageStore } from './usageDatabase.js';
export { appendUsageRecord, readUsageStore, removeUsageRecords, usageRecordAddress } from './usageDatabase.js';
export type { UsageStoreReadResult } from './usageDatabase.js';

/**
 * Собрать запись хранилища из манифеста, состояния и сводки расхода прогона —
 * единственная точка сборки, общая для движка (в конце прогона, минуя диск) и
 * переноса накопленного (читая те же три документа с диска). Расхождение
 * счёта между «живым» и «переносящим» путём было бы негде заметить: записи
 * прошлых прогонов уже не с чем сверить (Решение 2).
 *
 * `key` передаётся явно, а не вычисляется из `manifest.project_root`: ключ
 * проекта — необратимый хеш пути (`projectKey` в `paths.ts`), и его
 * пересчёт потребовал бы, чтобы путь проекта существовал на диске прямо
 * сейчас, — а вызывающие (движок, перенос, удаление прогона) уже знают ключ
 * из собственной раскладки, без обращения к файловой системе.
 */
export function usageRecord(
  key: string,
  manifest: RunManifest,
  status: RunStatus,
  report: UsageReport,
): UsageRecord {
  const { models, costUnreportedAttempts } = breakdownReport(report);

  return {
    format: USAGE_STORE_FORMAT,
    project: { key, path: manifest.project_root },
    pipeline: { name: manifest.pipeline, file: manifest.pipeline_address ?? manifest.pipeline_file },
    run_id: manifest.run_id,
    started_at: manifest.started_at,
    ...(manifest.finished_at === undefined ? {} : { finished_at: manifest.finished_at }),
    status: status.status,
    total: { ...report.total },
    ...(report.cost_catalog_as_of === undefined ? {} : { cost_catalog_as_of: report.cost_catalog_as_of }),
    unreported: report.unreported,
    cost_unreported_attempts: costUnreportedAttempts,
    models: Object.fromEntries(
      [...models].map(([model, delta]) => [
        model,
        {
          billable_tokens: delta.billableTokens,
          ...(delta.costUsd === undefined ? {} : { cost_usd: delta.costUsd }),
        },
      ]),
    ),
    jobs: Object.fromEntries(
      Object.entries(report.jobs).map(([jobId, job]) => [
        jobId,
        {
          billable_tokens: job.billable_tokens,
          wallclock_ms: job.wallclock_ms,
          ...(job.cost_usd === undefined ? {} : { cost_usd: job.cost_usd }),
          ...(job.cost_source === undefined ? {} : { cost_source: job.cost_source }),
          steps: Object.fromEntries(
            Object.entries(job.steps).map(([stepId, step]) => [
              stepId,
              {
                billable_tokens: step.billable_tokens,
                wallclock_ms: step.wallclock_ms,
                ...(step.cost_usd === undefined ? {} : { cost_usd: step.cost_usd }),
                ...(step.cost_source === undefined ? {} : { cost_source: step.cost_source }),
              },
            ]),
          ),
        },
      ]),
    ),
  };
}

/** Хранилища, перенос которых уже выполнен в этом процессе (Решение 9). */
const backfilled = new Set<string>();

export interface CatchUpUsageStoreOptions {
  /** Сузить обход до одного проекта — иначе обходятся все проекты корня. */
  readonly project?: string;
}

/**
 * Перенести в хранилище прогоны, которые есть на диске области, но которых в
 * хранилище ещё нет, — без защёлки: вызывать можно на каждый отбор, а не
 * только на открытие хранилища (design.md изменения
 * cleanup-selection-returns-empty, Решение 1).
 *
 * Отличие от `backfillUsageStore` — не в переносе (он тот же), а в том, когда
 * его можно повторить: `backfillUsageStore` защищён множеством `backfilled` и
 * годится для горячих путей (`GET /api/usage`, сборка обзора), где повторный
 * полный обход корня был бы дорог и не нужен — хранилище пополняется редко.
 * Отбор, который человек запросил и ждёт, — не горячий путь: он уже обходит
 * каждый каталог прогона рекурсивно ради размера, и место, где отставание
 * хранилища от диска видно и вредно. Обеим функциям нужны разные имена, чтобы
 * разница была видна в местах вызова, а не только в комментарии здесь.
 *
 * Живые прогоны пропускаются. Переносятся оборванные, застрявшие в `running`:
 * их расход накоплен и реален, а исход берётся из состояния как есть. Если
 * прогон впоследствии завершится, его запись перезапишется терминальной
 * (Решение 6) — перенос её не защищает от этого и не должен.
 */
export function catchUpUsageStore(runsRoot: string, options: CatchUpUsageStoreOptions = {}): void {
  const present = usageRecordAddresses(runsRoot);
  const keys =
    options.project !== undefined
      ? [options.project]
      : listProjects(runsRoot).map((project) => project.key);

  for (const key of keys) {
    for (const runId of listRunsByKey(runsRoot, key)) {
      if (!catchUpRun(runsRoot, key, runId, present)) return;
    }
  }
}

/**
 * Догон по явному списку прогонов: областью служит сам список, обходить корень
 * незачем. Нужен отбору по названным адресам (`GET /api/runs?run=…`), которому
 * хранилище нужно только ради метки «записи нет» у этих самых прогонов.
 */
export function catchUpUsageRecords(
  runsRoot: string,
  addresses: readonly { readonly key: string; readonly runId: string }[],
): void {
  const present = usageRecordAddresses(runsRoot);
  for (const { key, runId } of addresses) {
    if (!catchUpRun(runsRoot, key, runId, present)) return;
  }
}

/**
 * Один шаг догона. Отвечает, можно ли догону продолжать: `false` — дозапись
 * отказала.
 *
 * Догон дописывает производное (хранилище выводится из каталогов прогонов) и
 * зовётся с путей, которые сами по себе — чтение: отбор, который человек
 * запросил и ждёт. Отказ дозаписи — корень только для чтения, кончилось место,
 * база заведена другим пользователем — обязан вырождать догон в
 * «отбор без свежих записей», а не в отказ отбора и не в падение демона:
 * маршруты витрины синхронны, и брошенное отсюда исключение уронило бы весь
 * процесс. Обход при этом прекращается на первом же отказе: причина у всех
 * записей одна, и пятьсот одинаковых отказов подряд — только задержка ответа.
 *
 * Дозапись по просьбе удаления (`ensureUsageRecord`) этой пощады не знает и не
 * должна: там запись обязана лечь на диск до `rmSync`, и молчание стоило бы
 * статистики прогона.
 */
function catchUpRun(runsRoot: string, key: string, runId: string, present: Set<string>): boolean {
  const address = `${key}/${runId}`;
  if (present.has(address)) return true;
  try {
    if (appendIfSummarized(runsRoot, key, runId)) present.add(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Перенести в хранилище прогоны всего корня, не чаще одного раза за время
 * жизни процесса на хранилище (ключ — путь файла хранилища): повторный вызов —
 * дешёвый no-op, поэтому вызывать функцию можно откуда угодно, где хранилище
 * открывается, не думая, кто уже успел его открыть раньше. Однократный вход
 * для старта демона и `gc`; отбор, которому нужен свежий диск на каждый
 * запрос, зовёт догон `catchUpUsageStore` напрямую.
 */
export function backfillUsageStore(runsRoot: string): void {
  const path = usageDatabasePath(runsRoot);
  if (backfilled.has(path)) return;
  backfilled.add(path);
  catchUpUsageStore(runsRoot);
}

/**
 * Дописать запись прогона из его каталога, если сводка расхода уже есть.
 * Отвечает, дописана ли запись: вызывающий, ведущий набор уже сохранённых
 * адресов, обязан узнать об этом, не перечитывая хранилища.
 */
function appendIfSummarized(runsRoot: string, key: string, runId: string): boolean {
  const paths = runPaths(runsRoot, key, runId);
  if (isRunAlive(paths)) return false;
  let manifest: RunManifest;
  let status: RunStatus;
  try {
    manifest = readManifest(paths);
    status = readStatus(paths);
  } catch {
    // Журнал прогона не читается — переносить с диска нечего.
    return false;
  }

  const { summary } = readUsageSoft(paths);
  // Сводки ещё нет вовсе — окно до первой записи прогона прежней формы,
  // писавшей сводку только в конце и не дожившей до неё. Переносить нечего.
  if (summary === undefined) return false;

  appendUsageRecord(runsRoot, usageRecord(key, manifest, status, summary));
  return true;
}

/**
 * Адреса записей, уже лежащих в хранилище. Отдаётся изменяемым набором: тот,
 * кто обходит список прогонов, читает хранилище один раз на весь список и
 * ведёт этот набор дальше сам (`ensureUsageRecord`), вместо того чтобы
 * читать таблицу SQLite заново на каждый адрес.
 */
export function usageRecordAddresses(runsRoot: string): Set<string> {
  return new Set(readUsageStore(runsRoot).records.keys());
}

/**
 * Сохранить свежую запись прогона из его каталога перед удалением, не
 * зная про перенос всего корня и не запуская его. Используется удалением
 * файлов прогона: обязано убедиться, что запись есть, прежде чем каталог
 * уйдёт под `rmSync` (design.md, Решение 10).
 *
 * `present` — набор уже известных адресов: групповое удаление передаёт сюда
 * один набор на весь список и пополняет его дозаписанным, иначе каждый адрес
 * стоил бы полного чтения хранилища (и группа в 500 адресов — 500 чтений).
 */
export function ensureUsageRecord(
  runsRoot: string,
  key: string,
  runId: string,
  present: Set<string> = usageRecordAddresses(runsRoot),
): void {
  const address = `${key}/${runId}`;
  // Перед удалением перечитать сводку: перенос мог сохранить промежуточный
  // расход оборванного прогона, после которого движок успел дописать файлы.
  if (appendIfSummarized(runsRoot, key, runId)) present.add(address);
}

export interface UsageRecordSelectTraits {
  readonly failed?: boolean;
  readonly olderThanMs?: number;
}

export interface UsageRecordSelectOptions {
  /**
   * Ключ проекта: область отбора, за которую он не выходит. Проект сужает
   * отбор, как и срок: «снять записи отказавших прогонов этого проекта»
   * просит именно отказавшие записи этого проекта, а не все записи проекта
   * заодно с чужими отказавшими.
   */
  readonly project?: string;
  readonly now?: Date;
}

export interface SelectedUsageRecord {
  readonly address: string;
  readonly record: UsageRecord;
  readonly ageMs: number;
}

/**
 * Отбор записей к снятию — тем же трём признакам, что и у отбора каталогов
 * (`selectCandidates` в `run/cleanup.ts`), кроме «оборванного»: оборванность —
 * состояние `running` при мёртвом процессе, а `pid` живёт в каталоге, которого
 * у записи может уже не быть (Решение 14).
 *
 * Исход, срок и проект сужают отбор по «и»: «отказавшие старше 2d» — это
 * отказавшие записи старше двух дней, а не все отказавшие заодно со всем
 * старым (изменение cleanup-age-narrows-traits). Названный проект при этом
 * сам по себе признак: отбор без возраста и без исхода, но с проектом,
 * отбирает эту область целиком — иначе «снять
 * статистику вот этого проекта» не выражалось бы вовсе. Отбор совсем без
 * признаков не отбирает ничего — так же, как `gc` без `--older-than` только
 * отчитывается.
 */
export function selectUsageRecords(
  runsRoot: string,
  traits: UsageRecordSelectTraits,
  options: UsageRecordSelectOptions = {},
): SelectedUsageRecord[] {
  const narrowing = traits.failed === true || traits.olderThanMs !== undefined;
  if (!narrowing && options.project === undefined) return [];

  const now = options.now ?? new Date();
  const { records } = readUsageStore(runsRoot);
  const selected: SelectedUsageRecord[] = [];

  for (const [address, record] of records) {
    if (options.project !== undefined && record.project.key !== options.project) continue;

    const moment = record.finished_at ?? record.started_at;
    const ageMs = Math.max(0, now.getTime() - new Date(moment).getTime());

    const matches =
      (traits.failed !== true || isFailure(record.status)) &&
      (traits.olderThanMs === undefined || ageMs >= traits.olderThanMs);

    if (!matches) continue;
    selected.push({ address, record, ageMs });
  }

  return selected;
}

