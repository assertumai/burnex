import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { Context } from 'cordis';
import { renderToStaticMarkup } from 'react-dom/server';

import { ALL_TAB, ReviewFeedView, defenderLine, displayId, entriesForTab, initials, reviewerTabs, roleLabel, runningLabels, stanceLabel, type ReviewSelection } from '../src/components/ReviewFeed';
import { fetchReviewFeed, fetchStepOutput, type ReviewFeed, type ReviewFeedEntry, type ReviewFeedParticipant } from '../src/api';
import { bindRouterKernel } from '../src/router';

/**
 * Лента шага `review` (`review-defend`, задача 4.4) — по сценариям спеки
 * `ui-dashboard`. Щелчка в тестах нет: разметка проверяется статическим
 * рендером готовой модели, выбор участника — начальным `selected`, живое
 * дополнение — рендером модели следующего опроса и запросом
 * `GET /api/review-feed`.
 */

// Ссылка на исходный прогон (`TargetLink`) читает таблицу маршрутов ядра; без
// совпавшего маршрута она рисует текст с причиной — для рендера этого хватает.
bindRouterKernel({ routes: { get: () => ({ table: [] }) } } as unknown as Context);

function participant(id: string, color: number, overrides: Partial<ReviewFeedParticipant> = {}, withoutStatus = false): ReviewFeedParticipant {
  const made: ReviewFeedParticipant = {
    id,
    role: id === 'aggregator' ? 'aggregator' : id === 'defender' ? 'defender' : 'reviewer',
    agent: color % 2 === 0 ? 'codex' : 'claude',
    model: `m${color}`,
    color,
    status: 'success',
    running: false,
    sessions: [{ running: false, status: 'success', stdout: { name: 'stdout.log', path: `jobs/review/steps/01-check/participants/${id}/stdout.log`, bytes: 10 } }],
    usage: { billableTokens: 1200, costUsd: 0.5, costSource: 'reported', wallclockMs: 5000 },
    ...overrides,
  };
  if (!withoutStatus) return made;
  const { status: _status, ...rest } = made;
  return rest;
}

const DEFENDER = participant('defender', 4, {
  agent: 'claude',
  model: 'opus',
  sessions: [
    { thread: 'security', round: 1, running: false, status: 'success', stdout: { name: 'stdout.log', path: 'jobs/review/steps/01-check/participants/defender/security/rounds/1/stdout.log', bytes: 7 } },
    { thread: 'security', round: 2, running: false, status: 'success' },
    { thread: 'tests', round: 1, running: false, status: 'success' },
  ],
  usage: { billableTokens: 9000, costUsd: 2, costSource: 'reported', wallclockMs: 20_000 },
}, true);

const PARTICIPANTS = [participant('security', 0), participant('tests', 1), participant('style', 2), DEFENDER, participant('aggregator', 3)];

const VERDICT: ReviewFeedEntry = {
  kind: 'verdict',
  participant: 'aggregator',
  status: 'success',
  verdict: 'request_changes',
  summary: 'fix the injection',
  output: { verdict: 'request_changes' },
};

const DEFEND: ReviewFeed = {
  mode: 'defend',
  rounds: 2,
  defender: { mode: 'fork', implementer: 'build.implement', agent: 'claude', model: 'opus' },
  participants: PARTICIPANTS,
  entries: [
    { kind: 'defender', mode: 'fork', implementer: 'build.implement', agent: 'claude', model: 'opus' },
    {
      kind: 'findings',
      participant: 'security',
      summary: 'security summary',
      findings: [
        { id: 'security.1', severity: 'critical', title: 'SQL injection', location: 'src/db.ts:10', status: 'contested' },
        { id: 'security.2', severity: 'major', title: 'token in logs', status: 'accepted' },
        { id: 'security.3', severity: 'major', revisedFrom: 'critical', title: 'weak hash', status: 'accepted' },
      ],
    },
    {
      kind: 'reply',
      participant: 'defender',
      side: 'defender',
      thread: 'security',
      round: 1,
      messageId: 'm1',
      text: 'Most of it holds.',
      responses: [
        { finding: 'security.1', stance: 'dispute', text: 'the input is escaped', evidence: 'src/db.ts:42 escape(input)' },
        { finding: 'security.2', stance: 'accept', text: 'right' },
        { finding: 'security.3', stance: 'clarify', text: 'legacy hashes only' },
      ],
    },
    {
      kind: 'reply',
      participant: 'security',
      side: 'reviewer',
      thread: 'security',
      round: 1,
      messageId: 'm2',
      text: '',
      responses: [
        { finding: 'security.1', stance: 'maintain', text: 'not on every path' },
        { finding: 'security.3', stance: 'revise', text: 'major then', severity: 'major' },
      ],
    },
    {
      kind: 'findings',
      participant: 'tests',
      summary: 'tests summary',
      findings: [
        { id: 'tests.1', severity: 'minor', title: 'no edge case', status: 'withdrawn' },
        { id: 'tests.2', severity: 'major', title: 'flaky', status: 'accepted' },
      ],
    },
    { kind: 'reply', participant: 'defender', side: 'defender', thread: 'tests', round: 1, messageId: 'm3', text: '', responses: [], failure: 'fork failed' },
    { kind: 'failure', participant: 'style', reason: 'timeout' },
    { kind: 'outcome', accepted: 3, withdrawn: 1, contested: 1 },
    VERDICT,
  ],
  findings: [
    { id: 'security.1', by: 'security', title: 'SQL injection', severity: 'critical', status: 'contested' },
    { id: 'security.2', by: 'security', title: 'token in logs', severity: 'major', status: 'accepted' },
    { id: 'security.3', by: 'security', title: 'weak hash', severity: 'major', revisedFrom: 'critical', status: 'accepted' },
    { id: 'tests.1', by: 'tests', title: 'no edge case', severity: 'minor', status: 'withdrawn' },
    { id: 'tests.2', by: 'tests', title: 'flaky', severity: 'major', status: 'accepted' },
  ],
  threads: [
    { reviewer: 'security', rounds: 2, settled: true },
    { reviewer: 'tests', rounds: 1, settled: true },
  ],
  legacy: false,
  done: true,
};

function render(feed: ReviewFeed, selected?: ReviewSelection, initialTab?: string): string {
  return renderToStaticMarkup(
    <ReviewFeedView
      feed={feed}
      {...(initialTab === undefined ? {} : { initialTab })}
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
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

/** Разметка ленты без боковой панели. */
function log(html: string): string {
  return html.split('<aside')[0] ?? '';
}

describe('review-defend: лента защиты', () => {
  it('защитник-форк: первая строка ленты называет форк, шаг имплементатора, агента и модель', () => {
    const html = render(DEFEND);
    const first = /<ol class="review-log"[^>]*><li class="review-system">([^<]*)<\/li>/.exec(html)?.[1];
    assert.equal(first, 'Defender: fork of the build.implement session · claude · opus');
  });

  it('свежий защитник называет агента и причину', () => {
    assert.equal(defenderLine({ mode: 'fresh', agent: 'claude', reason: 'no_session' }), 'Defender: fresh agent claude — the implementer step recorded no session');
    assert.equal(defenderLine({ mode: 'fresh', agent: 'codex', model: 'gpt', reason: 'no_fork' }), "Defender: fresh agent codex · gpt — the implementer's agent cannot fork sessions");
    assert.equal(defenderLine({ mode: 'fresh', agent: 'claude', reason: 'no_implementer' }), 'Defender: fresh agent claude — the step names no implementer');
  });

  it('ветка со спором: карточка security.1 contested, реплика защитника disputes с доказательством, ревьюера — maintains', () => {
    const plain = text(log(render(DEFEND)));
    assert.match(plain, /security\.1 contested critical SQL injection · src\/db\.ts:10/);
    assert.match(plain, /security\.1 disputes the input is escaped evidence src\/db\.ts:42 escape\(input\)/);
    assert.match(plain, /security\.1 maintains not on every path/);
    assert.match(plain, /security\.2 accepts right/);
    assert.match(plain, /security\.3 clarifies legacy hashes only/);
    // Реплики ветки — под находками своего ревьюера, до находок следующего.
    assert.ok(plain.indexOf('the input is escaped') > plain.indexOf('SQL injection'));
    assert.ok(plain.indexOf('not on every path') < plain.indexOf('tests summary'));
  });

  it('пересмотр серьёзности: метка revises → major и серьёзность с отметкой прежней', () => {
    const plain = text(log(render(DEFEND)));
    assert.match(plain, /security\.3 revises → major major then/);
    assert.match(plain, /security\.3 accepted major \(revised from critical\) weak hash/);
    assert.equal(stanceLabel({ stance: 'revise', severity: 'minor' }), 'revises → minor');
    assert.equal(stanceLabel({ stance: 'withdraw' }), 'withdraws');
  });

  it('защитник стоит на противоположной стороне: его реплики и вердикт — own, ревьюеры — нет', () => {
    const html = log(render(DEFEND));
    assert.match(html, /<li class="review-message review-thread own"><article class="review-bubble participant-c4">/);
    assert.match(html, /<li class="review-message review-thread"><button[^>]*review-avatar participant-c0/);
    assert.match(html, /<li class="review-message own"><article class="review-bubble participant-c3">/, 'вердикт — на стороне защитника');
    const plain = text(html);
    assert.ok(plain.lastIndexOf('fix the injection') > plain.lastIndexOf('Defense finished'), 'вердикт — последним');
    assert.match(plain, /Defense finished: 3 accepted · 1 withdrawn · 1 contested/);
    assert.match(plain, /round 1\/2/, 'раунд реплики из лимита');
  });

  it('невалидная и упавшая реплики помечены', () => {
    const plain = text(log(render(DEFEND)));
    assert.match(plain, /reply failed: fork failed/);
    const invalid = text(
      render({
        ...DEFEND,
        entries: [{ kind: 'reply', participant: 'defender', side: 'defender', thread: 'security', round: 1, messageId: 'm1', text: '', responses: [], invalid: true }],
      }),
    );
    assert.match(invalid, /reply failed the schema check/);
  });

  it('ревьюер без находок — системной строкой с причиной; пустой список — «No findings»', () => {
    const plain = text(log(render(DEFEND)));
    assert.match(plain, /Reviewer style gave no findings: timeout/);
    const empty = text(log(render({ ...DEFEND, entries: [{ kind: 'findings', participant: 'style', summary: '', findings: [] }] })));
    assert.match(empty, /No findings\./);
  });

  it('аватары: инициалы, цвет по позиции, подпись агента и модели', () => {
    const html = render(DEFEND);
    assert.match(html, /review-avatar participant-c0[^>]*>SE</);
    assert.match(html, /review-avatar participant-c4[^>]*>DE</);
    const plain = text(html);
    assert.match(plain, /security reviewer codex · m0/);
    assert.match(plain, /defender defender claude · opus/);
  });

  it('лента — обновляемый журнал для вспомогательных технологий, пока шаг идёт', () => {
    assert.match(render({ ...DEFEND, done: false }), /role="log" aria-live="polite"/);
    assert.match(render(DEFEND), /role="log" aria-live="off"/);
  });
});

describe('review-defend: боковая панель', () => {
  it('итог защиты: пять находок со статусами и итоговой серьёзностью', () => {
    const side = text(render(DEFEND).split('<aside')[1] ?? '');
    assert.match(side, /Findings security\.1 contested critical security\.2 accepted major security\.3 accepted major \(revised from critical\) tests\.1 withdrawn minor tests\.2 accepted major/);
    assert.equal(side.match(/ accepted /g)?.length, 3);
    assert.equal(side.match(/ withdrawn /g)?.length, 1);
    assert.equal(side.match(/ contested /g)?.length, 1);
  });

  it('раунды веток r/rounds и расход по участникам, включая defender, и по шагу', () => {
    const side = text(render(DEFEND).split('<aside')[1] ?? '');
    assert.match(side, /Rounds security 2\/2 · settled tests 1\/2 · settled/);
    assert.match(side, /defender 9k · 20s/);
    assert.match(side, /security 1\.2k · 5s/);
    assert.match(side, /step 3\.6k · 15s/);
  });

  it('на узкой ширине панель уходит под ленту', () => {
    const css = readFileSync(join(process.cwd(), 'ui', 'src', 'components', 'reviewFeed.css'), 'utf8');
    assert.match(css, /@media \(max-width: \d+px\) \{\s*\.review-feed \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });
});

describe('review-defend: ход участника и живое обновление', () => {
  it('выбор реплики защитника открывает ход его ветки со ссылкой на stdout.log', () => {
    const html = render(DEFEND, { participant: 'defender', thread: 'security', round: 1 });
    const plain = text(html);
    assert.match(plain, /Turn of defender · on security · round 1/);
    assert.match(plain, /raw stdout\.log · 7 B/, 'сырой поток именно этого хода ветки');
    assert.match(plain, /step output ▾/, 'тот же StepOutput агентского шага, раскрытый');
    assert.match(html, /aria-label="Turn of defender"/);
  });

  it('выбор сообщения ревьюера открывает его первый ход; аватар — кнопка хода', () => {
    const plain = text(render(DEFEND, { participant: 'security' }));
    assert.match(plain, /Turn of security/);
    assert.match(plain, /raw stdout\.log · 10 B/);
    assert.match(render(DEFEND), /aria-label="Open the turn of defender"/);
  });

  it('новая реплика по ходу появляется со следующим опросом, статусы закрытых ею находок меняются', () => {
    const findings = DEFEND.entries[1] as Extract<ReviewFeedEntry, { kind: 'findings' }>;
    const open: ReviewFeedEntry = { ...findings, findings: findings.findings.map((entry) => ({ ...entry, status: 'open' as const })) };
    const running = { ...DEFENDER, running: true, sessions: [{ thread: 'security', round: 1, running: true }] };
    const before: ReviewFeed = {
      ...DEFEND,
      done: false,
      participants: [participant('security', 0), running, participant('aggregator', 3, {}, true)],
      entries: [DEFEND.entries[0]!, open],
      findings: DEFEND.findings.slice(0, 3).map((entry) => ({ ...entry, status: 'open' as const })),
      threads: [{ reviewer: 'security', rounds: 0, settled: false }],
    };
    const was = text(render(before));
    assert.match(was, /defender is answering security in round 1…/);
    assert.doesNotMatch(was, /the input is escaped/);
    assert.match(was, /security\.2 open/);

    const settled = { ...findings, findings: findings.findings.map((entry) => ({ ...entry, status: entry.id === 'security.2' ? ('accepted' as const) : ('open' as const) })) };
    const after: ReviewFeed = {
      ...before,
      participants: [participant('security', 0), DEFENDER, participant('aggregator', 3, {}, true)],
      entries: [DEFEND.entries[0]!, settled, DEFEND.entries[2]!],
    };
    const now = text(log(render(after)));
    assert.match(now, /the input is escaped/);
    assert.match(now, /security\.2 accepted/);
  });

  it('параллельные ветки — по строке на идущий ход', () => {
    const labels = runningLabels([
      { ...DEFENDER, running: true, sessions: [{ thread: 'security', round: 2, running: true }, { thread: 'tests', round: 1, running: true }] },
      participant('tests', 1, { running: true, sessions: [{ running: false }, { round: 1, running: true }] }),
    ]);
    assert.deepEqual(labels, [
      'defender is answering security in round 2…',
      'defender is answering tests in round 1…',
      'tests is answering the defender in round 1…',
    ]);
  });
});

describe('review-defend: прежние режимы', () => {
  it('режим independent: находки и вердикт без панели находок и раундов', () => {
    const html = render({
      mode: 'independent',
      participants: [participant('security', 0), participant('tests', 1), participant('aggregator', 2)],
      entries: [
        { kind: 'findings', participant: 'security', summary: 's', findings: [{ severity: 'critical', title: 'security finding', location: 'a.ts:1' }] },
        { kind: 'findings', participant: 'tests', summary: 't', findings: [{ severity: 'minor', title: 'tests finding' }] },
        VERDICT,
      ],
      findings: [],
      threads: [],
      legacy: false,
      done: true,
    });
    const plain = text(html);
    assert.match(plain, /security finding/);
    assert.match(plain, /tests finding/);
    assert.match(plain, /fix the injection/);
    assert.doesNotMatch(plain, /Defender|Rounds|Findings|round \d/);
    assert.doesNotMatch(plain, / open | contested /);
  });

  it('журнал прежнего режима discussion — список участников и выход агрегатора', () => {
    const plain = text(
      render({ participants: [participant('security', 0), participant('aggregator', 1)], entries: [VERDICT], findings: [], threads: [], legacy: true, legacyMode: 'discussion', done: true }),
    );
    assert.match(plain, /retired discussion mode/);
    assert.match(plain, /security reviewer codex · m0 success/);
    assert.match(plain, /fix the injection/);
  });

  it('журнал без записи режима — тот же показ с общей пометкой', () => {
    const plain = text(render({ participants: [participant('security', 0)], entries: [VERDICT], findings: [], threads: [], legacy: true, done: true }));
    assert.match(plain, /no review record/);
  });

  it('переиспользованный шаг называет исходный прогон; без него — вердикт вместо «No messages yet»', () => {
    const available = text(render({ ...DEFEND, reusedFrom: { runId: 'run-0', available: true } }));
    assert.match(available, /Reused from run run-0/);
    assert.match(available, /security summary/);

    const gone = text(
      render({ ...DEFEND, participants: PARTICIPANTS.map((entry) => ({ ...entry, sessions: [] })), entries: [VERDICT], findings: [], threads: [], reusedFrom: { runId: 'run-0', available: false } }),
    );
    assert.match(gone, /no longer available/);
    assert.doesNotMatch(gone, /No messages yet/);
  });

  it('инициалы аватара', () => {
    assert.equal(initials('security'), 'SE');
    assert.equal(initials('api-tests'), 'AT');
  });
});

describe('review-defend: запросы ленты и хода участника', () => {
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
    const urls = stubFetch(DEFEND);
    const feed = await fetchReviewFeed({ address: 'proj/run-1', jobId: 'review', stepId: 'check', pass: 2 });
    assert.equal(feed.entries.length, DEFEND.entries.length);
    const url = new URL(urls[0] ?? '', 'http://x');
    assert.equal(url.pathname, '/api/review-feed');
    assert.deepEqual(Object.fromEntries(url.searchParams), { run: 'proj/run-1', job: 'review', step: 'check', pass: '2' });
  });

  it('ход защитника спрашивается выводом шага с участником, веткой и раундом', async () => {
    const urls = stubFetch({ attempts: [], done: true });
    await fetchStepOutput({ address: 'proj/run-1', jobId: 'review', stepId: 'check', participant: 'defender', thread: 'security', round: 2, stdoutOffset: 0 });
    const query = new URL(urls[0] ?? '', 'http://x').searchParams;
    assert.equal(query.get('participant'), 'defender');
    assert.equal(query.get('thread'), 'security');
    assert.equal(query.get('round'), '2');
  });
});

describe('лента ревью: вкладки по ревьюерам', () => {
  it('вкладки — All и по ревьюеру в порядке участников, без защитника и судьи', () => {
    assert.deepEqual(reviewerTabs(DEFEND), ['security', 'tests', 'style']);
    const tabs = /<div[^>]*role="tablist"[^>]*>([\s\S]*?)<\/div>/.exec(render(DEFEND))?.[1] ?? '';
    assert.deepEqual([...tabs.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]), ['All', 'security', 'tests', 'style']);
  });

  it('вкладка ревьюера: защитник, его находки и ветка; ни чужих веток, ни итога, ни вердикта', () => {
    const kinds = entriesForTab(DEFEND.entries, 'security').map((entry) => `${entry.kind}${'participant' in entry ? `:${entry.participant}` : ''}`);
    assert.deepEqual(kinds, ['defender', 'findings:security', 'reply:defender', 'reply:security']);
    assert.deepEqual(entriesForTab(DEFEND.entries, 'style').map((entry) => entry.kind), ['defender', 'failure']);
    assert.equal(entriesForTab(DEFEND.entries, ALL_TAB), DEFEND.entries);
  });

  it('выбранная вкладка рисует только ветку ревьюера, а сводка — только его находки и раунды', () => {
    const html = render(DEFEND, undefined, 'tests');
    const feed = text(log(html));
    assert.match(feed, /tests summary/);
    assert.doesNotMatch(feed, /security summary/);
    assert.doesNotMatch(feed, /Defense finished/);
    assert.doesNotMatch(feed, /fix the injection/);
    const side = text(html.split('<aside')[1] ?? '');
    assert.match(side, /tests\.1/);
    assert.doesNotMatch(side, /security\.1/);
  });

  it('с одним ревьюером вкладок нет', () => {
    const feed: ReviewFeed = { ...DEFEND, participants: [participant('security', 0), DEFENDER, participant('aggregator', 3)] };
    assert.doesNotMatch(render(feed), /role="tablist"/);
  });

  it('во вкладке ревьюера «пишет» — только он и защитник в его ветке', () => {
    const running = [
      participant('security', 0, { running: true, sessions: [{ running: true }] }),
      participant('tests', 1, { running: true, sessions: [{ running: true }] }),
      participant('defender', 4, { running: true, sessions: [{ thread: 'tests', round: 1, running: true }] }, true),
    ];
    assert.deepEqual(runningLabels(running, 'tests'), ['tests is reviewing…', 'defender is answering tests in round 1…']);
    assert.deepEqual(runningLabels(running, 'security'), ['security is reviewing…']);
  });
});

describe('лента ревью: итог называется судьёй', () => {
  it('роль aggregator и умолчательный id показываются как judge', () => {
    assert.equal(roleLabel('aggregator'), 'judge');
    assert.equal(roleLabel('reviewer'), 'reviewer');
    assert.equal(displayId('aggregator'), 'judge');
    assert.equal(displayId('verdict-bot'), 'verdict-bot');
    const html = text(render(DEFEND));
    assert.match(html, /judge judge/);
    assert.doesNotMatch(html, /aggregator/);
  });
});
