import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { BurnexError } from '../src/kernel/errors.js';
import { createClaudeAdapter } from '../src/parts/backends/claude/adapter.js';
import { createCodexAdapter } from '../src/parts/backends/codex/index.js';
import { createFakeBackend, initLine, resultLine, type FakeBackend } from '../src/parts/pipeline/backend/fake.js';
import type { AgentInvocation, BackendCapabilities } from '../src/parts/pipeline/backend/types.js';
import type { BackendConfig } from '../src/parts/pipeline/config/resolve.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { jobLockHash, serializeLock } from '../src/parts/pipeline/document/lock.js';
import type { AgentStep, ReviewStep } from '../src/parts/pipeline/document/model.js';
import { parseReviewStrategyFile } from '../src/parts/pipeline/document/reviewStrategy.js';
import { lintPipeline } from '../src/parts/pipeline/domain/lint.js';
import { createSessionRegistry, executeAgentStep } from '../src/parts/pipeline/run/exec/agentStep.js';
import { findStepDir, readEvents, readStatus, readUsage } from '../src/parts/pipeline/run/journal/reader.js';
import { buildResumePlan, parseFrom, readSourceRun } from '../src/parts/pipeline/run/resumePlan.js';
import { runPipeline, type RunResult } from '../src/parts/pipeline/run/runner.js';
import { computeStepKey } from '../src/parts/pipeline/run/stepKey.js';
import { turnCheckSchema } from '../src/parts/pipeline/steps/review/defend.js';
import { gitCommit, gitInit, makeProject, testBaseEnv, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * `review-defend`: режим `defend` стратегии ревью — защитник (форк сессии
 * имплементатора либо свежий агент), ветки «ревьюер ↔ защитник» по
 * находкам, решение агрегатора по статусам и журнал `defense.ndjson`.
 */

const STRATEGY = (extra = '') => `version: 1
kind: review-strategy
name: panel
mode: defend
reviewers:
  - id: security
    agent: rev-0
    focus: безопасность
  - id: tests
    agent: rev-1
aggregator:
  agent: agg
defender:
  agent: def
  prompt: Защищай по коду.
${extra}`;

function rejection(fn: () => unknown): BurnexError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BurnexError, String(error));
    return error;
  }
  assert.fail('ожидался отказ');
}

function strategyFile(content: string): string {
  const path = join(tempDir('strategy-'), 's.yml');
  writeFileSync(path, content);
  return path;
}

describe('review-defend: документ стратегии', () => {
  // Сценарий: «Режим принят»
  it('mode: defend без блока defend принят с rounds 2; защитник раскрыт по defender, адрес step_agents — <шаг>/defender', () => {
    const raw = parseReviewStrategyFile(strategyFile(STRATEGY()), []);
    assert.equal(raw.mode, 'defend');
    assert.equal(raw.defend, undefined);

    const project = defendRepo();
    const expanded = expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config });
    const step = reviewStepOf(expanded);
    assert.equal(step.mode, 'defend');
    assert.equal(step.rounds, 2);
    assert.equal(step.defender?.agent, 'def');
    assert.equal(step.defender?.prompt, 'Защищай по коду.');
    assert.equal(expanded.agentOrigins.get('review/review-diff/defender')?.layer, 'step');
    assert.match(serializeLock(expanded.pipeline), /defend:\n\s+rounds: 2/);
  });

  it('rounds 1–5 принимаются, вне диапазона и дробное — отказ у defend.rounds', () => {
    assert.equal(parseReviewStrategyFile(strategyFile(STRATEGY('defend: { rounds: 5 }\n')), []).defend?.rounds, 5);
    for (const rounds of ['0', '6', '1.5']) {
      const error = rejection(() => parseReviewStrategyFile(strategyFile(STRATEGY(`defend: { rounds: ${rounds} }\n`)), []));
      assert.equal(error.at, 'defend.rounds', rounds);
      assert.match(error.message, /от 1 до 5/);
    }
  });

  // Сценарий: «Прежний режим»
  it('mode: discussion отклоняется у ключа mode с перечнем режимов и указанием замены', () => {
    const error = rejection(() =>
      parseReviewStrategyFile(strategyFile(STRATEGY().replace('mode: defend\n', 'mode: discussion\n').replace(/defender:[\s\S]*$/, '')), []),
    );
    assert.equal(error.at, 'mode');
    assert.match(error.message, /неизвестный режим: известны independent, defend \(discussion заменён режимом defend\)/);
  });

  // Сценарий: «Блок при другом режиме»
  it('defender и defend при режиме independent отклоняются у своего ключа', () => {
    const independent = STRATEGY().replace('mode: defend\n', 'mode: independent\n');
    assert.equal(rejection(() => parseReviewStrategyFile(strategyFile(independent), [])).at, 'defender');
    const withBlock = STRATEGY('defend: { rounds: 3 }\n').replace('mode: defend\n', '').replace(/defender:\n.*\n.*\n/, '');
    assert.equal(rejection(() => parseReviewStrategyFile(strategyFile(withBlock), [])).at, 'defend');
  });

  it('id ревьюера defender занят', () => {
    const error = rejection(() => parseReviewStrategyFile(strategyFile(STRATEGY().replace('id: tests', 'id: defender')), []));
    assert.equal(error.at, 'reviewers.1.id');
    assert.match(error.message, /занят защитником/);
  });

  it('prompt защитника берётся из file:', () => {
    const project = defendRepo({ strategy: STRATEGY().replace('prompt: Защищай по коду.', 'prompt: file:defender.md') });
    writeFileSync(project.path('strategies/defender.md'), 'Защищай, опираясь на тесты.');
    const step = reviewStepOf(expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config }));
    assert.equal(step.defender?.prompt, 'Защищай, опираясь на тесты.');
  });
});

// --- Пайплайны и поддельные бэкенды.

const SCHEMA = '{"type":"object","properties":{"verdict":{"type":"string"}},"required":["verdict"]}\n';

/** Работа `review`: шаг `implement` (агент `impl`), затем `review-diff`. */
function defendRepo(
  options: {
    readonly strategy?: string;
    /** `null` — шаг не называет имплементатора. */
    readonly implementer?: string | null;
    readonly stepExtra?: string;
    readonly body?: string;
  } = {},
): Project {
  const implementer = options.implementer === undefined ? 'implement' : options.implementer;
  const project = makeProject({
    'burnex.yml':
      options.body ??
      `version: 1
kind: pipeline
name: p
jobs:
  review:
    output: { from: review-diff }
    steps:
      - id: implement
        agent: impl
        prompt: реализуй фичу
      - id: review-diff
        review: ./strategies/panel.yml
        prompt: проверь дифф
        output_schema: verdict.json
${implementer === null ? '' : `        implementer: ${implementer}\n`}${options.stepExtra ?? ''}`,
    'verdict.json': SCHEMA,
    'strategies/panel.yml': options.strategy ?? STRATEGY(),
  });
  gitInit(project.root);
  gitCommit(project.root, 'init');
  return project;
}

/** Две работы: `build` с имплементатором и `review` с `needs: [build]`. */
const CROSS_JOB = (implementer: string, needs = '[build]') => `version: 1
kind: pipeline
name: p
jobs:
  build:
    steps:
      - id: implement
        agent: impl
        prompt: реализуй фичу
      - id: check
        run: [node, -e, ""]
  other:
    steps:
      - id: implement
        agent: impl
        prompt: другое
  review:
    needs: ${needs}
    output: { from: review-diff }
    steps:
      - id: review-diff
        review: ./strategies/panel.yml
        prompt: проверь дифф
        output_schema: verdict.json
        implementer: ${implementer}
`;

function reviewStepOf(expanded: ReturnType<typeof expandPipeline>, job = 'review'): ReviewStep {
  const step = expanded.pipeline.jobs.find((entry) => entry.id === job)?.steps.find((entry) => entry.kind === 'review');
  assert.ok(step !== undefined);
  return step as ReviewStep;
}

async function run(
  project: Project,
  backends: Readonly<Record<string, FakeBackend>>,
  extra: Partial<Parameters<typeof runPipeline>[0]> = {},
): Promise<RunResult> {
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
    ...extra,
  });
}

/** Ход по промпту: независимое ревью, ход защитника, ход ревьюера, прочее. */
type Turn =
  | { readonly kind: 'defense'; readonly reviewer: string; readonly round: number; readonly open: readonly string[] }
  | { readonly kind: 'rebuttal'; readonly round: number; readonly open: readonly string[] }
  | { readonly kind: 'other' };

function openIds(prompt: string): string[] {
  const at = Math.max(prompt.lastIndexOf('## Открытые находки'), prompt.lastIndexOf('## Находки\n'));
  return [...prompt.slice(at).matchAll(/^### ([\w-]+\.\d+) —/gm)].map((match) => match[1] as string);
}

function turnOf(prompt: string): Turn {
  const defense = /## Защита на ревью — раунд (\d+)\n\n[^\n]*Ревьюер `([^`]+)`/.exec(prompt);
  if (defense !== null) return { kind: 'defense', reviewer: defense[2] as string, round: Number(defense[1]), open: openIds(prompt) };
  const rebuttal = /## Защита находок — раунд (\d+)/.exec(prompt);
  if (rebuttal !== null) return { kind: 'rebuttal', round: Number(rebuttal[1]), open: openIds(prompt) };
  return { kind: 'other' };
}

interface Responding {
  readonly capabilities?: Partial<BackendCapabilities>;
  readonly tokens?: number;
  readonly hang?: (invocation: AgentInvocation) => number;
  readonly text?: (invocation: AgentInvocation) => string | undefined;
}

/** Бэкенд, отвечающий по промпту вызова, а не по номеру: ветки идут параллельно. */
function responding(respond: (invocation: AgentInvocation) => unknown, options: Responding = {}): FakeBackend {
  const tokens = options.tokens ?? 10;
  const backend: FakeBackend = createFakeBackend({
    lines: (index) => {
      const invocation = backend.invocations[index] as AgentInvocation;
      const text = options.text?.(invocation);
      return [initLine(), resultLine({ structured: respond(invocation), ...(text === undefined ? {} : { text }), tokensIn: tokens, tokensOut: tokens })];
    },
    hangMs: (index) => options.hang?.(backend.invocations[index] as AgentInvocation) ?? 0,
    capabilities: options.capabilities ?? {},
  });
  return backend;
}

const finding = (title: string, severity = 'major') => ({ severity, title, location: `src/${title}.ts:1`, detail: `подробно: ${title}`, suggestion: null });
const FINDINGS: Readonly<Record<string, readonly ReturnType<typeof finding>[]>> = {
  security: [finding('секрет', 'critical'), finding('инъекция')],
  tests: [finding('нет теста')],
};

type DefenseStance = 'accept' | 'dispute' | 'clarify';
type RebuttalAnswer = { readonly stance: 'maintain' | 'withdraw' | 'revise'; readonly severity?: string };

/** Ревьюер: находки на независимое ревью, ответы по таблице на ходы. */
function reviewer(id: string, answer: (round: number, finding: string) => RebuttalAnswer = () => ({ stance: 'maintain' }), list = FINDINGS[id] ?? []): FakeBackend {
  return responding((invocation) => {
    const turn = turnOf(invocation.prompt);
    if (turn.kind !== 'rebuttal') return { summary: `итог ${id}`, findings: list };
    return {
      text: `ревьюер ${id}, раунд ${turn.round}`,
      responses: turn.open.map((findingId) => {
        const { stance, severity } = answer(turn.round, findingId);
        return { finding: findingId, stance, text: `${stance} ${findingId} r${turn.round}`, severity: severity ?? null };
      }),
    };
  });
}

/** Защитник: позиция по таблице на каждую открытую находку хода. */
function defender(stance: (reviewer: string, round: number, finding: string) => DefenseStance = () => 'accept', options: Responding = {}): FakeBackend {
  return responding((invocation) => {
    const turn = turnOf(invocation.prompt);
    if (turn.kind !== 'defense') return undefined;
    return {
      text: `защита ${turn.reviewer}, раунд ${turn.round}`,
      responses: turn.open.map((findingId) => {
        const chosen = stance(turn.reviewer, turn.round, findingId);
        return { finding: findingId, stance: chosen, text: `${chosen} ${findingId} r${turn.round}`, evidence: chosen === 'dispute' ? `src/guard.ts:${turn.round}` : null };
      }),
    };
  }, options);
}

/**
 * Имплементатор на бэкенде с форком: первый вызов — сам шаг `implement`,
 * следующие — ходы форкнутого защитника.
 */
function implementer(stance?: Parameters<typeof defender>[0], options: Responding = {}): FakeBackend {
  return defender(stance, {
    capabilities: { forkSessions: true, ...options.capabilities },
    text: (invocation) => (turnOf(invocation.prompt).kind === 'defense' ? undefined : 'Сделал: добавил проверку прав'),
    ...(options.hang === undefined ? {} : { hang: options.hang }),
  });
}

const verdict = () => responding(() => ({ verdict: 'APPROVED' }));

type Line = Record<string, unknown>;

function defenseOf(result: RunResult, job = 'review'): { readonly lines: readonly Line[]; readonly dir: string } {
  const dir = findStepDir(result.journal.paths, job, 'review-diff');
  assert.ok(dir !== undefined);
  const lines = readFileSync(join(dir, 'defense.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Line);
  return { lines, dir };
}

const settledOf = (lines: readonly Line[]) =>
  Object.fromEntries(lines.filter((line) => line.kind === 'settled').map((line) => [line.finding, line.status]));

const defenseTurns = (backend: FakeBackend) => backend.invocations.filter((invocation) => turnOf(invocation.prompt).kind === 'defense');
const rebuttals = (backend: FakeBackend) => backend.invocations.filter((invocation) => turnOf(invocation.prompt).kind === 'rebuttal');

describe('review-defend: форк сессии имплементатора', () => {
  // Сценарии: «Форк сессии Claude», «Защитник принял находку», «Лента в журнале», «События по ходу»
  it('всё принято в первом раунде: две ветки-форка, сессия имплементатора не тронута, ревьюерам вопросов нет', async () => {
    const project = defendRepo();
    const impl = implementer();
    const security = reviewer('security');
    const tests = reviewer('tests');
    const agg = verdict();
    const def = defender();
    const result = await run(project, { impl, 'rev-0': security, 'rev-1': tests, agg, def });

    assert.equal(result.status, 'success');
    const implementSession = impl.invocations[0]?.sessionId;
    assert.ok(implementSession !== undefined);
    const forks = impl.invocations.slice(1);
    assert.equal(forks.length, 2, 'по ходу защитника на ветку');
    for (const fork of forks) {
      assert.equal(fork.forkFrom, implementSession);
      assert.equal(fork.resumeSession, false);
      assert.notEqual(fork.sessionId, implementSession);
    }
    assert.notEqual(forks[0]?.sessionId, forks[1]?.sessionId, 'у каждой ветки своя сессия защитника');
    assert.ok(!impl.invocations.slice(1).some((invocation) => invocation.sessionId === implementSession), 'сессия S не получила сообщений');
    assert.equal(def.invocations.length, 0, 'свежий защитник не нужен');
    // Форк помнит задание — его не повторяют; права — шага review.
    assert.doesNotMatch(forks[0]?.prompt ?? '', /проверь дифф/);
    assert.match(forks[0]?.prompt ?? '', /Ты — автор кода/);
    assert.match(forks[0]?.prompt ?? '', /Принимай только то, что подтверждается кодом/);
    assert.match(forks[0]?.prompt ?? '', /Файлы не правь/);
    assert.match(forks[0]?.outputSchemaPath ?? '', /review-defense\.schema\.json$/);
    // Ревьюерам вопросов не задавалось: находки закрыты защитником.
    assert.equal(security.invocations.length, 1);
    assert.equal(tests.invocations.length, 1);

    const { lines, dir } = defenseOf(result);
    assert.deepEqual(lines[0], { kind: 'defender', mode: 'fork', implementer: 'review.implement', agent: 'impl' });
    assert.deepEqual(lines.at(-1), { kind: 'outcome', accepted: 3, withdrawn: 0, contested: 0 });
    assert.deepEqual(
      lines.filter((line) => line.kind === 'finding').map((line) => line.id),
      ['security.1', 'security.2', 'tests.1'],
    );
    assert.deepEqual(lines[1], {
      kind: 'finding', id: 'security.1', by: 'security', severity: 'critical', title: 'секрет',
      location: 'src/секрет.ts:1', detail: 'подробно: секрет', suggestion: null,
    });
    assert.deepEqual(settledOf(lines), { 'security.1': 'accepted', 'security.2': 'accepted', 'tests.1': 'accepted' });
    assert.equal(lines.filter((line) => line.kind === 'settled').length, 3, 'ровно одна строка settled на находку');
    const message = lines.find((line) => line.kind === 'message' && line.thread === 'security');
    assert.equal(message?.role, 'agent');
    assert.equal(message?.from, 'defender');
    assert.equal(message?.round, 1);
    assert.deepEqual(message?.parts, [{ kind: 'text', text: 'защита security, раунд 1' }]);
    assert.deepEqual((message?.responses as Line[])[0], { finding: 'security.1', stance: 'accept', text: 'accept security.1 r1', evidence: null });
    assert.ok(existsSync(join(dir, 'participants', 'defender', 'security', 'rounds', '1', 'output.json')));
    const turn = JSON.parse(readFileSync(join(dir, 'participants', 'defender', 'tests', 'rounds', '1', 'step.json'), 'utf8')) as Line;
    assert.equal(turn.role, 'defender');
    assert.equal(turn.thread, 'tests');
    assert.equal(turn.fork_from, implementSession);
    assert.equal(turn.session, 'review-diff/defender/tests');

    // События: выбор защитника, реплики веток, закрытия за репликой, итог.
    const events = readEvents(result.journal.paths);
    const chosen = events.find((event) => event.kind === 'review.defender');
    assert.deepEqual(chosen?.kind === 'review.defender' ? { mode: chosen.mode, implementer: chosen.implementer, reason: chosen.reason } : undefined, {
      mode: 'fork', implementer: 'review.implement', reason: undefined,
    });
    const reply = events.findIndex((event) => event.kind === 'review.message' && event.participant === 'defender' && event.thread === 'security');
    assert.ok(reply !== -1);
    const settled = events.findIndex((event) => event.kind === 'review.settled' && event.finding === 'security.1' && event.status === 'accepted');
    assert.ok(settled > reply, 'review.settled — за репликой, что закрыла находку');
    assert.ok(events.some((event) => event.kind === 'review.participant.started' && event.participant === 'defender' && event.thread === 'security'));
    const finished = events.find((event) => event.kind === 'review.defense.finished');
    assert.deepEqual(finished?.kind === 'review.defense.finished' ? [finished.accepted, finished.withdrawn, finished.contested] : [], [3, 0, 0]);

    // Агрегатор: строка о защитнике и статусы находок.
    const aggPrompt = agg.invocations[0]?.prompt ?? '';
    assert.match(aggPrompt, /форк сессии имплементатора `review\.implement`/);
    assert.match(aggPrompt, /### security\.1 — critical: секрет/);
    assert.match(aggPrompt, /Статус: accepted/);
    assert.match(aggPrompt, /`accepted` включи в итог/);

    // Расход обеих веток — под участником defender.
    const usage = readUsage(result.journal.paths).jobs.review?.steps['review-diff'];
    assert.equal(usage?.participants?.defender?.billable_tokens, 40);
    assert.deepEqual(Object.keys(usage?.participants ?? {}).sort(), ['aggregator', 'defender', 'security', 'tests']);
  });

  // Сценарий: «Ревьюер снял находку»; `revise` меняет серьёзность
  it('снятие и пересмотр: dispute → withdraw закрывает находку, revise меняет серьёзность и оставляет её открытой', async () => {
    const project = defendRepo();
    const impl = implementer((reviewerId, round, id) => (id === 'security.2' && round === 2 ? 'accept' : 'dispute'));
    const security = reviewer('security', (_round, id) => (id === 'security.1' ? { stance: 'withdraw' } : { stance: 'revise', severity: 'minor' }));
    const tests = reviewer('tests', () => ({ stance: 'withdraw' }));
    const agg = verdict();
    const result = await run(project, { impl, 'rev-0': security, 'rev-1': tests, agg, def: defender() });

    assert.equal(result.status, 'success');
    const { lines } = defenseOf(result);
    assert.deepEqual(settledOf(lines), { 'tests.1': 'withdrawn', 'security.1': 'withdrawn', 'security.2': 'accepted' });
    const revised = lines.find((line) => line.kind === 'settled' && line.finding === 'security.2');
    assert.equal(revised?.severity, 'minor');
    assert.equal(revised?.round, 2);
    // Ветка tests кончилась в первом раунде; security — во втором.
    assert.equal(rebuttals(tests).length, 1);
    assert.equal(rebuttals(security).length, 1);
    // Ревьюер отвечает в своей возобновлённой сессии; видит ответ защитника.
    const rebuttal = rebuttals(security)[0];
    assert.equal(rebuttal?.resumeSession, true);
    assert.equal(rebuttal?.sessionId, security.invocations[0]?.sessionId);
    assert.match(rebuttal?.prompt ?? '', /\*\*dispute\*\* — dispute security\.1 r1\n\s+Доказательство: src\/guard\.ts:1/);
    assert.match(rebuttal?.outputSchemaPath ?? '', /review-rebuttal\.schema\.json$/);
    // Второй ход защитника — возобновлённый форк: только открытая находка и ответ ревьюера.
    const second = defenseTurns(impl).find((invocation) => turnOf(invocation.prompt).kind === 'defense' && /раунд 2/.test(invocation.prompt));
    assert.equal(second?.resumeSession, true);
    assert.equal(second?.forkFrom, undefined, 'форк — только у начала сессии ветки');
    assert.deepEqual(turnOf(second?.prompt ?? '').kind === 'defense' ? openIds(second?.prompt ?? '') : [], ['security.2']);
    assert.match(second?.prompt ?? '', /### security\.2 — minor \(было major\)/);
    assert.match(second?.prompt ?? '', /\*\*revise → minor\*\*/);
    assert.match(agg.invocations[0]?.prompt ?? '', /Статус: withdrawn/);
  });

  // Сценарий: «Спор не разрешился»; «Спорная находка»
  it('спор до лимита: dispute и maintain дважды — contested после второго ответа ревьюера, четыре вызова в ветке', async () => {
    const strategy = STRATEGY().replace('  - id: tests\n    agent: rev-1\n', '');
    const project = defendRepo({ strategy });
    const impl = implementer(() => 'dispute');
    const security = reviewer('security', () => ({ stance: 'maintain' }), [finding('секрет', 'critical')]);
    const agg = verdict();
    const result = await run(project, { impl, 'rev-0': security, agg, def: defender() });

    assert.equal(result.status, 'success');
    assert.equal(defenseTurns(impl).length + rebuttals(security).length, 4);
    const { lines } = defenseOf(result);
    assert.deepEqual(settledOf(lines), { 'security.1': 'contested' });
    assert.equal(lines.find((line) => line.kind === 'settled')?.round, 2);
    assert.deepEqual(
      lines.filter((line) => line.kind === 'message').map((line) => `${String(line.messageId)}:${String(line.from)}:${String(line.round)}`),
      ['m1:defender:1', 'm2:security:1', 'm3:defender:2', 'm4:security:2'],
    );
    const aggPrompt = agg.invocations[0]?.prompt ?? '';
    assert.match(aggPrompt, /Статус: contested/);
    assert.match(aggPrompt, /раунд 2, защитник: \*\*dispute\*\* — dispute security\.1 r2\n\s+Доказательство: src\/guard\.ts:2/);
    assert.match(aggPrompt, /раунд 2, ревьюер `security`: \*\*maintain\*\* — maintain security\.1 r2/);
    assert.match(aggPrompt, /`contested` реши сам, взвесив доводы/);
    assert.match(aggPrompt, /Фокус: безопасность/);
  });

  // Сценарий: «Сбой защитника»
  it('таймаут хода защитника: реплика с причиной сбоя, открытые находки ветки — contested, другая ветка продолжается', async () => {
    const project = defendRepo({ stepExtra: '        timeout: 1s\n' });
    const impl = implementer(undefined, {
      hang: (invocation) => (turnOf(invocation.prompt).kind === 'defense' && /Ревьюер `security`/.test(invocation.prompt) ? 5_000 : 0),
    });
    const agg = verdict();
    const result = await run(project, { impl, 'rev-0': reviewer('security'), 'rev-1': reviewer('tests'), agg, def: defender() });

    assert.equal(result.status, 'success');
    const { lines } = defenseOf(result);
    assert.deepEqual(settledOf(lines), { 'tests.1': 'accepted', 'security.1': 'contested', 'security.2': 'contested' });
    const failed = lines.find((line) => line.kind === 'message' && line.thread === 'security');
    assert.match(String(failed?.failure), /не завершился за 1000 мс/);
    assert.deepEqual(failed?.responses, []);
    assert.equal(failed?.invalid, undefined);
    assert.deepEqual(lines.at(-1), { kind: 'outcome', accepted: 1, withdrawn: 0, contested: 2 });
    const event = readEvents(result.journal.paths).find((entry) => entry.kind === 'review.message' && entry.thread === 'security');
    assert.match(event?.kind === 'review.message' ? event.failure ?? '' : '', /не завершился/);
    assert.match(agg.invocations[0]?.prompt ?? '', /ход защитника сорвался/);
  });

  it('дважды невалидный ход защитника: повтор с ошибкой схемы, затем invalid и contested', async () => {
    const strategy = STRATEGY().replace('  - id: tests\n    agent: rev-1\n', '');
    const project = defendRepo({ strategy });
    const impl = responding(
      (invocation) =>
        turnOf(invocation.prompt).kind === 'defense'
          ? { text: 'не та находка', responses: [{ finding: 'security.9', stance: 'accept', text: '', evidence: null }] }
          : undefined,
      { capabilities: { forkSessions: true } },
    );
    const result = await run(project, { impl, 'rev-0': reviewer('security'), agg: verdict(), def: defender() });

    assert.equal(result.status, 'success');
    const turns = defenseTurns(impl);
    assert.equal(turns.length, 2, 'невалидный ход получает один повтор');
    assert.match(turns[1]?.prompt ?? '', /## Прошлая попытка не прошла проверку[\s\S]*finding: must be equal to one of the allowed values/);
    const { lines, dir } = defenseOf(result);
    const message = lines.find((line) => line.kind === 'message');
    assert.equal(message?.invalid, true);
    assert.deepEqual(message?.responses, []);
    assert.deepEqual(settledOf(lines), { 'security.1': 'contested', 'security.2': 'contested' });
    const check = JSON.parse(readFileSync(join(dir, 'participants', 'defender', 'security', 'rounds', '1', 'turn-check.schema.json'), 'utf8')) as {
      properties: { responses: { minItems: number; items: { properties: { finding: { enum: string[] } } } } };
    };
    assert.deepEqual(check.properties.responses.items.properties.finding.enum, ['security.1', 'security.2']);
    assert.equal(check.properties.responses.minItems, 2);
  });

  it('ревьюер без находок ветки не получает и назван агрегатору с причиной', async () => {
    const project = defendRepo();
    const impl = implementer();
    const tests = reviewer('tests', undefined, []);
    const agg = verdict();
    const result = await run(project, { impl, 'rev-0': reviewer('security'), 'rev-1': tests, agg, def: defender() });

    assert.equal(result.status, 'success');
    assert.equal(defenseTurns(impl).length, 1);
    assert.equal(tests.invocations.length, 1);
    assert.match(agg.invocations[0]?.prompt ?? '', /## Ревьюеры без находок\n\n- `tests`: находок нет/);
  });
});

describe('review-defend: свежий защитник', () => {
  // Сценарий: «Без имплементатора»
  it('шаг без implementer: свежий агент defender с причиной no_implementer, промпт несёт задание и указания стратегии', async () => {
    const project = defendRepo({ implementer: null });
    const impl = implementer();
    const def = defender();
    const result = await run(project, { impl, 'rev-0': reviewer('security'), 'rev-1': reviewer('tests'), agg: verdict(), def });

    assert.equal(result.status, 'success');
    const { lines } = defenseOf(result);
    assert.deepEqual(lines[0], { kind: 'defender', mode: 'fresh', agent: 'def', reason: 'no_implementer' });
    assert.equal(impl.invocations.length, 1, 'имплементатор не форкается');
    assert.equal(def.invocations.length, 2);
    const prompt = def.invocations[0]?.prompt ?? '';
    assert.match(prompt, /проверь дифф/);
    assert.match(prompt, /Защищай по коду\./);
    assert.match(prompt, /вместо его автора/);
    assert.equal(def.invocations[0]?.forkFrom, undefined);
    assert.equal(def.invocations[0]?.resumeSession, false);
    assert.match(readFileSync(join(defenseOf(result).dir, 'participants', 'defender', 'security', 'rounds', '1', 'step.json'), 'utf8'), /"origin"/);
    const event = readEvents(result.journal.paths).find((entry) => entry.kind === 'review.defender');
    assert.deepEqual(event?.kind === 'review.defender' ? [event.mode, event.reason, event.implementer] : [], ['fresh', 'no_implementer', undefined]);
    assert.match(readFileSync(join(defenseOf(result).dir, 'participants', 'aggregator', 'prompt.txt'), 'utf8'), /свежий агент .*шаг не назвал имплементатора/);
  });

  // Сценарий: «Бэкенд без форка»
  it('бэкенд имплементатора без forkSessions: mode fresh, reason no_fork, промпт несёт текстовый выход имплементатора', async () => {
    const project = defendRepo();
    const impl = implementer(undefined, { capabilities: { forkSessions: false } });
    const def = defender();
    const result = await run(project, { impl, 'rev-0': reviewer('security'), 'rev-1': reviewer('tests'), agg: verdict(), def });

    assert.equal(result.status, 'success');
    assert.deepEqual(defenseOf(result).lines[0], { kind: 'defender', mode: 'fresh', implementer: 'review.implement', agent: 'def', reason: 'no_fork' });
    assert.equal(impl.invocations.length, 1);
    assert.ok(impl.invocations.every((invocation) => invocation.forkFrom === undefined), 'адаптер без форка forkFrom не получает');
    assert.match(def.invocations[0]?.prompt ?? '', /## Отчёт имплементатора `review\.implement`\n\nСделал: добавил проверку прав/);
  });

  // Сценарий: «Бэкенд имплементатора с форком, но без схемы» (backend-structured-output)
  it('бэкенд имплементатора с форком, но без схемы: mode fresh, reason no_schema', async () => {
    const project = defendRepo();
    const impl = implementer(undefined, { capabilities: { structuredOutput: false } });
    const def = defender();
    const result = await run(project, { impl, 'rev-0': reviewer('security'), 'rev-1': reviewer('tests'), agg: verdict(), def });

    assert.equal(result.status, 'success');
    assert.deepEqual(defenseOf(result).lines[0], { kind: 'defender', mode: 'fresh', implementer: 'review.implement', agent: 'def', reason: 'no_schema' });
    assert.ok(impl.invocations.every((invocation) => invocation.forkFrom === undefined), 'форка нет');
    assert.match(readFileSync(join(defenseOf(result).dir, 'participants', 'aggregator', 'prompt.txt'), 'utf8'), /не умеет ответ по схеме/);
  });

  // Сценарий: «Ревьюер на бэкенде без схемы»
  it('ревьюер на бэкенде без какой-либо схемы: отказ до старта с адресом участника', async () => {
    const project = defendRepo();
    // Ответы не важны: участник отклоняется до первого вызова.
    const security = responding(() => ({}), { capabilities: { structuredOutput: false } });
    await assert.rejects(
      run(project, { impl: implementer(), 'rev-0': security, 'rev-1': reviewer('tests'), agg: verdict(), def: defender() }),
      /Бэкенд rev-0 не поддерживает структурированный вывод, нужный для output_schema шага review\/review-diff\/security/,
    );
    assert.equal(security.invocations.length, 0);
  });

  it('у записи имплементатора нет сессии: reason no_session', async () => {
    const project = defendRepo();
    // Бэкенд сам выдаёт нить, но не назвал её: сессии у шага нет.
    const impl = implementer(undefined, { capabilities: { forkSessions: true, sessionIdSource: 'backend' } });
    const def = defender();
    const result = await run(project, { impl, 'rev-0': reviewer('security'), 'rev-1': reviewer('tests'), agg: verdict(), def });

    assert.equal(result.status, 'success');
    assert.deepEqual(defenseOf(result).lines[0], { kind: 'defender', mode: 'fresh', implementer: 'review.implement', agent: 'def', reason: 'no_session' });
    assert.equal(def.invocations.length, 2);
  });

  it('свежий защитник на бэкенде без сессий: каждый ход несёт задание и всю ветку', async () => {
    const strategy = STRATEGY().replace('  - id: tests\n    agent: rev-1\n', '');
    const project = defendRepo({ implementer: null, strategy });
    const def = defender(() => 'dispute', { capabilities: { sessions: false } });
    const result = await run(project, { impl: implementer(), 'rev-0': reviewer('security'), agg: verdict(), def });

    assert.equal(result.status, 'success');
    const second = def.invocations[1]?.prompt ?? '';
    assert.match(second, /проверь дифф/);
    assert.match(second, /## Ветка защиты/);
    assert.match(second, /#### m1 — Защитник, раунд 1/);
    assert.match(second, /#### m2 — Ревьюер `security`, раунд 1/);
    const degraded = readEvents(result.journal.paths).flatMap((event) =>
      event.kind === 'backend.degraded' && event.backend === 'def' && event.capability === 'sessions' ? [event.detail] : [],
    );
    assert.ok(degraded.some((detail) => /защитник шага review\/review-diff защищает находки без сессии/.test(detail)), degraded.join('; '));
  });
});

describe('review-defend: бюджет и повтор агрегатора', () => {
  it('перейдённый бюджет обрывает все ветки: шаг budget_exceeded без агрегатора', async () => {
    // Ревьюеры — 40 токенов, ход защитника — ещё 20: потолок 50 перейдён до
    // ходов ревьюеров, какая бы ветка ни шла первой.
    const project = defendRepo({ stepExtra: '        budget: { tokens: 50 }\n' });
    const impl = implementer(() => 'dispute');
    const security = reviewer('security');
    const tests = reviewer('tests');
    const agg = verdict();
    const result = await run(project, { impl, 'rev-0': security, 'rev-1': tests, agg, def: defender() });

    assert.equal(result.status, 'budget_exceeded');
    assert.equal(agg.invocations.length, 0);
    assert.equal(rebuttals(security).length + rebuttals(tests).length, 0);
    const { lines } = defenseOf(result);
    assert.deepEqual(lines.at(-1), { kind: 'outcome', accepted: 0, withdrawn: 0, contested: 3 });
  });

  it('провал expect агрегатора: следующая попытка — только агрегатор с той же защитой', async () => {
    const project = defendRepo({
      stepExtra: '        expect: [{ matches: APPROVED }]\n        attempts: { max: 2, escalation: [{ include_failure: true }] }\n',
    });
    const impl = implementer();
    const agg = createFakeBackend({
      lines: (index) => [initLine(), resultLine({ text: index === 0 ? 'REJECTED' : 'APPROVED', structured: { verdict: index === 0 ? 'REJECTED' : 'APPROVED' } })],
    });
    const result = await run(project, { impl, 'rev-0': reviewer('security'), 'rev-1': reviewer('tests'), agg, def: defender() });

    assert.equal(result.status, 'success');
    assert.equal(agg.invocations.length, 2);
    assert.equal(defenseTurns(impl).length, 2, 'защита не повторяется');
    assert.match(agg.invocations[1]?.prompt ?? '', /Статус: accepted/);
    assert.match(agg.invocations[1]?.prompt ?? '', /Прошлая попытка не прошла проверку/);
    assert.equal(defenseOf(result).lines.filter((line) => line.kind === 'outcome').length, 1);
  });
});

describe('review-defend: имплементатор в документе', () => {
  // Сценарий: «Шаг работы-предка»
  it('build.implement работы-предка принят; ссылка нормализована и входит в замок', () => {
    const project = defendRepo({ body: CROSS_JOB('build.implement') });
    const expanded = expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config });
    assert.deepEqual(reviewStepOf(expanded).implementer, { job: 'build', step: 'implement' });
    assert.match(serializeLock(expanded.pipeline), /implementer: build\.implement/);
  });

  // Сценарий: «Не агентский шаг»
  it('implementer на шаг run: отказ раскрытия с названием шага и требованием агентского', () => {
    const project = defendRepo({ body: CROSS_JOB('build.check') });
    const error = rejection(() => expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config }));
    assert.match(error.message, /build\.check/);
    assert.match(error.message, /имплементатор — агентский шаг/);
    assert.equal(error.at, 'jobs.review.steps.0.implementer');
  });

  // Сценарий: «Работа вне зависимостей»
  it('шаг работы, от которой review не зависит, и несуществующий шаг — отказ', () => {
    const outside = defendRepo({ body: CROSS_JOB('other.implement') });
    assert.match(
      rejection(() => expandPipeline({ pipelinePath: outside.path('burnex.yml'), config: outside.config })).message,
      /не зависит от работы other/,
    );
    const missing = defendRepo({ body: CROSS_JOB('build.nope') });
    assert.match(rejection(() => expandPipeline({ pipelinePath: missing.path('burnex.yml'), config: missing.config })).message, /такого шага нет/);
  });

  it('шаг своей работы после review — отказ', () => {
    const project = defendRepo({
      body: `version: 1
kind: pipeline
name: p
jobs:
  review:
    steps:
      - id: review-diff
        review: ./strategies/panel.yml
        prompt: проверь дифф
        output_schema: verdict.json
        implementer: implement
      - id: implement
        agent: impl
        prompt: реализуй
`,
    });
    assert.match(rejection(() => expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config })).message, /не раньше шага review/);
  });

  it('ключ шага: ссылка входит, запись implement и review.implement дают один ключ', () => {
    const project = defendRepo();
    const original = readFileSync(project.path('burnex.yml'), 'utf8');
    const keyOf = (implementer: string | null): string => {
      writeFileSync(
        project.path('burnex.yml'),
        implementer === null ? original.replace(/\s+implementer: .*\n/, '\n') : original.replace(/implementer: .*/, `implementer: ${implementer}`),
      );
      const expanded = expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config });
      const job = expanded.pipeline.jobs[0]!;
      return computeStepKey({
        lockHash: jobLockHash(expanded.pipeline, job),
        jobId: job.id,
        step: reviewStepOf(expanded),
        inputsFingerprint: undefined,
        backendCommand: undefined,
        upstream: [],
      });
    };
    assert.equal(keyOf('implement'), keyOf('review.implement'));
    assert.notEqual(keyOf('implement'), keyOf(null));
  });

  it('линт: implementer при режиме independent — ошибка у ключа implementer', () => {
    const project = defendRepo({ strategy: STRATEGY().replace('mode: defend\n', 'mode: independent\n').replace(/defender:\n.*\n.*\n/, '') });
    const expanded = expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config });
    const diagnostics = lintPipeline(expanded, { config: project.config, cwd: project.root });
    const found = diagnostics.find((entry) => entry.at === 'jobs.review.steps.1.implementer');
    assert.equal(found?.severity, 'error');
    assert.match(found?.message ?? '', /режиме independent/);
    // В режиме defend то же поле — не ошибка.
    const ok = defendRepo();
    const clean = lintPipeline(expandPipeline({ pipelinePath: ok.path('burnex.yml'), config: ok.config }), { config: ok.config, cwd: ok.root });
    assert.equal(clean.find((entry) => entry.at?.endsWith('.implementer')), undefined);
  });
});

describe('review-defend: имплементатор, переиспользованный при возобновлении', () => {
  it('форк берёт сессию имплементатора из исходного прогона', async () => {
    const project = defendRepo({ body: CROSS_JOB('build.implement').replace(/  other:\n[\s\S]*?(?=  review:)/, '') });
    const backends = () => ({ impl: implementer(), 'rev-0': reviewer('security'), 'rev-1': reviewer('tests'), agg: verdict(), def: defender() });
    const first = backends();
    const source = await run(project, first);
    assert.equal(source.status, 'success');
    const sourceSession = readStatus(source.journal.paths).jobs.find((job) => job.id === 'build')?.steps[0]?.session;
    assert.equal(sourceSession, first.impl.invocations[0]?.sessionId);

    const expanded = expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config });
    const sourceRun = readSourceRun(source.journal.paths);
    const plan = buildResumePlan({ expanded, config: project.config, source: sourceRun, changed: [], cwd: project.root, from: parseFrom('review') });
    assert.equal(plan.steps.find((entry) => entry.step === 'implement')?.decision.kind, 'reuse');
    const second = backends();
    const resumed = await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: dirname(source.journal.paths.projectDir) } },
      projectRoot: project.root,
      cwd: project.root,
      baseEnv: testBaseEnv(),
      resume: { plan, source: sourceRun },
      adapterFor: (name) => (second[name as keyof typeof second] as FakeBackend).adapter,
    });
    assert.equal(resumed.status, 'success');
    const forks = second.impl.invocations;
    assert.equal(forks.length, 2, 'имплементатор не исполнялся — только ходы форков');
    assert.ok(forks.every((invocation) => invocation.forkFrom === sourceSession));
    assert.deepEqual(defenseOf(resumed).lines[0], { kind: 'defender', mode: 'fork', implementer: 'build.implement', agent: 'impl' });
  });
});

describe('review-defend: форк в адаптерах и исполнении шага', () => {
  const CONFIG: BackendConfig = {
    command: 'cli',
    enabled: true,
    defaultModel: undefined,
    concurrency: 1,
    cacheReadWeight: 0.1,
    sessions: true,
    structuredOutput: true,
    strictPermissions: true,
    mcp: true,
    permissions: undefined,
    env: {},
  };

  it('Claude: --resume <forkFrom> --fork-session --session-id <выданный>; возможность — под sessions', () => {
    const adapter = createClaudeAdapter({ ...CONFIG, command: 'claude' });
    assert.equal(adapter.capabilities.forkSessions, true);
    assert.equal(createClaudeAdapter({ ...CONFIG, sessions: false }).capabilities.forkSessions, false);
    const fork = adapter.launch({ prompt: 'p', cwd: '/tmp', sessionId: 'new', resumeSession: false, forkFrom: 'S' });
    const at = fork.command.indexOf('--resume');
    assert.deepEqual(fork.command.slice(at, at + 5), ['--resume', 'S', '--fork-session', '--session-id', 'new']);
    assert.equal(fork.command.filter((arg) => arg === '--session-id').length, 1);
    // Продолжение форка — обычный --resume своей сессии.
    const resumed = adapter.launch({ prompt: 'p', cwd: '/tmp', sessionId: 'new', resumeSession: true });
    assert.ok(!resumed.command.includes('--fork-session'));
    assert.equal(resumed.command[resumed.command.indexOf('--resume') + 1], 'new');
  });

  // Сценарий: «Codex»
  it('Codex: команда начинается с codex exec fork T с прочими опциями; нить — из thread.started', () => {
    const adapter = createCodexAdapter({ ...CONFIG, command: 'codex' });
    assert.equal(adapter.capabilities.forkSessions, true);
    const launch = adapter.launch({ prompt: 'p', cwd: '/tmp', resumeSession: false, forkFrom: 'T', model: 'o3', outputSchemaPath: '/tmp/s.json' });
    assert.deepEqual(launch.command.slice(0, 4), ['codex', 'exec', 'fork', 'T']);
    assert.ok(launch.command.includes('--json'));
    assert.equal(launch.command[launch.command.indexOf('-m') + 1], 'o3');
    assert.equal(launch.command[launch.command.indexOf('--output-schema') + 1], '/tmp/s.json');
    assert.equal(launch.command.at(-1), '-');
    const started = adapter.parseLine('{"type":"thread.started","thread_id":"T2"}');
    assert.equal(started.kind === 'init' || started.kind === 'session_started' ? started.sessionId : undefined, 'T2');
    // Продолжение нити форка — форма resume.
    const resumed = adapter.launch({ prompt: 'p', cwd: '/tmp', sessionId: 'T2', resumeSession: true, forkFrom: 'T' });
    assert.deepEqual(resumed.command.slice(0, 4), ['codex', 'exec', 'resume', 'T2']);
  });

  const agentStep = (overrides: Partial<AgentStep> = {}): AgentStep =>
    ({
      kind: 'agent', id: 'turn', index: 1, env: {}, context: [], contextInherit: true, contextExclude: [], timeoutMs: 5_000,
      expect: [], attempts: { max: 2, escalation: [] }, agent: 'fake', session: 'step/defender/security', prompt: 'ход',
      forkFrom: 'S', ...overrides,
    }) as AgentStep;

  it('forkFrom уходит только на первом вызове псевдонима и только адаптеру с forkSessions', async () => {
    const dir = tempDir('fork-');
    const backend = createFakeBackend({ lines: [initLine(), resultLine({ text: 'ок' })], capabilities: { forkSessions: true } });
    const sessions = createSessionRegistry();
    const call = { adapter: backend.adapter, cwd: dir, stepDir: dir, sessions, buildPrompt: () => 'ход', env: () => ({ PATH: process.env.PATH ?? '' }) };
    await executeAgentStep({ ...call, step: agentStep() });
    await executeAgentStep({ ...call, step: agentStep() });
    assert.equal(backend.invocations[0]?.forkFrom, 'S');
    assert.equal(backend.invocations[1]?.forkFrom, undefined);
    assert.equal(backend.invocations[1]?.resumeSession, true);
    assert.equal(backend.invocations[1]?.sessionId, backend.invocations[0]?.sessionId);

    const plain = createFakeBackend({ lines: [initLine(), resultLine({ text: 'ок' })] });
    await executeAgentStep({ ...call, adapter: plain.adapter, sessions: createSessionRegistry(), step: agentStep() });
    assert.equal(plain.invocations[0]?.forkFrom, undefined);
  });

  it('неудачный форк — сбой попытки, и следующая попытка форкает снова', async () => {
    const dir = tempDir('fork-');
    const backend = createFakeBackend({
      lines: (index) => (index === 0 ? [] : [initLine(), resultLine({ text: 'ок' })]),
      exitCode: (index) => (index === 0 ? 1 : 0),
      capabilities: { forkSessions: true },
    });
    const result = await executeAgentStep({
      step: agentStep(),
      adapter: backend.adapter,
      cwd: dir,
      stepDir: dir,
      sessions: createSessionRegistry(),
      buildPrompt: () => 'ход',
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });
    assert.equal(result.status, 'success');
    assert.equal(result.attempts[0]?.status, 'failed');
    assert.equal(backend.invocations[1]?.forkFrom, 'S');
    assert.equal(backend.invocations[1]?.resumeSession, false);
  });

  it('проверочная схема хода: ровно открытые id, revise требует серьёзность', () => {
    const check = turnCheckSchema('rebuttal', ['a.1', 'a.2']) as {
      properties: { responses: { minItems: number; maxItems: number; allOf: unknown[]; items: { then: unknown } } };
    };
    assert.equal(check.properties.responses.minItems, 2);
    assert.equal(check.properties.responses.maxItems, 2);
    assert.equal(check.properties.responses.allOf.length, 2);
    assert.deepEqual(check.properties.responses.items.then, { properties: { severity: { type: 'string', enum: ['critical', 'major', 'minor', 'info'] } } });
  });
});

describe('named-workspace-trees: форк защитника только из дерева имплементатора', () => {
  const withTrees = (body: string, buildTree?: string): string =>
    body
      .replace('name: p\n', 'name: p\nworkspace: { mode: worktree, trees: [main, b] }\n')
      .replace(/ {2}other:\n[\s\S]*?(?= {2}review:)/, `  docs:\n    needs: [build]\n    steps: [{ id: c, run: [node, -e, ""] }]\n`)
      .replace('  build:\n', `  build:\n${buildTree === undefined ? '' : `    workspace: { tree: ${buildTree} }\n`}`);
  const backends = () => ({ impl: implementer(), 'rev-0': reviewer('security'), 'rev-1': reviewer('tests'), agg: verdict(), def: defender() });

  it('из той же работы в worktree: форк', async () => {
    const project = defendRepo();
    writeFileSync(project.path('burnex.yml'), readFileSync(project.path('burnex.yml'), 'utf8').replace('name: p\n', 'name: p\nworkspace: { mode: worktree }\n'));
    gitCommit(project.root, 'worktree');
    const result = await run(project, backends());
    assert.equal(result.status, 'success');
    assert.equal(defenseOf(result).lines[0]?.mode, 'fork');
  });

  // Сценарий: «Имплементатор в том же дереве другой работы» — у build два
  // потомка, а каталог всё равно один.
  it('из другой работы того же дерева при развилке: форк, каталог один', async () => {
    const project = defendRepo({ body: withTrees(CROSS_JOB('build.implement')) });
    const result = await run(project, backends());
    assert.equal(result.status, 'success');
    const jobs = readStatus(result.journal.paths).jobs;
    const path = (id: string) => jobs.find((job) => job.id === id)?.workspace?.path;
    assert.equal(path('review'), path('build'));
    assert.equal(path('docs'), path('build'));
    assert.deepEqual(defenseOf(result).lines[0], { kind: 'defender', mode: 'fork', implementer: 'build.implement', agent: 'impl' });
  });

  // Сценарий: «Имплементатор в другом дереве»
  it('из другого дерева: свежий защитник с причиной other_tree, линт предупреждает', async () => {
    const project = defendRepo({ body: withTrees(CROSS_JOB('build.implement'), 'b') });
    const expanded = expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config });
    const warning = lintPipeline(expanded, { config: project.config, cwd: project.root }).find((item) => item.at === 'jobs.review.steps.0.implementer');
    assert.equal(warning?.severity, 'warning');
    const all = backends();
    const result = await run(project, all);
    assert.equal(result.status, 'success');
    assert.equal(all.impl.invocations.length, 1, 'имплементатор не форкается');
    assert.deepEqual(defenseOf(result).lines[0], { kind: 'defender', mode: 'fresh', implementer: 'build.implement', agent: 'def', reason: 'other_tree' });
  });
});
