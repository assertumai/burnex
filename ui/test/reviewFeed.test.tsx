import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { Context } from 'cordis';
import { renderToStaticMarkup } from 'react-dom/server';

import { COLLAPSE_AFTER, ReviewFeedView, groupEntries, initials, type ReviewSelection } from '../src/components/ReviewFeed';
import { fetchReviewFeed, fetchStepOutput, type ReviewFeed, type ReviewFeedEntry, type ReviewFeedParticipant } from '../src/api';
import { bindRouterKernel } from '../src/router';

/**
 * Лента шага `review` (`ui-review-discussion`, задача 2.4) — по сценариям
 * спеки. Щелчка в тестах нет: разметка проверяется статическим рендером
 * готовой модели, выбор участника — начальным `selected`, живое дополнение —
 * рендером модели следующего опроса и запросом `GET /api/review-feed`.
 */

// Ссылка на исходный прогон (`TargetLink`) читает таблицу маршрутов ядра; без
// совпавшего маршрута она рисует текст с причиной — для рендера этого хватает.
bindRouterKernel({ routes: { get: () => ({ table: [] }) } } as unknown as Context);

function participant(id: string, color: number, overrides: Partial<ReviewFeedParticipant> = {}): ReviewFeedParticipant {
  return {
    id,
    role: id === 'aggregator' ? 'aggregator' : 'reviewer',
    agent: color % 2 === 0 ? 'codex' : 'claude',
    model: `m${color}`,
    color,
    status: 'success',
    running: false,
    messages: 0,
    sessions: [{ running: false, status: 'success', stdout: { name: 'stdout.log', path: `jobs/review/steps/01-check/participants/${id}/stdout.log`, bytes: 10 } }],
    usage: { billableTokens: 1200, costUsd: 0.5, costSource: 'reported', wallclockMs: 5000 },
    ...overrides,
  };
}

const PARTICIPANTS = [
  participant('security', 0, { messages: 2 }),
  participant('tests', 1, { messages: 1 }),
  participant('style', 2, { messages: 1 }),
  participant('aggregator', 3),
];

function findings(id: string, messageId: string, proposal: string): ReviewFeedEntry {
  return {
    kind: 'findings',
    participant: id,
    messageId,
    proposal,
    summary: `${id} summary`,
    findings: [{ severity: 'critical', title: `${id} finding`, location: 'a.ts:1' }],
  };
}

const CONSENSUS: ReviewFeed = {
  mode: 'discussion',
  maxMessages: 2,
  participants: PARTICIPANTS,
  entries: [
    findings('security', 'm1', 'p1'),
    findings('tests', 'm2', 'p2'),
    findings('style', 'm3', 'p3'),
    { kind: 'round', round: 1 },
    { kind: 'message', participant: 'security', messageId: 'm4', round: 1, seq: 1, stance: 'agree', text: 'agree with tests', count: 1, target: { id: 'p2', by: 'tests', summary: 'tests summary' } },
    { kind: 'message', participant: 'tests', messageId: 'm5', round: 1, seq: 2, stance: 'disagree', text: 'no', count: 1, target: { id: 'p3', by: 'style', summary: 'style summary' } },
    { kind: 'message', participant: 'style', messageId: 'm6', round: 1, seq: 3, stance: 'propose', text: 'new one', count: 1, proposal: { id: 'p4', by: 'style', summary: 'merged' } },
    { kind: 'round', round: 2 },
    { kind: 'message', participant: 'security', messageId: 'm7', round: 2, seq: 1, stance: 'agree', text: 'still', count: 2, target: { id: 'p2', by: 'tests', summary: 'tests summary' } },
    { kind: 'outcome', consensus: true, proposal: 'p2' },
    { kind: 'verdict', participant: 'aggregator', status: 'success', verdict: 'request_changes', summary: 'fix the injection', output: { verdict: 'request_changes' } },
  ],
  proposals: [
    { id: 'p1', by: 'security', round: 0, summary: 's', status: 'unsupported' },
    { id: 'p2', by: 'tests', round: 0, summary: 't', status: 'accepted' },
  ],
  legacy: false,
  done: true,
};

function render(feed: ReviewFeed, selected?: ReviewSelection): string {
  return renderToStaticMarkup(
    <ReviewFeedView
      feed={feed}
      address="proj/run-1"
      jobId="review"
      stepId="check"
      stepUsage={{ billableTokens: 3600, wallclockMs: 15000, costUsd: 1.5, costSource: 'reported' }}
      selected={selected}
      onSelect={() => undefined}
    />,
  );
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
}

describe('ui-review-discussion: лента обсуждения', () => {
  it('обсуждение с консенсусом: находки трёх ревьюеров, позиции текстом, цитаты, исход и вердикт последним', () => {
    const html = render(CONSENSUS);
    const plain = text(html);
    for (const id of ['security', 'tests', 'style']) assert.match(plain, new RegExp(`${id} finding`));
    assert.match(plain, /Round 1/);
    assert.match(plain, /Round 2/);
    assert.match(plain, /agrees/);
    assert.match(plain, /disagrees/);
    assert.match(plain, /proposes/);
    assert.match(plain, /agrees with p2 · tests tests summary/);
    assert.match(plain, /new proposal p4 · style merged/);
    assert.match(plain, /Consensus on proposal p2/);
    assert.match(plain, /2\/2/, 'счётчик реплик n/лимит');
    assert.ok(plain.lastIndexOf('fix the injection') > plain.lastIndexOf('Consensus on proposal p2'), 'вердикт — после исхода');
    assert.match(html, /class="review-message own"/, 'вердикт выровнен на свою сторону');
    // Аватары: инициалы и цвет по позиции в стратегии, подпись агента и модели.
    assert.match(html, /review-avatar participant-c0[^>]*>SE</);
    assert.match(html, /review-avatar participant-c1[^>]*>TE</);
    assert.match(plain, /codex · m0/);
  });

  it('лента — обновляемый журнал для вспомогательных технологий, пока шаг идёт', () => {
    assert.match(render({ ...CONSENSUS, done: false }), /role="log" aria-live="polite"/);
    assert.match(render(CONSENSUS), /role="log" aria-live="off"/);
  });

  it('ревьюер без находок и исход без консенсуса — системными строками с причиной', () => {
    const plain = text(
      render({
        ...CONSENSUS,
        entries: [
          findings('security', 'm1', 'p1'),
          { kind: 'failure', participant: 'tests', reason: 'timeout' },
          { kind: 'outcome', consensus: false, reason: 'limit' },
        ],
      }),
    );
    assert.match(plain, /Reviewer tests gave no findings: timeout/);
    assert.match(plain, /No consensus: message limit exhausted/);
  });

  it('невалидная реплика помечена', () => {
    const plain = text(
      render({
        ...CONSENSUS,
        entries: [{ kind: 'message', participant: 'tests', messageId: 'm2', round: 1, seq: 1, stance: 'disagree', text: '', count: 1, invalid: true }],
      }),
    );
    assert.match(plain, /reply failed the schema check/);
  });

  it('реплика, сорванная сбоем, помечена причиной, а не схемой', () => {
    const plain = text(
      render({
        ...CONSENSUS,
        entries: [
          { kind: 'message', participant: 'tests', messageId: 'm2', round: 1, seq: 1, stance: 'disagree', text: '', count: 1, failure: 'timeout' },
        ],
      }),
    );
    assert.match(plain, /reply failed: timeout/);
    assert.doesNotMatch(plain, /schema check/);
  });

  it('переиспользованный шаг называет исходный прогон; без него — вердикт вместо «No messages yet»', () => {
    const available = text(render({ ...CONSENSUS, reusedFrom: { runId: 'run-0', available: true } }));
    assert.match(available, /Reused from run run-0/);
    assert.match(available, /security summary/);

    const verdict = CONSENSUS.entries.at(-1) as ReviewFeedEntry;
    const gone = text(
      render({ ...CONSENSUS, participants: PARTICIPANTS.map((entry) => ({ ...entry, sessions: [] })), entries: [verdict], proposals: [], reusedFrom: { runId: 'run-0', available: false } }),
    );
    assert.match(gone, /Reused from run run-0/);
    assert.match(gone, /no longer available/);
    assert.doesNotMatch(gone, /No messages yet/);
  });

  it('режим independent: находки и вердикт без раундов и без блока лимита', () => {
    const html = render({
      mode: 'independent',
      participants: PARTICIPANTS,
      entries: [findings('security', 'm1', 'p1'), findings('tests', 'm2', 'p2'), CONSENSUS.entries.at(-1) as ReviewFeedEntry],
      proposals: [],
      legacy: false,
      done: true,
    });
    const plain = text(html);
    assert.doesNotMatch(plain, /Round/);
    assert.doesNotMatch(plain, /Message limit/);
    assert.match(plain, /security finding/);
    assert.match(plain, /fix the injection/);
  });

  it('боковая панель: исчерпанный лимит, предложения со статусом, расход по участникам и шагу', () => {
    const html = render(CONSENSUS);
    assert.match(html, /<li class="exhausted"><span class="review-name participant-c0">security<\/span> <span class="mono">2\/2<\/span><span class="kind"> · exhausted/);
    const plain = text(html);
    assert.match(plain, /tests 1\/2/);
    assert.match(plain, /p2 by tests accepted by consensus/);
    assert.match(plain, /p1 by security no support/);
    assert.match(plain, /security 1\.2k · 5s/);
    assert.match(plain, /step 3\.6k · 15s/);
  });

  it('на узкой ширине панель уходит под ленту', () => {
    const css = readFileSync(join(process.cwd(), 'ui', 'src', 'components', 'reviewFeed.css'), 'utf8');
    assert.match(css, /@media \(max-width: \d+px\) \{\s*\.review-feed \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });

  it('выбор сообщения ревьюера открывает разобранный ход его сессии со ссылкой на stdout.log', () => {
    const html = render(CONSENSUS, { participant: 'security', round: 1 });
    const plain = text(html);
    assert.match(plain, /Turn of security · round 1/);
    assert.match(plain, /step output ▾/, 'тот же StepOutput агентского шага, раскрытый');
    assert.match(html, /aria-label="Turn of security"/);
    const first = render({ ...CONSENSUS, participants: [participant('security', 0, { sessions: [{ running: false, stdout: { name: 'stdout.log', path: 'p/security/stdout.log', bytes: 3 } }] })] }, { participant: 'security' });
    assert.match(text(first), /raw .*stdout\.log/);
    assert.match(render(CONSENSUS), /aria-label="Open the turn of security"/, 'аватар — кнопка хода участника');
  });

  it('новая реплика по ходу появляется в ленте следующего опроса, идущий участник назван', () => {
    const before = { ...CONSENSUS, entries: CONSENSUS.entries.slice(0, 4), done: false, participants: [participant('security', 0, { running: true, sessions: [{ running: false }, { round: 1, running: true }] }), ...PARTICIPANTS.slice(1)] };
    assert.match(text(render(before)), /security is replying in round 1…/);
    assert.doesNotMatch(text(render(before)), /agree with tests/);
    const after = { ...before, entries: CONSENSUS.entries.slice(0, 5) };
    assert.match(text(render(after)), /agree with tests/);
  });

  it('журнал без ленты — список участников и выход агрегатора', () => {
    const plain = text(render({ participants: PARTICIPANTS, entries: [CONSENSUS.entries.at(-1) as ReviewFeedEntry], proposals: [], legacy: true, done: true }));
    assert.match(plain, /no discussion record/);
    assert.match(plain, /security reviewer codex · m0 success/);
    assert.match(plain, /fix the injection/);
  });

  it('длинная лента сворачивает раунды, кроме последнего', () => {
    const entries: ReviewFeedEntry[] = [findings('security', 'm0', 'p1')];
    let id = 1;
    for (let round = 1; round <= 4; round += 1) {
      entries.push({ kind: 'round', round });
      for (let seq = 1; seq <= 8; seq += 1) {
        entries.push({ kind: 'message', participant: 'security', messageId: `m${id}`, round, seq, stance: 'agree', text: `t${id}`, count: 1 });
        id += 1;
      }
    }
    entries.push({ kind: 'outcome', consensus: false, reason: 'limit' });
    assert.ok(id - 1 > COLLAPSE_AFTER);
    const groups = groupEntries(entries);
    assert.deepEqual(groups.map((group) => [group.round, group.collapsed]), [[0, false], [1, true], [2, true], [3, true], [4, false], [-1, false]]);
    const html = render({ ...CONSENSUS, entries });
    assert.equal(html.match(/<details><summary class="review-system">/g)?.length, 3);
    assert.deepEqual(groupEntries(CONSENSUS.entries).map((group) => group.collapsed), [false, false, false, false]);
  });

  it('инициалы аватара', () => {
    assert.equal(initials('security'), 'SE');
    assert.equal(initials('api-tests'), 'AT');
  });
});

describe('ui-review-discussion: запросы ленты и хода участника', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(body: unknown): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return urls;
  }

  it('лента спрашивается по адресу шага и проходу', async () => {
    const urls = stubFetch(CONSENSUS);
    const feed = await fetchReviewFeed({ address: 'proj/run-1', jobId: 'review', stepId: 'check', pass: 2 });
    assert.equal(feed.entries.length, CONSENSUS.entries.length);
    const url = new URL(urls[0] ?? '', 'http://x');
    assert.equal(url.pathname, '/api/review-feed');
    assert.deepEqual(Object.fromEntries(url.searchParams), { run: 'proj/run-1', job: 'review', step: 'check', pass: '2' });
  });

  it('ход участника спрашивается выводом шага с участником и раундом', async () => {
    const urls = stubFetch({ attempts: [], done: true });
    await fetchStepOutput({ address: 'proj/run-1', jobId: 'review', stepId: 'check', participant: 'security', round: 2, stdoutOffset: 0 });
    const query = new URL(urls[0] ?? '', 'http://x').searchParams;
    assert.equal(query.get('participant'), 'security');
    assert.equal(query.get('round'), '2');
  });
});
