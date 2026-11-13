import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { projectKey } from '../src/parts/pipeline/run/journal/paths.js';
import { createUiServer, LOOPBACK, type UiServer } from '../src/parts/ui/daemon/server.js';
import { readDiscussFeed } from '../src/parts/ui/discussFeed.js';
import type { RunJournal } from '../src/parts/pipeline/run/journal/writer.js';
import { makeJournalBed, seedRun } from './helpers.js';

/**
 * Лента шага `discuss` (`render-design`, задачи 3.3–3.5): участники, фазы,
 * возражения, раунды и документ из `discuss.ndjson`, каталогов участников и
 * `output.json`; маршруты `/api/discuss-feed` и `/api/design-render`.
 */

const LOCK = [
  'name: demo',
  'jobs:',
  '  - id: design',
  '    steps:',
  '      - id: discuss',
  '        discuss: { ref: ./strategy.yml, rounds: 2 }',
  '        prompt: спроектируй',
  '        participants:',
  '          - { id: pragmatist, agent: codex, model: gpt, focus: просто }',
  '          - { id: skeptic, agent: claude, model: sonnet }',
  '        author: { id: author, agent: claude, model: opus }',
  '        aggregator: { id: aggregator, agent: claude, model: sonnet }',
  '',
].join('\n');

const DRAFT = {
  kind: 'draft',
  summary: 'Черновик',
  decisions: [{ id: 'd1', question: 'Где?', options: [{ by: 'pragmatist', summary: 'PG' }], choice: 'PG', rationale: 'Есть' }],
  diagrams: [{ id: 'g1', title: 'Поток', kind: 'mermaid', source: 'flowchart LR\n A-->B', decisions: ['d1'] }],
  risks: [{ risk: 'R', mitigation: 'M' }],
};

const DOCUMENT = {
  title: 'Итог',
  summary: 'Сводка',
  decisions: [{ id: 'd1', question: 'Где?', choice: 'PG', rationale: 'Есть', rejected: [] }],
  diagrams: [],
  risks: [],
  open_questions: [],
  agreed: true,
  unresolved: [],
  changed_by_aggregator: [],
};

interface Bed {
  readonly journal: RunJournal;
  readonly stepDir: string;
  readonly runsRoot: string;
  readonly projectRoot: string;
}

function seed(options: { readonly alive?: boolean } = {}): Bed {
  const bed = makeJournalBed();
  const journal = seedRun(bed.runsRoot, bed.projectRoot, {
    runId: 'r',
    lock: LOCK,
    ...(options.alive === true
      ? { status: 'running' as const, manifest: { started_at: new Date().toISOString(), pid: process.pid } }
      : {}),
  });
  const stepDir = journal.prepareStep('design', 1, 'discuss');
  return { journal, stepDir, ...bed };
}

function call(stepDir: string, path: readonly string[], options: { readonly output?: unknown; readonly finished?: boolean; readonly status?: string } = {}): void {
  const dir = join(stepDir, 'participants', ...path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stdout.log'), '{}\n');
  if (options.output !== undefined) writeFileSync(join(dir, 'output.json'), JSON.stringify(options.output));
  if (options.finished === false) return;
  writeFileSync(
    join(dir, 'step.json'),
    JSON.stringify({
      status: options.status ?? 'success',
      attempts: [{ attempt: 1, status: 'success', started_at: '2026-11-01T00:00:00.000Z', finished_at: '2026-11-01T00:00:04.000Z' }],
    }),
  );
}

function record(stepDir: string, ...records: readonly object[]): void {
  appendFileSync(join(stepDir, 'discuss.ndjson'), records.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

function finishStep(stepDir: string, output: unknown): void {
  writeFileSync(join(stepDir, 'output.json'), JSON.stringify(output));
  writeFileSync(join(stepDir, 'step.json'), JSON.stringify({ id: 'discuss', index: 1, kind: 'discuss', status: 'success', attempts: [] }));
}

/** Полный ход: два предложения, черновик, блокирующее и пожелание, раунд с принятием, итог. */
function completeDiscussion(stepDir: string): void {
  call(stepDir, ['pragmatist'], { output: { summary: 'Взять PG', approach: 'Таблица' } });
  call(stepDir, ['skeptic'], { status: 'failed' });
  record(stepDir, { kind: 'proposal', participant: 'pragmatist', status: 'success' }, { kind: 'proposal', participant: 'skeptic', status: 'failed', reason: 'таймаут' });
  call(stepDir, ['author', 'draft']);
  record(stepDir, DRAFT);
  call(stepDir, ['pragmatist', 'objections']);
  record(
    stepDir,
    { kind: 'objection', id: 'pragmatist.1', by: 'pragmatist', target: 'd1', weight: 'blocking', title: 'Гонка', breaks: 'Счётчик', alternative: 'UPSERT' },
    { kind: 'objection', id: 'pragmatist.2', by: 'pragmatist', target: 'g1', weight: 'preference', title: 'Подпись', breaks: null, alternative: 'Короче' },
  );
  call(stepDir, ['author', 'rounds', '1']);
  record(
    stepDir,
    {
      kind: 'message',
      messageId: 'm1',
      role: 'agent',
      from: 'author',
      round: 1,
      parts: [{ kind: 'text', text: 'Принимаю' }],
      responses: [{ finding: 'pragmatist.1', stance: 'accept', text: 'Верно', evidence: null, change: { choice: 'UPSERT', rationale: 'Атомарно' } }],
    },
    { kind: 'settled', finding: 'pragmatist.1', status: 'accepted', round: 1 },
    { kind: 'outcome', accepted: 1, withdrawn: 0, contested: 0, preference: 1 },
  );
  call(stepDir, ['aggregator'], { output: DOCUMENT });
  finishStep(stepDir, DOCUMENT);
}

describe('лента шага discuss', () => {
  it('завершённое обсуждение: участники по замку, фазы, возражения с исходом, реплики, документ', () => {
    const { journal, stepDir } = seed();
    completeDiscussion(stepDir);

    const feed = readDiscussFeed(journal.paths, 'design', 'discuss');
    assert.ok(feed !== undefined);
    assert.equal(feed.rounds, 2);
    assert.equal(feed.done, true);
    assert.deepEqual(
      feed.participants.map((entry) => [entry.id, entry.role, entry.agent, entry.color]),
      [
        ['pragmatist', 'participant', 'codex', 0],
        ['skeptic', 'participant', 'claude', 1],
        ['author', 'author', 'claude', 2],
        ['aggregator', 'aggregator', 'claude', 3],
      ],
    );
    const pragmatist = feed.participants[0]!;
    assert.deepEqual(pragmatist.calls.map((entry) => entry.phase), ['proposals', 'objections']);
    assert.equal(pragmatist.usage.wallclockMs, 8000);
    assert.deepEqual(feed.participants[2]!.calls.map((entry) => [entry.phase, entry.round]), [['draft', undefined], ['defense', 1]]);
    assert.deepEqual(feed.phases.map((phase) => phase.state), ['done', 'done', 'done', 'done', 'done']);
    assert.deepEqual(feed.proposals, [
      { participant: 'pragmatist', status: 'success', summary: 'Взять PG', approach: 'Таблица' },
      { participant: 'skeptic', status: 'failed', reason: 'таймаут' },
    ]);
    assert.equal(feed.draft?.diagrams[0]?.source, 'flowchart LR\n A-->B');
    assert.deepEqual(feed.objections.map((entry) => [entry.id, entry.status, entry.round]), [['pragmatist.1', 'accepted', 1], ['pragmatist.2', 'note', undefined]]);
    assert.equal(feed.objections[1]!.breaks, undefined);
    assert.deepEqual(feed.messages[0]!.responses[0]!.change, { choice: 'UPSERT', rationale: 'Атомарно' });
    assert.equal(feed.messages[0]!.responses[0]!.evidence, undefined);
    assert.deepEqual(feed.outcome, { accepted: 1, withdrawn: 0, contested: 0, preference: 1 });
    assert.equal(feed.document?.title, 'Итог');
    assert.equal(feed.output, undefined);
  });

  it('шаг в разгаре: черновик готов, возражения идут, документа нет', () => {
    const { journal, stepDir } = seed({ alive: true });
    call(stepDir, ['pragmatist'], { output: { summary: 'S' } });
    call(stepDir, ['skeptic'], { output: { summary: 'S' } });
    record(stepDir, { kind: 'proposal', participant: 'pragmatist', status: 'success' }, { kind: 'proposal', participant: 'skeptic', status: 'success' });
    call(stepDir, ['author', 'draft']);
    record(stepDir, DRAFT);
    call(stepDir, ['skeptic', 'objections'], { finished: false });

    const feed = readDiscussFeed(journal.paths, 'design', 'discuss');
    assert.ok(feed !== undefined);
    assert.equal(feed.done, false);
    assert.deepEqual(feed.phases.map((phase) => phase.state), ['done', 'done', 'running', 'pending', 'pending']);
    assert.equal(feed.participants[1]!.running, true);
    assert.equal(feed.document, undefined);
  });

  it('только пожелания: защита пропущена; незакрытое блокирующее после исхода — contested', () => {
    const { journal, stepDir } = seed();
    record(
      stepDir,
      { kind: 'proposal', participant: 'pragmatist', status: 'success' },
      { kind: 'proposal', participant: 'skeptic', status: 'success' },
      DRAFT,
      { kind: 'objection', id: 'skeptic.1', by: 'skeptic', target: 'd1', weight: 'preference', title: 'P', breaks: null, alternative: null },
      { kind: 'outcome', accepted: 0, withdrawn: 0, contested: 0, preference: 1 },
    );
    finishStep(stepDir, DOCUMENT);
    const feed = readDiscussFeed(journal.paths, 'design', 'discuss');
    assert.equal(feed?.phases.find((phase) => phase.name === 'defense')?.state, 'skipped');

    record(stepDir, { kind: 'objection', id: 'skeptic.2', by: 'skeptic', target: 'd1', weight: 'blocking', title: 'B', breaks: 'x', alternative: 'y' });
    const again = readDiscussFeed(journal.paths, 'design', 'discuss');
    assert.equal(again?.objections.find((entry) => entry.id === 'skeptic.2')?.status, 'contested');
  });

  it('вывод не формы design-doc — сырой вывод с причиной; битая строка журнала пропущена', () => {
    const { journal, stepDir } = seed();
    appendFileSync(join(stepDir, 'discuss.ndjson'), '{"kind":"proposal","participant":"pragmatist","status":"success"}\n{"kind":"draft",');
    finishStep(stepDir, { verdict: 'ok' });
    const feed = readDiscussFeed(journal.paths, 'design', 'discuss');
    assert.equal(feed?.proposals.length, 1);
    assert.equal(feed?.document, undefined);
    assert.deepEqual(feed?.output, { verdict: 'ok' });
    assert.match(feed?.documentError ?? '', /burnex:design-doc/);
  });

  it('шаг без замка и без каталога — ленты нет', () => {
    const { journal } = seed();
    assert.equal(readDiscussFeed(journal.paths, 'design', 'другой'), undefined);
  });
});

async function startServer(t: TestContext, runsRoot: string): Promise<UiServer> {
  const server = await createUiServer({ runsRoot, port: 0 });
  t.after(() => server.close());
  return server;
}

function fetch(server: UiServer, path: string): Promise<{ code: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    get({ host: LOOPBACK, port: server.port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ code: res.statusCode ?? 0, body, headers: res.headers }));
    }).on('error', reject);
  });
}

describe('маршруты ленты discuss и рендера документа', () => {
  it('/api/discuss-feed отдаёт ленту, неверный адрес — 400, чужой шаг — 404', async (t) => {
    const { runsRoot, projectRoot, stepDir } = seed();
    completeDiscussion(stepDir);
    const server = await startServer(t, runsRoot);
    const run = `${projectKey(projectRoot)}/r`;

    const ok = await fetch(server, `/api/discuss-feed?run=${run}&job=design&step=discuss`);
    assert.equal(ok.code, 200);
    assert.equal((JSON.parse(ok.body) as { document: { title: string } }).document.title, 'Итог');
    assert.equal((await fetch(server, `/api/discuss-feed?run=${run}&job=design`)).code, 400);
    assert.equal((await fetch(server, `/api/discuss-feed?run=${run}&job=design&step=missing`)).code, 404);
  });

  it('/api/design-render отдаёт вложение HTML и design.md; не та форма — 422, формат — 400', async (t) => {
    const { runsRoot, projectRoot, stepDir } = seed();
    completeDiscussion(stepDir);
    const server = await startServer(t, runsRoot);
    const base = `/api/design-render?run=${projectKey(projectRoot)}/r&job=design&step=discuss`;

    const md = await fetch(server, `${base}&format=openspec`);
    assert.equal(md.code, 200);
    assert.equal(md.headers['content-disposition'], 'attachment; filename="design-discuss.design.md"');
    assert.match(md.body, /^# Итог\n/);
    const html = await fetch(server, `${base}&format=html`);
    assert.equal(html.code, 200);
    assert.match(String(html.headers['content-type']), /text\/html/);
    assert.equal((await fetch(server, `${base}&format=pdf`)).code, 400);

    finishStep(stepDir, { verdict: 'ok' });
    const wrong = await fetch(server, `${base}&format=html`);
    assert.equal(wrong.code, 422);
    assert.match(wrong.body, /burnex:design-doc/);
  });

  it('/api/vendor/mermaid.js отдаёт бандл Mermaid из сборки', async (t) => {
    const { runsRoot } = seed();
    const server = await startServer(t, runsRoot);
    const bundle = await fetch(server, '/api/vendor/mermaid.js');
    assert.equal(bundle.code, 200);
    assert.match(String(bundle.headers['content-type']), /text\/javascript/);
    assert.match(bundle.body, /globalThis\["mermaid"\]/);
  });
});
