import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { readReviewFeed, type ReviewFeedEntry } from '../src/parts/ui/reviewFeed.js';
import { readStepOutput } from '../src/parts/ui/stepOutput.js';
import type { RunJournal } from '../src/parts/pipeline/run/journal/writer.js';
import { makeJournalBed, seedRun } from './helpers.js';

/**
 * Модель ленты шага `review` (`ui-review-discussion`, задача 1.4): сборка из
 * `discussion.ndjson` и `participants/*`, режим `independent` по выходам
 * участников, невалидная реплика и журнал без ленты.
 */

function lock(mode: 'independent' | 'discussion' | undefined, reviewers: readonly string[] = ['security', 'tests', 'style']): string {
  const strategy = mode === undefined ? '{ ref: ./strategy.yml }' : `{ ref: ./strategy.yml, mode: ${mode}${mode === 'discussion' ? ', discussion: { max_messages: 2 }' : ''} }`;
  return [
    'name: demo',
    'jobs:',
    '  - id: review',
    '    steps:',
    '      - id: check',
    `        review: ${strategy}`,
    '        prompt: проверь',
    '        reviewers:',
    ...reviewers.map((id, index) => `          - { id: ${id}, agent: ${index % 2 === 0 ? 'codex' : 'claude'}, model: m${index} }`),
    '        aggregator: { id: aggregator, agent: claude, model: sonnet }',
    '',
  ].join('\n');
}

interface Bed {
  readonly journal: RunJournal;
  readonly stepDir: string;
}

function seed(mode: 'independent' | 'discussion' | undefined, options: { readonly alive?: boolean } = {}): Bed {
  const bed = makeJournalBed();
  const journal = seedRun(bed.runsRoot, bed.projectRoot, {
    lock: lock(mode),
    ...(options.alive === true
      ? { status: 'running' as const, manifest: { started_at: new Date().toISOString(), pid: process.pid } }
      : {}),
  });
  const stepDir = journal.prepareStep('review', 1, 'check');
  return { journal, stepDir };
}

function call(
  stepDir: string,
  participant: string,
  options: {
    readonly round?: number;
    readonly status?: string;
    readonly reason?: string;
    readonly output?: unknown;
    readonly finished?: boolean;
  } = {},
): void {
  const dir =
    options.round === undefined
      ? join(stepDir, 'participants', participant)
      : join(stepDir, 'participants', participant, 'rounds', String(options.round));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stdout.log'), `{"type":"result","result":"${participant}"}\n`);
  if (options.finished === false) return;
  writeFileSync(
    join(dir, 'step.json'),
    JSON.stringify({
      participant,
      role: participant === 'aggregator' ? 'aggregator' : 'reviewer',
      status: options.status ?? 'success',
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      attempts: [{ attempt: 1, status: 'success', started_at: '2026-08-01T00:00:00.000Z', finished_at: '2026-08-01T00:00:05.000Z' }],
    }),
  );
  if (options.output !== undefined) writeFileSync(join(dir, 'output.json'), JSON.stringify(options.output));
}

function findings(summary: string): unknown {
  return {
    summary,
    findings: [{ severity: 'major', title: `${summary}: заголовок`, location: 'a.ts:1', detail: 'd', suggestion: null }],
  };
}

function discussion(stepDir: string, records: readonly unknown[]): void {
  writeFileSync(join(stepDir, 'discussion.ndjson'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

function message(messageId: string, from: string, round: number, seq: number, extra: Record<string, unknown>): unknown {
  return { kind: 'message', messageId, role: 'agent', from, round, seq, parts: [{ kind: 'text', text: `${from} в раунде ${round}` }], ...extra };
}

function kinds(entries: readonly ReviewFeedEntry[]): string[] {
  return entries.map((entry) => (entry.kind === 'round' ? `round ${entry.round}` : entry.kind));
}

describe('лента шага review', () => {
  it('обсуждение с консенсусом: находки трёх ревьюеров, два раунда, консенсус и вердикт последним', () => {
    const { journal, stepDir } = seed('discussion');
    for (const id of ['security', 'tests', 'style']) call(stepDir, id, { output: findings(id) });
    for (const round of [1, 2]) for (const id of ['security', 'tests', 'style']) call(stepDir, id, { round });
    call(stepDir, 'aggregator', { output: { verdict: 'request_changes', summary: 'итог' } });
    discussion(stepDir, [
      { kind: 'proposal', id: 'p1', by: 'security', round: 0, content: findings('security') },
      message('m1', 'security', 0, 1, { stance: 'propose', proposal: 'p1' }),
      { kind: 'proposal', id: 'p2', by: 'tests', round: 0, content: findings('tests') },
      message('m2', 'tests', 0, 2, { stance: 'propose', proposal: 'p2' }),
      { kind: 'proposal', id: 'p3', by: 'style', round: 0, content: findings('style') },
      message('m3', 'style', 0, 3, { stance: 'propose', proposal: 'p3' }),
      message('m4', 'security', 1, 1, { stance: 'agree', target: 'p2' }),
      message('m5', 'tests', 1, 2, { stance: 'disagree', target: 'p3', replyTo: ['m3'] }),
      message('m6', 'style', 1, 3, { stance: 'disagree', target: 'p2' }),
      message('m7', 'security', 2, 1, { stance: 'agree', target: 'p2' }),
      message('m8', 'tests', 2, 2, { stance: 'agree', target: 'p2' }),
      message('m9', 'style', 2, 3, { stance: 'agree', target: 'p2' }),
      { kind: 'outcome', consensus: true, proposal: 'p2' },
    ]);
    journal.writeStepJson(stepDir, 'step.json', { status: 'success' });

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    assert.ok(feed !== undefined);
    assert.equal(feed.mode, 'discussion');
    assert.equal(feed.maxMessages, 2);
    assert.equal(feed.done, true);
    assert.equal(feed.legacy, false);
    assert.deepEqual(
      feed.participants.map((participant) => [participant.id, participant.role, participant.color, participant.agent, participant.model]),
      [
        ['security', 'reviewer', 0, 'codex', 'm0'],
        ['tests', 'reviewer', 1, 'claude', 'm1'],
        ['style', 'reviewer', 2, 'codex', 'm2'],
        ['aggregator', 'aggregator', 3, 'claude', 'sonnet'],
      ],
    );
    assert.deepEqual(kinds(feed.entries), [
      'findings', 'findings', 'findings',
      'round 1', 'message', 'message', 'message',
      'round 2', 'message', 'message', 'message',
      'outcome', 'verdict',
    ]);

    const reply = feed.entries.find((entry) => entry.kind === 'message' && entry.messageId === 'm5');
    assert.ok(reply?.kind === 'message');
    assert.equal(reply.stance, 'disagree');
    assert.deepEqual(reply.target, { id: 'p3', by: 'style', summary: 'style' });
    assert.deepEqual(reply.replyTo, [{ id: 'm3', by: 'style', summary: 'style в раунде 0' }]);
    assert.equal(reply.count, 1);
    const second = feed.entries.find((entry) => entry.kind === 'message' && entry.messageId === 'm8');
    assert.equal(second?.kind === 'message' ? second.count : undefined, 2);

    assert.deepEqual(feed.entries.at(-2), { kind: 'outcome', consensus: true, proposal: 'p2' });
    const verdict = feed.entries.at(-1);
    assert.ok(verdict?.kind === 'verdict');
    assert.equal(verdict.verdict, 'request_changes');
    assert.equal(verdict.summary, 'итог');

    assert.deepEqual(
      feed.proposals.map((proposal) => [proposal.id, proposal.status]),
      [['p1', 'unsupported'], ['p2', 'accepted'], ['p3', 'unsupported']],
    );
    const security = feed.participants[0];
    assert.equal(security?.messages, 2);
    assert.deepEqual(security?.sessions.map((session) => session.round), [undefined, 1, 2]);
    assert.equal(security?.sessions[1]?.stdout?.path, join('jobs', 'review', 'steps', '01-check', 'participants', 'security', 'rounds', '1', 'stdout.log'));
    assert.equal(security?.usage.wallclockMs, 15_000);
  });

  it('без консенсуса: исход с причиной, ревьюер без находок — системной строкой', () => {
    const { journal, stepDir } = seed('discussion');
    call(stepDir, 'security', { output: findings('security') });
    call(stepDir, 'tests', { status: 'failed', reason: 'таймаут' });
    call(stepDir, 'style', { output: findings('style') });
    call(stepDir, 'aggregator', { output: { verdict: 'approve' } });
    discussion(stepDir, [
      { kind: 'proposal', id: 'p1', by: 'security', round: 0, content: findings('security') },
      message('m1', 'security', 0, 1, { stance: 'propose', proposal: 'p1' }),
      { kind: 'proposal', id: 'p2', by: 'style', round: 0, content: findings('style') },
      message('m2', 'style', 0, 2, { stance: 'propose', proposal: 'p2' }),
      message('m3', 'security', 1, 1, { stance: 'disagree', target: 'p2' }),
      { kind: 'proposal', id: 'p3', by: 'style', round: 1, content: findings('style-2') },
      message('m4', 'style', 1, 2, { stance: 'propose', proposal: 'p3' }),
      { kind: 'outcome', consensus: false, reason: 'stalled' },
    ]);

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    assert.ok(feed !== undefined);
    assert.deepEqual(kinds(feed.entries), ['findings', 'findings', 'failure', 'round 1', 'message', 'message', 'outcome', 'verdict']);
    assert.deepEqual(feed.entries[2], { kind: 'failure', participant: 'tests', reason: 'таймаут' });
    assert.deepEqual(feed.entries.at(-2), { kind: 'outcome', consensus: false, reason: 'stalled' });
    const propose = feed.entries.find((entry) => entry.kind === 'message' && entry.messageId === 'm4');
    assert.deepEqual(propose?.kind === 'message' ? propose.proposal : undefined, { id: 'p3', by: 'style', summary: 'style-2' });
    assert.deepEqual(
      feed.proposals.map((proposal) => [proposal.id, proposal.status]),
      [['p1', 'unsupported'], ['p2', 'unsupported'], ['p3', 'unsupported']],
    );
  });

  it('невалидная реплика — сообщение с отметкой и без текста', () => {
    const { journal, stepDir } = seed('discussion');
    discussion(stepDir, [
      { kind: 'proposal', id: 'p1', by: 'security', round: 0, content: findings('security') },
      message('m1', 'security', 0, 1, { stance: 'propose', proposal: 'p1' }),
      { kind: 'message', messageId: 'm2', role: 'agent', from: 'tests', round: 1, seq: 1, parts: [], stance: 'disagree', invalid: true },
    ]);

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    const invalid = feed?.entries.find((entry) => entry.kind === 'message');
    assert.ok(invalid?.kind === 'message');
    assert.equal(invalid.invalid, true);
    assert.equal(invalid.text, '');
    assert.equal(invalid.stance, 'disagree');
  });

  it('режим independent: находки по выходам ревьюеров и вердикт без раундов', () => {
    const { journal, stepDir } = seed('independent');
    call(stepDir, 'security', { output: findings('security') });
    call(stepDir, 'tests', { output: findings('tests') });
    call(stepDir, 'style', { status: 'failed', reason: 'бэкенд недоступен' });
    call(stepDir, 'aggregator', { output: { verdict: 'approve', summary: 'ок' } });
    journal.writeStepJson(stepDir, 'step.json', { status: 'success' });

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    assert.ok(feed !== undefined);
    assert.equal(feed.mode, 'independent');
    assert.equal(feed.maxMessages, undefined);
    assert.deepEqual(kinds(feed.entries), ['findings', 'findings', 'failure', 'verdict']);
    const first = feed.entries[0];
    assert.ok(first?.kind === 'findings');
    assert.equal(first.summary, 'security');
    assert.deepEqual(first.findings, [{ severity: 'major', title: 'security: заголовок', location: 'a.ts:1', detail: 'd' }]);
  });

  it('журнал без ленты и без режима в замке — участники и выход агрегатора', () => {
    const { journal, stepDir } = seed(undefined);
    call(stepDir, 'security', { output: findings('security') });
    call(stepDir, 'aggregator', { output: { verdict: 'approve' } });
    journal.writeStepJson(stepDir, 'step.json', { status: 'success' });

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    assert.ok(feed !== undefined);
    assert.equal(feed.legacy, true);
    assert.deepEqual(kinds(feed.entries), ['verdict']);
    assert.deepEqual(feed.participants.map((participant) => participant.id), ['security', 'tests', 'style', 'aggregator']);
  });

  it('идущий шаг: участник с начатым вызовом помечен исполняющимся, лента не дописана', () => {
    const { journal, stepDir } = seed('discussion', { alive: true });
    call(stepDir, 'security', { output: findings('security') });
    call(stepDir, 'tests', { finished: false });

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    assert.ok(feed !== undefined);
    assert.equal(feed.done, false);
    assert.deepEqual(feed.participants.map((participant) => participant.running), [false, true, false, false]);
    // Раунд 0 ещё идёт, ленты нет: находки — из выходов, без строки отказа идущего ревьюера.
    assert.deepEqual(kinds(feed.entries), ['findings']);
  });

  it('вывод вызова участника читается по адресу участника и раунда', () => {
    const { journal, stepDir } = seed('discussion');
    call(stepDir, 'security', { output: findings('security') });
    call(stepDir, 'security', { round: 2 });

    const first = readStepOutput(journal.paths, 'review', 'check', { participant: 'security', stdoutOffset: 0 });
    assert.equal(first.stdout?.content, '{"type":"result","result":"security"}\n');
    assert.equal(first.done, true);
    const reply = readStepOutput(journal.paths, 'review', 'check', { participant: 'security', round: 2, stdoutOffset: 0 });
    assert.equal(reply.stdout?.exists, true);
    assert.deepEqual(readStepOutput(journal.paths, 'review', 'check', { participant: 'nobody', stdoutOffset: 0 }).attempts, []);
  });
});
