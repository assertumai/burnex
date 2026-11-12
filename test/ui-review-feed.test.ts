import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { readReviewFeed, type ReviewFeedEntry } from '../src/parts/ui/reviewFeed.js';
import { readStepOutput } from '../src/parts/ui/stepOutput.js';
import type { RunJournal } from '../src/parts/pipeline/run/journal/writer.js';
import { makeJournalBed, seedRun } from './helpers.js';

/**
 * Модель ленты шага `review` (`review-defend`, задача 4.4): режим `defend`
 * из `defense.ndjson` и `participants/*` (защитник-форк и свежий, спор до
 * `contested`, снятие, пересмотр серьёзности, сбой защитника), режим
 * `independent` по выходам участников и журнал прежнего режима `discussion`.
 */

type Mode = 'independent' | 'defend' | 'discussion';

function lock(mode: Mode | undefined, reviewers: readonly string[] = ['security', 'tests', 'style']): string {
  const extra = mode === 'defend' ? ', defend: { rounds: 3 }' : mode === 'discussion' ? ', discussion: { max_messages: 2 }' : '';
  const strategy = mode === undefined ? '{ ref: ./strategy.yml }' : `{ ref: ./strategy.yml, mode: ${mode}${extra} }`;
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

function seed(mode: Mode | undefined, options: { readonly alive?: boolean } = {}): Bed {
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
    /** Ветка защитника: каталог `participants/defender/<thread>/rounds/<round>`. */
    readonly thread?: string;
    readonly status?: string;
    readonly reason?: string;
    readonly output?: unknown;
    readonly finished?: boolean;
  } = {},
): void {
  const base = join(stepDir, 'participants', participant, ...(options.thread === undefined ? [] : [options.thread]));
  const dir = options.round === undefined ? base : join(base, 'rounds', String(options.round));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stdout.log'), `{"type":"result","result":"${participant}"}\n`);
  if (options.finished === false) return;
  writeFileSync(
    join(dir, 'step.json'),
    JSON.stringify({
      participant,
      role: participant === 'aggregator' ? 'aggregator' : participant === 'defender' ? 'defender' : 'reviewer',
      status: options.status ?? 'success',
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      attempts: [{ attempt: 1, status: 'success', started_at: '2026-08-01T00:00:00.000Z', finished_at: '2026-08-01T00:00:05.000Z' }],
    }),
  );
  if (options.output !== undefined) writeFileSync(join(dir, 'output.json'), JSON.stringify(options.output));
}

interface Declared {
  readonly severity: string;
  readonly title: string;
}

function findings(summary: string, list: readonly Declared[] = [{ severity: 'major', title: `${summary}: заголовок` }]): unknown {
  return {
    summary,
    findings: list.map((finding) => ({ ...finding, location: 'a.ts:1', detail: 'd', suggestion: null })),
  };
}

function defense(stepDir: string, records: readonly unknown[]): void {
  writeFileSync(join(stepDir, 'defense.ndjson'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

function finding(id: string, by: string, severity: string, title: string): unknown {
  return { kind: 'finding', id, by, severity, title, location: 'a.ts:1', detail: 'd', suggestion: null };
}

function reply(messageId: string, from: string, thread: string, round: number, responses: readonly unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    kind: 'message',
    messageId,
    role: 'agent',
    from,
    thread,
    round,
    parts: [{ kind: 'text', text: `${from} в ветке ${thread}, раунд ${round}` }],
    responses,
    ...extra,
  };
}

function kinds(entries: readonly ReviewFeedEntry[]): string[] {
  return entries.map((entry) => (entry.kind === 'reply' ? `${entry.side} ${entry.thread}/${entry.round}` : entry.kind === 'findings' || entry.kind === 'failure' ? `${entry.kind} ${entry.participant}` : entry.kind));
}

describe('лента шага review', () => {
  it('защитник-форк: спор до contested, принятие и снятие; реплики под находками своего ревьюера, вердикт последним', () => {
    const { journal, stepDir } = seed('defend');
    call(stepDir, 'security', { output: findings('security', [{ severity: 'critical', title: 'инъекция' }, { severity: 'major', title: 'утечка' }]) });
    call(stepDir, 'tests', { output: findings('tests') });
    call(stepDir, 'style', { status: 'failed', reason: 'таймаут' });
    for (const round of [1, 2]) call(stepDir, 'defender', { thread: 'security', round });
    call(stepDir, 'defender', { thread: 'tests', round: 1 });
    for (const round of [1, 2]) call(stepDir, 'security', { round });
    call(stepDir, 'tests', { round: 1 });
    call(stepDir, 'aggregator', { output: { verdict: 'request_changes', summary: 'итог' } });
    defense(stepDir, [
      { kind: 'defender', mode: 'fork', implementer: 'build.implement', agent: 'claude', model: 'opus' },
      finding('security.1', 'security', 'critical', 'инъекция'),
      finding('security.2', 'security', 'major', 'утечка'),
      finding('tests.1', 'tests', 'major', 'tests: заголовок'),
      reply('m1', 'defender', 'security', 1, [
        { finding: 'security.1', stance: 'dispute', text: 'вход экранирован', evidence: 'src/x.ts:42' },
        { finding: 'security.2', stance: 'accept', text: 'верно', evidence: null },
      ]),
      reply('m2', 'defender', 'tests', 1, [{ finding: 'tests.1', stance: 'clarify', text: 'тест есть', evidence: 'test/a.test.ts:7' }]),
      { kind: 'settled', finding: 'security.2', status: 'accepted', severity: 'major', round: 1 },
      reply('m3', 'security', 'security', 1, [{ finding: 'security.1', stance: 'maintain', text: 'не везде', severity: null }]),
      reply('m4', 'tests', 'tests', 1, [{ finding: 'tests.1', stance: 'withdraw', text: 'вижу', severity: null }]),
      { kind: 'settled', finding: 'tests.1', status: 'withdrawn', severity: 'major', round: 1 },
      reply('m5', 'defender', 'security', 2, [{ finding: 'security.1', stance: 'dispute', text: 'всё ещё', evidence: 'src/x.ts:50' }]),
      reply('m6', 'security', 'security', 2, [{ finding: 'security.1', stance: 'maintain', text: 'настаиваю', severity: null }]),
      { kind: 'settled', finding: 'security.1', status: 'contested', severity: 'critical', round: 2 },
      { kind: 'outcome', accepted: 1, withdrawn: 1, contested: 1 },
    ]);
    journal.writeStepJson(stepDir, 'step.json', { status: 'success' });

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    assert.ok(feed !== undefined);
    assert.equal(feed.mode, 'defend');
    assert.equal(feed.rounds, 3, 'лимит раундов — из записи стратегии в замке');
    assert.equal(feed.legacy, false);
    assert.equal(feed.done, true);
    assert.deepEqual(feed.defender, { mode: 'fork', implementer: 'build.implement', agent: 'claude', model: 'opus' });
    assert.deepEqual(
      feed.participants.map((participant) => [participant.id, participant.role, participant.color, participant.agent, participant.model]),
      [
        ['security', 'reviewer', 0, 'codex', 'm0'],
        ['tests', 'reviewer', 1, 'claude', 'm1'],
        ['style', 'reviewer', 2, 'codex', 'm2'],
        ['defender', 'defender', 4, 'claude', 'opus'],
        ['aggregator', 'aggregator', 3, 'claude', 'sonnet'],
      ],
    );
    assert.deepEqual(kinds(feed.entries), [
      'defender',
      'findings security', 'defender security/1', 'reviewer security/1', 'defender security/2', 'reviewer security/2',
      'findings tests', 'defender tests/1', 'reviewer tests/1',
      'failure style',
      'outcome', 'verdict',
    ]);

    const security = feed.entries[1];
    assert.ok(security?.kind === 'findings');
    assert.deepEqual(
      security.findings.map((entry) => [entry.id, entry.status, entry.severity, entry.title]),
      [['security.1', 'contested', 'critical', 'инъекция'], ['security.2', 'accepted', 'major', 'утечка']],
    );
    const dispute = feed.entries[2];
    assert.ok(dispute?.kind === 'reply');
    assert.equal(dispute.participant, 'defender');
    assert.equal(dispute.text, 'defender в ветке security, раунд 1');
    assert.deepEqual(dispute.responses, [
      { finding: 'security.1', stance: 'dispute', text: 'вход экранирован', evidence: 'src/x.ts:42' },
      { finding: 'security.2', stance: 'accept', text: 'верно' },
    ]);
    assert.deepEqual(feed.entries.at(-2), { kind: 'outcome', accepted: 1, withdrawn: 1, contested: 1 });
    const verdict = feed.entries.at(-1);
    assert.ok(verdict?.kind === 'verdict');
    assert.equal(verdict.verdict, 'request_changes');

    assert.deepEqual(
      feed.findings.map((entry) => [entry.id, entry.by, entry.status, entry.severity]),
      [
        ['security.1', 'security', 'contested', 'critical'],
        ['security.2', 'security', 'accepted', 'major'],
        ['tests.1', 'tests', 'withdrawn', 'major'],
      ],
    );
    assert.deepEqual(feed.threads, [
      { reviewer: 'security', rounds: 2, settled: true },
      { reviewer: 'tests', rounds: 1, settled: true },
    ]);

    const defender = feed.participants.find((participant) => participant.id === 'defender');
    assert.deepEqual(defender?.sessions.map((session) => [session.thread, session.round]), [['security', 1], ['security', 2], ['tests', 1]]);
    assert.equal(
      defender?.sessions[1]?.stdout?.path,
      join('jobs', 'review', 'steps', '01-check', 'participants', 'defender', 'security', 'rounds', '2', 'stdout.log'),
    );
    assert.equal(defender?.usage.wallclockMs, 15_000, 'расход защитника — по всем веткам');
    const reviewer = feed.participants[0];
    assert.deepEqual(reviewer?.sessions.map((session) => session.round), [undefined, 1, 2]);
    assert.equal(reviewer?.usage.wallclockMs, 15_000);
  });

  it('свежий защитник с причиной; пересмотр серьёзности отмечен прежней', () => {
    const { journal, stepDir } = seed('defend');
    call(stepDir, 'security', { output: findings('security', [{ severity: 'critical', title: 'инъекция' }]) });
    defense(stepDir, [
      { kind: 'defender', mode: 'fresh', agent: 'claude', reason: 'no_session' },
      finding('security.1', 'security', 'critical', 'инъекция'),
      reply('m1', 'defender', 'security', 1, [{ finding: 'security.1', stance: 'dispute', text: 'не критично', evidence: null }]),
      reply('m2', 'security', 'security', 1, [{ finding: 'security.1', stance: 'revise', text: 'соглашусь на major', severity: 'major' }]),
    ]);

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    assert.ok(feed !== undefined);
    assert.deepEqual(feed.entries[0], { kind: 'defender', mode: 'fresh', agent: 'claude', reason: 'no_session' });
    const own = feed.entries.find((entry) => entry.kind === 'findings');
    assert.ok(own?.kind === 'findings');
    assert.deepEqual(own.findings.map((entry) => [entry.id, entry.status, entry.severity, entry.revisedFrom]), [['security.1', 'open', 'major', 'critical']]);
    assert.deepEqual(feed.findings[0], { id: 'security.1', by: 'security', status: 'open', title: 'инъекция', severity: 'major', revisedFrom: 'critical' });
    const revise = feed.entries.find((entry) => entry.kind === 'reply' && entry.side === 'reviewer');
    assert.deepEqual(revise?.kind === 'reply' ? revise.responses : undefined, [{ finding: 'security.1', stance: 'revise', text: 'соглашусь на major', severity: 'major' }]);
    assert.deepEqual(feed.threads, [{ reviewer: 'security', rounds: 1, settled: false }]);
  });

  it('сбой защитника — реплика с причиной, находки ветки contested; невалидная — с отметкой', () => {
    const { journal, stepDir } = seed('defend');
    call(stepDir, 'security', { output: findings('security') });
    call(stepDir, 'tests', { output: findings('tests') });
    defense(stepDir, [
      { kind: 'defender', mode: 'fork', implementer: 'implement', agent: 'claude' },
      finding('security.1', 'security', 'major', 'security: заголовок'),
      finding('tests.1', 'tests', 'major', 'tests: заголовок'),
      { kind: 'message', messageId: 'm1', role: 'agent', from: 'defender', thread: 'security', round: 1, parts: [], responses: [], failure: 'форк не удался' },
      { kind: 'settled', finding: 'security.1', status: 'contested', severity: 'major', round: 1 },
      { kind: 'message', messageId: 'm2', role: 'agent', from: 'defender', thread: 'tests', round: 1, parts: [], responses: [], invalid: true },
      { kind: 'settled', finding: 'tests.1', status: 'contested', severity: 'major', round: 1 },
      { kind: 'outcome', accepted: 0, withdrawn: 0, contested: 2 },
    ]);

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    assert.ok(feed !== undefined);
    const failed = feed.entries.find((entry) => entry.kind === 'reply' && entry.thread === 'security');
    assert.ok(failed?.kind === 'reply');
    assert.equal(failed.failure, 'форк не удался');
    assert.equal(failed.invalid, undefined);
    assert.deepEqual(failed.responses, []);
    const invalid = feed.entries.find((entry) => entry.kind === 'reply' && entry.thread === 'tests');
    assert.equal(invalid?.kind === 'reply' ? invalid.invalid : undefined, true);
    assert.deepEqual(feed.findings.map((entry) => entry.status), ['contested', 'contested']);
  });

  it('идущая защита: находки open до закрытия, ход ветки защитника — исполняется', () => {
    const { journal, stepDir } = seed('defend', { alive: true });
    call(stepDir, 'security', { output: findings('security') });
    call(stepDir, 'tests', { output: findings('tests', [{ severity: 'minor', title: 'a' }, { severity: 'info', title: 'b' }]) });
    call(stepDir, 'style', { output: findings('style', []) });
    call(stepDir, 'defender', { thread: 'security', round: 1, finished: false });
    defense(stepDir, [
      { kind: 'defender', mode: 'fresh', reason: 'no_implementer', agent: 'codex' },
      finding('security.1', 'security', 'major', 'security: заголовок'),
    ]);

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    assert.ok(feed !== undefined);
    assert.equal(feed.done, false);
    assert.equal(feed.participants.find((participant) => participant.id === 'defender')?.running, true);
    const [security, tests, style] = feed.entries.filter((entry) => entry.kind === 'findings');
    assert.deepEqual(security?.kind === 'findings' ? security.findings.map((entry) => [entry.id, entry.status]) : undefined, [['security.1', 'open']]);
    // Строки находок ревьюера ещё не записаны — id по порядку его выхода.
    assert.deepEqual(tests?.kind === 'findings' ? tests.findings.map((entry) => [entry.id, entry.status]) : undefined, [['tests.1', 'open'], ['tests.2', 'open']]);
    assert.deepEqual(style?.kind === 'findings' ? style.findings : undefined, []);
    assert.deepEqual(feed.threads, [{ reviewer: 'security', rounds: 0, settled: false }]);
  });

  it('режим independent: находки по выходам ревьюеров и вердикт без защиты', () => {
    const { journal, stepDir } = seed('independent');
    call(stepDir, 'security', { output: findings('security') });
    call(stepDir, 'tests', { output: findings('tests') });
    call(stepDir, 'style', { status: 'failed', reason: 'бэкенд недоступен' });
    call(stepDir, 'aggregator', { output: { verdict: 'approve', summary: 'ок' } });
    journal.writeStepJson(stepDir, 'step.json', { status: 'success' });

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    assert.ok(feed !== undefined);
    assert.equal(feed.mode, 'independent');
    assert.equal(feed.rounds, undefined);
    assert.equal(feed.defender, undefined);
    assert.deepEqual(feed.findings, []);
    assert.deepEqual(kinds(feed.entries), ['findings security', 'findings tests', 'failure style', 'verdict']);
    assert.equal(feed.participants.some((participant) => participant.role === 'defender'), false);
    const first = feed.entries[0];
    assert.ok(first?.kind === 'findings');
    assert.equal(first.summary, 'security');
    assert.deepEqual(first.findings, [{ severity: 'major', title: 'security: заголовок', location: 'a.ts:1', detail: 'd' }]);
  });

  it('журнал прежнего режима discussion — участники и вердикт, реплики не разбираются', () => {
    const { journal, stepDir } = seed('discussion');
    call(stepDir, 'security', { output: findings('security') });
    call(stepDir, 'security', { round: 1 });
    call(stepDir, 'aggregator', { output: { verdict: 'approve', summary: 'ок' } });
    const old = { kind: 'message', messageId: 'm1', role: 'agent', from: 'security', round: 1, seq: 1, parts: [{ kind: 'text', text: 'x' }], stance: 'agree' };
    writeFileSync(join(stepDir, 'discussion.ndjson'), `${JSON.stringify(old)}\n`);
    journal.writeStepJson(stepDir, 'step.json', { status: 'success' });

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    assert.ok(feed !== undefined);
    assert.equal(feed.legacy, true);
    assert.equal(feed.legacyMode, 'discussion');
    assert.equal(feed.mode, undefined);
    assert.deepEqual(kinds(feed.entries), ['verdict']);
    assert.deepEqual(feed.participants.map((participant) => participant.id), ['security', 'tests', 'style', 'aggregator']);
  });

  it('журнал без ленты и без режима в замке — участники и выход агрегатора', () => {
    const { journal, stepDir } = seed(undefined);
    call(stepDir, 'security', { output: findings('security') });
    call(stepDir, 'aggregator', { output: { verdict: 'approve' } });
    journal.writeStepJson(stepDir, 'step.json', { status: 'success' });

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    assert.ok(feed !== undefined);
    assert.equal(feed.legacy, true);
    assert.equal(feed.legacyMode, undefined);
    assert.deepEqual(kinds(feed.entries), ['verdict']);
    assert.deepEqual(feed.participants.map((participant) => participant.id), ['security', 'tests', 'style', 'aggregator']);
  });

  it('идущий шаг: участник с начатым вызовом помечен исполняющимся, лента не дописана', () => {
    const { journal, stepDir } = seed('independent', { alive: true });
    call(stepDir, 'security', { output: findings('security') });
    call(stepDir, 'tests', { finished: false });

    const feed = readReviewFeed(journal.paths, 'review', 'check');
    assert.ok(feed !== undefined);
    assert.equal(feed.done, false);
    assert.deepEqual(feed.participants.map((participant) => participant.running), [false, true, false, false]);
    // Находки — из выходов, без строки отказа идущего ревьюера.
    assert.deepEqual(kinds(feed.entries), ['findings security']);
  });

  it('вывод вызова участника читается по адресу участника, раунда и ветки защитника', () => {
    const { journal, stepDir } = seed('defend');
    call(stepDir, 'security', { output: findings('security') });
    call(stepDir, 'security', { round: 2 });
    call(stepDir, 'defender', { thread: 'security', round: 1 });

    const first = readStepOutput(journal.paths, 'review', 'check', { participant: 'security', stdoutOffset: 0 });
    assert.equal(first.stdout?.content, '{"type":"result","result":"security"}\n');
    assert.equal(first.done, true);
    const answer = readStepOutput(journal.paths, 'review', 'check', { participant: 'security', round: 2, stdoutOffset: 0 });
    assert.equal(answer.stdout?.exists, true);
    assert.deepEqual(readStepOutput(journal.paths, 'review', 'check', { participant: 'nobody', stdoutOffset: 0 }).attempts, []);
    const turn = readStepOutput(journal.paths, 'review', 'check', { participant: 'defender', thread: 'security', round: 1, stdoutOffset: 0 });
    assert.equal(turn.stdout?.content, '{"type":"result","result":"defender"}\n');
    assert.deepEqual(readStepOutput(journal.paths, 'review', 'check', { participant: 'defender', thread: 'tests', round: 1, stdoutOffset: 0 }).attempts, []);
  });
});
