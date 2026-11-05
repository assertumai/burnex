import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path';

import {
  DEFAULT_STALE_HOURS,
  checkNeeds,
  declaresNeeds,
  isFree,
  isRunOwner,
  missingRefs,
  archivedPathFor,
  finishItem,
  insertItem,
  needsMet,
  parseBacklogFile,
  parseRunOwner,
  readArchivedEntries,
  runOwner,
  readBacklogFile,
  selectItems,
  statusResolver,
  toRecord,
  unmetNeeds,
  withBacklogLock,
  withFields,
  withoutFields,
  writeBacklogFile,
  type BacklogEntry,
  type BacklogRecord,
  type FinishOwner,
  type OwnerJudge,
  type StatusOf,
} from '../domain/backlog/index.js';
import { resolveConfig } from '../config/resolve.js';
import { mergeJobData } from '../run/journal/data.js';
import { atomicWrite } from '../run/journal/writer.js';
import { findProjectRoot, shortRunId } from '../run/journal/paths.js';
import { finishOwnerOfRun, runOwnerJudge } from '../run/journal/owner.js';
import { ExitCode, BurnexError, type ExitCodeValue } from '../../../kernel/errors.js';
import { readEngineEnv } from '../../../kernel/env-names.js';
import { readLaneItem, takenLanes } from '../domain/lanes/item.js';
import { commitPath, nestedRepoOf } from '../domain/lanes/tree.js';
import { commandRow } from '../../../kernel/cli/commandRow.js';
import { PIPELINE_SERVICES } from '../services.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';

/**
 * `burnex backlog list|pick|finish|settle|add|show` — очередь улучшений, не зависящая от
 * устройства проекта: ни конфигурация, ни `.burnex/`, ни каталог прогона ей
 * не нужны, только путь к файлу очереди. Подкоманда разбирается первым
 * позиционным аргументом самой командой: `parseArgs` вложенных команд не
 * заводит.
 */

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIONS = ['list', 'pick', 'finish', 'settle', 'add', 'show'] as const;

/** Единая причина `settle`: различимые причины несведения проставляет само сведение дорожек. */
const SETTLE_REASON = 'заход до сведения дорожки не дошёл';

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Ключ `--owner`: владелец-прогон `run:<id>`. Неверная форма — ошибка
 * конфигурации до захвата очереди: молча записать в `claimed_by` строку,
 * о которой никто не сумеет судить, значило бы вернуть пункту порог давности
 * под видом владельца.
 */
function ownerFlag(flags: ParsedArgs['flags']): string | undefined {
  const owner = stringFlag(flags, 'owner');
  if (owner !== undefined && !isRunOwner(owner)) {
    throw new BurnexError(`ключ --owner требует владельца вида run:<id прогона>, получено «${owner}»`, {
      hint: 'идентификатор прогона — непустой, без пробелов и /',
    });
  }
  return owner;
}

/**
 * Исход от имени прогона `runId`. Владелец, равный `run:<runId>`, свой сразу:
 * для такого ответа не нужны ни конфигурация, ни журнал прогонов. Они
 * читаются лишь ради родства по `resumed_from` — когда владелец пункта иной.
 */
function runFinishOwner(
  file: string,
  cwd: string,
  runId: string,
  onForeign?: (claimedBy: string, slug: string) => void,
): FinishOwner {
  const own = runOwner(runId);
  let kinship: FinishOwner | undefined;
  return {
    isOwn: (claimedBy) => {
      if (claimedBy === own) return true;
      kinship ??= finishOwnerOfRun(resolveConfig({ cwd }).config.runs.root, findProjectRoot(dirname(file)), runId);
      return kinship.isOwn(claimedBy);
    },
    ...(onForeign === undefined ? {} : { onForeign }),
  };
}

function numberFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = flags[name];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Каталог дорожек готовится до правки очереди.
 *
 * Порядок здесь существенный: помеченный `in_progress` пункт, чей
 * `item-<дорожка>.json` не записался, сведение не найдёт и исход ему никто не
 * проставит — он провисит до порога давности. Отказ обязан случиться раньше,
 * чем очередь тронута.
 */
function prepareRunDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    throw new BurnexError(
      `Не удалось подготовить каталог дорожек ${path}: ${(error as Error).message}`,
      { file: path, cause: error },
    );
  }
}

function parseLanes(raw: string): readonly string[] {
  const lanes = raw.split(',').map((entry) => entry.trim());
  if (lanes.length === 0 || lanes.some((lane) => lane === '')) {
    throw new BurnexError('ключ --lanes требует непустого перечня имён через запятую');
  }
  for (const lane of lanes) {
    if (!KEBAB_CASE.test(lane)) {
      throw new BurnexError(`имя дорожки «${lane}» не является слагом в kebab-case`);
    }
  }
  if (new Set(lanes).size !== lanes.length) {
    throw new BurnexError('имена дорожек должны быть попарно различны');
  }
  return lanes;
}

export function runBacklogCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  writeErr: (line: string) => void,
): ExitCodeValue {
  const [action, slug] = args.positional;
  const file = resolvePath(cwd, stringFlag(args.flags, 'file') ?? 'backlog.md');

  switch (action) {
    case 'list':
      return runList(file, write);
    case 'pick':
      return runPick(args, file, cwd, write, writeErr);
    case 'finish':
      return runFinish(args, slug, file, cwd, writeErr);
    case 'settle':
      return runSettle(args, file, cwd, write);
    case 'add':
      return runAdd(args, slug, file);
    case 'show':
      return runShow(args, slug, file, cwd, write);
    default:
      throw new BurnexError(
        `неизвестное действие «${action ?? ''}» у команды backlog, ожидалось одно из ${ACTIONS.join(', ')}`,
      );
  }
}

/**
 * Проверить связи `needs` и вернуть источник статусов зависимостей; `undefined`,
 * когда ни один пункт зависимостей не объявил, — тогда архив не читается и
 * очередь без поля ведёт себя как прежде.
 *
 * Зовут только `list` и `pick`. `finish`, `settle` и сведение дорожек
 * проставляют исход по слагу, и битая зависимость постороннего пункта не
 * должна стоить отметки `done` влитой работы.
 */
function checkedStatusOf(file: string, entries: readonly BacklogEntry[]): StatusOf | undefined {
  if (!declaresNeeds(entries)) return undefined;
  const archived = readArchivedEntries(file);
  try {
    checkNeeds(entries, archived);
  } catch (error) {
    if (!(error instanceof BurnexError)) throw error;
    throw new BurnexError(error.message, { file, ...(error.at === undefined ? {} : { at: error.at }), cause: error });
  }
  return statusResolver(entries, archived);
}

function runList(file: string, write: (line: string) => void): ExitCodeValue {
  const entries = parseBacklogFile(file, readBacklogFile(file));
  checkedStatusOf(file, entries);
  write(JSON.stringify(entries.map(toRecord), null, 2));
  return ExitCode.ok;
}

function runPick(
  args: ParsedArgs,
  file: string,
  cwd: string,
  write: (line: string) => void,
  writeErr: (line: string) => void,
): ExitCodeValue {
  const staleHours = numberFlag(args.flags, 'stale-hours') ?? DEFAULT_STALE_HOURS;
  if (!Number.isFinite(staleHours) || staleHours <= 0) {
    throw new BurnexError('ключ --stale-hours требует положительного числа');
  }
  const staleMs = staleHours * 3600_000;

  const now = new Date().toISOString();
  const nowMs = Date.parse(now);

  const only = stringFlag(args.flags, 'only');
  const owner = ownerFlag(args.flags);

  const lanesOption = stringFlag(args.flags, 'lanes');
  if (lanesOption !== undefined) {
    // Формы выдачи не смешиваются: у `--lanes` число пунктов задаёт перечень
    // дорожек, и молча выбранная за вызывающего форма скрыла бы от него, что
    // одно из двух названных чисел не сработало.
    if (args.flags['slots'] !== undefined) {
      throw new BurnexError('ключи --lanes и --slots взаимно исключают друг друга: форма выдачи одна');
    }
    runPickLanes(args, file, cwd, now, nowMs, staleMs, lanesOption, only, owner, write, writeErr);
    return ExitCode.ok;
  }

  const slots = numberFlag(args.flags, 'slots') ?? 1;
  if (!Number.isInteger(slots) || slots <= 0) {
    throw new BurnexError('ключ --slots требует целого положительного числа');
  }

  const chosen = claimItems(file, cwd, slots, only, owner, now, nowMs, staleMs, writeErr);

  write(JSON.stringify(chosen.map(toRecord), null, 2));
  return ExitCode.ok;
}

/**
 * Выбрать пункты и пометить их `in_progress` одним захватом очереди.
 *
 * Чтение, проверка названного пункта, отбор и запись обязаны идти под одним
 * lock'ом: иначе два параллельных `pick` читают один файл, видят одни и те же
 * свободные пункты и выдают их дважды.
 */
function claimItems(
  file: string,
  cwd: string,
  count: number,
  only: string | undefined,
  owner: string | undefined,
  now: string,
  nowMs: number,
  staleMs: number,
  writeErr: (line: string) => void,
): readonly BacklogEntry[] {
  return withBacklogLock(file, 'backlog pick', () => {
    const text = readBacklogFile(file);
    const entries = parseBacklogFile(file, text);
    const statusOf = checkedStatusOf(file, entries);
    const ownerOf = ownerJudgeFor(file, cwd, entries, writeErr);

    // Названный пункт проверяется до отбора: «пункта нет» и «пункт занят» —
    // разные беды, и обе обязаны прозвучать словами. Молчаливая пустая выдача
    // на опечатку в слаге выглядела бы как «свободных пунктов нет».
    if (only !== undefined) {
      const named = entries.find((entry) => entry.slug === only);
      if (named === undefined) {
        throw new BurnexError(`пункт «${only}» в очереди не найден`, { file, at: only });
      }
      if (!isFree(named, nowMs, staleMs, ownerOf)) {
        throw new BurnexError(
          `пункт «${only}» не свободен: status ${named.data.status}`,
          { file, at: only, hint: 'свободны todo, in_progress мёртвого владельца и зависший in_progress без владельца' },
        );
      }
      if (statusOf !== undefined && !needsMet(named, statusOf)) {
        const unmet = unmetNeeds(named, statusOf)
          .map((need) => `${need.slug} (${need.status})`)
          .join(', ');
        throw new BurnexError(`пункт «${only}» ждёт зависимостей: ${unmet}`, {
          file,
          at: only,
          hint: 'зависимость выполняет только статус done',
        });
      }
    }

    // Материалы пункта отсчитываются от каталога файла очереди. Проверка идёт
    // только здесь, под тем же lock'ом, что и отбор: `list`, `finish` и `settle`
    // файлов не трогают — исход и показ очереди не должны зависеть от диска.
    const queueDir = dirname(file);
    if (only !== undefined) {
      const named = entries.find((entry) => entry.slug === only);
      const missing = named === undefined ? [] : missingRefs(named, queueDir);
      if (missing.length > 0) {
        throw new BurnexError(
          `пункт «${only}» назвал материалы, которых нет: ${missing.join(', ')}`,
          { file, at: only, hint: `пути отсчитываются от каталога очереди ${queueDir}` },
        );
      }
    }

    const chosen = selectItems(
      entries,
      count,
      nowMs,
      staleMs,
      only,
      statusOf,
      (entry) => missingRefs(entry, queueDir),
      (entry, missing) =>
        writeErr(`backlog pick: пункт «${entry.slug}» пропущен: нет файла ${missing[0]} (goal/details)`),
      ownerOf,
    );
    if (chosen.length > 0) writeBacklogFile(file, applyPick(text, chosen, now, owner));
    return chosen;
  });
}

/**
 * Судья владельцев для отбора — только когда в очереди есть `in_progress` с
 * `claimed_by`: очередь без владельцев не зависит от устройства проекта, как
 * и прежде. Отказ конфигурации не останавливает `pick`: все владельцы тогда
 * `unknown`, то есть прежний порог давности — безопаснее остановки очереди.
 */
function ownerJudgeFor(
  file: string,
  cwd: string,
  entries: readonly BacklogEntry[],
  writeErr: (line: string) => void,
): OwnerJudge | undefined {
  const needed = entries.some(
    (entry) => entry.data.status === 'in_progress' && entry.data.claimed_by !== undefined,
  );
  if (!needed) return undefined;
  try {
    const { config } = resolveConfig({ cwd });
    return runOwnerJudge(config.runs.root, findProjectRoot(dirname(file)));
  } catch (error) {
    if (!(error instanceof BurnexError)) throw error;
    writeErr(
      `backlog pick: владельцы пунктов не проверены, действует порог давности: ${error.message}`,
    );
    return () => 'unknown';
  }
}

function runPickLanes(
  args: ParsedArgs,
  file: string,
  cwd: string,
  now: string,
  nowMs: number,
  staleMs: number,
  lanesOption: string,
  only: string | undefined,
  owner: string | undefined,
  write: (line: string) => void,
  writeErr: (line: string) => void,
): void {
  const lanes = parseLanes(lanesOption);
  // Относительный путь разрешается от того же рабочего каталога, что и
  // `--file`: команда обязана понимать все свои пути одинаково, а не брать
  // часть из них у процесса.
  const declaredRunDir = stringFlag(args.flags, 'run-dir');
  const runDir = declaredRunDir === undefined ? undefined : resolvePath(cwd, declaredRunDir);
  // Каталог дорожек готов до правки очереди и до захвата: отказ подготовки не
  // должен оставить пункты `in_progress` без каталога, а lock — висеть на
  // файловых операциях, которые очереди не касаются.
  if (runDir !== undefined) prepareRunDir(runDir);

  const chosen = claimItems(file, cwd, lanes.length, only, owner, now, nowMs, staleMs, writeErr);

  const result: Record<string, unknown> = {};

  lanes.forEach((lane, index) => {
    const entry = chosen[index];
    if (entry === undefined) {
      result[lane] = { filled: false, slug: '', title: '', group: '', track: '', item: null };
      return;
    }
    const record: BacklogRecord = toRecord(entry);
    result[lane] = {
      filled: true,
      slug: record.slug,
      title: record.title,
      group: record.group,
      track: record.track,
      item: record,
    };
    if (runDir !== undefined) {
      atomicWrite(join(runDir, `item-${lane}.json`), `${JSON.stringify(record, null, 2)}\n`);
    }
  });

  publishPickedTitles(lanes, chosen, writeErr);
  write(JSON.stringify({ lanes: result }, null, 2));
}

/**
 * Опубликовать выбранные пункты данными работы — тем же вызовом, что и выбор.
 *
 * Отдельного шага для этого не заводится: `pick` уже знает выбранный пункт, и
 * выковыривать значение из JSON в командной строке ради того же результата
 * значило бы платить вторым процессом за то, что здесь уже в руках.
 *
 * Пишется, только когда команда исполняется внутри шага прогона: вне его
 * `BURNEX_JOB_DIR` нет, и публиковать некуда — но и отказывать не за что,
 * `backlog pick` остаётся командой, работающей без прогона.
 *
 * Для нескольких дорожек заголовок и слаг пишутся по ключу на дорожку
 * (`title-a`, `slug-a`), а `title` без суффикса склеивается из заполненных
 * дорожек. Склейка — потому что подпись узла одна: узел `slots` в графе один
 * на все дорожки, и выбрать «какую из двух дорожек показать» нечем. Ключи с
 * суффиксом — потому что склеенная строка не разбирается обратно, а
 * потребителю, которому нужна одна дорожка, нужна именно она.
 *
 * Работа, не объявившая эти ключи, их не получит: `mergeJobData` отказывает,
 * и отказ не отменяет уже состоявшийся выбор — пункты в очереди уже помечены.
 * Молчание здесь, однако, не заведено: агент, вызвавший `backlog pick` внутри
 * чужой работы на пробу, — главный адресат объяснения, почему подписи нет.
 */
function publishPickedTitles(
  lanes: readonly string[],
  chosen: readonly BacklogEntry[],
  writeErr: (line: string) => void,
): void {
  const jobDir = readEngineEnv(process.env, 'JOB_DIR', { warn: false });
  if (jobDir === undefined || jobDir.trim() === '') return;

  const patch: Record<string, string> = {};
  const titles: string[] = [];

  lanes.forEach((lane, index) => {
    const entry = chosen[index];
    if (entry === undefined) return;
    const record = toRecord(entry);
    patch[`slug-${lane}`] = record.slug;
    patch[`title-${lane}`] = record.title;
    titles.push(record.title);
  });

  patch['title'] = titles.length === 0 ? 'свободных пунктов нет' : `Выбрано: ${titles.join('; ')}`;

  // Отказ публикации не отменяет выбор: пункты уже помечены в очереди, и
  // уронить команду из-за подписи значило бы потерять сделанную работу.
  try {
    mergeJobData(jobDir, patch);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeErr(`backlog pick: подпись выбора не опубликована: ${detail}`);
  }
}

/**
 * Проставить `status: in_progress`, общую метку `started_at` и владельца
 * выбранным пунктам. Без владельца `claimed_by` снимается: пункт, отобранный у
 * мёртвого прогона вызовом без `--owner`, иначе хранил бы мёртвого владельца и
 * тут же снова считался бы зависшим.
 */
function applyPick(text: string, chosen: readonly BacklogEntry[], now: string, owner?: string): string {
  let result = text;
  for (const entry of chosen) {
    result =
      owner === undefined
        ? withoutFields(
            withFields(result, entry.slug, { status: 'in_progress', started_at: now }),
            entry.slug,
            ['claimed_by'],
          )
        : withFields(result, entry.slug, { status: 'in_progress', started_at: now, claimed_by: owner });
  }
  return result;
}

function runFinish(
  args: ParsedArgs,
  slug: string | undefined,
  file: string,
  cwd: string,
  writeErr: (line: string) => void,
): ExitCodeValue {
  if (slug === undefined) {
    throw new BurnexError('finish требует слаг пункта первым позиционным аргументом');
  }

  const status = stringFlag(args.flags, 'status');
  if (status !== 'done' && status !== 'failed') {
    throw new BurnexError('ключ --status требует значения done либо failed');
  }

  const reason = stringFlag(args.flags, 'reason');
  if (status === 'failed' && (reason === undefined || reason.trim() === '')) {
    throw new BurnexError('исход failed требует ключа --reason с причиной');
  }

  const owner = ownerFlag(args.flags);
  const runId = owner === undefined ? undefined : parseRunOwner(owner);

  // Чтение, сведение причины к одной строке и неприкосновенность уже
  // проставленного исхода — забота `parts/pipeline/domain/backlog/file.ts`: тем же кодом
  // проставляет исход и сведение дорожек.
  // Забранный другим прогоном пункт — не отказ: закрывающий шаг не должен
  // валить прогон из-за того, что работу у него забрали, как и при уже
  // проставленном исходе. Причина слышна в stderr.
  const finishOwner =
    runId === undefined
      ? undefined
      : runFinishOwner(file, cwd, runId, (claimedBy) =>
          writeErr(`backlog finish: пункт «${slug}» не тронут: им владеет ${claimedBy}, а не ${owner}`),
        );
  finishItem(file, 'backlog finish', slug, status, reason, finishOwner);
  return ExitCode.ok;
}

/** Статусы, с которыми пункт можно завести: исход и работу проставляет петля, не автор. */
const ADD_STATUSES = ['todo', 'postponed'] as const;

/**
 * Значение ключа `add`. Пустая строка — не «нет ключа», а ошибка вызова:
 * молча выбросить её значило бы завести пункт не с теми полями, что просили.
 */
function addValue(flags: ParsedArgs['flags'], name: string, required: boolean): string | undefined {
  const raw = flags[name];
  if (raw === undefined) {
    if (required) throw new BurnexError(`add требует ключа --${name}`);
    return undefined;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new BurnexError(`ключ --${name} требует непустого значения`);
  }
  return raw.trim();
}

/**
 * `backlog add` — завести пункт. Чтение, все проверки и запись идут под одним
 * lock'ом очереди, а запись — только когда итоговый файл разобран теми же
 * читателями, что и остальные писатели: пункт, который `list` потом не
 * прочтёт, заблокировал бы очередь целиком.
 */
function runAdd(args: ParsedArgs, slug: string | undefined, file: string): ExitCodeValue {
  if (slug === undefined) {
    throw new BurnexError('add требует слаг пункта первым позиционным аргументом');
  }
  if (!KEBAB_CASE.test(slug)) {
    throw new BurnexError(`слаг «${slug}» не является слагом в kebab-case`);
  }

  const flags = args.flags;
  const status = stringFlag(flags, 'status') ?? 'todo';
  if (!(ADD_STATUSES as readonly string[]).includes(status)) {
    throw new BurnexError(`ключ --status у add принимает ${ADD_STATUSES.join(' либо ')}, получено «${status}»`);
  }
  const after = addValue(flags, 'after', false);
  const fields: Record<string, string> = { status };
  for (const [flag, field, required] of [
    ['title', 'title', true],
    ['group', 'group', false],
    ['track', 'track', false],
    ['needs', 'needs', false],
    ['goal', 'goal', false],
    ['details', 'details', false],
    ['why', 'why', true],
    ['done-when', 'done_when', true],
  ] as const) {
    const value = addValue(flags, flag, required);
    if (value !== undefined) fields[field] = value;
  }

  withBacklogLock(file, 'backlog add', () => {
    const text = readBacklogFile(file);
    const entries = parseBacklogFile(file, text);
    if (entries.some((entry) => entry.slug === slug)) {
      throw new BurnexError(`пункт «${slug}» уже есть в очереди`, { file, at: slug });
    }
    const archived = readArchivedEntries(file);
    if (archived.some((entry) => entry.slug === slug)) {
      throw new BurnexError(`пункт «${slug}» уже есть в архиве очереди`, { file: archivedPathFor(file), at: slug });
    }

    let next: string;
    try {
      next = insertItem(text, slug, fields, after);
    } catch (error) {
      if (!(error instanceof BurnexError)) throw error;
      throw new BurnexError(error.message, { file, ...(error.at === undefined ? {} : { at: error.at }), cause: error });
    }
    const added = parseBacklogFile(file, next);
    checkNeeds(added, archived);
    const created = added.find((entry) => entry.slug === slug);
    const missing = created === undefined ? [] : missingRefs(created, dirname(file));
    if (missing.length > 0) {
      throw new BurnexError(`пункт «${slug}» назвал материалы, которых нет: ${missing.join(', ')}`, {
        file,
        at: slug,
        hint: `пути отсчитываются от каталога очереди ${dirname(file)}`,
      });
    }
    writeBacklogFile(file, next);
  });
  return ExitCode.ok;
}

/**
 * `backlog show` — запись одного пункта `backlog.md`. Очередь не правится и не
 * блокируется: это чтение, как `list`. Файл дорожки пишется после успешного
 * поиска, чтобы отказ не оставил `item-a.json`, который сведение приняло бы
 * за взятый пункт.
 */
function runShow(
  args: ParsedArgs,
  slug: string | undefined,
  file: string,
  cwd: string,
  write: (line: string) => void,
): ExitCodeValue {
  if (slug === undefined) {
    throw new BurnexError('show требует слаг пункта первым позиционным аргументом');
  }
  const entries = parseBacklogFile(file, readBacklogFile(file));
  const found = entries.find((entry) => entry.slug === slug);
  if (found === undefined) {
    throw new BurnexError(`пункт «${slug}» в очереди не найден`, { file, at: slug });
  }
  const json = JSON.stringify(toRecord(found), null, 2);

  const declaredRunDir = stringFlag(args.flags, 'run-dir');
  if (declaredRunDir !== undefined) {
    const runDir = resolvePath(cwd, declaredRunDir);
    prepareRunDir(runDir);
    atomicWrite(join(runDir, 'item-a.json'), `${json}\n`);
  }
  write(json);
  return ExitCode.ok;
}

/**
 * `backlog settle` — закрытие захода: каждому пункту, взятому в прогон
 * (файлы `item-<дорожка>.json` каталога прогона, см. `parts/pipeline/domain/lanes/item.ts`) и
 * оставшемуся без исхода, проставляется `failed` с единой причиной.
 * Различимые причины несведения — забота `burnex merge-lanes`; `settle`
 * закрывает ровно тот случай, когда до неё дело не дошло вовсе.
 */
function runSettle(
  args: ParsedArgs,
  file: string,
  cwd: string,
  write: (line: string) => void,
): ExitCodeValue {
  const runDirFlag = stringFlag(args.flags, 'run-dir');
  if (runDirFlag === undefined) {
    throw new BurnexError('ключ --run-dir обязателен для settle');
  }
  const runDir = resolvePath(cwd, runDirFlag);
  if (!existsSync(runDir)) {
    throw new BurnexError(`каталог прогона не найден: ${runDir}`, { file: runDir });
  }

  const lanes = takenLanes(runDir);
  if (lanes.length === 0) {
    write('пункты очереди не брались — проставлять нечего');
    return ExitCode.ok;
  }

  // Исход проставляется от имени прогона, чей каталог закрывается: пункт,
  // перехваченный другим прогоном, чужой заход не закрывает. Конфигурация
  // читается лишь ради владельца, отличного от своего прогона: settle по
  // очереди без чужих владельцев от устройства проекта не зависит, как и прежде.
  const finishOwner = runFinishOwner(file, cwd, basename(runDir));

  let settled = 0;
  let foreign = 0;

  for (const lane of lanes) {
    const item = readLaneItem(runDir, lane);
    // Пункт с уже проставленным исходом `finishItem` не трогает: settle
    // закрывает заход, а не переписывает его результат.
    const outcome = finishItem(file, 'backlog settle', item.slug, 'failed', SETTLE_REASON, finishOwner);
    if (outcome === 'already-final') continue;
    if (outcome === 'foreign-owner') {
      foreign += 1;
      write(`пункт «${item.slug}» (дорожка ${lane}) пропущен: его забрал другой прогон, исход не проставлен`);
      continue;
    }
    settled += 1;
    write(`пункт «${item.slug}» (дорожка ${lane}) помечен failed: ${SETTLE_REASON}`);
  }

  if (settled === 0) {
    // Пункт, который забрал другой прогон, своего исхода не свёл: называть его
    // сведённым значило бы скрыть, что исход ему проставит чужой заход.
    if (foreign === 0) write('все взятые пункты уже свели свой исход — проставлять нечего');
    else write(`проставлять нечего: забранных другим прогоном пунктов ${foreign}, остальные уже свели свой исход`);
    return ExitCode.ok;
  }

  // Коммит адресован файлу очереди в том репозитории, где он лежит — не
  // индексу целиком: settle отвечает за очередь и не подметает в коммит чужие
  // правки дерева (design.md, решение 8). Отметка исхода дорожки обязана
  // пережить восстановление дерева — незакоммиченной она пропадает при первом
  // же resume.
  const { config } = resolveConfig({ cwd });
  const relDir = nestedRepoOf(cwd, config.project.nestedRepos ?? [], file);
  const repoDir = relDir === undefined ? cwd : join(cwd, relDir);
  const relPath = relative(repoDir, file);
  const message = `backlog: исходы дорожек прогона ${shortRunId(basename(runDir))}`;
  const committed = commitPath(repoDir, relPath, message);
  write(
    committed
      ? `правка очереди закоммичена в ${relDir ?? '.'}`
      : 'правка очереди не закоммичена: файл не отслеживается репозиторием или лежит вне его',
  );

  return ExitCode.ok;
}

export const row = commandRow(
  {
    name: 'backlog',
    spec: {
      description: 'вести очередь улучшений backlog.md: list|pick|finish|settle|add|show, см. docs/backlog.md',
      positional: ['action', 'slug'],
      flags: {
        file: { kind: 'string', description: 'путь к файлу очереди, по умолчанию backlog.md в рабочем каталоге' },
        slots: { kind: 'number', description: 'pick: сколько пунктов взять за раз, по умолчанию 1' },
        lanes: { kind: 'string', description: 'pick: раздать по дорожкам, имена через запятую — a,b' },
        only: {
          kind: 'string',
          description: 'pick: взять именно этот пункт по слагу, а не первый свободный по очерёдности',
        },
        'stale-hours': {
          kind: 'number',
          description:
            'pick: порог давности зависшего in_progress в часах, по умолчанию 6; для пунктов без владельца или с владельцем, о котором не судить',
        },
        'run-dir': {
          kind: 'string',
          description:
            'pick --lanes: каталог для файлов item-<дорожка>.json на каждую заполненную дорожку; settle: тот же каталог, обязателен; show: записать пункт в item-a.json этого каталога',
        },
        owner: {
          kind: 'string',
          description:
            'pick: записать владельца пункта run:<id прогона>; finish: проставить исход, только если пункт не забран другим прогоном',
        },
        status: {
          kind: 'string',
          description: 'finish: исход done либо failed; add: статус нового пункта, todo (по умолчанию) либо postponed',
        },
        title: { kind: 'string', description: 'add: заголовок пункта, обязателен' },
        why: { kind: 'string', description: 'add: зачем пункт нужен, обязателен' },
        'done-when': { kind: 'string', description: 'add: по чему пункт признаётся выполненным, обязателен' },
        group: { kind: 'string', description: 'add: слаг группы смежности' },
        track: { kind: 'string', description: 'add: метка веса, например express' },
        needs: { kind: 'string', description: 'add: слаги зависимостей через запятую' },
        goal: { kind: 'string', description: 'add: путь файла цели от каталога очереди' },
        details: { kind: 'string', description: 'add: пути файлов подробностей через запятую' },
        after: { kind: 'string', description: 'add: поставить пункт сразу за этим пунктом, по умолчанию в конец' },
        reason: { kind: 'string', description: 'finish --status failed: причина отказа' },
      },
    },
    run: (args, io, env) => runBacklogCommand(args, io.out, env.cwd, io.err),
  },
  { inject: PIPELINE_SERVICES },
);
