import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { stringify } from 'yaml';

import { formatDuration, formatTokens } from '../../../kernel/units.js';
import { DEFAULT_TREE, forStepHash, type Budget, type Job, type Loop, type Pipeline, type PipelinePublication, type ReviewParticipant, type Step, type Triggers, type Workspace } from './model.js';
import { normalizePackagePaths, portableForm, type PackagePathForm } from './packagePaths.js';

/**
 * Сериализация раскрытого пайплайна в `pipeline.lock.yml`.
 *
 * Файл существует, чтобы прогон был воспроизводим и объясним: в нём нет ни
 * ссылок `uses`, ни подстановок `${inputs.*}` и `${params.*}`, ни умолчаний,
 * оставленных «где-то в конфигурации». Всё, чем движок руководствовался при
 * сборке пайплайна, видно в одном месте.
 *
 * Отложенные подстановки — `${run.*}`, `${jobs.*}`, `${env.*}` — остаются в
 * локе текстом: их значения появляются только по ходу прогона, у работы, а не
 * у пайплайна. Фактические пути и значения, с которыми шаг пошёл в файловую
 * систему, лежат в `jobs/<job>/resolved.json`. То же состояние — до раскрытия
 * отложенных подстановок — берётся ключом шага, и потому `jobLockHash`
 * считается от нераскрытого определения работы.
 */

function budgetToPlain(budget: Budget | undefined): Record<string, unknown> | undefined {
  if (budget === undefined) return undefined;
  return {
    ...(budget.tokens === undefined ? {} : { tokens: formatTokens(budget.tokens) }),
    ...(budget.wallclockMs === undefined ? {} : { wallclock: formatDuration(budget.wallclockMs) }),
    ...(budget.rateLimitPct === undefined ? {} : { rate_limit_pct: budget.rateLimitPct }),
    on_exceed: budget.onExceed,
  };
}

function pipelineWorkspaceToPlain(
  workspace: Workspace,
  publication: PipelinePublication | undefined,
): Workspace | Record<string, unknown> {
  if (publication === undefined) return workspace;
  return {
    mode: workspace.mode,
    ...(workspace.path === undefined ? {} : { path: workspace.path }),
    source: publication.source,
    preserve_local_changes: publication.preserveLocalChanges,
    live_files: publication.liveFiles.map((entry) => ({
      path: entry.path,
      writeback: entry.writeback,
      commit_on_success: entry.commitOnSuccess,
    })),
  };
}

function triggersToPlain(triggers: Triggers | undefined): Record<string, unknown> | undefined {
  if (triggers === undefined) return undefined;
  return {
    schedule: triggers.schedule.map((entry) => ({
      ...(entry.cron === undefined ? {} : { cron: entry.cron }),
      ...(entry.timezone === undefined ? {} : { timezone: entry.timezone }),
    })),
  };
}

function stepToPlain(step: Step): Record<string, unknown> {
  const common = {
    id: step.id,
    index: step.index,
    timeout: formatDuration(step.timeoutMs),
    ...(Object.keys(step.env).length === 0 ? {} : { env: step.env }),
    ...(step.context.length === 0 ? {} : { context: step.context }),
    ...(step.contextInherit ? {} : { context_inherit: false }),
    ...(step.contextExclude.length === 0 ? {} : { context_exclude: step.contextExclude }),
    ...(step.contextMaxTokens === undefined
      ? {}
      : { context_max_tokens: formatTokens(step.contextMaxTokens) }),
    ...(step.budget === undefined ? {} : { budget: budgetToPlain(step.budget) }),
    ...(step.expect.length === 0 ? {} : { expect: step.expect }),
    attempts: {
      max: step.attempts.max,
      ...(step.attempts.escalation.length === 0 ? {} : { escalation: step.attempts.escalation }),
    },
    // Имена, не значения: замок читают глазами и сверяют при возобновлении.
    ...(step.secrets === undefined ? {} : { secrets: step.secrets }),
  };

  if (step.kind === 'run') {
    return {
      ...common,
      run: step.command,
      ...(step.onFail === undefined ? {} : { on_fail: step.onFail }),
    };
  }

  if (step.kind === 'script') {
    return {
      ...common,
      script: step.path,
      ...(step.args.length === 0 ? {} : { args: step.args }),
      ...(step.runner === undefined ? {} : { runner: step.runner }),
      ...(step.onFail === undefined ? {} : { on_fail: step.onFail }),
      // Объявленное значение — с нераскрытыми отложенными подстановками — а не
      // то, с чем скрипт исполнился (design.md, решение 4): ключ шага держится
      // на этой записи, а фактическое значение уже видно в `resolved.json`.
      ...(step.input === undefined ? {} : { input: step.input }),
      ...(step.outputSchemaPath === undefined ? {} : { output_schema: step.outputSchemaPath }),
      // Разрешённое — путь, слой, раннер, argv, отпечаток — а не содержимое
      // файла: замок читают глазами, отпечатка достаточно, чтобы отличить
      // один файл от другого (design.md, решение 8).
      ...(step.resolved === undefined
        ? {}
        : {
            resolved: {
              absolute_path: step.resolved.absolutePath,
              layer: step.resolved.layer,
              ...(step.resolved.package === undefined ? {} : { package: step.resolved.package }),
              runner: step.resolved.runner,
              argv: step.resolved.argv,
              fingerprint: step.resolved.fingerprint,
            },
          }),
      ...(step.unresolved === undefined ? {} : { unresolved: step.unresolved }),
      // Происхождение — имя, слой, путь и отпечаток манифеста, сведённые
      // параметры — рядом с разрешённым, а не вместо него (design.md
      // изменения reusable-steps, решение 11). Схема параметров манифеста
      // (`uses.paramsSchema`) сюда не идёт: отпечатка манифеста достаточно,
      // чтобы отличить одну версию шага от другой, а содержимому манифеста в
      // замке не место.
      ...(step.uses === undefined
        ? {}
        : {
            uses: {
              name: step.uses.name,
              ...(step.uses.layer === undefined ? {} : { layer: step.uses.layer }),
              ...(step.uses.package === undefined ? {} : { package: step.uses.package }),
              ...(step.uses.manifestPath === undefined ? {} : { manifest_path: step.uses.manifestPath }),
              ...(step.uses.manifestFingerprint === undefined
                ? {}
                : { manifest_fingerprint: step.uses.manifestFingerprint }),
              ...(step.uses.params === undefined ? {} : { params: step.uses.params }),
            },
          }),
    };
  }

  if (step.kind === 'review') {
    // Стратегия — имя, слой, путь и отпечаток — и разрешённые участники:
    // замок называет, кто ревьюил, не заставляя читать файл стратегии
    // (`review-strategies`, решение 7). Происхождение выбора каждого
    // участника — в `burnex config --pipeline`, как у агентского шага.
    const participant = (entry: ReviewParticipant): Record<string, unknown> => ({
      id: entry.id,
      agent: entry.agent,
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ...(entry.effort === undefined ? {} : { effort: entry.effort }),
      ...(entry.profile === undefined ? {} : { profile: entry.profile }),
      ...(entry.localProfile === true ? { local_profile: true } : {}),
      ...(entry.profileContext === undefined ? {} : { profile_context: entry.profileContext }),
      ...(entry.profileContextFingerprint === undefined
        ? {}
        : { profile_context_fingerprint: entry.profileContextFingerprint }),
      ...(entry.focus === undefined ? {} : { focus: entry.focus }),
      ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }),
    });
    return {
      ...common,
      review: {
        ref: step.strategy.ref,
        ...(step.strategy.name === undefined ? {} : { name: step.strategy.name }),
        ...(step.strategy.layer === undefined ? {} : { layer: step.strategy.layer }),
        ...(step.strategy.path === undefined ? {} : { path: step.strategy.path }),
        ...(step.strategy.fingerprint === undefined ? {} : { fingerprint: step.strategy.fingerprint }),
        mode: step.mode,
        ...(step.rounds === undefined ? {} : { defend: { rounds: step.rounds } }),
      },
      ...(step.implementer === undefined ? {} : { implementer: `${step.implementer.job}.${step.implementer.step}` }),
      prompt: step.prompt,
      ...(step.promptSource === undefined ? {} : { prompt_source: step.promptSource }),
      output_schema: step.outputSchemaPath,
      ...(step.permissions === undefined ? {} : { permissions: step.permissions }),
      reviewers: step.reviewers.map(participant),
      ...(step.aggregator === undefined ? {} : { aggregator: participant(step.aggregator) }),
      ...(step.defender === undefined ? {} : { defender: participant(step.defender) }),
      ...(step.unresolved === undefined ? {} : { unresolved: step.unresolved }),
    };
  }

  if (step.kind === 'plugin') {
    // Один ключ — имя вида, — все поля под ним, в объявленном виде: с
    // нераскрытыми отложенными подстановками, тем же приёмом, что и `input`
    // шага `script` выше (design.md, решение 3, решение 5).
    return {
      ...common,
      [step.name]: step.fields,
    };
  }

  return {
    ...common,
    agent: step.agent,
    ...(step.model === undefined ? {} : { model: step.model }),
    ...(step.effort === undefined ? {} : { effort: step.effort }),
    session: step.session,
    // Промпт кладётся целиком: без него по локу нельзя понять, что уйдёт агенту.
    prompt: step.prompt,
    ...(step.promptSource === undefined ? {} : { prompt_source: step.promptSource }),
    ...(step.outputSchemaPath === undefined ? {} : { output_schema: step.outputSchemaPath }),
    ...(step.permissions === undefined ? {} : { permissions: step.permissions }),
    ...(step.mcp === undefined ? {} : { mcp: step.mcp }),
    // Имя профиля — справочное: хеш работы его снимает (`jobLockHash`).
    ...(step.profile === undefined ? {} : { profile: step.profile }),
    ...(step.profileContext === undefined ? {} : { profile_context: step.profileContext }),
    ...(step.profileContextFingerprint === undefined
      ? {}
      : { profile_context_fingerprint: step.profileContextFingerprint }),
  };
}

export function jobToPlain(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    ...(job.description === undefined ? {} : { description: job.description }),
    source: job.source,
    needs: job.needs,
    on: job.on,
    ...(job.if === undefined ? {} : { if: job.if }),
    ...(job.lane === undefined ? {} : { lane: job.lane }),
    // Подпись кладётся нераскрытой — как и прочие отложенные подстановки:
    // раскрывает её витрина, в момент отрисовки, против данных работы.
    ...(job.display === undefined ? {} : { display: job.display }),
    session: job.session,
    ...(job.sessionGroup === undefined ? {} : { session_group: job.sessionGroup }),
    workspace: workspaceToPlain(job.workspace),
    ...(Object.keys(job.env).length === 0 ? {} : { env: job.env }),
    ...(job.context.length === 0 ? {} : { context: job.context }),
    context_upstream: job.contextUpstream,
    ...(job.output === undefined ? {} : { output: job.output }),
    ...(job.data.length === 0 ? {} : { data: job.data }),
    ...(job.outputs.length === 0 ? {} : { outputs: job.outputs }),
    ...(job.budget === undefined ? {} : { budget: budgetToPlain(job.budget) }),
    // Только при повторе: замок работы без ключа не меняется ни на байт.
    ...(job.attempts.max > 1 ? { attempts: { max: job.attempts.max } } : {}),
    ...(job.permissions === undefined ? {} : { permissions: job.permissions }),
    ...(job.mcp === undefined ? {} : { mcp: job.mcp }),
    steps: job.steps.map(stepToPlain),
  };
}

export function pipelineToPlain(pipeline: Pipeline): Record<string, unknown> {
  return {
    version: 1,
    kind: 'pipeline.lock',
    name: pipeline.name,
    file: pipeline.file,
    inputs: pipeline.inputs,
    workspace: pipelineWorkspaceToPlain(pipeline.workspace, pipeline.publication),
    ...(Object.keys(pipeline.env).length === 0 ? {} : { env: pipeline.env }),
    ...(pipeline.envFiles.length === 0 ? {} : { env_files: pipeline.envFiles }),
    env_deny: pipeline.envDeny,
    // Объявление без значения: провайдер, параметры и переменная. Значение
    // живёт только в памяти прогона (`secrets-named-providers`, решение 4).
    ...(pipeline.secrets.length === 0
      ? {}
      : {
          secrets: Object.fromEntries(
            pipeline.secrets.map((secret) => [
              secret.name,
              { provider: secret.provider, env: secret.env, ...secret.params },
            ]),
          ),
        }),
    ...(pipeline.context.length === 0 ? {} : { context: pipeline.context }),
    context_upstream: pipeline.contextUpstream,
    ...(pipeline.budget === undefined ? {} : { budget: budgetToPlain(pipeline.budget) }),
    ...(pipeline.mcp === undefined ? {} : { mcp: pipeline.mcp }),
    concurrency: pipeline.concurrency,
    fail_fast: pipeline.failFast,
    ...(pipeline.triggers === undefined ? {} : { triggers: triggersToPlain(pipeline.triggers) }),
    // Работа, чья рабочая директория совпадает с пайплайновой, ссылается на
    // тот же объект: печать замка даёт ей якорь YAML, как и до деревьев.
    jobs: pipeline.jobs.map((job) => sharingWorkspace(job, jobToPlain(job), pipeline.workspace)),
    ...(pipeline.loops.length === 0 ? {} : { loops: pipeline.loops.map(loopToPlain) }),
  };
}

function loopToPlain(loop: Loop): Record<string, unknown> {
  return {
    id: loop.id,
    jobs: loop.jobs,
    ...(loop.while === undefined ? {} : { while: loop.while }),
    max_iterations: loop.maxIterations,
    ...(loop.costMicroUsd === undefined ? {} : { cost_micro_usd: loop.costMicroUsd }),
    ...(loop.wallclockMs === undefined ? {} : { wallclock_ms: loop.wallclockMs }),
  };
}

export function serializeLock(pipeline: Pipeline): string {
  return stringify(pipelineToPlain(pipeline), { lineWidth: 0 });
}

/**
 * Определение работы для хеша: без справочных полей шагов (`forStepHash`).
 * Ключ уже держится на итоговых агенте, модели и контексте, а переименование
 * профиля без смены содержимого переиспользования не ломает
 * (`agent-profiles`, решение 6); перенос стратегии ревью между слоями —
 * тоже (`review-strategies`, решение 7).
 */
function jobForHash(job: Job): Record<string, unknown> {
  // Дерево — раскладка каталогов, а не определение работы: в ключ шага оно не
  // входит (`named-workspace-trees`), и разведение работ по деревьям не
  // лишает `resume` переиспользования.
  const { tree: _tree, ...workspace } = job.workspace;
  return { ...jobToPlain(job), workspace, steps: job.steps.map((step) => stepToPlain(forStepHash(step))) };
}

function sharingWorkspace(job: Job, plain: Record<string, unknown>, workspace: Workspace): Record<string, unknown> {
  // Только у работы дерева по умолчанию: её объект собран заново ради
  // `tree`, а до деревьев она делила объект пайплайна.
  if (job.workspace.tree !== DEFAULT_TREE) return plain;
  return JSON.stringify(plain.workspace) === JSON.stringify(workspace) ? { ...plain, workspace } : plain;
}

/**
 * Рабочая директория работы в замке. Неявное дерево по умолчанию (`main` без
 * объявленных `trees`) не пишется: замок пайплайна без объявлений деревьев
 * сохраняет прежний состав.
 */
function workspaceToPlain(workspace: Job['workspace']): Job['workspace'] {
  if (workspace.tree !== DEFAULT_TREE) return workspace;
  const { tree: _tree, ...rest } = workspace;
  return rest;
}

/**
 * Хеш определения одной работы: пайплайновые настройки, общие для всех
 * работ, плюс определение именно этой. Ключ шага держится на нём, а не на
 * хеше всего пайплайна, — иначе правка файла одной работы меняла бы ключи
 * шагов всех остальных, чьи определения не менялись.
 *
 * Пути ресурсов поставки (`burnex:<имя>` схем, обёртки, встроенных
 * скриптов и шагов) входят в хеш переносимой формой — именем и отпечатком
 * содержимого, а не абсолютным путём выпуска (`packagePaths.ts`): иначе новый
 * выпуск движка менял бы хеш каждой работы, ссылающейся на поставку.
 */
export function jobLockHash(pipeline: Pipeline, job: Job, form: PackagePathForm = portableForm()): string {
  // Циклы не входят в общее: объявление цикла меняет ключи только его
  // участников, а работы вне цикла сохраняют записи шагов.
  const { jobs: _jobs, loops: _loops, ...plain } = pipelineToPlain(pipeline);
  // Область и деревья пайплайна — та же раскладка, что и дерево работы.
  const { scope: _scope, trees: _trees, ...workspace } = plain.workspace as Record<string, unknown>;
  const shared = { ...plain, workspace };
  const loop = pipeline.loops.find((candidate) => candidate.jobs.includes(job.id));
  return createHash('sha256')
    .update(
      JSON.stringify(
        normalizePackagePaths(
          { shared, job: jobForHash(job), ...(loop === undefined ? {} : { loop: loopToPlain(loop) }) },
          form,
        ),
      ),
    )
    .digest('hex')
    .slice(0, 16);
}

/**
 * Хеш определения всего пайплайна. Ключ шага на нём больше не держится, но он
 * остаётся отпечатком прогона в манифесте и опорой совместимости с записями,
 * сделанными до перехода на хеш отдельной работы.
 */
export function pipelineLockHash(pipeline: Pipeline): string {
  return createHash('sha256').update(serializeLock(pipeline)).digest('hex').slice(0, 16);
}

export function writeLock(pipeline: Pipeline, path: string): void {
  writeFileSync(path, serializeLock(pipeline), { mode: 0o600 });
}
