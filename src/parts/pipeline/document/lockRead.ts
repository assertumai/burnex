import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';


/**
 * Разбор `pipeline.lock.yml`.
 *
 * Мягкий намеренно: обратного парсера лока в проекте нет — есть только
 * сериализатор `pipelineToPlain`. Заводить строгую схему ради интерфейса,
 * который только показывает уже записанное, значит расширять его задачу.
 * Отсутствующий файл и неожиданная форма поля дают пустоту в интерфейсе, а не
 * отказ демона: строгую проверку по-прежнему дают `lint` и `status`.
 *
 * Живёт в ядре, а не в витрине: `burnex diff` тоже читает замок, чтобы
 * назвать расхождение раскладки сессий (design.md изменения
 * lock-records-session-group, Решение 3), а `src/core` не импортирует
 * `src/ui` — направление зависимостей в проекте одно.
 */

export interface LockStep {
  readonly id: string;
  readonly kind: 'agent' | 'run' | 'script' | 'plugin' | 'review';
  /** Бэкенд агентского шага. */
  readonly agent?: string;
  /** Модель, если шаг её назвал; иначе действует модель бэкенда. */
  readonly model?: string;
  /** Промпт агентского шага целиком — лок хранит его раскрытым. */
  readonly prompt?: string;
  /** Команда командного шага, как она записана: строкой или списком argv. */
  readonly command?: string;
  /** Путь скрипта, объявленный документом, — у шага script. */
  readonly scriptPath?: string;
  /** Имя раннера, которым скрипт разрешён исполниться. */
  readonly scriptRunner?: string;
  /** Объявлен ли вход контракта (`input`) — у шага script. */
  readonly hasScriptInput?: boolean;
  /** Путь объявленной схемы выхода — у script означает проверку файла, а не разбор stdout. */
  readonly scriptOutputSchemaPath?: string;
  /** Имя переиспользуемого шага — у script, собранного из манифеста (`uses`). */
  readonly usesName?: string;
  /** Слой, в котором разрешён манифест — `project`, `home` либо `builtin`. */
  readonly usesLayer?: string;
  /** Путь манифеста, из которого собран шаг. */
  readonly usesManifestPath?: string;
  /** Сведённые параметры вызова, с применёнными умолчаниями. */
  readonly usesParams?: Readonly<Record<string, unknown>>;
  /** Имя вида шага плагинного вида — оно же единственный ключ вида в локе (design.md, решение 3). */
  readonly pluginKindName?: string;
  /** Поля под ключом вида, как записаны, — с нераскрытыми отложенными подстановками. */
  readonly pluginFields?: unknown;
  /** Имена секретов, названных шагом. Значений в замке нет. */
  readonly secrets?: readonly string[];
  /** Разрешённая стратегия шага `review` — у шага этого вида. */
  readonly review?: LockReview;
  readonly context: readonly string[];
}

/** Участник шага `review`, как его записал замок. */
export interface LockReviewParticipant {
  readonly id: string;
  readonly agent?: string;
  readonly model?: string;
  readonly focus?: string;
}

/**
 * Стратегия шага `review` в замке: режим, лимит реплик и участники в порядке
 * стратегии. Порядок нужен ленте шага (`ui-review-discussion`, `review-defend`):
 * цвет участника — по его позиции, а каталоги участников в журнале порядка
 * не хранят.
 */
export interface LockReview {
  readonly mode?: string;
  /** Раунды защиты режима `defend`. */
  readonly rounds?: number;
  /** Имплементатор `<работа>.<шаг>`, как его записал замок. */
  readonly implementer?: string;
  readonly reviewers: readonly LockReviewParticipant[];
  readonly aggregator?: LockReviewParticipant;
  /** Свежий защитник режима `defend` (форк выбирается при исполнении). */
  readonly defender?: LockReviewParticipant;
}

function reviewParticipant(value: unknown): LockReviewParticipant | undefined {
  const record = asRecord(value);
  const id = asString(record?.id);
  if (record === undefined || id === undefined) return undefined;
  const agent = asString(record.agent);
  const model = asString(record.model);
  const focus = asString(record.focus);
  return {
    id,
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(focus === undefined ? {} : { focus }),
  };
}

function reviewOf(record: Record<string, unknown>): LockReview | undefined {
  const strategy = asRecord(record.review);
  if (strategy === undefined) return undefined;
  const mode = asString(strategy.mode);
  const rounds = asRecord(strategy.defend)?.rounds;
  const implementer = asString(record.implementer);
  const defender = reviewParticipant(record.defender);
  const reviewers = Array.isArray(record.reviewers)
    ? record.reviewers.map(reviewParticipant).filter((entry): entry is LockReviewParticipant => entry !== undefined)
    : [];
  const aggregator = reviewParticipant(record.aggregator);
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(typeof rounds === 'number' ? { rounds } : {}),
    ...(implementer === undefined ? {} : { implementer }),
    reviewers,
    ...(aggregator === undefined ? {} : { aggregator }),
    ...(defender === undefined ? {} : { defender }),
  };
}

export interface LockJob {
  readonly id: string;
  readonly description?: string;
  readonly needs: readonly string[];
  /** Условие исполнения работы, как записано в определении. */
  readonly if?: string;
  /** Исход предшественников, при котором работа запускается. */
  readonly on: 'success' | 'failure' | 'always';
  /** Работа объявляет выход — значит, у неё может быть `artifacts/<id>.json`. */
  readonly publishesOutput: boolean;
  /**
   * Подпись работы, как объявлена: шаблоны нераскрыты. Раскрывает их снимок,
   * против данных, опубликованных работами этого прогона.
   */
  readonly display?: Readonly<Record<string, string>>;
  /** Дорожка, объявленная на месте подключения работы. */
  readonly lane?: string;
  /** Группа сессий, объявленная на месте подключения работы. */
  readonly sessionGroup?: string;
  /** Попытки работы; поле есть в замке только при `max > 1`. */
  readonly attempts?: { readonly max: number };
  readonly context: readonly string[];
  readonly steps: readonly LockStep[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Подпись лока: карта строк в строки. Всё, что не строка, отбрасывается. */
function displayMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') out[key] = item;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Записи контекста лока разнородны: строка, `{ path }` или `{ text }`. */
function contextLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    const record = asRecord(entry);
    if (record === undefined) continue;
    const path = asString(record.path);
    if (path !== undefined) {
      out.push(path);
      continue;
    }
    const text = asString(record.text);
    if (text !== undefined) out.push(`текст: ${text.trim().split('\n')[0] ?? ''}`);
  }
  return out;
}

/** Команда шага: в локе она либо строкой, либо списком argv. */
function commandLabel(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((part) => typeof part === 'string').join(' ');
  return undefined;
}

/**
 * Ключи общей части шага в локе (`stepToPlain`, `pipeline/lock.ts`) — то, чем
 * плагинный вид отличают от единственного собственного ключа: у плагинного
 * шага в записи ровно один ключ сверх этих (design.md, решение 3).
 */
const LOCK_COMMON_KEYS = new Set([
  'id',
  'index',
  'timeout',
  'env',
  'context',
  'context_inherit',
  'context_exclude',
  'context_max_tokens',
  'budget',
  'expect',
  'attempts',
  'secrets',
]);

/** Единственный ключ, оставшийся сверх общей части, — имя вида плагинного шага. */
function pluginKindKey(record: Record<string, unknown>): string | undefined {
  return Object.keys(record).find((key) => !LOCK_COMMON_KEYS.has(key));
}

function toStep(value: unknown): LockStep | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const id = asString(record.id);
  if (id === undefined) return undefined;

  const prompt = asString(record.prompt);
  const secretNames = Array.isArray(record.secrets)
    ? record.secrets.filter((name): name is string => typeof name === 'string')
    : undefined;
  const command = commandLabel(record.run);
  const agent = asString(record.agent);
  const model = asString(record.model);
  const scriptPath = asString(record.script);
  const scriptRunner = asString(asRecord(record.resolved)?.runner);
  const scriptOutputSchemaPath = scriptPath === undefined ? undefined : asString(record.output_schema);
  const usesRecord = asRecord(record.uses);
  const usesName = usesRecord === undefined ? undefined : asString(usesRecord.name);
  const usesLayer = usesRecord === undefined ? undefined : asString(usesRecord.layer);
  const usesManifestPath = usesRecord === undefined ? undefined : asString(usesRecord.manifest_path);
  const usesParams = usesRecord === undefined ? undefined : asRecord(usesRecord.params);

  // Ни один из трёх встроенных маркеров не найден — оставшийся единственный
  // ключ сверх общей части и есть имя плагинного вида (design.md, решение 3).
  const review = reviewOf(record);
  const isReview = review !== undefined;
  const isBuiltin = scriptPath !== undefined || prompt !== undefined || record.run !== undefined || isReview;
  const pluginKindName = isBuiltin ? undefined : pluginKindKey(record);

  return {
    id,
    kind:
      scriptPath !== undefined
        ? 'script'
        : isReview
          ? 'review'
          : prompt !== undefined
          ? 'agent'
          : pluginKindName !== undefined
            ? 'plugin'
            : 'run',
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(command === undefined ? {} : { command }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    ...(scriptRunner === undefined ? {} : { scriptRunner }),
    ...(scriptPath === undefined ? {} : { hasScriptInput: record.input !== undefined }),
    ...(scriptOutputSchemaPath === undefined ? {} : { scriptOutputSchemaPath }),
    ...(usesName === undefined ? {} : { usesName }),
    ...(usesLayer === undefined ? {} : { usesLayer }),
    ...(usesManifestPath === undefined ? {} : { usesManifestPath }),
    ...(usesParams === undefined ? {} : { usesParams }),
    ...(pluginKindName === undefined ? {} : { pluginKindName, pluginFields: record[pluginKindName] }),
    ...(secretNames === undefined ? {} : { secrets: secretNames }),
    ...(review === undefined ? {} : { review }),
    context: contextLabels(record.context),
  };
}

function toJob(value: unknown): LockJob | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const id = asString(record.id);
  if (id === undefined) return undefined;

  const needsRaw = record.needs;
  const needs =
    needsRaw === 'all'
      ? ['all']
      : Array.isArray(needsRaw)
        ? needsRaw.filter((item): item is string => typeof item === 'string')
        : [];

  const steps = Array.isArray(record.steps)
    ? record.steps.map(toStep).filter((step): step is LockStep => step !== undefined)
    : [];

  const description = asString(record.description);
  const condition = asString(record.if);
  const on = asString(record.on);
  const display = displayMap(record.display);
  const lane = asString(record.lane);
  const sessionGroup = asString(record.session_group);
  const attemptsMax = asRecord(record.attempts)?.max;

  return {
    id,
    ...(description === undefined ? {} : { description }),
    needs,
    ...(condition === undefined ? {} : { if: condition }),
    on: on === 'failure' || on === 'always' ? on : 'success',
    publishesOutput: asRecord(record.output) !== undefined,
    ...(display === undefined ? {} : { display }),
    ...(lane === undefined ? {} : { lane }),
    ...(sessionGroup === undefined ? {} : { sessionGroup }),
    ...(typeof attemptsMax === 'number' && attemptsMax > 1 ? { attempts: { max: attemptsMax } } : {}),
    context: contextLabels(record.context),
    steps,
  };
}

/**
 * Итог чтения лока. `readable` отделяет разобранный файл от отсутствующего,
 * испорченного и усечённого: витрине это различие безразлично — показывать в
 * обоих случаях нечего, — а `burnex diff` без него выдал бы нечитаемый замок
 * за замок, ничего не объявивший. Пустой список работ при `readable: true` —
 * утверждение файла, а не следствие сбоя чтения.
 */
/** Цикл из замка: участники и предел проходов. */
export interface LockLoop {
  readonly id: string;
  readonly jobs: readonly string[];
  readonly maxIterations: number;
}

export interface LockRead {
  readonly readable: boolean;
  readonly jobs: LockJob[];
  /** Присутствует только если пайплайн объявлял циклы. */
  readonly loops?: readonly LockLoop[];
  readonly workspace?: {
    readonly source: 'commit';
    readonly preserveLocalChanges: boolean;
    readonly liveFiles: readonly {
      readonly path: string;
      readonly writeback: 'always';
      readonly commitOnSuccess: boolean;
    }[];
  };
}

/** Разбор лока с признаком читаемости. */
export function readLock(path: string): LockRead {
  let document: unknown;
  try {
    document = parseYaml(readFileSync(path, 'utf8'));
  } catch {
    return { readable: false, jobs: [] };
  }

  const root = asRecord(document);
  const jobs = root?.jobs;
  if (!Array.isArray(jobs)) return { readable: false, jobs: [] };
  const workspace = asRecord(root?.workspace);
  const liveFiles = Array.isArray(workspace?.live_files)
    ? workspace.live_files.flatMap((value) => {
        const entry = asRecord(value);
        const path = asString(entry?.path);
        if (path === undefined || entry?.writeback !== 'always' || typeof entry.commit_on_success !== 'boolean') {
          return [];
        }
        return [{ path, writeback: 'always' as const, commitOnSuccess: entry.commit_on_success }];
      })
    : [];
  const publication =
    workspace?.source === 'commit' && typeof workspace.preserve_local_changes === 'boolean'
      ? {
          source: 'commit' as const,
          preserveLocalChanges: workspace.preserve_local_changes,
          liveFiles,
        }
      : undefined;
  const loops = Array.isArray(root?.loops)
    ? root.loops.flatMap((value) => {
        const entry = asRecord(value);
        const id = asString(entry?.id);
        const members = Array.isArray(entry?.jobs) ? entry.jobs.filter((job): job is string => typeof job === 'string') : [];
        const max = entry?.max_iterations;
        if (id === undefined || typeof max !== 'number') return [];
        return [{ id, jobs: members, maxIterations: max }];
      })
    : [];
  return {
    readable: true,
    jobs: jobs.map(toJob).filter((job): job is LockJob => job !== undefined),
    ...(loops.length === 0 ? {} : { loops }),
    ...(publication === undefined ? {} : { workspace: publication }),
  };
}

/** Работы из лока. Нечитаемый или отсутствующий файл даёт пустой список. */
export function readLockJobs(path: string): LockJob[] {
  return readLock(path).jobs;
}
