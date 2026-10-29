import type { ModelTier } from '../config/modelTiers.js';
/**
 * Раскрытая модель пайплайна: то, что получается после подстановок, раскрытия
 * `uses` и применения умолчаний. Дальше по конвейеру движок работает только с
 * ней и никогда не возвращается к исходным документам.
 */

export type WorkspaceMode = 'cwd' | 'worktree' | 'copy';

export interface Workspace {
  readonly mode: WorkspaceMode;
  readonly path?: string;
  /**
   * Источник наследования рабочего дерева: идентификатор работы-зависимости
   * либо `none`. Осмыслен только на работе, только в изолирующем режиме, и
   * только при нескольких зависимостях — при одной источник очевиден.
   */
  readonly inherit?: string;
}

export interface LiveFile {
  /** Путь относительно корня проекта, уже раскрытый и нормализованный. */
  readonly path: string;
  readonly writeback: 'always';
  readonly commitOnSuccess: boolean;
}

/** Политика исходного дерева принадлежит пайплайну, а не отдельной работе. */
export interface PipelinePublication {
  readonly source: 'commit';
  readonly preserveLocalChanges: boolean;
  readonly liveFiles: readonly LiveFile[];
}

export interface Budget {
  readonly tokens?: number;
  readonly costMicroUsd?: number;
  readonly wallclockMs?: number;
  readonly rateLimitPct?: number;
  /** Действующее значение: умолчание `stop` уже применено. */
  readonly onExceed: 'wait' | 'stop';
  /**
   * Значение, написанное в документе, — без умолчания. Нужно там, где режим
   * ищется у ближайшей объявившей его области: бюджет без `on_exceed` не
   * должен перекрывать режим внешней области своим умолчанием.
   */
  readonly declaredOnExceed?: 'wait' | 'stop';
}

export type ContextMode = 'inline' | 'reference' | 'auto';

export type ContextEntry =
  | {
      readonly kind: 'path';
      readonly path: string;
      readonly mode: ContextMode;
      /**
       * Запись обязана дать хотя бы один файл. Нужна глобу: путь без глоба и
       * так роняет сборку контекста, когда файла нет, а глоб без совпадений
       * молча даёт пусто — и шаг уходит к агенту с контекстом беднее
       * объявленного. Записывается, только когда объявлена: умолчание —
       * прежнее поведение.
       */
      readonly required?: boolean;
    }
  | { readonly kind: 'text'; readonly text: string }
  /**
   * Материалы пункта очереди: `path` называет JSON-файл записи пункта, из
   * которого сборка берёт `goal` и `details`. Каждый названный там файл
   * дальше идёт как запись `path` с этим `mode`.
   */
  | { readonly kind: 'item_refs'; readonly path: string; readonly mode: ContextMode }
  /**
   * Запись, разрешаемая объявленным источником знания. Селектор трёх форм:
   * `index` — оглавление без тел, `scope` — тела по пересечению областей,
   * `id` — тела поимённо.
   *
   * Собственный `budget` необязателен: он ограничивает объём, отобранный
   * этой записью, тогда как `context.max_tokens` ограничивает контекст шага
   * целиком. Одного второго мало — запись знания способна выбрать бюджет
   * шага целиком и вытеснить файлы, ради которых шаг и заводили.
   */
  | {
      readonly kind: 'knowledge';
      readonly selector:
        | { readonly kind: 'index' }
        | { readonly kind: 'scope'; readonly scope: readonly string[] }
        | { readonly kind: 'id'; readonly id: readonly string[] };
      readonly budget?: number;
    };

export type ContextUpstream = 'all' | 'none' | readonly string[];

export type Predicate =
  | { readonly kind: 'exit_code'; readonly value: number }
  | { readonly kind: 'file_exists'; readonly path: string }
  | { readonly kind: 'schema'; readonly path: string }
  | { readonly kind: 'matches'; readonly pattern: string }
  | { readonly kind: 'not_matches'; readonly pattern: string }
  | { readonly kind: 'changed_only'; readonly globs: readonly string[] }
  /**
   * Целостность памяти репозитория: вызов глагола `check` объявленного
   * источника. Проваливает шаг только красное нарушение — жёлтое попадает в
   * отчёт и проверку проходит.
   */
  | { readonly kind: 'knowledge_valid' }
  | { readonly kind: 'cmd'; readonly command: string }
  | {
      readonly kind: 'judge';
      readonly claim: string;
      readonly hard: boolean;
      readonly agent?: string;
      readonly model?: string;
    }
  /**
   * Файл-проверка на любом языке — тот же путь и раннер, что у шага `script`
   * (`docs/pipeline-format.md`, раздел script). Разрешён на раскрытии, тем же
   * способом, что несёт `ScriptStep`: ровно одно из `resolved`/`unresolved`.
   * Ключей `runner` и `hard` у предиката нет — раннер решает расширение или
   * shebang, а жёсткость безусловна.
   */
  | {
      readonly kind: 'script';
      readonly path: string;
      readonly resolved?: ResolvedScript;
      readonly unresolved?: ScriptUnresolved;
    }
  /**
   * Предикат, внесённый плагином (`docs/plugins.md`). Движок видит его как
   * данные: имя из реестра и значение, уже проверенное схемой вклада при
   * разборе. Ключ шага, файл фиксации и журнал несут их как есть — знание о
   * том, что предикат означает, живёт только в самом вкладе.
   */
  | { readonly kind: 'plugin'; readonly name: string; readonly value: unknown };

export interface EscalationStep {
  readonly includeFailure: boolean;
  readonly model?: string;
}

export interface Attempts {
  readonly max: number;
  readonly escalation: readonly EscalationStep[];
}

/** Попытки работы целиком: перезапуск упавшей работы с первого шага. */
export interface JobAttempts {
  readonly max: number;
}

export interface StepCommon {
  readonly id: string;
  /** Позиция шага в работе, с 1. Задаёт числовой префикс каталога в журнале. */
  readonly index: number;
  readonly env: Readonly<Record<string, string>>;
  readonly context: readonly ContextEntry[];
  readonly contextInherit: boolean;
  readonly contextExclude: readonly string[];
  readonly contextMaxTokens?: number;
  readonly timeoutMs: number;
  readonly budget?: Budget;
  readonly expect: readonly Predicate[];
  readonly attempts: Attempts;
  /**
   * Имена секретов, которые шаг получает (`secrets-named-providers`): уникальные
   * и отсортированные — порядок записи в документе шаг не меняет. Поле
   * отсутствует, а не пусто, у шага без секретов: `computeStepKey` хеширует
   * шаг целиком, и пустой список сменил бы ключи всех прежних шагов.
   * У агентского шага поля нет никогда.
   */
  readonly secrets?: readonly string[];
}

/**
 * Именованный MCP-сервер: процесс, поднимаемый бэкендом, либо конечная точка.
 * Вид определяется тем, какой из двух ключей объявлен — не третьим полем,
 * которое можно рассогласовать с остальными (design.md, решение 3).
 */
export type McpServer =
  | {
      readonly command: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

/** Объявление серверов одного уровня: имя сервера → его описание. */
export type McpServers = Readonly<Record<string, McpServer>>;

export interface Permissions {
  readonly mode?: string;
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  /**
   * Режим применения политики. `inherit` (умолчание) — сегодняшнее поведение:
   * список добавляется к правилам, которые бэкенд читает из своих настроек.
   * `strict` запрещает всё не названное и отсекает настройки вне репозитория.
   */
  readonly enforce?: 'inherit' | 'strict';
}

export interface AgentStep extends StepCommon {
  readonly kind: 'agent';
  readonly agent: string;
  readonly model?: string;
  /** Уровень reasoning effort, передаваемый агентскому CLI. */
  readonly effort?: string;
  /** Псевдоним сессии. Шаги с одинаковым псевдонимом продолжают один диалог. */
  readonly session: string;
  /** Текст промпта, уже прочитанный из файла и раскрытый. */
  readonly prompt: string;
  /** Откуда прочитан промпт — для диагностики. */
  readonly promptSource?: string;
  readonly outputSchemaPath?: string;
  readonly permissions?: Permissions;
  /** Действующее для шага объявление MCP-серверов — своё либо унаследованное. */
  readonly mcp?: McpServers;
}

export interface RunStep extends StepCommon {
  readonly kind: 'run';
  /** Список argv либо строка для оболочки. */
  readonly command: readonly string[] | string;
  readonly onFail?: { readonly analyze: string; readonly prompt: string };
  /** Действующий код пропуска (`skip_exit_code`), см. `skipExitCode` у `ScriptStep`. */
  readonly skipExitCode?: number;
  /**
   * Схема, объявляющая структурированный выход командного шага. Присутствие
   * поля включает разбор stdout как одного JSON-документа — без него
   * командный шаг структурированного выхода не имеет.
   */
  readonly outputSchemaPath?: string;
}

/**
 * Слой, в котором найден файл скрипта (design.md, решение 3). `explicit` —
 * значение с префиксом `./`, `../` либо абсолютное: слоёв не касается,
 * разрешается от файла объявления или принимается как есть.
 */
export type ScriptLayer = 'project' | 'home' | 'builtin' | 'explicit';

/** Успешно разрешённый скрипт: то, чем шаг исполнится (design.md, решение 8). */
export interface ResolvedScript {
  readonly absolutePath: string;
  readonly layer: ScriptLayer;
  readonly runner: string;
  /** argv целиком: команда раннера, затем путь скрипта, затем `args` шага. */
  readonly argv: readonly string[];
  /** Короткий sha256 содержимого файла на момент раскрытия. */
  readonly fingerprint: string;
}

/**
 * Почему скрипт не разрешён: несуществующий файл, незнакомое имя раннера,
 * раннер, не определённый ни расширением, ни shebang. Не исключение
 * раскрытия (design.md, решение 1) — диагностику даёт `stepcast lint`, а
 * прогон отказывает шагу названно (`src/parts/pipeline/run/runner.ts`).
 *
 * Пять последних вариантов — причины отказа шага `uses` (design.md, решение
 * 8): ненайденное имя, дефектный манифест (нечитаемый файл, не прошедшая
 * схему форма документа, схема параметров не объектная либо не
 * компилируется), несовпадение `name` манифеста с именем каталога,
 * отсутствующий файл шага `file`, промах параметров вызова (неизвестный,
 * непереданный обязательный, значение не по схеме — когда оно известно
 * статически). Ни один не бросает исключение при чтении манифеста по той же
 * причине, по которой его не бросает `file_not_found`: `stepcast lint`
 * обязан назвать все промахи документа за один проход.
 */
export type ScriptUnresolved =
  | { readonly reason: 'file_not_found'; readonly searched: readonly string[] }
  | { readonly reason: 'unknown_runner'; readonly runner: string; readonly known: readonly string[] }
  | { readonly reason: 'runner_undetermined'; readonly extensions: readonly string[] }
  | { readonly reason: 'step_not_found'; readonly name: string; readonly searched: readonly string[] }
  | {
      readonly reason: 'manifest_invalid';
      readonly name: string;
      readonly manifestPath: string;
      readonly detail: string;
    }
  | {
      readonly reason: 'name_mismatch';
      readonly name: string;
      readonly manifestName: string;
      readonly manifestPath: string;
    }
  | {
      readonly reason: 'step_file_missing';
      readonly name: string;
      readonly manifestPath: string;
      readonly expectedPath: string;
    }
  | {
      readonly reason: 'params_invalid';
      readonly name: string;
      readonly manifestPath: string;
      readonly detail: string;
    };

/** Слой, в котором может быть найден переиспользуемый шаг — без `explicit`: `uses` путём не бывает (design.md, решение 2). */
export type StepLayer = Exclude<ScriptLayer, 'explicit'>;

/**
 * Происхождение шага `uses`: то, что было написано в документе и чем это
 * разрешилось, — рядом с исполняемым, а не вместо него (design.md, решение
 * 11). Поля, кроме `name`, отсутствуют, пока разрешение не дошло до них:
 * ненайденное имя не оставляет ни слоя, ни манифеста, ни параметров.
 */
export interface UsesOrigin {
  readonly name: string;
  readonly layer?: StepLayer;
  readonly manifestPath?: string;
  /** Короткий sha256 содержимого манифеста на момент раскрытия. */
  readonly manifestFingerprint?: string;
  /** Сведённый `with` — после применения умолчаний манифеста. */
  readonly params?: Readonly<Record<string, unknown>>;
  /**
   * Схема параметров манифеста — не публикуется в замок (design.md, решение
   * 11: содержимое манифеста в замок не попадает, отпечатка достаточно).
   * Живёт только в раскрытом пайплайне в памяти: движок сверяет ей параметры
   * ещё раз после позднего раскрытия, перед записью `input.json`
   * (`src/parts/pipeline/run/runner.ts`), — до этого момента значение могло нести
   * отложенную подстановку, непроверимую статически.
   */
  readonly paramsSchema?: Readonly<Record<string, unknown>>;
}

export interface ScriptStep extends StepCommon {
  readonly kind: 'script';
  /** Путь, объявленный в документе — до разрешения слоями. */
  readonly path: string;
  readonly args: readonly string[];
  /** Имя раннера, объявленное на шаге явно — побеждает расширение и shebang. */
  readonly runner?: string;
  readonly onFail?: { readonly analyze: string; readonly prompt: string };
  /**
   * Код выхода (1..255), которым шаг объявляет «делать нечего»: выход этим
   * кодом — пропуск работы, а не успех и не отказ (`skip_exit_code`). Уже
   * действующий для шага: свой ключ, иначе место подключения, иначе тело
   * работы, иначе пайплайн — исполнитель об уровнях не знает. У `uses`-шага
   * код берётся с места вызова, не из манифеста.
   */
  readonly skipExitCode?: number;
  /**
   * Объявленный вход шага — JSON-дерево, раскрытое типизированной подстановкой
   * (design.md, решение 4). Не объявлен — движок пишет `input.json` пустым
   * отображением (design.md, решение 3), но поле здесь остаётся неопределённым:
   * в замок попадает только то, что действительно объявлено.
   */
  readonly input?: unknown;
  /**
   * Схема, проверяющая файл выхода шага, — не разбор `stdout`, как у `run`
   * (design.md, решение 1).
   */
  readonly outputSchemaPath?: string;
  /** Ровно одно из двух: разрешённый скрипт либо причина, почему не вышло. */
  readonly resolved?: ResolvedScript;
  readonly unresolved?: ScriptUnresolved;
  /**
   * Происхождение шага, собранного из манифеста переиспользуемого шага
   * (`uses`, design.md решение 1). Отсутствует у шага, объявленного `script`
   * напрямую. Шаг `uses` — та же `ScriptStep`: `path`, `resolved`,
   * `outputSchemaPath` и `input` несут ровно то же, чем шаг исполнится, а
   * `uses` — чем это было объявлено и откуда разрешилось.
   */
  readonly uses?: UsesOrigin;
}

/**
 * Шаг зарегистрированного плагином вида (`docs/plugins.md`). Движок видит его
 * как данные: имя вида из реестра и поля, уже проверенные схемой вклада при
 * разборе, — тот же довод, что у варианта `plugin` предиката. Ключ шага
 * (`computeStepKey`), файл фиксации и журнал несут `fields` как есть: что они
 * значат, знает только сам вклад.
 */
export interface PluginStep extends StepCommon {
  readonly kind: 'plugin';
  /** Имя вида из реестра — оно же ключ шага в документе. */
  readonly name: string;
  /** Значение под ключом, уже проверенное схемой вклада при раскрытии. */
  readonly fields: unknown;
}

export type Step = AgentStep | RunStep | ScriptStep | PluginStep;

export interface JobOutput {
  readonly from?: string;
  readonly schemaPath?: string;
}

export interface Until {
  readonly maxIterations: number;
  readonly check: readonly Predicate[];
}

export type NeedsAll = 'all';

export interface Job {
  readonly id: string;
  readonly description?: string;
  /** Файл, из которого пришло определение. Нужен для разрешения путей и ошибок. */
  readonly source: string;
  readonly needs: readonly string[] | NeedsAll;
  readonly on: 'success' | 'failure' | 'always';
  readonly if?: string;
  /** Метка обвязки, объявленная на месте подключения работы. Не влияет на порядок исполнения графа. */
  readonly lane?: string;
  /**
   * Подпись работы в витрине: имена в шаблоны. Хранится нераскрытой — эти
   * поля не потребляет ни один шаг, их читает витрина, и раскрываются они в
   * момент сборки снимка, против текущих данных работы. Поэтому же
   * `resolveLate` их не трогает: к раскрытию определения работа ещё ничего не
   * опубликовала, и самоссылка `${jobs.<сам>.data.*}` дала бы там пустоту.
   */
  readonly display?: Readonly<Record<string, string>>;
  readonly session: 'shared' | 'per_step';
  /**
   * Имя сессии, общей нескольким работам, объявленное обвязкой. Работы с
   * одинаковым именем продолжают один диалог агента, и псевдонимы их шагов
   * живут в общем пространстве имён. Без имени пространство псевдонимов
   * замкнуто на работу и на итерацию её цикла `until` — сегодняшнее
   * поведение.
   */
  readonly sessionGroup?: string;
  readonly workspace: Workspace;
  readonly env: Readonly<Record<string, string>>;
  readonly context: readonly ContextEntry[];
  readonly contextUpstream: ContextUpstream;
  readonly output?: JobOutput;
  /**
   * Объявленные входы работы. Пусто — отпечаток считается по всему дереву;
   * заполнено — только по этим путям, и пропущенный файл означает пропущенную
   * инвалидацию.
   */
  readonly inputs: readonly string[];
  /**
   * Ключи данных, которые работа вправе опубликовать (`stepcast data`,
   * `backlog pick`). Список именной, а не шаблонный: форма ключа, которую
   * строит команда, не отличает объявленную публикацию от случайной — обе
   * пишет одна и та же команда, с разными аргументами. Пусто — работа не
   * публикует ничего, это fail-closed умолчание, а не временная недосказанность.
   */
  readonly data: readonly string[];
  readonly budget?: Budget;
  /**
   * Освобождение от потолка прогона, объявленное обвязкой. Шаги такой работы
   * запускаются и после остановки по бюджету прогона; расход по-прежнему
   * копится в счётчиках прогона и виден в отчёте — освобождение снимает
   * применение потолка, а не учёт.
   */
  readonly budgetExempt?: boolean;
  readonly until?: Until;
  /**
   * Попытки работы. Без объявления `max: 1` — работа исполняется один раз, а
   * раскладка журнала и ключи сессий остаются прежними.
   */
  readonly attempts: JobAttempts;
  /** Политика доступа агентских шагов работы, объявленная на её уровне. */
  readonly permissions?: Permissions;
  /**
   * Объявление MCP-серверов, сделанное самой работой — не унаследованное от
   * пайплайна. Отдельно от эффективного значения шага по той же причине, что
   * и `permissions`: замок обязан показывать то, что написано на этом уровне,
   * а не то, что до него дошло раскрытием.
   */
  readonly mcp?: McpServers;
  readonly steps: readonly Step[];
}

/**
 * Одна запись расписания: cron-выражение и необязательный часовой пояс.
 *
 * `cron` может отсутствовать: незаполненную запись ловит линт, называя её
 * номер, — схема о ней молчит намеренно (см. `ScheduleTriggerEntrySchema`).
 */
export interface ScheduleTrigger {
  readonly cron?: string;
  readonly timezone?: string;
}

/**
 * Триггеры пайплайна. Единственный признанный вид на сегодня — `schedule`;
 * ключ заведён с запасом на вторую объявленную форму запуска (GitHub).
 */
export interface Triggers {
  readonly schedule: readonly ScheduleTrigger[];
}

/**
 * Действующая практика памяти: пайплайн поверх конфигурации, по каждому ключу
 * отдельно. Лежит на модели пайплайна, а не берётся из конфигурации напрямую,
 * по той же причине, по которой на ней лежит всё остальное раскрытое:
 * документ вправе объявить свою практику верхним ключом `project`, и
 * потребитель обязан видеть уже слитое значение, а не два слоя.
 *
 * `provider` неопределён — практики нет. Величины определены всегда: у них
 * есть встроенные умолчания, потому что описывают поведение движка, а не
 * устройство репозитория.
 */
export interface KnowledgeDeclaration {
  readonly provider: 'fs' | 'cmd' | undefined;
  readonly command: string | undefined;
  readonly dir: string | undefined;
  readonly rules: string | undefined;
  readonly indexMaxTokens: number;
  readonly specIndexMaxTokens: number;
  readonly unitMaxTokens: number;
  readonly staleAfterMs: number;
  readonly timeoutMs: number;
}

/**
 * Объявление секрета пайплайна: имя, провайдер, переменная окружения и
 * параметры провайдера. Значения здесь нет и быть не может — модель
 * сериализуется в замок прогона.
 */
export interface SecretDeclaration {
  readonly name: string;
  readonly provider: string;
  /** Переменная окружения, под которой значение дойдёт до шага: `env` объявления либо имя в верхнем регистре. */
  readonly env: string;
  /** Параметры провайдера — соседние с `provider` и `env` ключи объявления. */
  readonly params: Readonly<Record<string, unknown>>;
}

export interface Pipeline {
  readonly name: string;
  readonly file: string;
  /** Действующая практика памяти — пайплайн поверх конфигурации. */
  readonly knowledge: KnowledgeDeclaration;
  readonly inputs: Readonly<Record<string, string | number | boolean>>;
  readonly workspace: Workspace;
  readonly publication?: PipelinePublication;
  readonly env: Readonly<Record<string, string>>;
  readonly envFiles: readonly string[];
  readonly envDeny: readonly string[];
  /** Объявленные секреты в порядке записи в документе. Пусто — документ `secrets:` не объявляет. */
  readonly secrets: readonly SecretDeclaration[];
  readonly context: readonly ContextEntry[];
  readonly contextUpstream: ContextUpstream;
  readonly budget?: Budget;
  /** Объявление MCP-серверов, сделанное документом пайплайна. */
  readonly mcp?: McpServers;
  readonly concurrency: number;
  readonly failFast: boolean;
  readonly triggers?: Triggers;
  /** Порядок объявления сохраняется: он задаёт детерминированный порядок работ. */
  readonly jobs: readonly Job[];
  /** Циклы по группам работ; без объявления `loops` — пустой список. */
  readonly loops: readonly Loop[];
}

/**
 * Цикл по группе работ: участники исполняются проходами, пока `while` истинно
 * и не исчерпан предел. Предел обязателен — цикл без него неограничен по
 * расходу.
 */
export interface Loop {
  readonly id: string;
  /** Участники в порядке записи в документе. */
  readonly jobs: readonly string[];
  /** Выражение продолжения; без него — «в проходе есть участник со статусом failed». */
  readonly while?: string;
  readonly maxIterations: number;
  readonly costMicroUsd?: number;
  readonly wallclockMs?: number;
}

/** Ссылка на подстановку, оставшуюся в значении до времени исполнения. */
export interface Substitution {
  readonly expression: string;
  readonly namespace: string;
  readonly path: string;
  readonly deferred: boolean;
  /**
   * Файл, из которого пришёл раскрываемый текст, — например, файл промпта,
   * подключённый через `prompt: file:`. Отсутствует у подстановок в самом
   * документе: там место уже названо точечным путём поля.
   */
  readonly origin?: string;
  /**
   * Документ, объявивший поле, в котором стоит подстановка: сам пайплайн либо
   * подключённый им файл работы. Отличается от `origin` тем, что называет
   * место объявления, а не файл, откуда взят текст: подстановка в теле работы
   * принадлежит файлу работы, а подстановка в `with` того же подключения —
   * файлу пайплайна.
   */
  readonly file?: string;
  /** Позиция начала выражения в исходном тексте, считая с единицы. */
  readonly line?: number;
  readonly column?: number;
}

/** Где в документе какие подстановки применялись. Ключ — точечный путь. */
export type SubstitutionMap = ReadonlyMap<string, readonly Substitution[]>;

/**
 * Слой конфигурации, давший значение выбора пользователя (`pipeline_agents`,
 * `step_agents`): вместе с файлом, иначе экран не отличит запись глобального
 * файла от проектной.
 */
export interface ConfigEntryLayer {
  readonly layer: 'pipeline_agents' | 'step_agents';
  readonly file: string;
}

/** Звено цепочки, давшее агента агентского шага. */
export type AgentOrigin =
  | { readonly layer: 'step' }
  | { readonly layer: 'job' }
  | { readonly layer: 'pipeline' }
  | { readonly layer: 'config' }
  | ConfigEntryLayer;

/**
 * Явная модель документа, отброшенная как чужая агенту, пришедшему от
 * пользователя (`agent-policy-and-pipeline-agents`, решение 4).
 */
export interface DroppedModel {
  readonly model: string;
  readonly layer: 'step' | 'job' | 'pipeline';
}

/**
 * Звено цепочки, давшее модель агентского шага: объявление самого шага,
 * работа, пайплайн, конфигурация, запись выбора пользователя, карта tier
 * выбранного агента, умолчание бэкенда либо отсутствие модели. Происхождение
 * не входит в исполняемый шаг.
 */
export type ModelOrigin = (
  | { readonly layer: 'step' }
  | { readonly layer: 'job' }
  | {
      readonly layer: 'tier';
      readonly backend: string;
      readonly tier: ModelTier;
      readonly tierLayer: 'pipeline' | 'job' | 'step' | 'pipeline_agents' | 'step_agents';
      /** Файл записи пользователя, когда tier выбран ею. */
      readonly file?: string;
      readonly fallback?: true;
    }
  | { readonly layer: 'pipeline' }
  | { readonly layer: 'config' }
  | ConfigEntryLayer
  | { readonly layer: 'backend'; readonly backend: string }
  | { readonly layer: 'none' }
) & {
  /** Явная модель документа, замененная потому, что она чужая выбранному агенту. */
  readonly dropped?: DroppedModel;
};

/** Звено цепочки, давшее reasoning effort агентского шага. */
export type EffortOrigin =
  | { readonly layer: 'step' }
  | { readonly layer: 'job' }
  | {
      readonly layer: 'tier';
      readonly backend: string;
      readonly tier: ModelTier;
      readonly tierLayer: 'pipeline' | 'job' | 'step' | 'pipeline_agents' | 'step_agents';
      readonly file?: string;
    }
  | { readonly layer: 'pipeline' }
  | { readonly layer: 'config' }
  | ConfigEntryLayer
  | { readonly layer: 'none' };

/**
 * Запись выбора пользователя, не повлиявшая ни на один шаг пайплайна, и
 * причина (`stepcast config --pipeline`, экран Pipelines).
 */
export interface UnusedAgentEntry {
  /** Путь ключа записи: `pipeline_agents.p` или `step_agents.p.job.step`. */
  readonly key: string;
  readonly kind: 'pipeline_agents' | 'step_agents';
  /** Файл, давший хотя бы одно поле записи. */
  readonly files: readonly string[];
  readonly reason: AgentEntryReason;
}

export type AgentEntryReason =
  | {
      readonly kind: 'lost';
      readonly to: 'step' | 'job' | 'pipeline' | 'config' | 'pipeline_agents' | 'step_agents';
      readonly policy: 'force' | 'fallback';
    }
  /** Запись пайплайна, у которого нет ни одного агентского шага. */
  | { readonly kind: 'no_agent_steps' }
  | { readonly kind: 'no_job' }
  | { readonly kind: 'no_step' }
  | { readonly kind: 'not_agent' };

export interface ExpandedPipeline {
  readonly pipeline: Pipeline;
  readonly substitutions: SubstitutionMap;
  /**
   * Слой модели каждого агентского шага, ключ — `<job>/<step>`. Живёт рядом с
   * раскрытым пайплайном, а не полем `Step`: `computeStepKey` хеширует `Step`
   * целиком, и справочное поле, ничего не меняющее в исполнении, обнулило бы
   * переиспользование шагов всех прошлых прогонов при первом же `resume`.
   */
  readonly modelOrigins: ReadonlyMap<string, ModelOrigin>;
  /** Слой reasoning effort каждого агентского шага, ключ — `<job>/<step>`. */
  readonly effortOrigins: ReadonlyMap<string, EffortOrigin>;
  /** Слой агента каждого агентского шага, ключ — `<job>/<step>`; по той же причине, что и модель, не в `Step`. */
  readonly agentOrigins: ReadonlyMap<string, AgentOrigin>;
  /** Записи `pipeline_agents` и `step_agents` этого пайплайна, не повлиявшие ни на один шаг. */
  readonly unusedAgentEntries: readonly UnusedAgentEntry[];
  /**
   * Имя, под которым пайплайн читает `pipeline_agents` и `step_agents`, — `name`
   * документа. У документа без `name` отсутствует: подставленное имя `pipeline`
   * записи не адресует, и выбору пользователя такой пайплайн недоступен.
   */
  readonly agentEntryName?: string;
}

/** Файлы, из которых собрано определение прогона: пайплайн и работы. */
export function definitionFiles(pipeline: Pipeline): readonly string[] {
  return [...new Set([pipeline.file, ...pipeline.jobs.map((job) => job.source)])];
}
