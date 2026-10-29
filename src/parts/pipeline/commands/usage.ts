import { resolveConfig } from '../config/resolve.js';
import { findProjectRoot, shortRunId } from '../run/journal/paths.js';
import {
  isRunAlive,
  readStatus,
  readUsageSoft,
  resolveRun,
  type UsageSummaryUnavailable,
} from '../run/journal/reader.js';
import type { AttemptRecord, CostSource, UsageAttemptReport, UsageReport } from '../run/journal/schema.js';
import { effectiveCost } from '../backend/types.js';
import { estimateMark, estimateNote, mergeCostSources } from '../run/budget/costSource.js';
import { formatDuration, formatMoney, formatTokens } from '../../../kernel/units.js';
import { ExitCode, type ExitCodeValue } from '../../../kernel/errors.js';
import { formatColumns } from '../../../kernel/cli/output.js';
import { commandRow } from '../../../kernel/cli/commandRow.js';
import { PIPELINE_SERVICES } from '../services.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';

const DASH = '—';

/**
 * Общая разметка столбцов для всех трёх уровней.
 *
 * Работа и шаг заполняют только «время» и «списано» — сырые токены и модель
 * принадлежат попытке и складываться по уровню не должны. Пустые ячейки на
 * их местах держат столбцы на своих позициях: столбец обязан означать одно и
 * то же в любой строке, иначе таблицу нельзя читать по вертикали.
 */
const COLUMNS = [
  'бэкенд',
  'модель',
  'вход',
  'выход',
  'чт. кэша',
  'зап. кэша',
  'время',
  'списано',
  'пик',
  'цена',
] as const;

const TIME_COLUMN = COLUMNS.indexOf('время');
const BILLABLE_COLUMN = COLUMNS.indexOf('списано');
const PEAK_COLUMN = COLUMNS.indexOf('пик');
const COST_COLUMN = COLUMNS.indexOf('цена');

/** Цена уровня с источником: без источника (сводка прежней формы) она сообщённая. */
interface CostValue {
  readonly usd: number | undefined;
  readonly source: CostSource | undefined;
}

function totalCells(
  billable: number | undefined,
  wallclockMs: number | undefined,
  cost: CostValue,
): string[] {
  const cells = COLUMNS.map(() => '');
  cells[TIME_COLUMN] = timeCell(wallclockMs);
  cells[BILLABLE_COLUMN] = tokensCell(billable);
  cells[COST_COLUMN] = costCell(cost);
  return cells;
}

/**
 * Строка шага дополнительно несёт пик — максимум по попыткам из сводки. У
 * работы своего пика нет (см. `UsageAccumulator.report`): «наибольшее
 * обращение за работу» не указывает, в каком шаге оно случилось, а столбец
 * там остаётся пустым, как и у сырых токенов.
 */
function stepCells(
  billable: number | undefined,
  wallclockMs: number | undefined,
  cost: CostValue,
  peak: number | undefined,
): string[] {
  const cells = totalCells(billable, wallclockMs, cost);
  cells[PEAK_COLUMN] = tokensCell(peak);
  return cells;
}

/**
 * Расход прогона: работа → шаг → попытка.
 *
 * Источники — `status.json` (всегда, переживает `gc`, несёт бэкенд, модель,
 * сырые токены и время каждой попытки) и `usage.json` (взвешенный
 * billable-токен по попытке, шагу, работе и прогону, и список несообщённых
 * измерений — величины, которых `status.json` не считает). Сводка идущего
 * прогона накоплена на текущий момент, а не подведена (`partial: true`), и
 * строится разбивка по ней так же, как по завершённому прогону. Сводки может
 * не быть вовсе — окно до первой записи или формат устарел, — тогда отчёт
 * всё равно строится, а недоступное помечается явно, а не молчит нулём.
 */
export function runUsageCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): ExitCodeValue {
  const { config } = resolveConfig({ cwd });
  const projectRoot = findProjectRoot(cwd);
  const paths = resolveRun(config.runs.root, projectRoot, args.positional[0]);
  const status = readStatus(paths);
  const { summary, unavailable } = readUsageSoft(paths);

  write(`прогон ${shortRunId(status.run_id)}  ${status.pipeline}  ${status.status}`);
  const costTotal: CostValue =
    summary?.total.cost_usd !== undefined
      ? { usd: summary.total.cost_usd, source: summary.total.cost_source }
      : { usd: status.budget.cost_used_usd, source: status.budget.cost_source };
  write(
    `расход: ${formatTokens(summary?.total.billable_tokens ?? status.budget.tokens_used)} токенов, ${formatDuration(summary?.total.wallclock_ms ?? status.budget.wallclock_ms)}, ${costCell(costTotal)}`,
  );

  const rows: string[][] = [['', ...COLUMNS]];
  // Группировка по lane включается, только если хоть одна работа её несёт:
  // прогон без объявленных дорожек печатается ровно как прежде.
  const hasLanes = status.jobs.some((job) => job.lane !== undefined);
  const printedLanes = new Set<string>();

  for (const job of status.jobs) {
    if (hasLanes && job.lane !== undefined && !printedLanes.has(job.lane)) {
      printedLanes.add(job.lane);
      const laneReports = status.jobs
        .filter((entry) => entry.lane === job.lane)
        .map((entry) => summary?.jobs[entry.id]);
      rows.push([
        job.lane,
        ...totalCells(
          sumOrUnreported(laneReports.map((report) => report?.billable_tokens)),
          sumOrUnreported(laneReports.map((report) => report?.wallclock_ms)),
          {
            usd: sumOrUnreported(laneReports.map((report) => report?.cost_usd)),
            source: mergeCostSources(laneReports.map((report) => report?.cost_source)),
          },
        ),
      ]);
    }

    const jobReport = summary?.jobs[job.id];
    rows.push([
      `  ${job.id}`,
      ...totalCells(jobReport?.billable_tokens, jobReport?.wallclock_ms, {
        usd: jobReport?.cost_usd,
        source: jobReport?.cost_source,
      }),
    ]);
    // Работа с попытками: расход каждой отдельной строкой, а шаги ниже — это
    // шаги последней попытки, и записи расхода берутся её же.
    if (job.attempts !== undefined) {
      for (let n = 1; n <= job.attempts; n += 1) {
        rows.push([`    попытка работы ${n}`, ...jobAttemptCells(jobReport, n)]);
      }
    }
    for (const step of job.steps) {
      const stepReport = jobReport?.steps[step.id];
      const reportedAttempts =
        job.attempts === undefined
          ? stepReport?.attempts
          : stepReport?.attempts.filter((entry) => entry.job_attempt === job.attempts);
      rows.push([
        `    ${step.id}`,
        ...stepCells(
          stepReport?.billable_tokens,
          stepReport?.wallclock_ms,
          { usd: stepReport?.cost_usd, source: stepReport?.cost_source },
          stepReport?.peak_prefix_tokens,
        ),
      ]);
      for (const attempt of step.attempts) {
        rows.push([`      #${attempt.attempt}`, ...attemptCells(attempt, reportedAttempts)]);
      }
    }
  }
  for (const line of formatColumns(rows)) write(line);

  // Живость спрашивается только у незаконченной сводки: у подведённой она
  // ничего не меняет, а лишний обход файлов прогона не бесплатен.
  const alive = summary?.partial === true && isRunAlive(paths);
  // Дата — из самой сводки: старый прогон показывает прейскурант, по которому
  // считался, а не тот, что установлен сейчас.
  const catalogAsOf = summary?.cost_catalog_as_of ?? status.budget.cost_catalog_as_of;
  for (const line of incompleteness(
    summary,
    unavailable,
    status.budget.cost_unreported_attempts,
    alive,
    catalogAsOf,
  )) {
    write(line);
  }

  return ExitCode.ok;
}

/** Расход одной попытки работы: сумма записей её шагов из сводки. */
function jobAttemptCells(jobReport: UsageReport['jobs'][string] | undefined, jobAttempt: number): string[] {
  const entries = Object.values(jobReport?.steps ?? {})
    .flatMap((step) => step.attempts)
    .filter((entry) => entry.job_attempt === jobAttempt);
  if (entries.length === 0) return totalCells(undefined, undefined, { usd: undefined, source: undefined });
  return totalCells(
    entries.reduce((sum, entry) => sum + entry.billable_tokens, 0),
    entries.reduce((sum, entry) => sum + entry.wallclock_ms, 0),
    {
      usd: sumOrUnreported(entries.map((entry) => entry.cost_usd)),
      source: mergeCostSources(entries.map((entry) => entry.cost_source)),
    },
  );
}

function attemptCells(
  attempt: AttemptRecord,
  reported: readonly UsageAttemptReport[] | undefined,
): string[] {
  const usage = attempt.usage;
  const billable = reported?.find((entry) => entry.attempt === attempt.attempt);

  // Ровно столько же ячеек, сколько в ветке ниже: иначе строки без расхода
  // сдвигают колонки соседних, и таблица перестаёт читаться.
  if (usage === undefined) return COLUMNS.map(() => DASH);

  return [
    usage.backend,
    usage.model ?? DASH,
    tokensCell(usage.tokens_in ?? undefined),
    tokensCell(usage.tokens_out ?? undefined),
    tokensCell(usage.cache_read ?? undefined),
    tokensCell(usage.cache_write ?? undefined),
    timeCell(usage.wallclock_ms),
    tokensCell(billable?.billable_tokens),
    // Сначала сводка, и только потом status.json: в status.json попытки лежит
    // пик одного агента, а «списано» слева от него и пик строки шага уже
    // включают вызванного шагом судью. Взять здесь агентский пик значило бы
    // печатать в строке шага величину больше, чем в любой её строке попытки,
    // — расхождение, которое таблица ничем не объясняет. Значение из
    // status.json остаётся запасным: оно переживает gc сводки.
    tokensCell(billable?.peak_prefix_tokens ?? usage.peak_prefix_tokens),
    costCell(
      billable?.cost_usd !== undefined
        ? { usd: billable.cost_usd, source: billable.cost_source }
        : { usd: effectiveCost(usage)?.usd, source: effectiveCost(usage)?.source },
    ),
  ];
}

/** Сумма измерения по дорожке: одна несообщённая работа делает итог несообщённым, не нулевым. */
function sumOrUnreported(values: readonly (number | undefined)[]): number | undefined {
  if (values.some((value) => value === undefined)) return undefined;
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}

function tokensCell(value: number | undefined): string {
  return value === undefined ? DASH : formatTokens(value);
}

function timeCell(value: number | undefined): string {
  return value === undefined ? DASH : formatDuration(value);
}

/** Прочерк вместо нуля: несообщённая цена — не то же самое, что нулевая. */
function costCell(cost: CostValue): string {
  return cost.usd === undefined
    ? DASH
    : `${estimateMark(cost.source)}${formatMoney(Math.round(cost.usd * 1_000_000))}`;
}

/**
 * Строки о неполноте отчёта. `alive` — жив ли процесс прогона: сводка с
 * признаком незаконченности остаётся такой навсегда у прогона, чей процесс
 * убит, и обещать там, что величины «ещё вырастут», значило бы соврать дважды
 * — прогон не идёт и ничего к сводке уже не допишет.
 */
function incompleteness(
  summary: UsageReport | undefined,
  unavailable: UsageSummaryUnavailable | undefined,
  costUnreportedAttempts: number | undefined,
  alive: boolean,
  catalogAsOf: string | undefined,
): string[] {
  const notes: string[] = [];

  if (catalogAsOf !== undefined) notes.push(estimateNote(catalogAsOf));

  if (unavailable === 'missing') {
    // Живая запись пишет usage.json сразу при старте прогона (writeStatus в
    // runner.ts), поэтому это окно — доли секунды между созданием каталога и
    // первой записью — или прогон прежней формы, чей процесс уже мёртв:
    // обещать «агрегат появится по завершении» здесь было бы неверно в обоих
    // случаях.
    notes.push('сводка расхода ещё не записана');
  } else if (unavailable === 'unreadable') {
    notes.push('сводка расхода не прочитана: usage.json не проходит текущую схему');
  } else if (summary !== undefined) {
    if (summary.partial) {
      notes.push(
        alive
          ? 'сводка накоплена на текущий момент: прогон идёт, величины ещё вырастут'
          : 'сводка не подведена: прогон оборван, величины остались на момент обрыва',
      );
    }
    if (summary.unreported.length > 0) {
      notes.push(`учёт неполон: не сообщено — ${summary.unreported.join(', ')}`);
    }
  }

  if (costUnreportedAttempts !== undefined && costUnreportedAttempts > 0) {
    notes.push(
      `цена неполна: ${costUnreportedAttempts} ${pluralAttempts(costUnreportedAttempts)} без сообщённой цены`,
    );
  }

  return notes.length === 0 ? [] : ['', ...notes];
}

function pluralAttempts(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'попытка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'попытки';
  return 'попыток';
}

export const row = commandRow(
  {
    name: 'usage',
    spec: {
      description: 'показать расход прогона по работам, шагам и попыткам',
      positional: ['run'],
    },
    run: (args, io, env) => runUsageCommand(args, io.out, env.cwd),
  },
  { inject: PIPELINE_SERVICES },
);
