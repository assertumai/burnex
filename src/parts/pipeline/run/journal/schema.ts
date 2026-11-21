import { z } from 'zod';

/**
 * Схемы файлов журнала. Они же задают формат, который читают UI и внешние
 * инструменты, поэтому описаны явно, а не выводятся из внутренних типов.
 */

export const StatusValueSchema = z.enum([
  'pending',
  'running',
  'success',
  'failed',
  'skipped',
  'canceled',
  'budget_exceeded',
]);

export type StatusValue = z.infer<typeof StatusValueSchema>;

/**
 * Почему работа пропущена. `condition` — решение графа: слот не заполнен,
 * условие `if` ложно, зависимость пропущена; такой пропуск нормален и
 * годности дорожки не отменяет. `halted` — прогон до работы не дошёл:
 * остановка после отказа либо неразрешённые зависимости; такой пропуск
 * означает недоделанную дорожку, и различать их обязан журнал, а не
 * догадка читателя по тексту причины. `declared` — работа исполнялась, а её
 * шаг кодом выхода (`skip_exit_code`) сказал «делать нечего»: это не решение
 * графа (у работы есть записи шагов, и возобновление её не переносит) и не
 * недоделка (дорожка свою ветку прошла).
 */
export const SKIP_KINDS = ['condition', 'halted', 'declared'] as const;

export const SkipKindSchema = z.enum(SKIP_KINDS);

export type SkipKind = (typeof SKIP_KINDS)[number];

/** Исход, который для условий считается отказом. */
export function isFailure(status: StatusValue): boolean {
  return status === 'failed' || status === 'budget_exceeded' || status === 'canceled';
}

/**
 * Откуда взята цена: `reported` — сообщил бэкенд, `catalog` — оценка движка
 * по каталогу цен, `mixed` — в сумме есть и то и другое.
 */
export const CostSourceSchema = z.enum(['reported', 'catalog', 'mixed']);

export type CostSource = z.infer<typeof CostSourceSchema>;

export const UsageSchema = z
  .object({
    backend: z.string(),
    model: z.string().optional(),
    // Несообщаемое поле остаётся null: ноль превратил бы неполный учёт в
    // мнимую точность.
    tokens_in: z.number().nullable(),
    tokens_out: z.number().nullable(),
    cache_read: z.number().nullable(),
    cache_write: z.number().nullable(),
    pricing: z.object({
      service_tier: z.enum(['standard', 'fast', 'flex', 'batch', 'ultrafast']).optional(),
      context_tokens: z.number().nonnegative().optional(),
      cache_ttl: z.enum(['30m', '12h']).optional(),
      input_scope: z.enum(['request', 'turn', 'thread_or_turn']).optional(),
      requested_service_tier: z.enum(['standard', 'fast', 'flex', 'batch', 'ultrafast']).optional(),
    }).strict().optional(),
    wallclock_ms: z.number(),
    rate_limits: z
      .record(
        z.string(),
        z.object({ used_pct: z.number(), resets_at: z.number().optional() }).strict(),
      )
      .optional(),
    reported_cost_usd: z.number().optional(),
    /** Часть расхода нельзя оценить, даже если в сумме есть цена других вызовов. */
    cost_incomplete: z.literal(true).optional(),
    /**
     * Нарастающая цена сессии бэкенда на конец вызова — как её сообщает
     * бэкенд, считающий цену по всей сессии (Claude `total_cost_usd`; у
     * форка — вместе с исходной сессией). Цену самого вызова
     * (`reported_cost_usd`) из неё выводит движок; поле хранится, чтобы
     * продолжение сессии в другом прогоне знало, от чего вычитать.
     */
    session_cost_usd: z.number().optional(),
    /**
     * Действующая цена вызова: сообщённая бэкендом либо оценка по каталогу
     * цен. Читатель записи прежней формы, где поля нет, берёт
     * `reported_cost_usd` с источником `reported` (`effectiveCost`).
     */
    cost_usd: z.number().optional(),
    cost_source: CostSourceSchema.optional(),
    /**
     * Объём одного самого большого обращения — сумма tokens_in + cache_read +
     * cache_write того сообщения потока, где она была наибольшей. Не путать с
     * трафиком: последний суммирует все обращения, а это — максимум одного.
     * Отсутствует, если бэкенд не сообщает расход по отдельным сообщениям.
     */
    peak_prefix_tokens: z.number().optional(),
  })
  .strict();

export type Usage = z.infer<typeof UsageSchema>;

/**
 * Эффект решения — закрытый набор движка (`user-decision-steps`, design.md,
 * решение 1). Держится строкой в схеме, как и `HaltCauseSchema`: описывает
 * формат файла, который читают посторонние инструменты.
 */
export const DecisionEffectSchema = z.enum(['continue', 'reject', 'restart']);

export type DecisionEffect = z.infer<typeof DecisionEffectSchema>;

/** Один допустимый исход объявленного ожидания: эффект и подпись для витрины. */
export const AwaitingOutcomeSchema = z
  .object({
    effect: DecisionEffectSchema,
    label: z.string().optional(),
  })
  .strict();

/**
 * Запись ожидания решения в состоянии прогона (`RunStatusSchema.awaiting`,
 * design.md решение 2): ожиданий может быть несколько одновременно — работы
 * идут параллельно, — и перечень, а не одно поле, отличает их так же, как
 * `wake_at`/`WaitState` отличают несколько уснувших работ.
 */
export const AwaitingDecisionSchema = z
  .object({
    wait_id: z.string(),
    job: z.string(),
    step: z.string(),
    outcomes: z.record(z.string(), AwaitingOutcomeSchema),
    prompt: z.string().optional(),
    /** Момент начала ожидания — от него считается срок (design.md, решение 7). */
    since: z.string(),
    /** Момент истечения срока, если он объявлен. */
    deadline: z.string().optional(),
    /** Исход по истечении срока — из outcomes, не bывает restart (design.md, решение 7). */
    on_expire: z.string().optional(),
  })
  .strict();

export type AwaitingDecision = z.infer<typeof AwaitingDecisionSchema>;

/** Решение, принятое по ожиданию, — записывается в запись шага, его применившего. */
export const DecisionRecordSchema = z
  .object({
    outcome: z.string(),
    effect: DecisionEffectSchema,
    /** Кто применил исход: человек либо истёкший срок. */
    by: z.enum(['user', 'deadline']),
    reason: z.string().optional(),
    /** Адрес шага перезапуска — только у эффекта restart. */
    restart_from: z.string().optional(),
  })
  .strict();

export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/**
 * Форма файла `decisions/<wait_id>.json`, которым `burnex decide` пишет
 * решение (design.md, решение 5): исход, причина отклонения, шаг перезапуска.
 * Автор — всегда человек; поле `by` в записи шага пишет читающая сторона, не
 * файл. Не входит в отпечаток формата журнала (`journal/format.ts`): каталог
 * `decisions/` — не файл прогона, который читают посторонние инструменты
 * версией движка, а канал ровно между `burnex decide` и ждущим процессом.
 */
export const DecisionRequestFileSchema = z
  .object({
    outcome: z.string(),
    reason: z.string().optional(),
    restart_from: z.string().optional(),
  })
  .strict();

export type DecisionRequestFile = z.infer<typeof DecisionRequestFileSchema>;

export const PredicateResultSchema = z
  .object({
    predicate: z.string(),
    passed: z.boolean(),
    hard: z.boolean(),
    detail: z.string().optional(),
    expected: z.unknown().optional(),
    actual: z.unknown().optional(),
  })
  .strict();

export const ExpectReportSchema = z
  .object({
    attempt: z.number().int().positive(),
    results: z.array(PredicateResultSchema),
  })
  .strict();

/**
 * Уровень записи контекста: место в документе либо профиль агента
 * (`profile:<имя>`, `agent-profiles`).
 */
const ContextOriginSchema = z.union([
  z.enum(['upstream', 'pipeline', 'job', 'step']),
  z.templateLiteral(['profile:', z.string().regex(/^[a-z][a-z0-9_-]*$/)]),
]);

export const ContextEntryReportSchema = z
  .object({
    origin: ContextOriginSchema,
    /**
     * `knowledge` — запись, пришедшая от источника знания. Отдельный вид, а
     * не `path`/`text` с признаком: разбирающий состав контекста постфактум
     * обязан отличать то, что назвал автор пайплайна, от того, что подобрал
     * источник, — иначе непонятно, чьё решение разбирать.
     */
    kind: z.enum(['path', 'text', 'knowledge']),
    /** Идентификатор единицы знания. Есть только у записей вида `knowledge`. */
    id: z.string().optional(),
    path: z.string().optional(),
    mode: z.enum(['inline', 'reference']),
    tokens: z.number(),
    /**
     * Уровни, на которых запись была объявлена, — только когда их больше
     * одного. `origin` остаётся местом, где запись фактически вошла в
     * контекст; запись, объявленная однажды, этого поля не несёт.
     */
    declared_in: z.array(ContextOriginSchema).optional(),
  })
  .strict();

export const ContextReportSchema = z
  .object({
    session: z.string().optional(),
    entries: z.array(ContextEntryReportSchema),
    total_tokens: z.number(),
    downgraded: z.array(z.string()).optional(),
  })
  .strict();

export const AttemptRecordSchema = z
  .object({
    attempt: z.number().int().positive(),
    status: StatusValueSchema,
    reason: z.string().optional(),
    started_at: z.string(),
    finished_at: z.string(),
    exit_code: z.number().nullable().optional(),
    usage: UsageSchema.optional(),
    /**
     * Число отказов бэкенда в разрешении за эту попытку. Необязательное:
     * журналы прежней версии его не несут, и отсутствие поля значит
     * «сведений нет», а не ноль отказов.
     */
    permission_denials: z.number().int().nonnegative().optional(),
    /**
     * Прогон, из которого перенесена эта попытка, оборванная отменой. Есть
     * только у попытки, перенесённой в запись продолжающего шага без
     * повторного исполнения, — её расход складывается с расходом
     * продолженной попытки, но не входит в счёт объявленных `attempts`.
     */
    carried_from: z.string().optional(),
  })
  .strict();

/**
 * Причина досрочной остановки из закрытого перечня `parts/pipeline/run/halt.ts`.
 * Держится строкой, а не ссылкой на константу: схема описывает формат файла,
 * который читают посторонние инструменты.
 */
export const HaltCauseSchema = z.enum([
  'expect_failed',
  'timeout',
  'spawn_failed',
  'until_not_met',
  'loop_exhausted',
  'budget_exceeded',
  'canceled',
  'backend_rate_limited',
  'backend_unauthenticated',
]);

export const StepRecordSchema = z
  .object({
    id: z.string(),
    index: z.number().int().positive(),
    kind: z.enum(['agent', 'run', 'script', 'plugin', 'review', 'discuss']),
    key: z.string(),
    status: StatusValueSchema,
    reason: z.string().optional(),
    /** Причина неуспеха из закрытого перечня. */
    cause: HaltCauseSchema.optional(),
    session: z.string().optional(),
    attempts: z.array(AttemptRecordSchema),
    /** Якорь состояния рабочего дерева на конец шага. */
    tree_id: z.string().optional(),
    /** Якорь на начало шага: база для `changed_only` и для `diff.patch`. */
    tree_before: z.string().optional(),
    /** Способ фиксации: якоря разных способов несравнимы. */
    anchor_kind: z.enum(['git', 'manifest', 'composite']).optional(),
    /**
     * Почему якорь снять не удалось. Наличие поля означает, что шаг непригоден
     * для переиспользования при возобновлении, но на его статус это не влияло.
     */
    anchor_missing: z.string().optional(),
    /** Отпечаток входов шага — то, что решает вопрос о его валидности. */
    inputs_fingerprint: z.string().optional(),
    /**
     * Откуда взят отпечаток. Пишется рядом с ним, чтобы объяснение
     * инвалидации собиралось из записи, без повторного вычисления.
     */
    inputs_origin: z.enum(['declared', 'observed', 'tree']).optional(),
    /** Файлы, которые шаг фактически прочитал, — уточняют инвалидацию. */
    observed_inputs: z.array(z.string()).optional(),
    /** Что бэкенд сообщил о своей инициализации: плагины, серверы, ошибки. */
    backend_init: z.record(z.string(), z.unknown()).optional(),
    /** Прогон, из которого запись перенесена без исполнения шага. */
    reused_from: z.string().optional(),
    /** Прогон, чью оборванную сессию продолжает этот шаг. */
    continued_from: z.string().optional(),
    /**
     * Разрешение шага `script`: объявленный путь, слой, абсолютный путь,
     * раннер и действующий argv — то же, что несёт `pipeline.lock.yml`, но
     * рядом с исходом попытки. Есть только у `kind: script` с разрешённым
     * файлом; неразрешённый шаг отказывает до попытки, и разрешать ему
     * нечего.
     */
    script: z
      .object({
        path: z.string(),
        layer: z.enum(['project', 'home', 'builtin', 'explicit']),
        /** Пакет, давший скрипт (`layer` — слой самого пакета). Ключа нет у скрипта вне пакета и у прогона прежней версии. */
        package: z.string().optional(),
        absolute_path: z.string(),
        runner: z.string(),
        argv: z.array(z.string()),
      })
      .strict()
      .optional(),
    /**
     * Происхождение шага, собранного из манифеста переиспользуемого шага
     * (design.md изменения reusable-steps, решение 11): имя, слой, в котором
     * найден манифест, и его путь — рядом с `script`, а не вместо него, чтобы
     * запись отвечала и на вопрос «что исполнится», и на вопрос «что здесь
     * было написано». Есть только у `kind: script`, собранного из `uses`.
     */
    uses: z
      .object({
        name: z.string(),
        layer: z.enum(['project', 'home', 'builtin']).optional(),
        /** Пакет, давший шаг (`layer` — слой самого пакета). Ключа нет у шага вне пакета и у прогона прежней версии. */
        package: z.string().optional(),
        manifest_path: z.string().optional(),
      })
      .strict()
      .optional(),
    /**
     * Вид и плагин шага плагинного вида (`step-kinds-registry`): имя из
     * реестра и имя плагина, его внёсшего, — «встроенный» здесь не бывает,
     * `kind: plugin` у встроенных видов не встречается. Есть только у
     * `kind: plugin`; читатель без этого плагина показывает запись этими же
     * полями, не отказывая чтением (design.md, риски).
     */
    plugin_step: z
      .object({
        name: z.string(),
        plugin: z.string(),
      })
      .strict()
      .optional(),
    /**
     * Решение, применённое к ожиданию этого шага (`user-decision-steps`,
     * design.md решение 5): исход, эффект, автор и, если ожидание отклонено
     * или перезапущено, причина и адрес перезапуска. Есть только у шага
     * ожидающего вида, дождавшегося решения.
     */
    decision: DecisionRecordSchema.optional(),
    /**
     * Выходы работы, внесённые этим шагом `run` (job-outputs-key-value): ключи,
     * которых до него не было или чьё значение он изменил. По ним `resume`
     * переносит выходы только переиспользованных шагов. Нет у шага, ничего не
     * опубликовавшего.
     */
    outputs: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const JobRecordSchema = z
  .object({
    id: z.string(),
    status: StatusValueSchema,
    reason: z.string().optional(),
    /** Причина неуспеха из закрытого перечня. */
    cause: HaltCauseSchema.optional(),
    /** Происхождение пропуска. Есть только у `status: skipped`. */
    skip: SkipKindSchema.optional(),
    /** Метка обвязки, объявленная на месте подключения работы. У работы без lane отсутствует. */
    lane: z.string().optional(),
    /**
     * Данные, опубликованные работой по ходу исполнения (`burnex data`).
     * Складываются сюда движком после каждого шага: файл `data.json` пишет
     * подпроцесс, а `status.json` принадлежит движку и переписывается им на
     * каждом событии журнала — конкурентная запись была бы гонкой.
     */
    data: z.record(z.string(), z.string()).optional(),
    /**
     * Выходы, принятые движком из `$BURNEX_JOB_OUTPUTS` (job-outputs-key-value).
     * Источник для переменных `NEEDS_*` потребителей — запись, а не файл. Поле
     * необязательно: запись прогона прежней версии читается как работа без выходов.
     */
    outputs: z.record(z.string(), z.string()).optional(),
    /** Число выполненных итераций цикла. У работы без цикла отсутствует. */
    iterations: z.number().int().positive().optional(),
    /** Число использованных попыток работы. Есть только у работы с `attempts.max > 1`. */
    attempts: z.number().int().positive().optional(),
    /**
     * Результаты предикатов check последней вычисленной итерации. Есть
     * только при отказе с причиной until_not_met — иначе цикл завершился
     * успехом и объяснять нечего.
     */
    last_check: z.array(PredicateResultSchema).optional(),
    /** Режим и путь рабочей директории работы: их нужно знать для apply. */
    workspace: z
      .object({
        mode: z.string(),
        path: z.string(),
        /**
         * Дерево, в котором работа исполнялась (`named-workspace-trees`):
         * имя общего дерева либо `own` — личное дерево и каталог при
         * `scope: job`. Нет в режиме `cwd` и у записи прежнего формата: её
         * каталог берётся из `path`.
         */
        tree: z.string().optional(),
        /**
         * Засев каталога, заведённого для этой работы: работа-источник (или
         * `none` — исходное состояние) и способ — `copy` (перенесён весь
         * каталог источника) либо `anchor` (каталога источника уже не было,
         * засев якорем, с причиной). У `from: none` способа нет.
         */
        seed: z
          .object({
            from: z.string(),
            by: z.enum(['copy', 'anchor']).optional(),
            reason: z.string().optional(),
          })
          .strict()
          .optional(),
        /** Работа прежнего формата: чьё дерево унаследовано. Новый формат пишет `seed.from`. */
        inherited_from: z.string().optional(),
        /** Каталог продолжен, а не заведён для этой работы: она шла в уже заведённом дереве. */
        continued: z.boolean().optional(),
        /**
         * Прогон, у которого перенят этот каталог для продолжения оборванной
         * сессии. Отсутствует у работы, заведшей каталог сама.
         */
        adopted_from: z.string().optional(),
        /**
         * Материализованные части дерева — объявленный каталог и репозиторий,
         * которому он принадлежит. Нужно уборке: она снимает учётную запись
         * рабочего дерева каждой части адресно, а с завершением работы это
         * поле не связано — пишется в момент заведения, до первого шага, и
         * переживает отказ, отмену и остановку по бюджету. Репозиторий
         * записан явным абсолютным путём, а не выводится из каталога прогона:
         * манифест каталог запуска не хранит, а к моменту уборки проект мог
         * переехать.
         */
        nested: z.array(z.object({ dir: z.string(), repo: z.string() }).strict()).optional(),
      })
      .strict()
      .optional(),
    started_at: z.string().optional(),
    finished_at: z.string().optional(),
    output: z.string().optional(),
    steps: z.array(StepRecordSchema),
  })
  .strict();

/**
 * Объявление рабочей директории пайплайна в манифесте и состоянии: режим,
 * путь размещения копий, область и деревья (`named-workspace-trees`) —
 * последние два есть, только если пайплайн их объявил.
 */
const PipelineWorkspaceRecordSchema = z
  .object({
    mode: z.string(),
    path: z.string().optional(),
    scope: z.enum(['run', 'job']).optional(),
    trees: z.array(z.string()).optional(),
  })
  .strict();

export const RunManifestSchema = z
  .object({
    run_id: z.string(),
    pipeline: z.string(),
    pipeline_file: z.string(),
    /**
     * Адрес `<пакет>:<имя>`, как пайплайн был назван при запуске
     * (`packages-directory-layer`), рядом с разрешённым `pipeline_file`.
     * Ключа нет у прогона по пути и у прогона прежней версии. `resume` идёт по
     * `pipeline_file` и адрес не разрешает заново; поле говорит, что пайплайн
     * лежит вне проекта и слои шагов и скриптов ищутся от корня проекта.
     */
    pipeline_address: z.string().optional(),
    lock_hash: z.string(),
    project_root: z.string(),
    workspace: PipelineWorkspaceRecordSchema,
    /** Способ фиксации состояния дерева: определяется один раз на прогон. */
    anchor_kind: z.enum(['git', 'manifest', 'composite']).optional(),
    /**
     * Состав вложенных репозиториев, с которым снимался прогон (`project.
     * nested_repos`), в каноническом порядке. Отсутствует, если состав не
     * объявлен. Отпечаток в `tree_id` отвечает «тот же ли состав», это поле —
     * «а какой был»: без него отчёт о несравнимости составов называл бы
     * только сегодняшнюю половину.
     */
    nested_repos: z.array(z.string()).optional(),
    /** Коммиты корня и частей, от которых заведены рабочие деревья прогона. */
    source_commits: z.record(z.string(), z.string()).optional(),
    /**
     * Загруженные плагины прогона: имя, версия и разрешённый путь модуля, в
     * порядке загрузки. Прогон, снятый с плагинным предикатом, без этого поля
     * нечем воспроизвести — журнал называет предикат по имени, а чем оно
     * предоставлено, знает только конфигурация, которой уже может не быть.
     * Отсутствие поля — прогон прежней версии, а не прогон без плагинов.
     */
    plugins: z
      .array(
        z
          .object({
            name: z.string(),
            version: z.string().optional(),
            source: z.string(),
            /** Пакет, в каталоге которого лежал плагин. Ключа нет у плагина вне пакета и у прогона прежней версии. */
            package: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    /** Прогон, из которого этот получен возобновлением. */
    resumed_from: z.string().optional(),
    inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    /**
     * Переопределения объявленного `env:` флагом `run --env` — буквальные
     * значения. Ключа нет у прогона без переопределений и у прогона прежней
     * версии; `resume` берёт их отсюда, собственного флага у него нет.
     */
    env_overrides: z.record(z.string(), z.string()).optional(),
    /**
     * Режим прогона (`shadow-run-mode`): `shadow` — внешние действия объявленных
     * шагов не совершались, а записаны. Ключа нет у обычного прогона и у прогона
     * прежней версии — оба читаются как обычный режим; `resume` берёт режим
     * отсюда, собственного флага у него нет.
     */
    mode: z.literal('shadow').optional(),
    /**
     * Агент, выбранный флагом `run --agent` на этот прогон (слой флага над
     * `defaults.agent`, по тому же порядку слоёв и `agent_policy`). Ключа нет
     * у прогона без флага и у прогона прежней версии; `resume` берёт имя
     * отсюда, собственного флага у него нет — как у `env_overrides` и `mode`.
     */
    agent_override: z.string().optional(),
    /**
     * Происхождение прогона (`ui-schedule-view`): запущен по записи
     * `triggers.schedule` — её номер, выражение и пояс на момент запуска
     * (документ правят, номера сдвигаются), момент расписания и признак догона
     * (его выставляет запускающий, а не выводит читатель). `kind` оставлен
     * закрытым перечислением под будущий вид триггера. Ключа нет у ручного
     * прогона и у прогона прежней версии; `resume` его не наследует. Манифест
     * с этим полем прежней версией движка не читается — тот же необратимый
     * шаг, что у `mode` и `pid`.
     */
    trigger: z
      .object({
        kind: z.literal('schedule'),
        entry: z.number().int().min(0),
        cron: z.string(),
        timezone: z.string().optional(),
        moment: z.string(),
        catchup: z.boolean(),
      })
      .strict()
      .optional(),
    git: z.object({ head: z.string().optional(), dirty_hash: z.string().optional() }).strict(),
    backends: z.record(z.string(), z.object({ command: z.string(), version: z.string().optional() }).strict()),
    started_at: z.string(),
    finished_at: z.string().optional(),
    status: StatusValueSchema.optional(),
    exit_code: z.number().optional(),
    /**
     * Идентификатор процесса, ведущего прогон. Пишется до запуска первой
     * работы — читатель журнала использует его, чтобы отличить прогон,
     * зависший в `running` после `SIGKILL` или перезагрузки, от идущего или
     * спящего до сброса окна лимита. Манифест прежней формы этого поля не
     * несёт: тот же необратимый шаг, что уже был у сводок расхода.
     */
    pid: z.number().optional(),
    /**
     * Версия формата журнала (`JOURNAL_FORMAT` в `./format.ts`), действующая
     * на момент записи манифеста. Проставляет её писатель журнала сам —
     * поле, которое можно забыть передать, забудут. Отсутствие поля значит
     * «журнал прежней формы», а не нулевую версию: манифест, записанный до
     * появления версии, читается как прежде и расхождением версий не
     * считается.
     */
    format: z.number().int().positive().optional(),
    /**
     * Движок, которым прогон исполнялся: корень пакета, точка входа и признак
     * снимка (`run/engine.ts`). Пишется у всякого прогона, включая тот, что
     * шёл обычной установкой (`pinned: false`) — «движок лежал вне дерева» и
     * «версия движка не умела писать это поле» разные утверждения, и
     * отсутствие поля значит второе, а не первое.
     */
    engine: z
      .object({ root: z.string(), entry: z.string(), pinned: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Измерение потолка бюджета: в чём считаны `used` и `limit`. Без него
 * величины события — голые числа, одинаково похожие на токены, микродоллары,
 * миллисекунды и проценты.
 */
export const BudgetDimensionSchema = z.enum(['tokens', 'cost', 'wallclock', 'rate_limit']);

export type BudgetDimension = z.infer<typeof BudgetDimensionSchema>;

export const BudgetStateSchema = z
  .object({
    tokens_used: z.number(),
    tokens_limit: z.number().optional(),
    cost_used_usd: z.number().optional(),
    cost_limit_usd: z.number().optional(),
    /** Попытки, чья цена неизвестна: объявленный денежный потолок мог не применяться. */
    cost_unreported_attempts: z.number().optional(),
    /** Источник денежного расхода прогона; нет — сообщённый (состояние прежней формы). */
    cost_source: CostSourceSchema.optional(),
    /** Дата прейскуранта, если в расходе есть оценка по каталогу. */
    cost_catalog_as_of: z.string().optional(),
    wallclock_ms: z.number(),
    wallclock_limit_ms: z.number().optional(),
    /**
     * Первое превышение потолка, остановившее исполнение — заполняется один
     * раз, тем же превышением, что уходит в событие `budget.exceeded`.
     * Отсутствует, если ни один потолок прогон не остановил: расход выше
     * этого поля не поднимается сам по себе, только явной остановкой.
     */
    exceeded: z
      .object({
        scope: z.string(),
        dimension: BudgetDimensionSchema.optional(),
        used: z.number(),
        limit: z.number(),
        at: z.string(),
        job: z.string(),
        step: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Вердикт цикла по группе работ (`run/scheduler.ts`, `LoopVerdict`). */
export const LoopVerdictSchema = z.enum(['done', 'exhausted', 'canceled']);

/**
 * Состояние цикла в `status.json`: пишется на границе прохода. Проход виден
 * здесь, а не в записях работ — запись участника описывает его последний
 * проход.
 */
export const LoopRecordSchema = z
  .object({
    id: z.string(),
    jobs: z.array(z.string()),
    /** Проходов начато к этому моменту. */
    iterations: z.number().int().nonnegative(),
    max_iterations: z.number().int().positive(),
    /** Есть только у законченного цикла. */
    verdict: LoopVerdictSchema.optional(),
    status: StatusValueSchema,
    reason: z.string().optional(),
    cause: HaltCauseSchema.optional(),
  })
  .strict();

export const RunStatusSchema = z
  .object({
    run_id: z.string(),
    pipeline: z.string(),
    lock_hash: z.string(),
    status: StatusValueSchema,
    workspace: PipelineWorkspaceRecordSchema,
    /** Прогон, из которого этот получен возобновлением. */
    resumed_from: z.string().optional(),
    inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    jobs: z.array(JobRecordSchema),
    /** Циклы по группам работ. Без объявленных циклов ключа нет. */
    loops: z.array(LoopRecordSchema).optional(),
    budget: BudgetStateSchema,
    /** Команда возобновления: состояние должно объяснять, как продолжить. */
    resume: z.object({ command: z.string(), blocked_by: z.string().optional() }).strict().optional(),
    /**
     * Момент, когда прогон, уснувший до сброса окна лимита, должен
     * возобновиться. Пишется на диск до начала сна и снимается после
     * пробуждения — это отличает спящий прогон от зависшего.
     */
    wake_at: z.string().optional(),
    /**
     * Ожидания решения, идущие в прогоне прямо сейчас (`user-decision-steps`,
     * design.md решение 2): статус остаётся `running`, «ждёт решения» читатель
     * выводит из непустого перечня — тем же приёмом, каким «спит» выводится
     * из `wake_at`. Снимается по применению решения этого ожидания и при
     * снятии области прогона.
     */
    awaiting: z.array(AwaitingDecisionSchema).optional(),
    /**
     * Точка, с которой продолжится возобновление, — записана исходом `restart`
     * (design.md, решение 4). Той же формы, что `--from job[/step]`. Есть
     * только у прогона, законченного этим исходом.
     */
    restart_from: z.string().optional(),
    updated_at: z.string(),
  })
  .strict();

export const UsageAttemptReportSchema = z
  .object({
    attempt: z.number().int().positive(),
    /** Попытка работы, в которой исполнена эта попытка шага. Есть только у работы с `attempts.max > 1`. */
    job_attempt: z.number().int().positive().optional(),
    /** Участник шага `review`, чья это попытка: `id` ревьюера либо `aggregator`. */
    participant: z.string().optional(),
    backend: z.string(),
    model: z.string().optional(),
    billable_tokens: z.number(),
    wallclock_ms: z.number(),
    /** Отсутствует, если ни один сообщённый расход попытки не содержал цены. */
    cost_usd: z.number().optional(),
    /** Источник цены; отсутствует у сводки прежней формы — тогда она сообщённая. */
    cost_source: CostSourceSchema.optional(),
    /** Известная цена покрывает только часть вызовов попытки. */
    cost_incomplete: z.literal(true).optional(),
    /** Наибольший префикс обращения этой попытки. См. `UsageSchema`. */
    peak_prefix_tokens: z.number().optional(),
  })
  .strict();

export const UsageReportSchema = z
  .object({
    run_id: z.string(),
    /**
     * Прогон ещё не завершён — величины ниже накоплены на текущий момент, а
     * не подведены. Ставится каждой записью, кроме последней; отсутствие поля
     * означает подведённую сводку. Так читаются и все сводки, записанные до
     * появления поля: их писали ровно один раз, в конце прогона.
     */
    partial: z.boolean().optional(),
    total: z
      .object({
        tokens_in: z.number(),
        tokens_out: z.number(),
        cache_read: z.number(),
        cache_write: z.number(),
        billable_tokens: z.number(),
        wallclock_ms: z.number(),
        cost_usd: z.number().optional(),
        cost_source: CostSourceSchema.optional(),
      })
      .strict(),
    /**
     * Дата прейскуранта, по которому считалась оценка: старый прогон
     * показывает свою дату, а не дату каталога, установленного позже.
     * Есть, только если в сводке есть оценка.
     */
    cost_catalog_as_of: z.string().optional(),
    /** Измерения, которых бэкенды не сообщили: учёт по ним неполон. */
    unreported: z.array(z.string()),
    jobs: z.record(
      z.string(),
      z
        .object({
          billable_tokens: z.number(),
          wallclock_ms: z.number(),
          cost_usd: z.number().optional(),
          cost_source: CostSourceSchema.optional(),
          steps: z.record(
            z.string(),
            z
              .object({
                billable_tokens: z.number(),
                wallclock_ms: z.number(),
                cost_usd: z.number().optional(),
                cost_source: CostSourceSchema.optional(),
                // Максимум по попыткам шага, не сумма. Отсутствует, если ни
                // одна попытка не сообщила пика, — уровни работы и прогона
                // этого поля не несут вовсе: величина теряет смысл ориентира
                // выше шага.
                peak_prefix_tokens: z.number().optional(),
                // Расход шага `review` по участникам (`review-strategies`):
                // ревьюеры по `id` и `aggregator`. Сумма — расход шага.
                participants: z
                  .record(
                    z.string(),
                    z
                      .object({
                        billable_tokens: z.number(),
                        wallclock_ms: z.number(),
                        cost_usd: z.number().optional(),
                        cost_source: CostSourceSchema.optional(),
                      })
                      .strict(),
                  )
                  .optional(),
                // Прежняя форма сводки хранила число попыток. Разбивки в ней
                // нет и взять её неоткуда, но остальная сводка старого прогона
                // остаётся годной: терять её целиком ради поля, которого тогда
                // не писали, значит ослепить отчёт на всех прошлых прогонах.
                attempts: z.preprocess(
                  (value) => (typeof value === 'number' ? [] : value),
                  z.array(UsageAttemptReportSchema),
                ),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * Разрез расхода по одной модели в записи хранилища расхода
 * (`journal/usageStore.ts`). Без попыток: попытки — самая объёмная часть
 * сводки прогона и в хранилище не переносятся (design.md изменения
 * run-stats-retention, Решение 5).
 */
export const UsageStoreModelSliceSchema = z
  .object({
    billable_tokens: z.number(),
    cost_usd: z.number().optional(),
  })
  .passthrough();

export const UsageStoreStepSliceSchema = z
  .object({
    billable_tokens: z.number(),
    wallclock_ms: z.number(),
    cost_usd: z.number().optional(),
    cost_source: CostSourceSchema.optional(),
  })
  .passthrough();

export const UsageStoreJobSliceSchema = z
  .object({
    billable_tokens: z.number(),
    wallclock_ms: z.number(),
    cost_usd: z.number().optional(),
    cost_source: CostSourceSchema.optional(),
    steps: z.record(z.string(), UsageStoreStepSliceSchema),
  })
  .passthrough();

/**
 * Запись хранилища расхода: построчный журнал `<корень прогонов>/usage.ndjson`
 * (`journal/usageStore.ts`), по одной записи на прогон, переживающий удаление
 * его каталога.
 *
 * В отличие от прочих схем этого файла, запись не `.strict()`, а
 * `.passthrough()` на каждом уровне: журнал прогона живёт, пока жив сам
 * прогон, и строгость там ловит разошедшиеся версии рано, — а хранилище
 * расхода заведено ровно ради того, чтобы пережить и прогон, и читателя.
 * Отвергнутая по незнакомому полю запись — это потерянная навсегда история,
 * то есть та самая беда, против которой хранилище и строится (design.md
 * изменения run-stats-retention, Решение 7). Поэтому запись версии новее
 * читателя читается по известным полям, а не отвергается целиком.
 */
export const UsageRecordSchema = z
  .object({
    /** Версия формата записи — не связана с `JOURNAL_FORMAT` журнала прогона. */
    format: z.number().int().positive(),
    project: z.object({ key: z.string(), path: z.string() }).passthrough(),
    pipeline: z.object({ name: z.string(), file: z.string() }).passthrough(),
    run_id: z.string(),
    started_at: z.string(),
    /** Отсутствует у прогона, перенесённого незавершённым (Решение 9). */
    finished_at: z.string().optional(),
    status: StatusValueSchema,
    total: z
      .object({
        tokens_in: z.number(),
        tokens_out: z.number(),
        cache_read: z.number(),
        cache_write: z.number(),
        billable_tokens: z.number(),
        wallclock_ms: z.number(),
        cost_usd: z.number().optional(),
        cost_source: CostSourceSchema.optional(),
      })
      .passthrough(),
    /** Дата прейскуранта, если в расходе прогона есть оценка по каталогу. */
    cost_catalog_as_of: z.string().optional(),
    /** Измерения, которых бэкенды не сообщили, — то же поле, что в `UsageReport`. */
    unreported: z.array(z.string()),
    /** Число попыток прогона, чей расход не содержал цены. */
    cost_unreported_attempts: z.number().int().nonnegative(),
    models: z.record(z.string(), UsageStoreModelSliceSchema),
    jobs: z.record(z.string(), UsageStoreJobSliceSchema),
  })
  .passthrough();

export type UsageRecord = z.infer<typeof UsageRecordSchema>;
export type UsageStoreJobSlice = z.infer<typeof UsageStoreJobSliceSchema>;
export type UsageStoreStepSlice = z.infer<typeof UsageStoreStepSliceSchema>;
export type UsageStoreModelSlice = z.infer<typeof UsageStoreModelSliceSchema>;

const eventBase = { ts: z.string(), seq: z.number().int().nonnegative() };

export const EventSchema = z.discriminatedUnion('kind', [
  z.object({ ...eventBase, kind: z.literal('run.started'), pipeline: z.string(), run_id: z.string() }).strict(),
  // Движок распознан правимым и снят снимком (run-engine-snapshot); root —
  // корень установки, path — каталог снимка в директории прогона. Событие не
  // пишется, если движок правимым не распознан: обычной установке объявлять
  // нечего.
  z.object({ ...eventBase, kind: z.literal('engine.pinned'), root: z.string(), path: z.string() }).strict(),
  // Runner, запущенный демоном витрины, завершился, не успев записать
  // терминальный исход. Отдельное событие сохраняет наблюдённые демоном код
  // и сигнал: один `run.finished: failed` не объяснил бы, что отказал не
  // пайплайн, а ведущий его процесс.
  z.object({
    ...eventBase,
    kind: z.literal('run.interrupted'),
    pid: z.number().int().positive(),
    exit_code: z.number().nullable(),
    signal: z.string().nullable(),
    detail: z.string(),
  }).strict(),
  z.object({ ...eventBase, kind: z.literal('run.finished'), status: StatusValueSchema, exit_code: z.number() }).strict(),
  z.object({ ...eventBase, kind: z.literal('job.started'), job: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('job.errored'), job: z.string(), detail: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('job.finished'), job: z.string(), status: StatusValueSchema, reason: z.string().optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('step.started'), job: z.string(), step: z.string(), attempt: z.number().int().positive() }).strict(),
  z.object({ ...eventBase, kind: z.literal('step.finished'), job: z.string(), step: z.string(), attempt: z.number().int().positive(), status: StatusValueSchema, reason: z.string().optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('step.stalled'), job: z.string(), step: z.string(), silent_ms: z.number() }).strict(),
  // Участник шага `review` (`review-strategies`, design.md, решение 6): ревьюер
  // по своему `id`, `aggregator` либо `defender`. Исход — статус участника;
  // провал ревьюера шага не роняет, и `reason` называет то, что получит
  // агрегатор. `round` — раунд защиты (`review-defend`, решение 7): ход
  // ревьюера или защитника в раунде N ≥ 1; у независимого ревью и агрегатора
  // поля нет. `thread` писали журналы прежнего формата у хода защитника —
  // ветка, то есть ревьюер, чьи находки он защищал; в общих раундах
  // (`review-defend-shared-session`) поля нет ни у кого.
  z.object({ ...eventBase, kind: z.literal('review.participant.started'), job: z.string(), step: z.string(), participant: z.string(), round: z.number().int().positive().optional(), thread: z.string().optional(), agent: z.string(), model: z.string().optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('review.participant.finished'), job: z.string(), step: z.string(), participant: z.string(), round: z.number().int().positive().optional(), thread: z.string().optional(), status: StatusValueSchema, reason: z.string().optional() }).strict(),
  // Выбор защитника режима `defend` (`review-defend-shared-session`,
  // решение 1): сама сессия имплементатора, её форк с причиной (`reused`,
  // `shared`) либо свежий агент с причиной. Журналы прежнего формата знали
  // только форк без причины и свежего агента.
  z.object({
    ...eventBase,
    kind: z.literal('review.defender'),
    job: z.string(),
    step: z.string(),
    mode: z.enum(['resume', 'fork', 'fresh']),
    implementer: z.string().optional(),
    agent: z.string(),
    model: z.string().optional(),
    reason: z.enum(['no_implementer', 'other_tree', 'no_session', 'no_fork', 'no_schema', 'reused', 'shared']).optional(),
  }).strict(),
  // Реплика защиты (`review-defend`, решение 7): запись в `defense.ndjson` —
  // событием по ходу шага. `thread` — у реплики ревьюера его id; у реплики
  // защитника поля нет (`review-defend-shared-session`, решение 4), а в
  // журналах прежнего формата там была ветка.
  // Прежний режим `discussion` (`review-discussion`) писал это событие с
  // позицией `stance` и раундом 0: движок их больше не пишет, но схема их
  // читает, чтобы прежние прогоны открывались.
  z.object({
    ...eventBase,
    kind: z.literal('review.message'),
    job: z.string(),
    step: z.string(),
    participant: z.string(),
    thread: z.string().optional(),
    round: z.number().int().nonnegative(),
    message_id: z.string(),
    stance: z.enum(['propose', 'agree', 'disagree']).optional(),
    proposal: z.string().optional(),
    target: z.string().optional(),
    invalid: z.literal(true).optional(),
    failure: z.string().optional(),
  }).strict(),
  // Закрытие находки (`review-defend`, решение 5): `accepted` — защитник
  // принял, `withdrawn` — ревьюер снял, `contested` — открыта к концу ветки.
  z.object({ ...eventBase, kind: z.literal('review.settled'), job: z.string(), step: z.string(), finding: z.string(), status: z.enum(['accepted', 'withdrawn', 'contested']) }).strict(),
  z.object({ ...eventBase, kind: z.literal('review.defense.finished'), job: z.string(), step: z.string(), accepted: z.number().int().nonnegative(), withdrawn: z.number().int().nonnegative(), contested: z.number().int().nonnegative() }).strict(),
  // Шаг `discuss` (`discuss-step`, design.md, решение 9): границы фаз,
  // вызовы участников с фазой и раундом, реплики и закрытия защиты черновика,
  // итог со счётом и отметкой согласия агрегатора.
  z.object({
    ...eventBase,
    kind: z.literal('discuss.phase'),
    job: z.string(),
    step: z.string(),
    phase: z.enum(['proposals', 'draft', 'objections', 'defense', 'aggregate']),
    boundary: z.enum(['started', 'finished']),
  }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('discuss.participant.started'),
    job: z.string(),
    step: z.string(),
    participant: z.string(),
    phase: z.enum(['proposals', 'draft', 'objections', 'defense', 'aggregate']),
    round: z.number().int().positive().optional(),
    agent: z.string(),
    model: z.string().optional(),
  }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('discuss.participant.finished'),
    job: z.string(),
    step: z.string(),
    participant: z.string(),
    phase: z.enum(['proposals', 'draft', 'objections', 'defense', 'aggregate']),
    round: z.number().int().positive().optional(),
    status: StatusValueSchema,
    reason: z.string().optional(),
  }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('discuss.message'),
    job: z.string(),
    step: z.string(),
    participant: z.string(),
    thread: z.string().optional(),
    round: z.number().int().positive(),
    message_id: z.string(),
    invalid: z.literal(true).optional(),
    failure: z.string().optional(),
  }).strict(),
  z.object({ ...eventBase, kind: z.literal('discuss.settled'), job: z.string(), step: z.string(), finding: z.string(), status: z.enum(['accepted', 'withdrawn', 'contested']) }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('discuss.finished'),
    job: z.string(),
    step: z.string(),
    accepted: z.number().int().nonnegative(),
    withdrawn: z.number().int().nonnegative(),
    contested: z.number().int().nonnegative(),
    preference: z.number().int().nonnegative(),
    agreed: z.boolean().optional(),
  }).strict(),
  // Исход прежнего режима `discussion` — только для чтения старых журналов.
  z.object({ ...eventBase, kind: z.literal('review.consensus'), job: z.string(), step: z.string(), proposal: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('review.no_consensus'), job: z.string(), step: z.string(), reason: z.enum(['limit', 'stalled', 'budget', 'participants']) }).strict(),
  // Внешнее действие шага записано, а не совершено (`shadow-run-mode`): `n` —
  // сквозной номер действий шага, `path` — файл `action-<n>.json`. Достаточно,
  // чтобы перечислить действия, не читая файлов.
  z.object({ ...eventBase, kind: z.literal('step.action'), job: z.string(), step: z.string(), attempt: z.number().int().positive(), n: z.number().int().positive(), path: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('expect.failed'), job: z.string(), step: z.string(), attempt: z.number().int().positive(), predicate: z.string(), detail: z.string().optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('env.denied'), name: z.string(), pattern: z.string(), scope: z.string() }).strict(),
  // Переменная объявленного секрета вычеркнута из окружения шага, который
  // этот секрет не назвал (`secrets-named-providers`). `secret` — имя секрета, а
  // не его значение; значение в журнале не появляется нигде.
  z.object({ ...eventBase, kind: z.literal('env.withheld'), name: z.string(), secret: z.string(), scope: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('context.denied'), job: z.string().optional(), step: z.string().optional(), path: z.string(), pattern: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('context.downgraded'), job: z.string(), step: z.string(), path: z.string(), tokens: z.number() }).strict(),
  z.object({ ...eventBase, kind: z.literal('context.note_truncated'), job: z.string(), step: z.string(), original_tokens: z.number(), final_tokens: z.number() }).strict(),
  // `dimension` необязателен только ради журналов, записанных до его появления:
  // пишущая сторона задаёт его всегда.
  z.object({ ...eventBase, kind: z.literal('budget.warning'), scope: z.string(), job: z.string().optional(), step: z.string().optional(), dimension: BudgetDimensionSchema.optional(), used: z.number(), limit: z.number() }).strict(),
  // Работа и шаг названы отдельно от `scope`: имя области — текст для чтения,
  // а разбирать чересполосный поток нужно по идентификаторам.
  z.object({ ...eventBase, kind: z.literal('budget.exceeded'), scope: z.string(), job: z.string().optional(), step: z.string().optional(), dimension: BudgetDimensionSchema.optional(), used: z.number(), limit: z.number() }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('budget.waiting'),
    scope: z.string(),
    job: z.string().optional(),
    step: z.string().optional(),
    dimension: z.literal('rate_limit'),
    // Отсутствует, когда ожидание вызвано отказом бэкенда, а не превышением
    // объявленного `rate_limit_pct`: измеренного порога тут нет.
    threshold: z.number().optional(),
    resets_at: z.number(),
    wait_ms: z.number(),
  }).strict(),
  z.object({ ...eventBase, kind: z.literal('budget.resumed'), job: z.string().optional(), step: z.string().optional(), actual_ms: z.number() }).strict(),
  // Неустранимый отказ бэкенда: виден без чтения stdout.log шага.
  z.object({
    ...eventBase,
    kind: z.literal('backend.refused'),
    job: z.string(),
    step: z.string(),
    attempt: z.number().int().positive(),
    class: z.enum(['rate_limit', 'unauthenticated']),
    status_code: z.number().optional(),
    message: z.string(),
    resets_at: z.number().optional(),
  }).strict(),
  // Первая завершившаяся попытка без цены при объявленном денежном потолке:
  // молча довести прогон до конца значило бы соврать, что потолок применялся.
  z.object({ ...eventBase, kind: z.literal('budget.cost_unreported'), job: z.string(), step: z.string(), attempt: z.number().int().positive() }).strict(),
  // Прогноз на старте, а не факт попытки: вызов, для которого цены не будет ни
  // от бэкенда, ни из каталога, и денежный потолок его не проверит. Прогон
  // из-за этого не останавливается.
  z.object({ ...eventBase, kind: z.literal('budget.cost_unpriced'), job: z.string(), step: z.string(), backend: z.string(), model: z.string().optional(), judge: z.literal(true).optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('backend.degraded'), backend: z.string(), capability: z.string(), detail: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('backend.unparsed'), job: z.string(), step: z.string(), line: z.string() }).strict(),
  // Отказ бэкенда в разрешении на вызов инструмента в жёстком режиме прав.
  // Сам по себе попытку не проваливает: агент вправе обойтись разрешённым.
  z.object({
    ...eventBase,
    kind: z.literal('permission.denied'),
    job: z.string(),
    step: z.string(),
    attempt: z.number().int().positive(),
    tool: z.string(),
    detail: z.string().optional(),
  }).strict(),
  // Объявленный сервер, о котором бэкенд сообщил, что тот не подключён.
  // Валит попытку (см. `MCP_SERVER_UNAVAILABLE_PREDICATE`), а не шаг: повтор
  // может застать сервер поднявшимся.
  z.object({
    ...eventBase,
    kind: z.literal('mcp_server.unavailable'),
    job: z.string(),
    step: z.string(),
    attempt: z.number().int().positive(),
    server: z.string(),
  }).strict(),
  // Неудача внутреннего учёта. Статусов не меняет: см. parts/pipeline/run/bookkeeping.ts.
  z.object({ ...eventBase, kind: z.literal('iteration.started'), job: z.string(), iteration: z.number().int().positive() }).strict(),
  z.object({ ...eventBase, kind: z.literal('iteration.finished'), job: z.string(), iteration: z.number().int().positive(), passed: z.boolean(), reason: z.string().optional() }).strict(),
  // Цикл по группе работ: проходы и вердикт. iteration — номер прохода с единицы.
  z.object({ ...eventBase, kind: z.literal('loop.started'), loop: z.string(), jobs: z.array(z.string()), max_iterations: z.number().int().positive() }).strict(),
  z.object({ ...eventBase, kind: z.literal('loop.pass.started'), loop: z.string(), iteration: z.number().int().positive() }).strict(),
  z.object({ ...eventBase, kind: z.literal('loop.pass.finished'), loop: z.string(), iteration: z.number().int().positive(), continue: z.boolean() }).strict(),
  z.object({ ...eventBase, kind: z.literal('loop.finished'), loop: z.string(), iterations: z.number().int().positive(), verdict: LoopVerdictSchema, status: StatusValueSchema, reason: z.string().optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('job.attempt.started'), job: z.string(), attempt: z.number().int().positive() }).strict(),
  z.object({ ...eventBase, kind: z.literal('job.attempt.finished'), job: z.string(), attempt: z.number().int().positive(), status: StatusValueSchema, reason: z.string().optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('step.reused'), job: z.string(), step: z.string(), source: z.string() }).strict(),
  // Шаг переисполнен продолжением своей сессии, оборванной отменой в исходном
  // прогоне: session — идентификатор диалога, source — прогон-источник.
  z.object({
    ...eventBase,
    kind: z.literal('session.continued'),
    job: z.string(),
    step: z.string(),
    session: z.string(),
    source: z.string(),
  }).strict(),
  z.object({ ...eventBase, kind: z.literal('tree.restored'), anchor: z.string(), path: z.string() }).strict(),
  // Пишется до первого шага наследующей работы: объясняет, откуда в её
  // каталоге чужие файлы и почему две работы делят один путь.
  z.object({
    ...eventBase,
    kind: z.literal('workspace.inherited'),
    job: z.string(),
    source: z.string(),
    via: z.enum(['continue', 'seed']),
  }).strict(),
  // Каталог дерева заведён для работы засевом из источника
  // (`named-workspace-trees`): пишется до её первого шага. Прежнее
  // `workspace.inherited` остаётся читаемым в журналах старых прогонов.
  z.object({
    ...eventBase,
    kind: z.literal('workspace.seeded'),
    job: z.string(),
    tree: z.string(),
    source: z.string(),
    by: z.enum(['copy', 'anchor']).optional(),
    reason: z.string().optional(),
  }).strict(),
  // Состояние каталога прогона, оставленное переиспользованными шагами:
  // перенесено из исходного прогона, потому что каталог нового пуст.
  z.object({ ...eventBase, kind: z.literal('run_dir.carried'), path: z.string(), source: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('bookkeeping.failed'), operation: z.string(), job: z.string().optional(), step: z.string().optional(), detail: z.string() }).strict(),
  // Выдержка о прошлом отказе так и не досталась никому: адресат назван
  // планом, но его агентский шаг не исполнялся — работа пропущена по `if`
  // или `on`. Молчать нельзя: возобновление выглядело бы как разбор отказа,
  // которого агент не видел.
  z.object({ ...eventBase, kind: z.literal('resume.note_undelivered'), job: z.string().optional(), detail: z.string() }).strict(),
  // Свободное сообщение исполнителя вида шага (`StepKindLog.note`,
  // design.md, решение 6) — событие рядом с прочими, а не строка в
  // `stdout.log`: вклад волен писать и то и другое.
  z.object({
    ...eventBase,
    kind: z.literal('step_kind.logged'),
    job: z.string(),
    step: z.string(),
    attempt: z.number().int().positive(),
    message: z.string(),
  }).strict(),
  // Пять событий ожидания решения (`user-decision-steps`, design.md решение
  // 5): объявление ожидания, применённое решение, истечение срока,
  // отвергнутая негодная запись и решение, перенесённое возобновлением из
  // прогона, чей процесс его не применил, — читатель журнала не обязан
  // выводить их из одной пары полей записи шага.
  z.object({
    ...eventBase,
    kind: z.literal('decision.awaiting'),
    wait_id: z.string(),
    job: z.string(),
    step: z.string(),
    outcomes: z.record(z.string(), AwaitingOutcomeSchema),
    prompt: z.string().optional(),
    deadline: z.string().optional(),
    on_expire: z.string().optional(),
  }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('decision.applied'),
    wait_id: z.string(),
    job: z.string(),
    step: z.string(),
    outcome: z.string(),
    effect: DecisionEffectSchema,
    by: z.enum(['user', 'deadline']),
    reason: z.string().optional(),
    restart_from: z.string().optional(),
  }).strict(),
  // Срок истёк — сообщается отдельно от применения (`decision.applied` с
  // `by: 'deadline'` следует сразу за ним): читатель, разбирающий, почему
  // прогон продолжился без человека, не обязан выводить это из поля `by`.
  z.object({
    ...eventBase,
    kind: z.literal('decision.expired'),
    wait_id: z.string(),
    job: z.string(),
    step: z.string(),
    outcome: z.string(),
  }).strict(),
  // Запись в decisions/, не прошедшая проверку по объявленному ожиданию:
  // ожидание продолжается, а не применяет её молча.
  z.object({
    ...eventBase,
    kind: z.literal('decision.refused'),
    wait_id: z.string(),
    job: z.string(),
    step: z.string(),
    detail: z.string(),
  }).strict(),
  // Решение, записанное прогону, чей процесс его не применил: возобновление
  // переносит его в новый прогон и применяет первым же тактом ожидания того
  // же шага (дельта `run-resume`). Событие — и след переноса, и источник, из
  // которого перенос читается ещё раз, если и новый прогон не успеет его
  // применить.
  z.object({
    ...eventBase,
    kind: z.literal('decision.carried'),
    /** Ожидание исходного прогона, которому решение было адресовано. */
    wait_id: z.string(),
    job: z.string(),
    step: z.string(),
    /** Прогон, в котором решение записано. */
    source: z.string(),
    outcome: z.string(),
    reason: z.string().optional(),
    restart_from: z.string().optional(),
  }).strict(),
]);

export type Event = z.infer<typeof EventSchema>;
export type EventInput = Omit<Event, 'ts' | 'seq'> extends never ? never : DistributiveOmit<Event, 'ts' | 'seq'>;

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

export type RunManifest = z.infer<typeof RunManifestSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type BudgetState = z.infer<typeof BudgetStateSchema>;
export type BudgetExceededState = NonNullable<BudgetState['exceeded']>;
export type JobRecord = z.infer<typeof JobRecordSchema>;
export type LoopRecord = z.infer<typeof LoopRecordSchema>;
export type StepRecord = z.infer<typeof StepRecordSchema>;
export type AttemptRecord = z.infer<typeof AttemptRecordSchema>;
export type UsageReport = z.infer<typeof UsageReportSchema>;
export type UsageAttemptReport = z.infer<typeof UsageAttemptReportSchema>;
export type ContextReport = z.infer<typeof ContextReportSchema>;
export type ContextEntryReport = z.infer<typeof ContextEntryReportSchema>;
export type ExpectReport = z.infer<typeof ExpectReportSchema>;
export type PredicateResult = z.infer<typeof PredicateResultSchema>;
