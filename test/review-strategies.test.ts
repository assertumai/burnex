import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { BurnexError } from '../src/kernel/errors.js';
import { registryFromKernel, type Registry } from '../src/kernel/registry.js';
import { createKernelShell } from '../src/parts/builtin.js';
import { BUILTIN_ROWS } from '../src/parts/rows.js';
import { createFakeBackend, initLine, resultLine, type FakeBackend } from '../src/parts/pipeline/backend/fake.js';
import { renderAgentsReport } from '../src/parts/pipeline/commands/configAgents.js';
import { resolveConfig, type Config } from '../src/parts/pipeline/config/resolve.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { jobLockHash, serializeLock } from '../src/parts/pipeline/document/lock.js';
import type { ReviewStep } from '../src/parts/pipeline/document/model.js';
import { parseReviewStrategyFile } from '../src/parts/pipeline/document/reviewStrategy.js';
import { lintPipeline } from '../src/parts/pipeline/domain/lint.js';
import { findStepDir, readEvents, readStatus, readUsage } from '../src/parts/pipeline/run/journal/reader.js';
import { runPipeline, type RunResult } from '../src/parts/pipeline/run/runner.js';
import { computeStepKey } from '../src/parts/pipeline/run/stepKey.js';
import { gitCommit, gitInit, makeProject, testBaseEnv, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * `review-strategies`: документ стратегии ревью, шаг `review:` и режим
 * `independent` — ревьюеры параллельно, затем агрегатор.
 */

interface Box {
  readonly home: string;
  readonly cwd: string;
  readonly globalPath: string;
  readonly projectPath: string;
}

const BACKENDS = `backends:
  codex:
    model_tiers: { max: gpt-max, balance: gpt-mid }
  claude:
    model_tiers: { deep: opus, max: opus-max, balance: sonnet }
`;

function box(files: Readonly<Record<string, string>> = {}, global = '', project?: string): Box {
  const root = tempDir('review-');
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  mkdirSync(join(home, '.burnex'), { recursive: true });
  mkdirSync(join(cwd, '.burnex'), { recursive: true });
  const globalPath = join(home, '.burnex', 'config.yml');
  const projectPath = join(cwd, '.burnex', 'config.yml');
  writeFileSync(globalPath, `${BACKENDS}${global}`);
  if (project !== undefined) writeFileSync(projectPath, project);
  for (const [name, content] of Object.entries(files)) {
    const path = name.startsWith('~/') ? join(home, name.slice(2)) : join(cwd, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return { home, cwd, globalPath, projectPath };
}

function configOf(b: Box): Config {
  return resolveConfig({ cwd: b.cwd, home: b.home, globalPath: b.globalPath, projectPath: b.projectPath }).config;
}

function expandIn(b: Box, config: Config = configOf(b), registry?: Registry) {
  return expandPipeline({
    pipelinePath: join(b.cwd, 'burnex.yml'),
    config,
    scriptRoots: { project: b.cwd, home: b.home, builtin: join(b.cwd, 'нет-встроенного') },
    ...(registry === undefined ? {} : { registry }),
  });
}

function reviewOf(expanded: ReturnType<typeof expandIn>, id = 'build/review-diff'): ReviewStep {
  const [jobId, stepId] = id.split('/');
  const step = expanded.pipeline.jobs.find((job) => job.id === jobId)?.steps.find((candidate) => candidate.id === stepId);
  assert.equal(step?.kind, 'review');
  return step as ReviewStep;
}

function keyOf(expanded: ReturnType<typeof expandIn>): string {
  const job = expanded.pipeline.jobs[0]!;
  return computeStepKey({
    lockHash: jobLockHash(expanded.pipeline, job),
    jobId: job.id,
    step: reviewOf(expanded),
    inputsFingerprint: undefined,
    backendCommand: undefined,
    upstream: [],
  });
}

function rejection(fn: () => unknown): BurnexError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BurnexError, String(error));
    return error;
  }
  assert.fail('ожидался отказ');
}

const SCHEMA = '{"type":"object","properties":{"verdict":{"type":"string"}},"required":["verdict"]}\n';

function pipeline(review: string, extra = ''): string {
  return `version: 1
kind: pipeline
name: p
jobs:
  build:
    output: { from: review-diff }
    steps:
      - id: review-diff
        review: ${review}
        prompt: проверь дифф
        output_schema: verdict.json
${extra}`;
}

const PANEL = `version: 1
kind: review-strategy
name: panel
reviewers:
  - id: security
    agent: codex
    focus: Границы доверия
  - id: tests
    model_tier: balance
aggregator:
  model_tier: max
`;

describe('review-strategies: документ стратегии', () => {
  it('стратегия разбирается: два ревьюера и агрегатор с model_tier: max', () => {
    const b = box({ 'burnex.yml': pipeline('panel'), 'verdict.json': SCHEMA, '.burnex/review-strategies/panel.yml': PANEL });
    const step = reviewOf(expandIn(b));
    assert.equal(step.mode, 'independent');
    assert.deepEqual(step.reviewers.map((reviewer) => [reviewer.id, reviewer.agent, reviewer.model ?? null, reviewer.focus ?? null]), [
      ['security', 'codex', null, 'Границы доверия'],
      // Без `agent` — профиль default со своим уровнем.
      ['tests', 'claude', 'sonnet', null],
    ]);
    assert.equal(step.aggregator?.agent, 'claude');
    assert.equal(step.aggregator?.model, 'opus-max');
    assert.equal(step.strategy.layer, 'project');
    assert.match(step.strategy.fingerprint ?? '', /^sha256:/);
  });

  it('повторный id отклоняется с файлом и путём второго ревьюера', () => {
    const b = box({ 's.yml': PANEL.replace('id: tests', 'id: security') });
    const error = rejection(() => parseReviewStrategyFile(join(b.cwd, 's.yml'), ['claude', 'codex']));
    assert.equal(error.file, join(b.cwd, 's.yml'));
    assert.equal(error.at, 'reviewers.1.id');
    assert.match(error.message, /повторный id ревьюера security/);
  });

  it('model рядом с model_tier и незнакомое поле отклоняются с путём ключа', () => {
    const b = box({
      'both.yml': PANEL.replace('    agent: codex\n', '    model: x\n    model_tier: max\n'),
      'extra.yml': PANEL.replace('    agent: codex\n', '    agent: codex\n    temperature: 1\n'),
    });
    const both = rejection(() => parseReviewStrategyFile(join(b.cwd, 'both.yml'), []));
    assert.equal(both.at, 'reviewers.0');
    assert.match(both.message, /и model, и model_tier/);
    const extra = rejection(() => parseReviewStrategyFile(join(b.cwd, 'extra.yml'), []));
    assert.match(`${extra.at ?? ''} ${extra.message}`, /temperature/);
  });

  it('режим вне independent отклоняется с перечнем известных режимов', () => {
    const b = box({ 's.yml': `${PANEL}mode: discussion\n` });
    const error = rejection(() => parseReviewStrategyFile(join(b.cwd, 's.yml'), []));
    assert.equal(error.at, 'mode');
    assert.match(error.message, /известны independent/);
  });

  it('без aggregator агрегатор исполняется профилем default', () => {
    const b = box(
      { 'burnex.yml': pipeline('panel'), 'verdict.json': SCHEMA, '.burnex/review-strategies/panel.yml': PANEL.replace('aggregator:\n  model_tier: max\n', '') },
      'defaults:\n  agent: codex\n',
    );
    const expanded = expandIn(b);
    const aggregator = reviewOf(expanded).aggregator;
    assert.equal(aggregator?.agent, 'codex');
    assert.equal(aggregator?.profile, 'default');
    assert.equal(expanded.agentOrigins.get('build/review-diff/aggregator')?.profile, 'default');
  });
});

describe('review-strategies: локальные профили', () => {
  const LOCAL = `${PANEL.replace('    agent: codex\n', '    agent: arch\n')}profiles:
  arch:
    backend: codex
    model_tier: max
    context: [{ path: ./rules.md }]
`;

  it('ревьюер исполняется профилем стратегии; его контекст разрешён от файла стратегии', () => {
    const b = box({
      'burnex.yml': pipeline('panel'),
      'verdict.json': SCHEMA,
      '.burnex/review-strategies/panel.yml': LOCAL,
      '.burnex/review-strategies/rules.md': 'правила архитектуры',
    });
    const security = reviewOf(expandIn(b)).reviewers[0]!;
    assert.equal(security.agent, 'codex');
    assert.equal(security.model, 'gpt-max');
    assert.equal(security.profile, 'arch');
    assert.equal(security.localProfile, true);
    assert.deepEqual(security.profileContext?.map((entry) => ('path' in entry ? entry.path : '')), [
      join(b.cwd, '.burnex', 'review-strategies', 'rules.md'),
    ]);
  });

  it('локальный профиль перекрывает профиль настроек, а линт называет оба файла', () => {
    const b = box(
      { 'burnex.yml': pipeline('panel'), 'verdict.json': SCHEMA, '.burnex/review-strategies/panel.yml': LOCAL },
      'agents:\n  arch: { backend: claude }\n',
    );
    const config = configOf(b);
    const expanded = expandIn(b, config);
    assert.equal(reviewOf(expanded).reviewers[0]?.agent, 'codex');
    const warning = lintPipeline(expanded, { config, cwd: b.cwd }).find((item) => /перекрывает профиль arch/.test(item.message));
    assert.ok(warning !== undefined);
    assert.equal(warning.severity, 'warning');
    assert.equal(warning.file, join(b.cwd, '.burnex', 'review-strategies', 'panel.yml'));
    assert.match(warning.hint ?? '', new RegExp(b.globalPath.replaceAll('/', '\\/')));
  });

  it('локальный профиль не виден агентскому шагу того же пайплайна', () => {
    const b = box({
      'burnex.yml': `${pipeline('panel')}      - id: check\n        agent: arch\n        prompt: проверь\n`,
      'verdict.json': SCHEMA,
      '.burnex/review-strategies/panel.yml': LOCAL,
    });
    const config = configOf(b);
    const expanded = expandIn(b, config);
    const step = expanded.pipeline.jobs[0]!.steps[1]!;
    assert.equal(step.kind, 'agent');
    assert.equal(step.kind === 'agent' ? step.profile : 'x', undefined);
    const error = lintPipeline(expanded, { config, cwd: b.cwd }).find((item) => item.at?.endsWith('steps.1.agent'));
    assert.match(error?.message ?? '', /Неизвестный бэкенд arch/);
  });

  it('локальный профиль default и профиль с именем бэкенда отклоняются теми же отказами', () => {
    const b = box({
      'default.yml': `${PANEL}profiles:\n  default: { backend: codex }\n`,
      'backend.yml': `${PANEL}profiles:\n  claude: { backend: codex }\n`,
    });
    const named = rejection(() => parseReviewStrategyFile(join(b.cwd, 'default.yml'), ['claude', 'codex']));
    assert.equal(named.at, 'profiles.default');
    assert.match(named.message, /Профиль default встроен/);
    const backend = rejection(() => parseReviewStrategyFile(join(b.cwd, 'backend.yml'), ['claude', 'codex']));
    assert.match(backend.message, /назван именем бэкенда/);
  });
});

describe('review-strategies: разрешение ссылки', () => {
  it('проект перекрывает дом', () => {
    const b = box({
      'burnex.yml': pipeline('panel'),
      'verdict.json': SCHEMA,
      '.burnex/review-strategies/panel.yml': PANEL,
      '~/.burnex/review-strategies/panel.yml': PANEL.replace('Границы доверия', 'дом'),
    });
    const step = reviewOf(expandIn(b));
    assert.equal(step.strategy.layer, 'project');
    assert.equal(step.reviewers[0]?.focus, 'Границы доверия');
  });

  it('только в настройках пользователя: шаг использует её, линт предупреждает о домашнем слое', () => {
    const b = box({ 'burnex.yml': pipeline('panel'), 'verdict.json': SCHEMA, '~/.burnex/review-strategies/panel.yml': PANEL });
    const config = configOf(b);
    const expanded = expandIn(b, config);
    assert.equal(reviewOf(expanded).strategy.layer, 'home');
    const warning = lintPipeline(expanded, { config, cwd: b.cwd }).find((item) => /домашнего слоя/.test(item.message));
    assert.equal(warning?.severity, 'warning');
  });

  it('явный файл читается относительно документа шага, слоёв не касаясь', () => {
    const b = box({
      'burnex.yml': pipeline('./strategies/strict.yml'),
      'verdict.json': SCHEMA,
      'strategies/strict.yml': PANEL.replace('name: panel', 'name: strict'),
      '.burnex/review-strategies/strict.yml': PANEL,
    });
    const step = reviewOf(expandIn(b));
    assert.equal(step.strategy.layer, 'explicit');
    assert.equal(step.strategy.path, join(b.cwd, 'strategies', 'strict.yml'));
  });

  it('не найдена: отказ шага называет имя и оба пути, линт называет все промахи за проход', () => {
    const b = box({
      'burnex.yml': pipeline('nosuch', `      - id: second\n        review: other\n        prompt: ещё\n        output_schema: verdict.json\n`),
      'verdict.json': SCHEMA,
    });
    const config = configOf(b);
    const expanded = expandIn(b, config);
    const step = reviewOf(expanded);
    assert.equal(step.unresolved?.reason, 'not_found');
    assert.deepEqual(step.unresolved?.reason === 'not_found' ? step.unresolved.searched : [], [
      join(b.cwd, '.burnex', 'review-strategies', 'nosuch.yml'),
      join(b.home, '.burnex', 'review-strategies', 'nosuch.yml'),
    ]);
    const misses = lintPipeline(expanded, { config, cwd: b.cwd }).filter((item) => /не найдена/.test(item.message));
    assert.equal(misses.length, 2);
    assert.match(misses[0]?.message ?? '', /nosuch/);
    assert.match(misses[1]?.message ?? '', /other/);
  });

  it('name в файле обязан совпадать с именем файла', () => {
    const b = box({ 'burnex.yml': pipeline('panel'), 'verdict.json': SCHEMA, '.burnex/review-strategies/panel.yml': PANEL.replace('name: panel', 'name: other') });
    assert.equal(reviewOf(expandIn(b)).unresolved?.reason, 'name_mismatch');
  });
});

/** Реестр без одной строки встроенного слоя — состав, снятый патчем. */
async function registryWithoutRow(excludedRowId: string): Promise<Registry> {
  const kernel = createKernelShell();
  await Promise.all(BUILTIN_ROWS.filter((row) => row.id !== excludedRowId).map((row) => row.apply(kernel)));
  return registryFromKernel(kernel);
}

describe('review-strategies: вид шага review', () => {
  it('агент на шаге review отклоняется с подсказкой объявить участников в стратегии', () => {
    const b = box({ 'burnex.yml': pipeline('panel', '        agent: claude\n'), 'verdict.json': SCHEMA, '.burnex/review-strategies/panel.yml': PANEL });
    const error = rejection(() => expandIn(b));
    assert.match(error.message, /участников и их агентов объявляет стратегия ревью/);
  });

  it('снятая строка step-review: шаг review отклоняется отказом о виде вне состава', async () => {
    const b = box({ 'burnex.yml': pipeline('panel'), 'verdict.json': SCHEMA, '.burnex/review-strategies/panel.yml': PANEL });
    const registry = await registryWithoutRow('step-review');
    const error = rejection(() => expandIn(b, configOf(b), registry));
    assert.match(error.message, /Вид шага review отключён составом/);
  });

  it('step_agents …/<ревьюер> подменяет агента ревьюеру, …/<шаг> — агрегатору', () => {
    const b = box(
      { 'burnex.yml': pipeline('panel'), 'verdict.json': SCHEMA, '.burnex/review-strategies/panel.yml': PANEL },
      `agent_policy: fallback
step_agents:
  p:
    build:
      review-diff/security: { agent: claude }
      review-diff: { model_tier: deep }
      review-diff/perf: { agent: claude }
`,
    );
    const config = configOf(b);
    const expanded = expandIn(b, config);
    const step = reviewOf(expanded);
    assert.equal(step.reviewers[0]?.agent, 'claude');
    assert.equal(step.reviewers[1]?.model, 'sonnet');
    assert.equal(step.aggregator?.model, 'opus');
    assert.deepEqual(
      expanded.unusedAgentEntries.map((entry) => [entry.key, entry.reason.kind]),
      [['step_agents.p.build.review-diff/perf', 'no_reviewer']],
    );
    const report = renderAgentsReport(
      resolveConfig({ cwd: b.cwd, home: b.home, globalPath: b.globalPath, projectPath: b.projectPath }),
      expanded,
    ).join('\n');
    assert.match(report, /review-diff\/perf\s+— ревьюера нет в стратегии/);
    assert.match(report, /build\/review-diff\/security\s+claude/);
  });

  it('запись …/<ревьюер> у шага не вида review — запись без действия', () => {
    const b = box(
      {
        'burnex.yml': 'version: 1\nkind: pipeline\nname: p\njobs:\n  build:\n    steps:\n      - id: check\n        prompt: проверь\n',
      },
      'step_agents:\n  p:\n    build:\n      check/security: { agent: claude }\n',
    );
    assert.deepEqual(expandIn(b).unusedAgentEntries.map((entry) => entry.reason.kind), ['not_review']);
  });

  it('замок печатает стратегию и участников; правка фокуса меняет ключ, перенос между слоями — нет', () => {
    const focusPanel = PANEL.replace('focus: Границы доверия', 'focus: file:./security-focus.md');
    const b = box({
      'burnex.yml': pipeline('panel'),
      'verdict.json': SCHEMA,
      '~/.burnex/review-strategies/panel.yml': focusPanel,
      '~/.burnex/review-strategies/security-focus.md': 'секреты',
    });
    const before = expandIn(b);
    const lock = serializeLock(before.pipeline);
    assert.match(lock, /layer: home/);
    assert.match(lock, /reviewers:\n\s+- id: security\n\s+agent: codex/);
    const key = keyOf(before);

    writeFileSync(join(b.home, '.burnex', 'review-strategies', 'security-focus.md'), 'инъекции');
    assert.notEqual(keyOf(expandIn(b)), key);
    writeFileSync(join(b.home, '.burnex', 'review-strategies', 'security-focus.md'), 'секреты');

    mkdirSync(join(b.cwd, '.burnex', 'review-strategies'), { recursive: true });
    renameSync(join(b.home, '.burnex', 'review-strategies'), join(b.cwd, '.burnex', 'review-strategies'));
    const moved = expandIn(b);
    assert.equal(reviewOf(moved).strategy.layer, 'project');
    assert.equal(keyOf(moved), key);
    assert.match(serializeLock(moved.pipeline), /layer: project/);
  });
});

// --- Исполнение на поддельных бэкендах.

/** Проект в репозитории git: исполнение снимает якоря дерева. */
function repo(files: Record<string, string>): Project {
  const project = makeProject(files);
  gitInit(project.root);
  gitCommit(project.root, 'init');
  return project;
}

async function run(project: Project, backends: Readonly<Record<string, FakeBackend>>): Promise<RunResult> {
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config }),
    config: { ...project.config, runs: { ...project.config.runs, root: tempDir('runs-') } },
    projectRoot: project.root,
    cwd: project.root,
    baseEnv: testBaseEnv(),
    adapterFor: (name) => {
      const backend = backends[name];
      assert.ok(backend !== undefined, `нет поддельного бэкенда для «${name}»`);
      return backend.adapter;
    },
  });
}

const FINDINGS = {
  summary: 'одна находка',
  findings: [{ severity: 'major', title: 'секрет в логе', location: 'a.ts:1', detail: 'печатается токен', suggestion: null }],
};

const RUN_STRATEGY = `version: 1
kind: review-strategy
name: panel
reviewers:
  - id: security
    agent: rev-a
    focus: Границы доверия
  - id: tests
    agent: rev-b
aggregator:
  agent: agg
  prompt: Сведи строго.
`;

function runPipelineDoc(stepExtra = ''): string {
  return `version: 1
kind: pipeline
name: p
jobs:
  review:
    output: { from: review-diff }
    steps:
      - id: review-diff
        review: ./strategies/panel.yml
        prompt: проверь дифф
        output_schema: verdict.json
${stepExtra}  after:
    needs: [review]
    steps:
      - id: echo
        run: [sh, -c, 'printf %s "\${jobs.review.output.verdict}" > "$BURNEX_RUN_DIR/verdict.txt"']
`;
}

function reviewRepo(stepExtra = ''): Project {
  return repo({
    'burnex.yml': runPipelineDoc(stepExtra),
    'verdict.json': SCHEMA,
    'strategies/panel.yml': RUN_STRATEGY,
  });
}

const ok = (structured: unknown, tokens = 10) =>
  createFakeBackend({ name: 'fake', lines: [initLine(), resultLine({ structured, tokensIn: tokens, tokensOut: tokens })] });

function stepDirOf(result: RunResult): string {
  const dir = findStepDir(result.journal.paths, 'review', 'review-diff');
  assert.ok(dir !== undefined);
  return dir;
}

describe('review-strategies: исполнение independent', () => {
  it('находки сведены: выход шага — вердикт агрегатора, журнал и расход разложены по участникам', async () => {
    const project = reviewRepo();
    const agg = ok({ verdict: 'APPROVED' }, 5);
    const revA = ok(FINDINGS);
    const revB = ok({ summary: 'чисто', findings: [] }, 20);
    const result = await run(project, { 'rev-a': revA, 'rev-b': revB, agg });

    assert.equal(result.status, 'success');
    const dir = stepDirOf(result);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'output.json'), 'utf8')), { verdict: 'APPROVED' });
    assert.equal(readFileSync(join(result.journal.paths.dir, 'verdict.txt'), 'utf8'), 'APPROVED');

    for (const participant of ['security', 'tests', 'aggregator']) {
      for (const file of ['prompt.txt', 'context.json', 'stdout.log', 'stderr.log', 'output.json', 'step.json']) {
        assert.ok(existsSync(join(dir, 'participants', participant, file)), `${participant}/${file}`);
      }
    }
    const security = JSON.parse(readFileSync(join(dir, 'participants', 'security', 'step.json'), 'utf8'));
    assert.equal(security.agent, 'rev-a');
    assert.equal(security.status, 'success');
    assert.equal(security.session, 'review-diff/security');

    // Ревьюер получает задачу шага, свой фокус и требование схемы находок.
    const reviewerPrompt = revA.invocations[0]?.prompt ?? '';
    assert.match(reviewerPrompt, /проверь дифф/);
    assert.match(reviewerPrompt, /Границы доверия/);
    assert.match(reviewerPrompt, /схеме находок/);
    assert.match(revA.invocations[0]?.outputSchemaPath ?? '', /review-findings\.schema\.json$/);
    // Агрегатор — находки с id и фокусом, указания стратегии и схема шага.
    const aggregatorPrompt = agg.invocations[0]?.prompt ?? '';
    assert.match(aggregatorPrompt, /Ревьюер `security`/);
    assert.match(aggregatorPrompt, /секрет в логе/);
    assert.match(aggregatorPrompt, /Сведи строго\./);
    assert.equal(agg.invocations[0]?.outputSchemaPath, project.path('verdict.json'));
    assert.notEqual(revA.invocations[0]?.sessionId, revB.invocations[0]?.sessionId);

    const events = readEvents(result.journal.paths).flatMap((event) =>
      event.kind === 'review.participant.finished' ? [`${event.participant}:${event.status}`] : [],
    );
    assert.deepEqual([...events].sort(), ['aggregator:success', 'security:success', 'tests:success']);

    const usage = readUsage(result.journal.paths).jobs.review?.steps['review-diff'];
    assert.deepEqual(
      Object.fromEntries(Object.entries(usage?.participants ?? {}).map(([id, entry]) => [id, entry.billable_tokens])),
      { security: 20, tests: 40, aggregator: 10 },
    );
    assert.equal(usage?.billable_tokens, 70);
    assert.deepEqual(new Set(usage?.attempts.map((attempt) => attempt.participant)), new Set(['security', 'tests', 'aggregator']));
  });

  it('один ревьюер упал: агрегатор получает отметку и причину', async () => {
    const project = reviewRepo();
    const agg = ok({ verdict: 'APPROVED' });
    const broken = createFakeBackend({ lines: [initLine(), resultLine({ text: 'не структура' })], exitCode: 1 });
    const result = await run(project, { 'rev-a': ok(FINDINGS), 'rev-b': broken, agg });

    assert.equal(result.status, 'success');
    // Свой повтор — у самого ревьюера, затем он отказывает, а шаг идёт дальше.
    assert.equal(broken.invocations.length, 2);
    assert.match(agg.invocations[0]?.prompt ?? '', /Ревьюер `tests` не дал находок: /);
    const tests = JSON.parse(readFileSync(join(stepDirOf(result), 'participants', 'tests', 'step.json'), 'utf8'));
    assert.equal(tests.status, 'failed');
  });

  it('невалидные находки дают ревьюеру один повтор с ошибкой схемы', async () => {
    const project = reviewRepo();
    const agg = ok({ verdict: 'APPROVED' });
    const flaky = createFakeBackend({
      lines: (index) => [initLine(), resultLine({ structured: index === 0 ? { summary: 1 } : FINDINGS })],
    });
    const result = await run(project, { 'rev-a': ok(FINDINGS), 'rev-b': flaky, agg });
    assert.equal(result.status, 'success');
    assert.equal(flaky.invocations.length, 2);
    assert.match(flaky.invocations[1]?.prompt ?? '', /Прошлая попытка не прошла проверку/);
    assert.doesNotMatch(agg.invocations[0]?.prompt ?? '', /не дал находок/);
  });

  it('упали все: шаг проваливается, агрегатор не запускается, причина называет каждого', async () => {
    const project = reviewRepo();
    const agg = ok({ verdict: 'APPROVED' });
    const failing = () => createFakeBackend({ lines: [initLine()], exitCode: 1 });
    const result = await run(project, { 'rev-a': failing(), 'rev-b': failing(), agg });

    assert.equal(result.status, 'failed');
    assert.equal(agg.invocations.length, 0);
    const step = readStatus(result.journal.paths).jobs.find((job) => job.id === 'review')?.steps[0];
    assert.match(step?.reason ?? '', /ни один ревьюер не дал находок — security: .*; tests: /);
    assert.equal(existsSync(join(stepDirOf(result), 'participants', 'aggregator')), false);
  });

  it('провал expect перезапускает только агрегатора с прежними находками', async () => {
    const project = reviewRepo(
      '        expect: [{ matches: APPROVED }]\n        attempts: { max: 2, escalation: [{ include_failure: true }] }\n',
    );
    const agg = createFakeBackend({
      lines: (index) => [initLine(), resultLine({ text: index === 0 ? 'REJECTED' : 'APPROVED', structured: { verdict: index === 0 ? 'REJECTED' : 'APPROVED' } })],
    });
    const revA = ok(FINDINGS);
    const revB = ok(FINDINGS);
    const result = await run(project, { 'rev-a': revA, 'rev-b': revB, agg });

    assert.equal(result.status, 'success');
    assert.equal(revA.invocations.length, 1);
    assert.equal(revB.invocations.length, 1);
    assert.equal(agg.invocations.length, 2);
    const second = agg.invocations[1]?.prompt ?? '';
    assert.match(second, /секрет в логе/);
    assert.match(second, /Прошлая попытка не прошла проверку/);
    const step = readStatus(result.journal.paths).jobs.find((job) => job.id === 'review')?.steps[0];
    assert.equal(step?.attempts.length, 2);
  });

  it('бюджет общий: шаг останавливается по бюджету, расход разложен по участникам', async () => {
    const project = reviewRepo('        budget: { tokens: 30 }\n');
    const agg = ok({ verdict: 'APPROVED' });
    const result = await run(project, { 'rev-a': ok(FINDINGS, 20), 'rev-b': ok(FINDINGS, 20), agg });

    assert.equal(result.status, 'budget_exceeded');
    assert.equal(agg.invocations.length, 0);
    const usage = readUsage(result.journal.paths).jobs.review?.steps['review-diff'];
    assert.deepEqual(Object.keys(usage?.participants ?? {}).sort(), ['security', 'tests']);
  });
});
