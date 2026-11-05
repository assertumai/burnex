import { resolveConfig, type Config } from '../config/resolve.js';
import type { Registry } from '../../../kernel/registry.js';
import { ExitCode, isStepcastError, StepcastError, type ExitCodeValue } from '../../../kernel/errors.js';
import { defaultPipelineName } from '../../../kernel/dirs.js';
import { findProjectRoot, projectKey, runPaths, shortRunId } from '../run/journal/paths.js';
import { readStatus } from '../run/journal/reader.js';
import type { Event, RunManifest } from '../run/journal/schema.js';
import { hasErrors, lintPipeline } from '../domain/lint.js';
import { expandPipeline } from '../document/expand.js';
import { resolvePipelineTarget } from '../domain/package-schema.js';
import type { PipelineCommandEnv } from '../contract.js';
import { runPipeline } from '../run/runner.js';
import { validateEnvOverrides } from '../run/envOverrides.js';
import { assertShadowDeclarations } from '../run/shadow.js';
import { resolveConfigWithAgent } from '../config/agentOverride.js';
import { checkScheduleEntry } from '../domain/trigger/entry.js';
import type { ExpandedPipeline } from '../document/model.js';
import type { UsageSnapshot } from '../run/budget/accumulator.js';
import { renderProgressLine } from './progress.js';
import { commandRow } from '../../../kernel/cli/commandRow.js';
import { PIPELINE_SERVICES } from '../services.js';
import { formatDiagnostic } from './lint.js';
import { continueRestartChain } from './resume.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';

/**
 * Конфигурация приходит из окружения команды, когда точка входа уже разрешила
 * её вместе с плагинами: повторный `resolveConfig({ cwd })` терял бы слой
 * умолчаний плагинных бэкендов, и `backends.<имя>` плагина не существовало бы
 * для команды, хотя `burnex config` его показывает. Без `config` (прямой
 * вызов из тестов) команда разрешает конфигурацию сама, как прежде.
 */
export async function runRunCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  registry?: Registry,
  resolvedConfig?: Config,
): Promise<ExitCodeValue> {
  const target = args.positional[0] ?? defaultPipelineName(cwd);
  // `burnex:<имя>` называет пайплайн поставки, а не файл каталога запуска
  // (`pipeline-definition`, «Ссылка на поставку называет и пайплайн, а не
  // только схему»), `<пакет>:<имя>` — пайплайн пакета: путь разрешается не от
  // `cwd`, и слои `script`/`step` пайплайна ищутся от `cwd`, а не от каталога,
  // где файл лежит (`projectRoot` ниже). Конфигурация нужна раньше цели: пакеты
  // home лежат рядом с глобальным конфигом.
  const baseConfig = resolvedConfig ?? resolveConfig({ cwd }).config;
  // Повторное разрешение — только при флаге: без него действует конфигурация
  // точки входа. Отказ (неизвестный агент) случается до раскрытия пайплайна и,
  // как отказ `--env`, до каталога прогона — в том числе при `--dry-run`.
  const agentOverride = typeof args.flags.agent === 'string' ? args.flags.agent : undefined;
  let config = baseConfig;
  if (agentOverride !== undefined) {
    try {
      config = resolveConfigWithAgent({ cwd, agent: agentOverride, ...(registry === undefined ? {} : { registry }) });
    } catch (error) {
      if (!isStepcastError(error)) throw error;
      for (const line of formatDiagnostic({
        severity: 'error',
        message: error.message,
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      })) {
        write(line);
      }
      return error.exitCode;
    }
  }
  const { pipelinePath, outsideProject, address } = resolvePipelineTarget(cwd, target, {
    globalConfigDir: config.globalConfigDir,
  });
  const inputs = (args.flags.input as Record<string, string> | undefined) ?? {};
  const envOverrides = (args.flags.env as Record<string, string> | undefined) ?? {};

  const expanded = expandPipeline({
    pipelinePath,
    config,
    inputs,
    ...(registry === undefined ? {} : { registry }),
    ...(outsideProject ? { projectRoot: cwd } : {}),
  });

  // До записи прогона: отказ не должен оставлять после себя каталог журнала.
  const shadow = args.flags.shadow === true;
  let trigger: RunManifest['trigger'];
  try {
    validateEnvOverrides(envOverrides, expanded.pipeline.env);
    // И при `--dry-run`: проверка объявлений — часть вопроса «пойдёт ли такой
    // прогон», на который сухой запуск отвечает.
    if (shadow) assertShadowDeclarations(expanded.pipeline);
    trigger = resolveScheduledTrigger(args, expanded.pipeline);
  } catch (error) {
    if (!isStepcastError(error)) throw error;
    for (const line of formatDiagnostic({
      severity: 'error',
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    })) {
      write(line);
    }
    return error.exitCode;
  }

  // Проверка перед запуском бесплатна по сравнению с прогоном, поэтому она
  // безусловна: ловить структурную ошибку после первого агентского шага
  // означает платить за неё токенами.
  const diagnostics = lintPipeline(expanded, { config, cwd, ...(registry === undefined ? {} : { registry }) });
  for (const diagnostic of diagnostics) {
    for (const line of formatDiagnostic(diagnostic)) write(line);
  }
  if (hasErrors(diagnostics)) return ExitCode.configError;

  if (args.flags['dry-run'] === true) {
    write(`ok: ${target} — проверка пройдена, прогон не запускался`);
    return ExitCode.ok;
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const projectRoot = findProjectRoot(cwd);
  const onEvent = args.flags.quiet === true ? undefined : buildProgressObserver(config, projectRoot, write);

  try {
    const result = await runPipeline({
      expanded,
      config,
      projectRoot,
      cwd,
      ...(address === undefined ? {} : { pipelineAddress: address }),
      ...(registry === undefined ? {} : { registry }),
      signal: controller.signal,
      ...(Object.keys(envOverrides).length === 0 ? {} : { envOverrides }),
      ...(shadow ? { mode: 'shadow' as const } : {}),
      ...(agentOverride === undefined ? {} : { agentOverride }),
      ...(trigger === undefined ? {} : { trigger }),
      ...(onEvent === undefined ? {} : { onEvent }),
    });

    const runId = shortRunId(result.journal.paths.runId);
    write(`прогон ${runId}: ${result.status}`);
    write(`журнал: ${result.journal.paths.dir}`);

    if (result.costLimitUnapplied) {
      write(
        'предупреждение: денежный потолок объявлен, но ни одна попытка не сообщила цены — потолок не применялся',
      );
    }

    // В изолированном режиме результат остался в стороне. Молча закончить —
    // значит оставить пользователя гадать, где его работа.
    const isolated = readStatus(result.journal.paths).jobs.filter(
      (job) => job.workspace !== undefined && job.workspace.mode !== 'cwd',
    );
    if (isolated.length > 0) {
      write('рабочие деревья:');
      for (const job of isolated) {
        write(`  ${job.id} (${job.workspace?.mode}): ${job.workspace?.path}`);
      }
      write(`наложить результат на текущее дерево: burnex apply ${runId}`);
    }

    if (result.restart !== undefined) {
      // Сигнал отмены идёт в цепочку: обработчики SIGINT/SIGTERM стоят до
      // конца команды, и звено цепочки обязано слушать тот же контроллер —
      // иначе Ctrl-C на ожидающем звене не отменял бы ничего.
      return continueRestartChain(
        result.restart.from,
        result.journal.paths,
        config,
        cwd,
        write,
        registry,
        controller.signal,
      );
    }
    return result.exitCode;
  } catch (error) {
    if (!isStepcastError(error)) throw error;
    for (const line of formatDiagnostic({
      severity: 'error',
      message: error.message,
      ...(error.file === undefined ? {} : { file: error.file }),
      ...(error.at === undefined ? {} : { at: error.at }),
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    })) {
      write(line);
    }
    return error.exitCode;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

/**
 * Наблюдатель ленты хода прогона: по `run.started` первыми строками печатает
 * идентификатор прогона и путь к каталогу журнала — до того, как исполнится
 * хоть одна работа, — затем по одной строке на печатаемое событие.
 *
 * Время строки считается от `run.started` по меткам времени самих событий, а
 * не через `usage.elapsedMs()` снимка: тот вычитает сон и после
 * `budget.waiting` пошёл бы назад.
 */
function buildProgressObserver(
  config: Config,
  projectRoot: string,
  write: (line: string) => void,
): (event: Event, usage: UsageSnapshot) => void {
  let startedAtMs: number | undefined;
  const loopLimits = new Map<string, number>();
  return (event, usage) => {
    if (event.kind === 'loop.started') loopLimits.set(event.loop, event.max_iterations);
    if (event.kind === 'run.started') {
      startedAtMs = Date.parse(event.ts);
      const paths = runPaths(config.runs.root, projectKey(projectRoot), event.run_id);
      write(`прогон ${shortRunId(event.run_id)}`);
      write(`журнал: ${paths.dir}`);
    }
    const elapsedMs = startedAtMs === undefined ? 0 : Date.parse(event.ts) - startedAtMs;
    const rendered = renderProgressLine(event, usage, elapsedMs, loopLimits);
    if (rendered !== undefined) write(rendered);
  };
}

/** ISO 8601 с явным поясом (`Z` или `±hh:mm`): момент без пояса значил бы пояс машины запускающего. */
const ISO_MOMENT_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Момент, который есть в календаре. `Date.parse` в V8 принимает день до 31 при
 * любом месяце и молча переносит `2026-02-30` на 2 марта, поэтому поля
 * сверяются явно: в манифест не должен попасть момент, которого не было.
 */
function isCalendarMoment(text: string): boolean {
  const match = ISO_MOMENT_WITH_ZONE.exec(text);
  if (match === null) return false;
  const [, year, month, day, hour, minute, second = 0, offsetHour = 0, offsetMinute = 0] = match.map((group) =>
    group === undefined ? undefined : Number(group),
  );
  if (month! < 1 || month! > 12) return false;
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  if (day! < 1 || day! > daysInMonth) return false;
  if (hour! > 23 || minute! > 59 || second > 59) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;
  return !Number.isNaN(Date.parse(text));
}

/**
 * Флаги `--scheduled`, `--schedule-entry`, `--catchup` → происхождение прогона
 * для манифеста. Всё проверяется до создания каталога прогона. Что момент —
 * действительно момент выражения, не проверяется: это знание запускающего.
 */
function resolveScheduledTrigger(args: ParsedArgs, pipeline: ExpandedPipeline['pipeline']): RunManifest['trigger'] {
  const moment = args.flags.scheduled;
  const entryFlag = args.flags['schedule-entry'];
  const catchup = args.flags.catchup === true;

  if (moment === undefined && entryFlag === undefined) {
    if (catchup) throw new StepcastError('Флаг --catchup допустим только вместе с --scheduled и --schedule-entry');
    return undefined;
  }
  if (moment === undefined) throw new StepcastError('Флаг --schedule-entry требует пары --scheduled <момент>');
  if (entryFlag === undefined) throw new StepcastError('Флаг --scheduled требует пары --schedule-entry <номер>');

  const momentText = String(moment);
  if (!isCalendarMoment(momentText)) {
    throw new StepcastError(
      `Флаг --scheduled требует момент ISO 8601 с поясом (например 2026-11-01T03:00:00Z), получено ${momentText}`,
    );
  }

  const entryText = String(entryFlag);
  const entry = /^\d+$/.test(entryText) ? Number(entryText) : -1;
  const schedule = pipeline.triggers?.schedule ?? [];
  if (entry < 0 || entry >= schedule.length) {
    throw new StepcastError(
      `Запись расписания ${entryText} не существует: в triggers.schedule пайплайна записей ${schedule.length}`,
    );
  }

  const declared = schedule[entry]!;
  const checked = checkScheduleEntry(declared, entry);
  if (!checked.ok) throw new StepcastError(checked.reason);

  return {
    kind: 'schedule',
    entry,
    cron: declared.cron!,
    ...(declared.timezone === undefined ? {} : { timezone: declared.timezone }),
    moment: momentText,
    catchup,
  };
}

export const row = commandRow<PipelineCommandEnv>(
  {
    name: 'run',
    spec: {
      description: 'выполнить пайплайн',
      positional: ['pipeline'],
      flags: {
        input: { kind: 'keyValue', description: 'значение входа пайплайна: --input имя=значение' },
        env: {
          kind: 'keyValue',
          description: 'переопределить объявленную переменную env пайплайна на этот прогон: --env ИМЯ=значение',
        },
        'dry-run': { kind: 'boolean', description: 'только проверить, не запуская работы' },
        shadow: {
          kind: 'boolean',
          description:
            'исполнить локальное, а действия шагов с external: true записать, не совершая (external обязателен у каждого шага)',
        },
        agent: {
          kind: 'string',
          description:
            'бэкенд агента на этот прогон — слой флага над defaults.agent; агент шага или работы документа, pipeline_agents и step_agents сильнее флага, агент корня документа — только при agent_policy: force',
        },
        scheduled: {
          kind: 'string',
          description:
            'пометить прогон как запущенный по расписанию в этот момент ISO 8601 с поясом (только с --schedule-entry)',
        },
        'schedule-entry': {
          kind: 'string',
          description: 'номер записи triggers.schedule, по которой запущен прогон (только с --scheduled)',
        },
        catchup: { kind: 'boolean', description: 'прогон — догон пропущенного момента (только с --scheduled)' },
        quiet: { kind: 'boolean', description: 'не печатать ход прогона' },
      },
    },
    run: (args, io, env) => runRunCommand(args, io.out, env.cwd, env.registry, env.config),
  },
  { inject: PIPELINE_SERVICES },
);
