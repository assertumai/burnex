import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Context } from 'cordis';

import { RunPublication } from '../src/components/RunPublication';
import { parseHiddenColumns, RUN_COLUMNS, RunColumns } from '../src/components/RunColumns';
import { Runs } from '../src/pages/Runs';
import { bindRouterKernel } from '../src/router';

bindRouterKernel({ routes: { get: () => ({ table: [] }) } } as unknown as Context);

describe('run publications and column preferences', () => {
  it('renders Markdown, plain URLs and dashboard links with escaped text', () => {
    const html = renderToStaticMarkup(<RunPublication text={'Checking <script>\n[Report](https://example.org/a?q=1&b=2) https://example.org/log. [Run](/runs/abc)'} />);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /href="https:\/\/example.org\/a\?q=1&amp;b=2"/);
    assert.match(html, /href="https:\/\/example.org\/log"/);
    assert.match(html, /href="\/runs\/abc"/);
    assert.match(html, /rel="noopener noreferrer"/);
  });

  it('does not turn executable, protocol-relative or file URLs into links', () => {
    const html = renderToStaticMarkup(<RunPublication text={'[bad](javascript:alert(1)) [bad](data:text/html,test) [bad](//evil.test) [bad](file:///etc/passwd) [bad](/\\evil.test)'} />);
    assert.doesNotMatch(html, /<a /);
    assert.match(renderToStaticMarkup(<RunPublication text={undefined} />), /—/);
  });

  it('preserves parentheses in URLs and separates adjacent Markdown links', () => {
    const html = renderToStaticMarkup(<RunPublication text={'[A](https://example.org/a)[B](https://example.org/b) https://example.org/Foo_(bar).'} />);
    assert.equal((html.match(/<a /g) ?? []).length, 3);
    assert.match(html, /href="https:\/\/example.org\/Foo_\(bar\)"/);
  });

  it('restores known hidden columns, survives corrupt preferences, and keeps at least one visible', () => {
    assert.deepEqual(parseHiddenColumns('["cost","unknown","cost","tokens"]'), ['cost', 'tokens']);
    for (const value of [null, '{', '{}', 'false']) assert.deepEqual(parseHiddenColumns(value), []);
    const hidden = parseHiddenColumns(JSON.stringify(RUN_COLUMNS.map(([key]) => key)));
    assert.equal(hidden.includes('name'), false);
    const html = renderToStaticMarkup(<RunColumns hidden={hidden} setHidden={() => {}} />);
    assert.match(html, /disabled=""/);
    assert.match(html, /Show all/);
  });

  it('restores column preferences on the actual run table and shows publications', () => {
    const globals = globalThis as Record<string, unknown>;
    const previous = globals['window'];
    globals['window'] = { localStorage: { getItem: () => '["cost","result"]' } };
    try {
      const html = renderToStaticMarkup(<Runs navigate={() => {}} overview={{
        generatedAt: '2026-11-11T00:00:00Z',
        projects: [{ key: 'project', path: '/demo', runs: [{
          runId: 'run-1', shortId: '1', pipeline: 'demo', status: 'success',
          running: false, abandoned: false, swept: false, filesGone: false, unreadable: false,
          description: 'Checking changes', result: '[Report](https://example.org/report)',
        }] }],
      }} />);
      assert.match(html, /<th[^>]*>Description<\/th>/);
      assert.match(html, /<th[^>]*hidden=""[^>]*>Result<\/th>/);
      assert.match(html, /<td[^>]*hidden=""[^>]*><div class="run-publication"><a[^>]*>Report<\/a>/);
      assert.match(html, /Checking changes/);
      assert.doesNotMatch(html, /sort-button[^>]*>Cost/);
    } finally { globals['window'] = previous; }
  });
});
