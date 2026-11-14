import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BurnexError } from '../src/kernel/errors.js';
import { createFakeBackend, initLine, resultLine, type FakeBackend } from '../src/parts/pipeline/backend/fake.js';
import type { AgentInvocation, BackendCapabilities } from '../src/parts/pipeline/backend/types.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { serializeLock } from '../src/parts/pipeline/document/lock.js';
import type { DiscussStep } from '../src/parts/pipeline/document/model.js';
import { parseDiscussionStrategyFile } from '../src/parts/pipeline/document/discussionStrategy.js';
import { lintPipeline } from '../src/parts/pipeline/domain/lint.js';
import { findStepDir, readEvents, readUsage } from '../src/parts/pipeline/run/journal/reader.js';
import { runPipeline, type RunResult } from '../src/parts/pipeline/run/runner.js';
import { draftProblems, MERMAID_LABEL_RULE, withEngineFields } from '../src/parts/pipeline/steps/discuss/discuss.js';
import { gitCommit, gitInit, makeProject, testBaseEnv, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * `discuss-step`: стратегия обсуждения, шаг `discuss:` и его фазы —
 * предложения, черновик автора, возражения по точкам, общие раунды защиты
 * черновика и итог агрегатора с полями движка.
 */

const STRATEGY = (extra = '') => `version: 1
kind: discussion-strategy
name: panel
participants:
  - id: pragmatist
    agent: p-a
    focus: минимум сущностей
  - id: skeptic
    agent: p-b
author:
  agent: auth
  prompt: Своди честно.
aggregator:
  agent: agg
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
  const path = join(tempDir('discuss-strategy-'), 's.yml');
  writeFileSync(path, content);
  return path;
}

const PLAN_SCHEMA = '{"type":"object","properties":{"plan":{"type":"string"}},"required":["plan"],"additionalProperties":false}\n';

function discussRepo(options: { readonly strategy?: string; readonly stepExtra?: string; readonly schema?: string } = {}): Project {
  const project = makeProject({
    'burnex.yml': `version: 1
kind: pipeline
name: p
jobs:
  design:
    output: { from: discuss }
    steps:
      - id: discuss
        discuss: ./strategies/panel.yml
        prompt: спроектируй фичу
        output_schema: ${options.schema ?? 'plan.json'}
${options.stepExtra ?? ''}`,
    'plan.json': PLAN_SCHEMA,
    'strategies/panel.yml': options.strategy ?? STRATEGY(),
  });
  gitInit(project.root);
  gitCommit(project.root, 'init');
  return project;
}

function stepOf(project: Project): DiscussStep {
  const expanded = expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config });
  const step = expanded.pipeline.jobs[0]?.steps[0];
  assert.ok(step?.kind === 'discuss');
  return step;
}

describe('discuss-step: документ стратегии и шага', () => {
  // Сценарий: «Стратегия разбирается»
  it('стратегия: участники, автор, агрегатор, rounds по умолчанию 1; шаг раскрыт в агентов, замок называет участников', () => {
    const raw = parseDiscussionStrategyFile(strategyFile(STRATEGY()), []);
    assert.equal(raw.participants.length, 2);
    const project = discussRepo();
    const step = stepOf(project);
    assert.equal(step.rounds, 1);
    assert.deepEqual(step.participants.map((participant) => [participant.id, participant.agent, participant.focus]), [
      ['pragmatist', 'p-a', 'минимум сущностей'],
      ['skeptic', 'p-b', undefined],
    ]);
    assert.equal(step.author?.agent, 'auth');
    assert.equal(step.author?.prompt, 'Своди честно.');
    assert.equal(step.aggregator?.agent, 'agg');
    const lock = serializeLock(expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config }).pipeline);
    assert.match(lock, /discuss:\n\s+ref: \.\/strategies\/panel\.yml/);
    assert.match(lock, /rounds: 1/);
    assert.match(lock, /author:\n\s+id: author\n\s+agent: auth/);
  });

  // Сценарий: «Зарезервированный id»
  it('id author и aggregator заняты, повторный id и rounds вне 1–5 — отказ с путём ключа', () => {
    assert.equal(rejection(() => parseDiscussionStrategyFile(strategyFile(STRATEGY().replace('id: skeptic', 'id: author')), [])).at, 'participants.1.id');
    assert.equal(rejection(() => parseDiscussionStrategyFile(strategyFile(STRATEGY().replace('id: skeptic', 'id: pragmatist')), [])).at, 'participants.1.id');
    for (const rounds of ['0', '6']) {
      assert.equal(rejection(() => parseDiscussionStrategyFile(strategyFile(STRATEGY(`rounds: ${rounds}\n`)), [])).at, 'rounds');
    }
  });

  // Сценарий: «Запрещённый ключ»
  it('шаг discuss отклоняет model, session и implementer', () => {
    for (const extra of ['        model: sonnet\n', '        session: s\n', '        implementer: build\n']) {
      const project = discussRepo({ stepExtra: extra });
      assert.throws(() => expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config }), /шаге discuss не объявляется/);
    }
  });

  // Сценарии: «Закрытая схема пользователя», «Конфликт имени поля»
  it('output_schema: поля движка домешиваются в закрытую схему; собственное поле agreed — отказ у output_schema', () => {
    const merged = withEngineFields(JSON.parse(PLAN_SCHEMA) as Record<string, unknown>);
    assert.deepEqual(merged.required, ['plan', 'agreed', 'unresolved', 'changed_by_aggregator']);
    assert.equal(merged.additionalProperties, false);
    const project = discussRepo();
    writeFileSync(project.path('plan.json'), '{"type":"object","properties":{"agreed":{"type":"boolean"}}}');
    const error = rejection(() => expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config }));
    assert.equal(error.at, 'jobs.design.steps.0.output_schema');
    assert.match(error.message, /agreed/);
  });

  it('burnex:design-doc — встроенная схема документа принимается', () => {
    const step = stepOf(discussRepo({ schema: 'burnex:design-doc' }));
    assert.match(step.outputSchemaPath, /schema\/design-doc\.schema\.json$/);
  });

  it('линт: стратегия не найдена — ошибка у ключа discuss', () => {
    const project = discussRepo();
    writeFileSync(project.path('burnex.yml'), readFileSync(project.path('burnex.yml'), 'utf8').replace('./strategies/panel.yml', 'nowhere'));
    const expanded = expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config });
    const found = lintPipeline(expanded, { config: project.config, cwd: project.root }).find((entry) => entry.at === 'jobs.design.steps.0.discuss');
    assert.equal(found?.severity, 'error');
    assert.match(found?.message ?? '', /стратегия обсуждения nowhere не найдена/);
  });

  it('проверки черновика: сквозная нумерация решений и диаграмм, ссылки диаграмм на решения', () => {
    const draft = {
      summary: '',
      decisions: [{ id: 'd2', question: 'q', options: [], choice: 'c', rationale: 'r' }],
      diagrams: [{ id: 'g1', title: 't', kind: 'mermaid' as const, source: 'graph TD', decisions: ['d7'] }],
      risks: [],
    };
    assert.deepEqual(draftProblems(draft), [
      'решение 1 обязано иметь id d1, а не d2',
      'диаграмма g1 ссылается на решение d7, которого в черновике нет',
    ]);
  });
});

// --- Поддельные бэкенды.

type Phase =
  | { readonly kind: 'proposal' }
  | { readonly kind: 'draft' }
  | { readonly kind: 'objections' }
  | { readonly kind: 'defense'; readonly round: number; readonly open: readonly string[] }
  | { readonly kind: 'rebuttal'; readonly round: number; readonly open: readonly string[] }
  | { readonly kind: 'aggregate' };

function phaseOf(prompt: string): Phase {
  const open = (/Открытые возражения: ([^\n]*)/.exec(prompt)?.[1] ?? '').split(', ').filter((id) => id !== '');
  const round = Number(/## Защита черновика — раунд (\d+)/.exec(prompt)?.[1] ?? 0);
  if (/Ты — агрегатор\. Собери итоговый документ/.test(prompt)) return { kind: 'aggregate' };
  if (/Автор ответил на твои возражения/.test(prompt)) return { kind: 'rebuttal', round, open };
  if (/## Защита черновика — раунд/.test(prompt)) return { kind: 'defense', round, open };
  if (/Автор свёл предложения участников в один черновик/.test(prompt)) return { kind: 'objections' };
  if (/Ты — автор\. Своих предложений ты не подавал|## Прошлый черновик не прошёл проверку/.test(prompt)) return { kind: 'draft' };
  return { kind: 'proposal' };
}

function responding(respond: (invocation: AgentInvocation, phase: Phase) => unknown, capabilities: Partial<BackendCapabilities> = {}): FakeBackend {
  const backend: FakeBackend = createFakeBackend({
    lines: (index) => {
      const invocation = backend.invocations[index] as AgentInvocation;
      return [initLine(), resultLine({ structured: respond(invocation, phaseOf(invocation.prompt)), tokensIn: 10, tokensOut: 10 })];
    },
    capabilities,
  });
  return backend;
}

const proposal = (id: string) => ({
  summary: `предложение ${id}`,
  approach: `подход ${id}`,
  decisions: [{ question: 'хранилище', choice: id === 'pragmatist' ? 'файлы' : 'sqlite', rationale: 'потому что' }],
  risks: ['риск'],
  diagrams: [],
});

const DRAFT = {
  summary: 'черновик',
  decisions: [
    { id: 'd1', question: 'хранилище', options: [{ by: 'pragmatist', summary: 'файлы' }, { by: 'skeptic', summary: 'sqlite' }], choice: 'файлы', rationale: 'проще' },
    { id: 'd2', question: 'формат', options: [{ by: 'author', summary: 'json' }], choice: 'json', rationale: 'привычно' },
  ],
  diagrams: [{ id: 'g1', title: 'поток', kind: 'mermaid', source: 'graph TD; A-->B', decisions: ['d1'] }],
  risks: [{ risk: 'рост', mitigation: 'ротация' }],
};

type Objection = { readonly target: string; readonly weight: 'blocking' | 'preference'; readonly title: string; readonly breaks: string | null; readonly alternative: string | null };

const BLOCKING: Objection = { target: 'd1', weight: 'blocking', title: 'файлы не выдержат конкуренции', breaks: 'гонки записи', alternative: 'sqlite' };
const PREFERENCE: Objection = { target: 'd2', weight: 'preference', title: 'лучше yaml', breaks: null, alternative: 'yaml' };

function participant(
  id: string,
  options: {
    readonly objections?: readonly Objection[];
    readonly rebut?: (round: number, objection: string) => 'maintain' | 'withdraw';
    readonly proposal?: (invocation: AgentInvocation) => unknown;
  } = {},
): FakeBackend {
  return responding((invocation, phase) => {
    switch (phase.kind) {
      case 'proposal':
        return options.proposal?.(invocation) ?? proposal(id);
      case 'objections':
        return { summary: `возражения ${id}`, objections: options.objections ?? [] };
      case 'rebuttal':
        return {
          text: `${id}, раунд ${phase.round}`,
          responses: phase.open.map((finding) => {
            const stance = options.rebut?.(phase.round, finding) ?? 'maintain';
            return { finding, stance, text: `${stance} ${finding}` };
          }),
        };
      default:
        return undefined;
    }
  });
}

type AuthorAnswer = { readonly stance: 'accept' | 'dispute' | 'clarify'; readonly change?: { choice: string; rationale: string } | null };

function author(options: { readonly draft?: (attempt: number) => unknown; readonly answer?: (round: number, objection: string) => AuthorAnswer } = {}): FakeBackend {
  let drafts = 0;
  return responding((_invocation, phase) => {
    if (phase.kind === 'draft') {
      drafts += 1;
      return options.draft?.(drafts) ?? DRAFT;
    }
    if (phase.kind !== 'defense') return undefined;
    return {
      text: `автор, раунд ${phase.round}`,
      responses: phase.open.map((finding) => {
        const answer = options.answer?.(phase.round, finding) ?? { stance: 'accept', change: { choice: 'sqlite', rationale: 'конкурентная запись' } };
        return { finding, stance: answer.stance, text: `${answer.stance} ${finding}`, evidence: null, change: answer.change ?? null };
      }),
    };
  });
}

const DOC = { plan: 'итог', agreed: true, unresolved: [], changed_by_aggregator: [] };
const aggregator = (output: (attempt: number) => unknown = () => DOC): FakeBackend => {
  let calls = 0;
  return responding((_invocation, phase) => {
    if (phase.kind !== 'aggregate') return undefined;
    calls += 1;
    return output(calls);
  });
};

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

type Line = Record<string, unknown>;

function journalOf(result: RunResult): { readonly lines: readonly Line[]; readonly dir: string } {
  const dir = findStepDir(result.journal.paths, 'design', 'discuss');
  assert.ok(dir !== undefined);
  const path = join(dir, 'discuss.ndjson');
  const lines = existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Line)
    : [];
  return { lines, dir };
}

const calls = (backend: FakeBackend, kind: Phase['kind']) => backend.invocations.filter((invocation) => phaseOf(invocation.prompt).kind === kind);

describe('discuss-step: фазы', () => {
  // Сценарии: «Полный проход», «Принятое возражение», «Только пожелания» (часть)
  it('полный проход: предложения, черновик, возражения, раунд защиты, итог с полями движка', async () => {
    const project = discussRepo();
    const pa = participant('pragmatist', { objections: [BLOCKING] });
    const pb = participant('skeptic', { objections: [PREFERENCE] });
    const auth = author();
    const agg = aggregator();
    const result = await run(project, { 'p-a': pa, 'p-b': pb, auth, agg });

    assert.equal(result.status, 'success');
    // Предложения независимы: участник не видит чужого.
    assert.doesNotMatch(calls(pa, 'proposal')[0]?.prompt ?? '', /предложение skeptic/);
    assert.match(calls(pa, 'proposal')[0]?.prompt ?? '', /## Твой фокус\n\nминимум сущностей/);
    // Черновик: предложения под подписью, указания стратегии.
    const draftPrompt = calls(auth, 'draft')[0]?.prompt ?? '';
    assert.match(draftPrompt, /— Участник `pragmatist` \(p-a\), фокус: минимум сущностей\n\nпредложение pragmatist/);
    assert.match(draftPrompt, /## Указания стратегии\n\nСводи честно\./);
    // Правило кавычек Mermaid — у всех, кто пишет диаграммы: без него `A[/путь]` ломает отрисовку.
    assert.ok((calls(pa, 'proposal')[0]?.prompt ?? '').includes(MERMAID_LABEL_RULE));
    assert.ok(draftPrompt.includes(MERMAID_LABEL_RULE));
    // Возражения — в сессии участника, без повторного предложения.
    const objections = calls(pa, 'objections')[0];
    assert.equal(objections?.resumeSession, true);
    assert.equal(objections?.sessionId, calls(pa, 'proposal')[0]?.sessionId);
    assert.doesNotMatch(objections?.prompt ?? '', /## Твоё предложение/);
    assert.match(objections?.prompt ?? '', /### d1 — хранилище/);
    assert.match(objections?.prompt ?? '', /```mermaid\ngraph TD; A-->B\n```/);
    // Защита: только блокирующее, ход автора в его сессии.
    const defense = calls(auth, 'defense');
    assert.equal(defense.length, 1);
    assert.equal(defense[0]?.sessionId, calls(auth, 'draft')[0]?.sessionId);
    assert.match(defense[0]?.prompt ?? '', /Открытые возражения: pragmatist\.1\n/);
    assert.equal(calls(pa, 'rebuttal').length + calls(pb, 'rebuttal').length, 0, 'принятое возражение ответа участника не требует');
    // Агрегатор: черновик, правка автора, пожелание.
    const aggPrompt = calls(agg, 'aggregate')[0]?.prompt ?? '';
    assert.ok(aggPrompt.includes(MERMAID_LABEL_RULE));
    assert.match(aggPrompt, /Статус: accepted/);
    assert.match(aggPrompt, /Правка: \*\*sqlite\*\* — конкурентная запись/);
    assert.match(aggPrompt, /## Пожелания участников\n\n- skeptic\.1 \(d2\): лучше yaml — yaml/);
    assert.match(aggPrompt, /не сшивай|Не сшивай/);

    const { lines, dir } = journalOf(result);
    assert.deepEqual(lines.map((line) => line.kind), ['proposal', 'proposal', 'draft', 'objection', 'objection', 'message', 'settled', 'outcome']);
    assert.deepEqual(lines.find((line) => line.kind === 'settled'), { kind: 'settled', finding: 'pragmatist.1', status: 'accepted', round: 1 });
    assert.deepEqual(lines.at(-1), { kind: 'outcome', accepted: 1, withdrawn: 0, contested: 0, preference: 1 });
    assert.equal(lines.find((line) => line.kind === 'message')?.from, 'author');
    for (const path of ['participants/pragmatist/output.json', 'participants/pragmatist/objections/output.json', 'participants/author/draft/output.json', 'participants/author/rounds/1/output.json', 'participants/aggregator/output.json', 'participants/aggregator/output.schema.json']) {
      assert.ok(existsSync(join(dir, path)), path);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'output.json'), 'utf8')), DOC);

    const events = readEvents(result.journal.paths);
    assert.deepEqual(
      events.flatMap((event) => (event.kind === 'discuss.phase' && event.boundary === 'started' ? [event.phase] : [])),
      ['proposals', 'draft', 'objections', 'defense', 'aggregate'],
    );
    const finished = events.find((event) => event.kind === 'discuss.finished');
    assert.deepEqual(finished?.kind === 'discuss.finished' ? [finished.accepted, finished.preference, finished.agreed] : [], [1, 1, true]);
    assert.ok(events.some((event) => event.kind === 'discuss.message' && event.participant === 'author'));
    const usage = readUsage(result.journal.paths).jobs.design?.steps.discuss;
    assert.deepEqual(Object.keys(usage?.participants ?? {}).sort(), ['aggregator', 'author', 'pragmatist', 'skeptic']);
  });

  // Сценарий: «Одно предложение сорвалось»
  it('предложение одного участника сорвалось: автор получает отметку, шаг продолжается', async () => {
    const project = discussRepo();
    const pb = participant('skeptic', { proposal: () => ({ wrong: true }) });
    // Вариант сорвавшегося участника в черновике отклонила бы проверка `by`.
    const solo = { ...DRAFT, decisions: [{ ...DRAFT.decisions[0]!, options: [{ by: 'pragmatist', summary: 'файлы' }] }, DRAFT.decisions[1]!] };
    const auth = author({ draft: () => solo });
    const result = await run(project, { 'p-a': participant('pragmatist'), 'p-b': pb, auth, agg: aggregator() });

    assert.equal(result.status, 'success', readFileSync(join(journalOf(result).dir, 'step.json'), 'utf8'));
    assert.match(calls(auth, 'draft')[0]?.prompt ?? '', /## Участники без предложения\n\n- `skeptic`:/);
    assert.equal(calls(pb, 'objections').length, 0, 'без предложения — без возражений');
    assert.equal(journalOf(result).lines.filter((line) => line.kind === 'proposal' && line.status !== 'success').length, 1);
  });

  // Сценарий: «Все сорвались»
  it('ни одного предложения: шаг провален, автор не запускался', async () => {
    const project = discussRepo();
    const bad = () => ({ wrong: true });
    const auth = author();
    const result = await run(project, { 'p-a': participant('pragmatist', { proposal: bad }), 'p-b': participant('skeptic', { proposal: bad }), auth, agg: aggregator() });

    assert.equal(result.status, 'failed');
    assert.equal(auth.invocations.length, 0);
    const record = result.status === 'failed' ? JSON.parse(readFileSync(join(journalOf(result).dir, 'step.json'), 'utf8')) as Line : {};
    assert.match(String(record.reason), /ни один участник не дал предложения — pragmatist: [\s\S]*; skeptic:/);
  });

  // Сценарий: «Вариант приписан не тому»; проверки движка с повтором
  it('черновик: by не того участника — повтор по схеме; нумерация d2 вместо d1 — повтор движка в той же сессии', async () => {
    const project = discussRepo();
    const wrongBy = { ...DRAFT, decisions: [{ ...DRAFT.decisions[0]!, options: [{ by: 'ghost', summary: 'x' }] }, DRAFT.decisions[1]!] };
    const wrongIds = { ...DRAFT, decisions: [{ ...DRAFT.decisions[0]!, id: 'd2' }, { ...DRAFT.decisions[1]!, id: 'd3' }] };
    const auth = author({ draft: (attempt) => (attempt === 1 ? wrongBy : attempt === 2 ? wrongIds : DRAFT) });
    const result = await run(project, { 'p-a': participant('pragmatist'), 'p-b': participant('skeptic'), auth, agg: aggregator() });

    assert.equal(result.status, 'success', readFileSync(join(journalOf(result).dir, 'step.json'), 'utf8'));
    const drafts = calls(auth, 'draft');
    assert.equal(drafts.length, 3);
    assert.match(drafts[1]?.prompt ?? '', /Прошлая попытка не прошла проверку[\s\S]*by/);
    assert.match(drafts[2]?.prompt ?? '', /## Прошлый черновик не прошёл проверку\n\n- решение 1 обязано иметь id d1, а не d2/);
    assert.equal(drafts[2]?.resumeSession, true);
    assert.ok(existsSync(join(journalOf(result).dir, 'participants', 'author', 'draft', 'retry', 'output.json')));
  });

  it('черновик дважды с неверной нумерацией: шаг провален с причиной', async () => {
    const project = discussRepo();
    const wrongIds = { ...DRAFT, decisions: [{ ...DRAFT.decisions[0]!, id: 'd5' }] , diagrams: [] };
    const agg = aggregator();
    const result = await run(project, { 'p-a': participant('pragmatist'), 'p-b': participant('skeptic'), auth: author({ draft: () => wrongIds }), agg });
    assert.equal(result.status, 'failed');
    assert.equal(agg.invocations.length, 0);
  });

  // Сценарий: «Только пожелания»
  it('только пожелания: защиты нет, агрегатор получает черновик и пожелания', async () => {
    const project = discussRepo();
    const auth = author();
    const agg = aggregator();
    const result = await run(project, { 'p-a': participant('pragmatist', { objections: [PREFERENCE] }), 'p-b': participant('skeptic'), auth, agg });

    assert.equal(result.status, 'success');
    assert.equal(calls(auth, 'defense').length, 0);
    assert.ok(!readEvents(result.journal.paths).some((event) => event.kind === 'discuss.phase' && event.phase === 'defense'));
    assert.match(calls(agg, 'aggregate')[0]?.prompt ?? '', /## Блокирующие возражения\n\nНет/);
  });

  // Сценарий: «Блокирующее без альтернативы»
  it('блокирующее возражение без альтернативы — повтор хода возражений', async () => {
    const project = discussRepo();
    let attempts = 0;
    const pa = responding((_invocation, phase) => {
      if (phase.kind === 'proposal') return proposal('pragmatist');
      if (phase.kind !== 'objections') return undefined;
      attempts += 1;
      return { summary: '', objections: [attempts === 1 ? { ...BLOCKING, alternative: null } : PREFERENCE] };
    });
    const result = await run(project, { 'p-a': pa, 'p-b': participant('skeptic'), auth: author(), agg: aggregator() });

    assert.equal(result.status, 'success');
    assert.equal(calls(pa, 'objections').length, 2);
  });

  // Сценарий: «Accept без правки»
  it('accept без change — повтор хода автора с ошибкой схемы', async () => {
    const project = discussRepo();
    let turns = 0;
    const auth = author({
      answer: () => {
        turns += 1;
        return turns === 1 ? { stance: 'accept', change: null } : { stance: 'accept', change: { choice: 'sqlite', rationale: 'r' } };
      },
    });
    const result = await run(project, { 'p-a': participant('pragmatist', { objections: [BLOCKING] }), 'p-b': participant('skeptic'), auth, agg: aggregator() });

    assert.equal(result.status, 'success');
    const defense = calls(auth, 'defense');
    assert.equal(defense.length, 2);
    assert.match(defense[1]?.prompt ?? '', /Прошлая попытка не прошла проверку/);
    assert.equal(journalOf(result).lines.find((line) => line.kind === 'settled')?.status, 'accepted');
  });

  // Сценарий: «Спор до лимита»
  it('dispute и maintain при rounds: 1 — contested, агрегатор решает', async () => {
    const project = discussRepo();
    const pa = participant('pragmatist', { objections: [BLOCKING], rebut: () => 'maintain' });
    const agg = aggregator();
    const result = await run(project, { 'p-a': pa, 'p-b': participant('skeptic'), auth: author({ answer: () => ({ stance: 'dispute' }) }), agg });

    assert.equal(result.status, 'success');
    assert.equal(calls(pa, 'rebuttal').length, 1);
    assert.match(calls(pa, 'rebuttal')[0]?.prompt ?? '', /Автор ответил на твои возражения/);
    assert.deepEqual(journalOf(result).lines.at(-1), { kind: 'outcome', accepted: 0, withdrawn: 0, contested: 1, preference: 0 });
    assert.match(calls(agg, 'aggregate')[0]?.prompt ?? '', /Статус: contested — спор не разрешён, решай ты/);
  });

  // Сценарии: «Ложное согласие», «Повтор шага не повторяет обсуждение»
  it('agreed: true при непустом unresolved — попытка не засчитана; повтор — только агрегатор', async () => {
    const project = discussRepo({ stepExtra: '        attempts: { max: 2, escalation: [{ include_failure: true }] }\n' });
    const pa = participant('pragmatist');
    const auth = author();
    const agg = aggregator((attempt) =>
      attempt === 1 ? { ...DOC, unresolved: [{ decision: 'd1', reason: 'спор' }] } : { ...DOC, agreed: false, unresolved: [{ decision: 'd1', reason: 'спор' }] },
    );
    const result = await run(project, { 'p-a': pa, 'p-b': participant('skeptic'), auth, agg });

    assert.equal(result.status, 'success');
    assert.equal(calls(agg, 'aggregate').length, 2);
    assert.match(calls(agg, 'aggregate')[1]?.prompt ?? '', /Прошлая попытка не прошла проверку/);
    assert.equal(calls(auth, 'draft').length, 1, 'обсуждение не повторяется');
    assert.equal(calls(pa, 'proposal').length, 1);
    const finished = readEvents(result.journal.paths).find((event) => event.kind === 'discuss.finished');
    assert.equal(finished?.kind === 'discuss.finished' ? finished.agreed : undefined, false);
  });

  it('бюджет шага перейдён до черновика: budget_exceeded без автора', async () => {
    const project = discussRepo({ stepExtra: '        budget: { tokens: 30 }\n' });
    const auth = author();
    const result = await run(project, { 'p-a': participant('pragmatist'), 'p-b': participant('skeptic'), auth, agg: aggregator() });
    assert.equal(result.status, 'budget_exceeded');
    assert.equal(auth.invocations.length, 0);
  });
});
