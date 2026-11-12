import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { BurnexError } from '../src/kernel/errors.js';
import { createFakeBackend, initLine, resultLine, type FakeBackend } from '../src/parts/pipeline/backend/fake.js';
import type { BackendCapabilities } from '../src/parts/pipeline/backend/types.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { serializeLock } from '../src/parts/pipeline/document/lock.js';
import type { ReviewStep } from '../src/parts/pipeline/document/model.js';
import { parseReviewStrategyFile } from '../src/parts/pipeline/document/reviewStrategy.js';
import { findStepDir, readEvents, readUsage } from '../src/parts/pipeline/run/journal/reader.js';
import { buildResumePlan, readSourceRun } from '../src/parts/pipeline/run/resumePlan.js';
import { runPipeline, type RunResult } from '../src/parts/pipeline/run/runner.js';
import { readReviewFeed } from '../src/parts/ui/reviewFeed.js';
import { findConsensus, type MessageRecord } from '../src/parts/pipeline/steps/review/discussion.js';
import { gitCommit, gitInit, makeProject, testBaseEnv, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * `review-discussion`: режим `discussion` стратегии ревью — раунды реплик
 * через движок, консенсус по позициям, агрегатор и лента `discussion.ndjson`.
 */

const STRATEGY = (reviewers: readonly string[], discussion = 'mode: discussion\ndiscussion: { max_messages: 3 }\n') =>
  `version: 1
kind: review-strategy
name: panel
reviewers:
${reviewers.map((id, index) => `  - id: ${id}\n    agent: rev-${index}\n`).join('')}aggregator:
  agent: agg
${discussion}`;

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

describe('review-discussion: документ', () => {
  it('режим discussion с двумя ревьюерами и лимитом принят; лимит виден в шаге и замке', () => {
    const raw = parseReviewStrategyFile(strategyFile(STRATEGY(['security', 'tests'], 'mode: discussion\ndiscussion: { max_messages: 10 }\n')), []);
    assert.equal(raw.mode, 'discussion');
    assert.equal(raw.discussion?.max_messages, 10);

    const project = reviewRepo(['security', 'tests']);
    const expanded = expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config });
    const step = expanded.pipeline.jobs[0]?.steps[0] as ReviewStep;
    assert.equal(step.mode, 'discussion');
    assert.equal(step.maxMessages, 3);
    assert.match(serializeLock(expanded.pipeline), /mode: discussion\n\s+discussion:\n\s+max_messages: 3/);
  });

  it('нет лимита: отказ с путём discussion.max_messages', () => {
    const error = rejection(() => parseReviewStrategyFile(strategyFile(STRATEGY(['a', 'b'], 'mode: discussion\n')), []));
    assert.equal(error.at, 'discussion.max_messages');
    assert.match(error.message, /лимит реплик/);
  });

  it('пустой блок discussion: отказ с путём discussion.max_messages', () => {
    const error = rejection(() => parseReviewStrategyFile(strategyFile(STRATEGY(['a', 'b'], 'mode: discussion\ndiscussion: {}\n')), []));
    assert.equal(error.at, 'discussion.max_messages');
  });

  it('лимит вне 1–50 и дробный отклоняются с путём ключа', () => {
    for (const value of ['0', '51', '2.5']) {
      const error = rejection(() =>
        parseReviewStrategyFile(strategyFile(STRATEGY(['a', 'b'], `mode: discussion\ndiscussion: { max_messages: ${value} }\n`)), []),
      );
      assert.equal(error.at, 'discussion.max_messages', value);
    }
  });

  it('блок discussion при другом режиме отклоняется', () => {
    for (const mode of ['mode: independent\n', '']) {
      const error = rejection(() =>
        parseReviewStrategyFile(strategyFile(STRATEGY(['a', 'b'], `${mode}discussion: { max_messages: 3 }\n`)), []),
      );
      assert.equal(error.at, 'discussion');
      assert.match(error.message, /только при mode: discussion/);
    }
  });

  it('один ревьюер: отказ — обсуждению нужны хотя бы два', () => {
    const error = rejection(() => parseReviewStrategyFile(strategyFile(STRATEGY(['solo'])), []));
    assert.equal(error.at, 'reviewers');
    assert.match(error.message, /хотя бы два ревьюера/);
  });
});

describe('review-discussion: консенсус', () => {
  const message = (from: string, stance: MessageRecord['stance'], ref: string): MessageRecord => ({
    kind: 'message',
    messageId: `m-${from}`,
    role: 'agent',
    from,
    round: 1,
    seq: 1,
    parts: [],
    stance,
    ...(stance === 'propose' ? { proposal: ref } : { target: ref }),
  });

  it('автор без новых реплик и согласные — консенсус; несогласный или другое предложение — нет', () => {
    const agreed = new Map([
      ['a', message('a', 'propose', 'p2')],
      ['b', message('b', 'agree', 'p2')],
    ]);
    assert.equal(findConsensus(agreed), 'p2');
    assert.equal(findConsensus(new Map([...agreed, ['c', message('c', 'disagree', 'p2')]])), undefined);
    assert.equal(findConsensus(new Map([...agreed, ['c', message('c', 'agree', 'p1')]])), undefined);
  });
});

// --- Исполнение на поддельных бэкендах.

const SCHEMA = '{"type":"object","properties":{"verdict":{"type":"string"}},"required":["verdict"]}\n';

function reviewRepo(
  reviewers: readonly string[],
  options: { readonly discussion?: string; readonly stepExtra?: string; readonly jobExtra?: string; readonly strategy?: string } = {},
): Project {
  const project = makeProject({
    'burnex.yml': `version: 1
kind: pipeline
name: p
jobs:
  review:
${options.jobExtra ?? ''}    output: { from: review-diff }
    steps:
      - id: review-diff
        review: ./strategies/panel.yml
        prompt: проверь дифф
        output_schema: verdict.json
${options.stepExtra ?? ''}`,
    'verdict.json': SCHEMA,
    'strategies/panel.yml': options.strategy ?? STRATEGY(reviewers, options.discussion),
  });
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

const findings = (title: string) => ({
  summary: `находка: ${title}`,
  findings: [{ severity: 'major', title, location: null, detail: title, suggestion: null }],
});
const agree = (target: string, text = `согласен с ${target}`) => ({ text, stance: 'agree', proposal: null, target, reply_to: null });
const disagree = (target: string) => ({ text: `против ${target}`, stance: 'disagree', proposal: null, target, reply_to: null });
const propose = (title: string, replyTo: string[] | null = null) => ({
  text: `предлагаю ${title}`,
  stance: 'propose',
  proposal: findings(title),
  target: null,
  reply_to: replyTo,
});

/**
 * Ревьюер по сценарию: `n`-й ответ — `n`-й вызов его бэкенда (раунд 0 —
 * находки, затем реплики); последний повторяется. `hang` — задержка вызова,
 * чтобы проверить порядок записей при обратном порядке ответов.
 */
function scripted(
  replies: readonly unknown[],
  tokens = 10,
  hang: (index: number) => number = () => 0,
  capabilities: Partial<BackendCapabilities> = {},
): FakeBackend {
  return createFakeBackend({
    lines: (index) => [
      initLine(),
      resultLine({ structured: replies[Math.min(index, replies.length - 1)], tokensIn: tokens, tokensOut: tokens }),
    ],
    hangMs: hang,
    capabilities,
  });
}

const verdict = () => scripted([{ verdict: 'APPROVED' }]);

interface Feed {
  readonly records: readonly Record<string, unknown>[];
  readonly dir: string;
}

function feedOf(result: RunResult): Feed {
  const dir = findStepDir(result.journal.paths, 'review', 'review-diff');
  assert.ok(dir !== undefined);
  const records = readFileSync(join(dir, 'discussion.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { records, dir };
}

const shape = (records: readonly Record<string, unknown>[]) =>
  records.map((record) =>
    record.kind === 'proposal'
      ? `${String(record.id)}<${String(record.by)}`
      : record.kind === 'message'
        ? `${String(record.messageId)}:${String(record.from)}:${String(record.stance)}:${String(record.proposal ?? record.target ?? '')}${record.invalid === true ? '!' : ''}`
        : record.consensus === true
          ? `consensus:${String(record.proposal)}`
          : `no_consensus:${String(record.reason)}`,
  );

describe('review-discussion: раунды', () => {
  it('консенсус во втором раунде: лента, только новые реплики, возобновление сессий, события и расход', async () => {
    const project = reviewRepo(['security', 'tests', 'architecture']);
    // security отвечает в раунде 1 позже всех: порядок записей — порядок стратегии.
    const security = scripted([findings('секрет'), disagree('p3'), agree('p4')], 10, (index) => (index === 1 ? 300 : 0));
    const tests = scripted([findings('тест'), disagree('p3'), agree('p4')]);
    const architecture = scripted([findings('слой'), propose('итог', ['m1', 'm2']), agree('p4')]);
    const agg = verdict();
    const result = await run(project, { 'rev-0': security, 'rev-1': tests, 'rev-2': architecture, agg });

    assert.equal(result.status, 'success');
    const { records, dir } = feedOf(result);
    assert.deepEqual(shape(records), [
      'p1<security', 'm1:security:propose:p1',
      'p2<tests', 'm2:tests:propose:p2',
      'p3<architecture', 'm3:architecture:propose:p3',
      'm4:security:disagree:p3', 'm5:tests:disagree:p3', 'p4<architecture', 'm6:architecture:propose:p4',
      'm7:security:agree:p4', 'm8:tests:agree:p4', 'm9:architecture:agree:p4',
      'consensus:p4',
    ]);
    // Форма A2A Message и метаданные движка.
    assert.deepEqual(records[9], {
      kind: 'message', messageId: 'm6', role: 'agent', from: 'architecture', round: 1, seq: 3,
      parts: [{ kind: 'text', text: 'предлагаю итог' }], stance: 'propose', proposal: 'p4', replyTo: ['m1', 'm2'],
    });
    assert.deepEqual(records[8], { kind: 'proposal', id: 'p4', by: 'architecture', round: 1, content: findings('итог') });
    assert.deepEqual(records[0], { kind: 'proposal', id: 'p1', by: 'security', round: 0, content: findings('секрет') });

    // Раунд 1: security получает находки остальных, но не свои; раунд 2 —
    // только две реплики раунда 1 других ревьюеров.
    const round1 = security.invocations[1]?.prompt ?? '';
    assert.match(round1, /### m2 — `tests`/);
    assert.match(round1, /### m3 — `architecture`/);
    assert.doesNotMatch(round1, /### m1 /);
    const round2 = security.invocations[2]?.prompt ?? '';
    assert.match(round2, /раунд 2/);
    assert.match(round2, /### m5 — `tests`/);
    assert.match(round2, /### m6 — `architecture`.*\n\nВ ответ на: m1, m2/);
    assert.match(round2, /"title": "итог"/);
    assert.doesNotMatch(round2, /### m[1-4] /);
    // Сессия ревьюера возобновляется, контекст шага не повторяется.
    assert.equal(security.invocations[1]?.resumeSession, true);
    assert.equal(security.invocations[1]?.sessionId, security.invocations[0]?.sessionId);
    assert.doesNotMatch(round1, /проверь дифф/);
    assert.match(security.invocations[1]?.outputSchemaPath ?? '', /review-message\.schema\.json$/);
    assert.ok(existsSync(join(dir, 'participants', 'security', 'rounds', '2', 'output.json')));

    // Агрегатор оформляет согласованное предложение, не меняя решения.
    const aggPrompt = agg.invocations[0]?.prompt ?? '';
    assert.match(aggPrompt, /Согласованное предложение p4/);
    assert.match(aggPrompt, /не меняя решения/);
    assert.match(aggPrompt, /"title": "итог"/);
    assert.doesNotMatch(aggPrompt, /секрет/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'output.json'), 'utf8')), { verdict: 'APPROVED' });

    // События: реплика каждого раунда — до начала следующего раунда.
    const events = readEvents(result.journal.paths);
    const messages = events.flatMap((event) => (event.kind === 'review.message' ? [event] : []));
    assert.deepEqual(messages.map((event) => event.message_id), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']);
    assert.deepEqual(
      { participant: messages[5]?.participant, round: messages[5]?.round, stance: messages[5]?.stance, proposal: messages[5]?.proposal },
      { participant: 'architecture', round: 1, stance: 'propose', proposal: 'p4' },
    );
    const position = (predicate: (event: (typeof events)[number]) => boolean) => events.findIndex(predicate);
    assert.ok(
      position((event) => event.kind === 'review.message' && event.message_id === 'm6') <
        position((event) => event.kind === 'review.participant.started' && event.round === 2),
    );
    assert.deepEqual(
      events.flatMap((event) => (event.kind === 'review.consensus' ? [event.proposal] : event.kind === 'review.no_consensus' ? ['нет'] : [])),
      ['p4'],
    );

    // Расход каждого ревьюера — сумма всех его вызовов, не последнего.
    const usage = readUsage(result.journal.paths).jobs.review?.steps['review-diff'];
    assert.equal(usage?.participants?.security?.billable_tokens, 60);
    assert.equal(usage?.billable_tokens, 200);
  });

  it('исчерпан лимит: движок больше не запускает ревьюера, исход limit, агрегатор решает по ленте', async () => {
    const project = reviewRepo(['security', 'tests'], { discussion: 'mode: discussion\ndiscussion: { max_messages: 2 }\n' });
    const security = scripted([findings('секрет'), disagree('p2'), disagree('p3')]);
    const tests = scripted([findings('тест'), propose('вариант 1'), propose('вариант 2')]);
    const agg = verdict();
    const result = await run(project, { 'rev-0': security, 'rev-1': tests, agg });

    assert.equal(result.status, 'success');
    assert.equal(security.invocations.length, 3);
    assert.equal(tests.invocations.length, 3);
    const { records } = feedOf(result);
    assert.deepEqual(shape(records).slice(4), [
      'm3:security:disagree:p2', 'p3<tests', 'm4:tests:propose:p3',
      'm5:security:disagree:p3', 'p4<tests', 'm6:tests:propose:p4',
      'no_consensus:limit',
    ]);
    const aggPrompt = agg.invocations[0]?.prompt ?? '';
    assert.match(aggPrompt, /исчерпан лимит реплик/);
    assert.match(aggPrompt, /### m5 — `security`, раунд 2: disagree с p3/);
    assert.match(aggPrompt, /## Действующие позиции\n\n- `security`: disagree p3 \(m5\)\n- `tests`: propose p4 \(m6\)/);
    assert.match(aggPrompt, /вынеси итог сам/);
    assert.ok(readEvents(result.journal.paths).some((event) => event.kind === 'review.no_consensus' && event.reason === 'limit'));
  });

  it('раунд без изменений: исход stalled', async () => {
    const project = reviewRepo(['security', 'tests'], { discussion: 'mode: discussion\ndiscussion: { max_messages: 5 }\n' });
    const security = scripted([findings('секрет'), disagree('p2')]);
    const tests = scripted([findings('тест'), disagree('p1')]);
    const agg = verdict();
    const result = await run(project, { 'rev-0': security, 'rev-1': tests, agg });

    assert.equal(result.status, 'success');
    assert.equal(security.invocations.length, 3);
    assert.deepEqual(shape(feedOf(result).records).at(-1), 'no_consensus:stalled');
    assert.match(agg.invocations[0]?.prompt ?? '', /раунд не изменил ни одной позиции/);
  });

  it('дважды невалидная реплика засчитана disagree с отметкой и расходует лимит', async () => {
    const project = reviewRepo(['security', 'tests'], { discussion: 'mode: discussion\ndiscussion: { max_messages: 1 }\n' });
    const security = scripted([findings('секрет'), agree('p2')]);
    // Цель вне известных предложений, затем propose без предложения.
    const tests = scripted([findings('тест'), agree('p9'), { ...propose('x'), proposal: null }]);
    const agg = verdict();
    const result = await run(project, { 'rev-0': security, 'rev-1': tests, agg });

    assert.equal(result.status, 'success');
    assert.equal(tests.invocations.length, 3);
    assert.match(tests.invocations[2]?.prompt ?? '', /Прошлая попытка не прошла проверку/);
    const { records } = feedOf(result);
    assert.deepEqual(shape(records).slice(4), ['m3:security:agree:p2', 'm4:tests:disagree:!', 'no_consensus:limit']);
    assert.deepEqual(records[5], { kind: 'message', messageId: 'm4', role: 'agent', from: 'tests', round: 1, seq: 2, parts: [], stance: 'disagree', invalid: true });
    assert.ok(readEvents(result.journal.paths).some((event) => event.kind === 'review.message' && event.invalid === true));
  });

  it('бэкенд без сессий: реплика несёт задачу, контексты, фокус, свои находки и всю ленту; деградация в журнале', async () => {
    const project = reviewRepo(['security', 'tests'], {
      jobExtra: '    context: [{ text: "КОНТЕКСТ РАБОТЫ" }]\n',
      stepExtra: '        context: [{ text: "КОНТЕКСТ ШАГА" }]\n',
      strategy: `version: 1
kind: review-strategy
name: panel
reviewers:
  - id: security
    agent: sec
    focus: ищи утечки секретов
  - id: tests
    agent: rev-1
aggregator:
  agent: agg
profiles:
  sec:
    backend: claude
    context: [{ text: "КОНТЕКСТ ПРОФИЛЯ" }]
mode: discussion
discussion: { max_messages: 3 }
`,
    });
    const security = scripted([findings('секрет'), disagree('p2'), agree('p3')], 10, () => 0, { sessions: false });
    const tests = scripted([findings('тест'), propose('итог'), agree('p3')]);
    const agg = verdict();
    const result = await run(project, { claude: security, 'rev-1': tests, agg });

    assert.equal(result.status, 'success');
    assert.equal(security.invocations.length, 3);
    for (const round of [1, 2]) {
      const prompt = security.invocations[round]?.prompt ?? '';
      assert.equal(security.invocations[round]?.resumeSession, false, `раунд ${round}`);
      for (const part of [/проверь дифф/, /КОНТЕКСТ РАБОТЫ/, /КОНТЕКСТ ШАГА/, /КОНТЕКСТ ПРОФИЛЯ/, /ищи утечки секретов/, /Ты — ревьюер `security`/]) {
        assert.match(prompt, part, `раунд ${round}`);
      }
      // Вся лента с предложениями, включая собственные находки ревьюера.
      assert.match(prompt, /### m1 — `security`, раунд 0: propose — предложение p1/, `раунд ${round}`);
      assert.match(prompt, /"title": "секрет"/, `раунд ${round}`);
      assert.match(prompt, /### m2 — `tests`/, `раунд ${round}`);
    }
    const round2 = security.invocations[2]?.prompt ?? '';
    assert.match(round2, /### m3 — `security`, раунд 1: disagree с p2/);
    assert.match(round2, /"title": "итог"/);
    // Ревьюер с сессией по-прежнему получает только новое.
    assert.equal(tests.invocations[1]?.resumeSession, true);
    assert.doesNotMatch(tests.invocations[1]?.prompt ?? '', /проверь дифф/);

    const discussing = readEvents(result.journal.paths).flatMap((event) =>
      event.kind === 'backend.degraded' && /обсуждает без сессии/.test(event.detail) ? [event] : [],
    );
    assert.deepEqual(
      discussing.map((event) => [event.backend, event.capability, event.detail]),
      [['claude', 'sessions', 'ревьюер security шага review/review-diff обсуждает без сессии: каждая реплика несёт задание, контекст и всю ленту заново']],
    );
  });

  it('сбой бэкенда в реплике записан с причиной, а не как невалидная реплика; лимит расходуется', async () => {
    const project = reviewRepo(['security', 'tests'], { discussion: 'mode: discussion\ndiscussion: { max_messages: 1 }\n' });
    const security = scripted([findings('секрет'), agree('p2')]);
    const tests = createFakeBackend({
      lines: (index) => [initLine(), resultLine({ structured: index === 0 ? findings('тест') : agree('p1'), tokensIn: 10, tokensOut: 10 })],
      exitCode: (index) => (index === 0 ? 0 : 1),
    });
    const agg = verdict();
    const result = await run(project, { 'rev-0': security, 'rev-1': tests, agg });

    assert.equal(result.status, 'success');
    const { records } = feedOf(result);
    assert.deepEqual(shape(records).slice(4), ['m3:security:agree:p2', 'm4:tests:disagree:', 'no_consensus:limit']);
    assert.deepEqual(records[5], {
      kind: 'message', messageId: 'm4', role: 'agent', from: 'tests', round: 1, seq: 2, parts: [], stance: 'disagree',
      failure: 'бэкенд завершился кодом 1',
    });
    const event = readEvents(result.journal.paths).find((entry) => entry.kind === 'review.message' && entry.message_id === 'm4');
    assert.deepEqual(event?.kind === 'review.message' ? [event.invalid, event.failure] : [], [undefined, 'бэкенд завершился кодом 1']);
    const aggPrompt = agg.invocations[0]?.prompt ?? '';
    assert.match(aggPrompt, /### m4 — `tests`, раунд 1: disagree \(реплики нет — сбой: бэкенд завершился кодом 1; засчитана несогласием\)/);
    assert.doesNotMatch(aggPrompt, /не прошла схему/);
  });

  it('ревьюер без находок не участвует; консенсус двух оставшихся', async () => {
    const project = reviewRepo(['security', 'tests', 'architecture']);
    const security = scripted([findings('секрет'), agree('p2')]);
    const tests = scripted([findings('тест'), agree('p2')]);
    const broken = createFakeBackend({ lines: [initLine()], exitCode: 1 });
    const agg = verdict();
    const result = await run(project, { 'rev-0': security, 'rev-1': tests, 'rev-2': broken, agg });

    assert.equal(result.status, 'success');
    assert.equal(broken.invocations.length, 2);
    const { records } = feedOf(result);
    assert.ok(records.every((record) => record.from !== 'architecture' && record.by !== 'architecture'));
    assert.deepEqual(shape(records).at(-1), 'consensus:p2');
    assert.doesNotMatch(security.invocations[1]?.prompt ?? '', /architecture/);
  });

  it('находки дал один ревьюер: раундов нет, исход participants, решение за агрегатором', async () => {
    const project = reviewRepo(['security', 'tests']);
    const security = scripted([findings('секрет'), agree('p1')]);
    const broken = createFakeBackend({ lines: [initLine()], exitCode: 1 });
    const agg = verdict();
    const result = await run(project, { 'rev-0': security, 'rev-1': broken, agg });

    assert.equal(result.status, 'success');
    assert.equal(security.invocations.length, 1);
    assert.deepEqual(shape(feedOf(result).records), ['p1<security', 'm1:security:propose:p1', 'no_consensus:participants']);
    const aggPrompt = agg.invocations[0]?.prompt ?? '';
    assert.match(aggPrompt, /обсуждать было некому/);
    assert.match(aggPrompt, /## Ревьюеры без находок\n\n- `tests`: /);
  });
});

describe('review-discussion: агрегатор и бюджет', () => {
  it('провал expect агрегатора: следующая попытка — только агрегатор с прежним обсуждением', async () => {
    const project = reviewRepo(['security', 'tests'], {
      stepExtra: '        expect: [{ matches: APPROVED }]\n        attempts: { max: 2, escalation: [{ include_failure: true }] }\n',
    });
    const security = scripted([findings('секрет'), agree('p2')]);
    const tests = scripted([findings('тест'), agree('p2')]);
    const agg = createFakeBackend({
      lines: (index) => [initLine(), resultLine({ text: index === 0 ? 'REJECTED' : 'APPROVED', structured: { verdict: index === 0 ? 'REJECTED' : 'APPROVED' } })],
    });
    const result = await run(project, { 'rev-0': security, 'rev-1': tests, agg });

    assert.equal(result.status, 'success');
    assert.equal(security.invocations.length, 2);
    assert.equal(tests.invocations.length, 2);
    assert.equal(agg.invocations.length, 2);
    assert.match(agg.invocations[1]?.prompt ?? '', /Согласованное предложение p2/);
    assert.match(agg.invocations[1]?.prompt ?? '', /Прошлая попытка не прошла проверку/);
    assert.equal(shape(feedOf(result).records).filter((entry) => entry.startsWith('consensus')).length, 1);
  });

  it('бюджет кончился посреди обсуждения: исход budget, без запаса на агрегатора шаг стоит по бюджету', async () => {
    // Раунд 0 — 40 токенов, раунд 1 — ещё 40: потолок 60 перейдён до раунда 2.
    const project = reviewRepo(['security', 'tests'], { stepExtra: '        budget: { tokens: 60 }\n' });
    const security = scripted([findings('секрет'), disagree('p2')]);
    const tests = scripted([findings('тест'), propose('вариант')]);
    const agg = verdict();
    const result = await run(project, { 'rev-0': security, 'rev-1': tests, agg });

    assert.equal(result.status, 'budget_exceeded');
    assert.equal(security.invocations.length, 2);
    assert.equal(agg.invocations.length, 0);
    assert.deepEqual(shape(feedOf(result).records).at(-1), 'no_consensus:budget');
    assert.ok(readEvents(result.journal.paths).some((event) => event.kind === 'review.no_consensus' && event.reason === 'budget'));
  });
});

describe('review-discussion: переиспользование при возобновлении', () => {
  it('переиспользованный шаг показывает ленту исходного прогона', async () => {
    const project = reviewRepo(['security', 'tests']);
    const backends = { 'rev-0': scripted([findings('секрет'), agree('p2')]), 'rev-1': scripted([findings('тест'), agree('p2')]), agg: verdict() };
    const source = await run(project, backends);
    assert.equal(source.status, 'success');

    const expanded = expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config });
    const sourceRun = readSourceRun(source.journal.paths);
    const plan = buildResumePlan({ expanded, config: project.config, source: sourceRun, changed: [], cwd: project.root });
    assert.equal(plan.steps.find((entry) => entry.step === 'review-diff')?.decision.kind, 'reuse');
    const resumed = await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: dirname(source.journal.paths.projectDir) } },
      projectRoot: project.root,
      cwd: project.root,
      baseEnv: testBaseEnv(),
      resume: { plan, source: sourceRun },
      adapterFor: (name) => (backends[name as keyof typeof backends] as FakeBackend).adapter,
    });
    assert.equal(resumed.status, 'success');
    assert.equal(backends.agg.invocations.length, 1);

    // Витрина `review-defend` журнал обсуждения не разбирает: участники и вердикт.
    const feed = readReviewFeed(resumed.journal.paths, 'review', 'review-diff');
    assert.equal(feed?.legacyMode, 'discussion');
    assert.deepEqual(feed?.entries.map((entry) => entry.kind), ['verdict']);
    assert.deepEqual(feed?.reusedFrom, { runId: source.journal.paths.runId, available: true });
    assert.deepEqual(feed?.participants.map((participant) => participant.status), ['success', 'success', 'success']);

    // Исходный прогон удалён: остаются вердикт и ссылка на источник.
    rmSync(source.journal.paths.dir, { recursive: true, force: true });
    const orphan = readReviewFeed(resumed.journal.paths, 'review', 'review-diff');
    assert.deepEqual(orphan?.reusedFrom, { runId: source.journal.paths.runId, available: false });
    assert.deepEqual(orphan?.entries.map((entry) => entry.kind), ['verdict']);
    const verdictEntry = orphan?.entries[0];
    assert.deepEqual(verdictEntry?.kind === 'verdict' ? verdictEntry.output : undefined, { verdict: 'APPROVED' });
  });
});
