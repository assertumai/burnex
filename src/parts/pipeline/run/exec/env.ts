import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import { isEngineVariable, withLegacyNames } from '../../../../kernel/env-names.js';
import { compileNameGlob } from '../../domain/lint.js';

/**
 * Сборка окружения шага.
 *
 * Окружение процесса наследуется целиком: агентский CLI и сборочные
 * инструменты нуждаются в JAVA_HOME, NVM_DIR, SSH_AUTH_SOCK, прокси и десятке
 * других переменных, и отсечение по списку ломает первый же реальный шаг.
 * Единственный фильтр — env_deny, и он применяется последним.
 */

export interface EnvLayers {
  /** Окружение процесса stepcast. */
  readonly base: Readonly<Record<string, string | undefined>>;
  readonly envFiles: readonly string[];
  readonly pipeline: Readonly<Record<string, string>>;
  readonly job: Readonly<Record<string, string>>;
  readonly step: Readonly<Record<string, string>>;
  /** Переменные бэкенда: их добавляет адаптер, запрету они тоже подчиняются. */
  readonly backend?: Readonly<Record<string, string>>;
  /** Переменные stepcast: добавляются последними и не переопределяются. */
  readonly injected: Readonly<Record<string, string>>;
  readonly deny: readonly string[];
  /**
   * Секреты, которые шаг назвал: имя переменной → значение. Накладываются
   * последними и мимо `deny` — объявление секрета явное намерение, а
   * встроенные шаблоны (`*_TOKEN`) вычеркнули бы именно то, ради чего его
   * писали (`secrets-named-providers`, design.md, решение 3).
   */
  readonly secrets?: Readonly<Record<string, string>>;
  /**
   * Переменные остальных объявленных секретов: имя переменной → имя секрета.
   * Вычёркиваются после `deny`, откуда бы ни пришли (процесс, `env_files`),
   * — так один механизм закрывает и агента, и соседний командный шаг.
   */
  readonly withheld?: Readonly<Record<string, string>>;
  /** Каталог, от которого разрешаются относительные пути env_files. */
  readonly cwd: string;
}

export interface DeniedVariable {
  readonly name: string;
  readonly pattern: string;
}

export interface WithheldVariable {
  readonly name: string;
  /** Имя секрета, чья это переменная. */
  readonly secret: string;
}

export interface BuiltEnv {
  readonly env: Record<string, string>;
  readonly denied: readonly DeniedVariable[];
  /** Вычеркнутые переменные необъявленных секретов — только те, что реально стояли в окружении. */
  readonly withheld: readonly WithheldVariable[];
}

export function buildStepEnv(layers: EnvLayers): BuiltEnv {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(layers.base)) {
    if (value !== undefined) env[name] = value;
  }

  for (const file of layers.envFiles) {
    const path = isAbsolute(file) ? file : resolvePath(layers.cwd, file);
    Object.assign(env, parseEnvFile(path));
  }

  Object.assign(env, layers.pipeline, layers.job, layers.backend ?? {}, layers.step);

  // Инжектируемые последними: шаг не должен подменять сведения о самом себе.
  Object.assign(env, layers.injected);

  const matchers = layers.deny.map((pattern) => ({ pattern, matcher: compileNameGlob(pattern) }));
  const denied: DeniedVariable[] = [];

  for (const name of Object.keys(env)) {
    // Собственные переменные движка (под обоими именами переходного периода)
    // под запрет не попадают: они описывают прогон, а не несут учётных данных.
    if (isEngineVariable(name)) continue;
    const hit = matchers.find(({ matcher }) => matcher.test(name));
    if (hit === undefined) continue;
    delete env[name];
    denied.push({ name, pattern: hit.pattern });
  }

  // Событие сообщает о том, что вычеркнуто, а не о том, что могло бы быть:
  // переменная, которой в собранном окружении не было, в перечень не входит.
  // Имя сравнивается тем же правилом, что и `env_deny`: на Windows регистр
  // не различается, и `Gh_Token` из окружения процесса — та же переменная.
  const withheldMatchers = Object.entries(layers.withheld ?? {}).map(([name, secret]) => ({
    secret,
    matcher: compileNameGlob(name),
  }));
  const withheld: WithheldVariable[] = [];
  for (const name of Object.keys(env)) {
    const hit = withheldMatchers.find(({ matcher }) => matcher.test(name));
    if (hit === undefined) continue;
    delete env[name];
    withheld.push({ name, secret: hit.secret });
  }

  Object.assign(env, layers.secrets ?? {});

  return { env, denied, withheld };
}

/** Минимальный разбор файла окружения: `KEY=value`, комментарии, кавычки. */
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};

  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const name = line.slice(0, separator).trim().replace(/^export\s+/, '');
    let value = line.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    out[name] = value;
  }

  return out;
}

export interface InjectedContext {
  readonly runId: string;
  readonly runDir: string;
  /**
   * Точка входа движка этого прогона: снимка, если прогон его снял, иначе
   * исполняющего процесса (`process.argv[1]`) — см. `run/engine.ts`.
   */
  readonly binPath: string;
  readonly jobId: string;
  readonly jobDir: string;
  /** Шаг и его каталог. Отсутствуют у проверки цикла: она не шаг. */
  readonly stepId?: string;
  readonly stepDir?: string;
  readonly attempt: number;
  /**
   * Номер попытки работы и её предел. Есть у каждой работы — `1` и `1` без
   * объявления `attempts`, — в отличие от `BURNEX_ITERATION`: скрипту,
   * решающему «последняя попытка — черновик не публиковать», не нужно
   * ветвиться на отсутствие переменной.
   */
  readonly jobAttempt: number;
  readonly jobAttemptMax: number;
  /**
   * Цикл по группе работ, в котором исполняется работа. Есть только у
   * участника: отсутствие переменных отвечает на вопрос «я в цикле?» так же,
   * как отсутствие `BURNEX_ITERATION` — на вопрос «я в until?».
   */
  readonly loop?: { readonly id: string; readonly iteration: number; readonly maxIterations: number };
  readonly workspace: string;
  readonly artifacts: string;
  /** Каталог черновиков работы — общий на все её шаги и итерации. */
  readonly scratch: string;
  readonly iteration?: number;
  readonly previousFailurePath?: string;
  /**
   * Пути файлов контракта шага `script` — переданы только вызывающим, у кого
   * они есть: `stepEnv` называет их лишь для шага этого вида, у `run` и
   * агентского шага контракт свой (design.md, решение 1).
   */
  readonly contractInputPath?: string;
  readonly contractOutputPath?: string;
  /**
   * Действующий код пропуска командного шага (`skip_exit_code`). Скрипт
   * выходит им, не повторяя число из документа, — правка документа тогда не
   * расходится со скриптом. Не объявлен — переменной нет вовсе.
   */
  readonly skipExitCode?: number;
  /**
   * Файл выходов работы (`BURNEX_JOB_OUTPUTS`). Передан вызывающим только
   * для шага `run`: `script` публикует через свой контракт, агент — через
   * `burnex data` (job-outputs-key-value, design.md, цели и не-цели).
   */
  readonly jobOutputsPath?: string;
  /**
   * Переменные `NEEDS_<РАБОТА>_<КЛЮЧ>` от прямых зависимостей. Лежат в слое
   * `injected`, поэтому не перекрываются `env:` и не вычёркиваются `env_deny`.
   */
  readonly needs?: Readonly<Record<string, string>>;
}

/**
 * Переменные движка для шага. Каждая `BURNEX_*` выставляется и под прежним
 * именем `STEPCAST_*` — один выпуск переходного периода (`kernel/env-names.ts`);
 * `NEEDS_*` двойников не получают.
 */
export function injectedVariables(context: InjectedContext): Record<string, string> {
  return withLegacyNames({
    BURNEX_RUN_ID: context.runId,
    BURNEX_RUN_DIR: context.runDir,
    BURNEX_BIN: context.binPath,
    BURNEX_JOB: context.jobId,
    BURNEX_JOB_DIR: context.jobDir,
    ...(context.stepId === undefined ? {} : { BURNEX_STEP: context.stepId }),
    ...(context.stepDir === undefined ? {} : { BURNEX_STEP_DIR: context.stepDir }),
    BURNEX_ATTEMPT: String(context.attempt),
    BURNEX_JOB_ATTEMPT: String(context.jobAttempt),
    BURNEX_JOB_ATTEMPT_MAX: String(context.jobAttemptMax),
    BURNEX_WORKSPACE: context.workspace,
    BURNEX_ARTIFACTS: context.artifacts,
    BURNEX_SCRATCH: context.scratch,
    ...(context.iteration === undefined ? {} : { BURNEX_ITERATION: String(context.iteration) }),
    ...(context.loop === undefined
      ? {}
      : {
          BURNEX_LOOP: context.loop.id,
          BURNEX_LOOP_ITERATION: String(context.loop.iteration),
          BURNEX_LOOP_ITERATION_MAX: String(context.loop.maxIterations),
        }),
    ...(context.previousFailurePath === undefined
      ? {}
      : { BURNEX_PREV_FAILURE: context.previousFailurePath }),
    ...(context.contractInputPath === undefined ? {} : { BURNEX_INPUT: context.contractInputPath }),
    ...(context.contractOutputPath === undefined ? {} : { BURNEX_OUTPUT: context.contractOutputPath }),
    ...(context.skipExitCode === undefined ? {} : { BURNEX_SKIP_EXIT_CODE: String(context.skipExitCode) }),
    ...(context.jobOutputsPath === undefined ? {} : { BURNEX_JOB_OUTPUTS: context.jobOutputsPath }),
    ...context.needs,
  });
}
