import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Context } from 'cordis';
import { renderToStaticMarkup } from 'react-dom/server';

import { DiscussFeedView, callLabel, defaultTab, runningLabels } from '../src/components/DiscussFeed';
import { DesignDocView } from '../src/components/DesignDoc';
import { MermaidDiagram } from '../src/components/Mermaid';
import { designRenderUrl, type DesignDocument, type DiscussFeed, type DiscussFeedParticipant } from '../src/api';
import { bindRouterKernel } from '../src/router';

/**
 * Шаг `discuss` в деталях прогона (`render-design`, задача 4.5): документ,
 * лента обсуждения, фазы и диаграммы — статическим рендером готовой модели.
 */

bindRouterKernel({ routes: { get: () => ({ table: [] }) } } as unknown as Context);

function participant(id: string, role: DiscussFeedParticipant['role'], color: number, overrides: Partial<DiscussFeedParticipant> = {}): DiscussFeedParticipant {
  return {
    id,
    role,
    agent: 'claude',
    model: 'sonnet',
    color,
    running: false,
    calls: [{ phase: role === 'aggregator' ? 'aggregate' : 'proposals', running: false, status: 'success' }],
    usage: { billableTokens: 1000, costUsd: 0.1, wallclockMs: 3000 },
    ...overrides,
  };
}

const DOCUMENT: DesignDocument = {
  title: 'Лимит входа',
  summary: 'Счётчики в PostgreSQL',
  decisions: [
    { id: 'd1', question: 'Где?', choice: 'PostgreSQL', rationale: 'Есть', rejected: [{ by: 'skeptic', summary: 'Redis', reason: 'Нет' }] },
    { id: 'd2', question: 'Окно?', choice: 'Фиксированное', rationale: 'Проще', rejected: [] },
  ],
  diagrams: [{ id: 'g1', title: 'Поток', kind: 'mermaid', source: 'flowchart LR\n  A --> B', decisions: ['d1'] }],
  risks: [{ risk: 'Всплеск', mitigation: 'Документировать' }],
  open_questions: ['Сколько прокси?'],
  agreed: false,
  unresolved: ['d2'],
  changed_by_aggregator: ['d1'],
};

function feed(overrides: Partial<DiscussFeed> = {}): DiscussFeed {
  return {
    rounds: 1,
    phases: [
      { name: 'proposals', state: 'done' },
      { name: 'draft', state: 'done' },
      { name: 'objections', state: 'done' },
      { name: 'defense', state: 'done' },
      { name: 'aggregate', state: 'done' },
    ],
    participants: [
      participant('pragmatist', 'participant', 0),
      participant('skeptic', 'participant', 1),
      participant('author', 'author', 2, { calls: [{ phase: 'draft', running: false }, { phase: 'defense', round: 1, running: false }] }),
      participant('aggregator', 'aggregator', 3),
    ],
    proposals: [
      { participant: 'pragmatist', status: 'success', summary: 'Взять PG', approach: 'Таблица' },
      { participant: 'skeptic', status: 'failed', reason: 'таймаут' },
    ],
    draft: {
      summary: 'Черновик автора',
      decisions: [{ id: 'd1', question: 'Где?', choice: 'PG', rationale: 'Есть', options: [{ by: 'pragmatist', summary: 'PG' }] }],
      diagrams: [{ id: 'g1', title: 'Поток', source: 'flowchart LR\n  A --> B', decisions: ['d1'] }],
      risks: [],
    },
    objections: [
      { id: 'pragmatist.1', by: 'pragmatist', target: 'd1', weight: 'blocking', title: 'Гонка', breaks: 'Счётчик', alternative: 'UPSERT', status: 'accepted', round: 1 },
      { id: 'pragmatist.2', by: 'pragmatist', target: 'g1', weight: 'preference', title: 'Подпись', status: 'note' },
    ],
    messages: [
      {
        id: 'm1',
        from: 'author',
        round: 1,
        text: 'Принимаю',
        responses: [{ objection: 'pragmatist.1', stance: 'accept', text: 'Верно', change: { choice: 'UPSERT', rationale: 'Атомарно' } }],
      },
    ],
    outcome: { accepted: 1, withdrawn: 0, contested: 0, preference: 1 },
    document: DOCUMENT,
    done: true,
    ...overrides,
  };
}

function render(model: DiscussFeed, tab?: 'document' | 'discussion'): string {
  return renderToStaticMarkup(
    <DiscussFeedView feed={model} address="p/r" jobId="design" stepId="discuss" {...(tab === undefined ? {} : { initialTab: tab })} />,
  );
}

describe('шаг discuss: документ', () => {
  it('документ — вкладка по умолчанию: пометки итога, решения, диаграмма исходником до загрузки Mermaid, скачивание', () => {
    const html = render(feed());
    assert.match(html, /Лимит входа/);
    assert.match(html, /not agreed/);
    assert.match(html, /did not agree on d2\./);
    assert.match(html, /changed by aggregator/);
    assert.match(html, /unresolved/);
    assert.match(html, /Rejected \(1\)/);
    assert.match(html, /<pre class="mermaid-source">flowchart LR\n {2}A --&gt; B<\/pre>/);
    assert.ok(html.includes(designRenderUrl({ address: 'p/r', jobId: 'design', stepId: 'discuss', format: 'html' }).replace(/&/g, '&amp;')));
    assert.match(html, /design\.md/);
    assert.match(html, /Сколько прокси\?/);
  });

  it('вывод не формы design-doc — причина и сырой вывод; документа нет — пустое состояние', () => {
    const { document: _document, ...rest } = feed();
    const raw = render({ ...rest, output: { verdict: 'ok' }, documentError: 'нет decisions' });
    assert.match(raw, /not a burnex:design-doc document: нет decisions/);
    assert.match(raw, /&quot;verdict&quot;: &quot;ok&quot;/);
    assert.match(render({ ...rest, done: false }, 'document'), /No document yet/);
  });

  it('DesignDocView без полей движка не рисует пометок согласия', () => {
    const { agreed: _a, unresolved: _u, changed_by_aggregator: _c, ...plain } = DOCUMENT;
    const html = renderToStaticMarkup(<DesignDocView document={plain} />);
    assert.doesNotMatch(html, /agreed/);
    assert.doesNotMatch(html, /design\.md/);
  });
});

describe('шаг discuss: лента обсуждения', () => {
  it('предложения, черновик автора справа, возражения с весом и исходом, реплика с правкой, исход', () => {
    const html = render(feed(), 'discussion');
    assert.match(html, /Взять PG/);
    assert.match(html, /таймаут/);
    assert.match(html, /review-message own[^"]*"><span class="review-avatar discuss-avatar"[^>]*>AU/);
    assert.match(html, /Черновик автора/);
    assert.match(html, /pragmatist\.1.*blocking.*accepted/s);
    assert.match(html, /pragmatist\.2.*preference.*note/s);
    assert.match(html, /accepts/);
    assert.match(html, /UPSERT<\/b> — Атомарно/);
    assert.match(html, /1 accepted · 0 withdrawn · 0 contested · 1 notes/);
  });

  it('идущий шаг: фазы, «пишет» по идущему вызову, вкладка обсуждения без документа', () => {
    const live = feed({
      done: false,
      phases: [
        { name: 'proposals', state: 'done' },
        { name: 'draft', state: 'running' },
        { name: 'objections', state: 'pending' },
        { name: 'defense', state: 'pending' },
        { name: 'aggregate', state: 'pending' },
      ],
      participants: [participant('author', 'author', 2, { running: true, calls: [{ phase: 'draft', running: true }] })],
      objections: [],
      messages: [],
    });
    const { document: _document, draft: _draft, outcome: _outcome, ...rest } = live;
    assert.equal(defaultTab(rest), 'discussion');
    const html = render(rest);
    assert.match(html, /author is writing \(draft\)…/);
    assert.match(html, /defense ≤1/);
    assert.deepEqual(runningLabels(rest.participants), ['author is writing (draft)…']);
  });

  it('подписи вызовов', () => {
    assert.equal(callLabel({ phase: 'defense', round: 2 }), 'round 2');
    assert.equal(callLabel({ phase: 'draft', retry: true }), 'draft (retry)');
    assert.equal(callLabel({ phase: 'aggregate' }), 'document');
  });
});

describe('диаграмма Mermaid', () => {
  it('до загрузки бандла показывает исходник', () => {
    const html = renderToStaticMarkup(<MermaidDiagram source="graph TD; A-->B" />);
    assert.match(html, /<pre class="mermaid-source">graph TD; A--&gt;B<\/pre>/);
  });
});
