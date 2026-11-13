import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { tempDir } from './tmp.js';
import { parseArgs } from '../src/kernel/cli/args.js';
import { BurnexError } from '../src/kernel/errors.js';
import { row, runRenderCommand } from '../src/parts/pipeline/commands/render.js';
import {
  mermaidBundlePath,
  parseDesignDocument,
  renderDesign,
  renderDesignHtml,
  renderDesignOpenSpec,
  type DesignDocument,
} from '../src/parts/pipeline/render/designDoc.js';

function doc(overrides: Partial<DesignDocument> = {}): DesignDocument {
  return {
    title: 'Лимит входа',
    summary: 'Счётчики в PostgreSQL.',
    decisions: [
      { id: 'd1', question: 'Где хранить?', choice: 'PostgreSQL', rationale: 'Единственное общее хранилище.', rejected: [{ by: 'skeptic', summary: 'Redis', reason: 'Нет в окружении' }] },
      { id: 'd2', question: 'Окно?', choice: 'Фиксированное', rationale: 'Проще.', rejected: [] },
    ],
    diagrams: [{ id: 'g1', title: 'Поток', kind: 'mermaid', source: 'flowchart LR\n  A --> B', decisions: ['d1'] }],
    risks: [{ risk: 'Всплеск на стыке окон', mitigation: 'Документировать' }],
    open_questions: [],
    ...overrides,
  };
}

const BUNDLE = 'window.mermaid = {}; // </script> внутри бандла';

describe('design-render: разбор входа', () => {
  it('принимает документ без полей движка и с ними', () => {
    assert.equal(parseDesignDocument(doc()).agreed, undefined);
    const full = parseDesignDocument({ ...doc(), agreed: false, unresolved: ['d2'], changed_by_aggregator: ['d1'] });
    assert.deepEqual(full.unresolved, ['d2']);
  });

  it('отказывает с путём ключа', () => {
    const { decisions: _decisions, ...rest } = doc();
    assert.throws(() => parseDesignDocument(rest, 'out.json'), (error: unknown) => error instanceof BurnexError && error.at === 'decisions' && error.file === 'out.json');
    assert.throws(
      () => parseDesignDocument({ ...doc(), decisions: [{ id: 'd1' }] }),
      (error: unknown) => error instanceof BurnexError && error.at === 'decisions.0.question',
    );
    assert.throws(() => parseDesignDocument({ ...doc(), agreed: 'yes' }), (error: unknown) => error instanceof BurnexError && error.at === 'agreed');
    assert.throws(() => parseDesignDocument({ ...doc(), unresolved: [1] }), (error: unknown) => error instanceof BurnexError && error.at === 'unresolved');
    assert.throws(() => parseDesignDocument([]), (error: unknown) => error instanceof BurnexError);
  });
});

describe('design-render: HTML', () => {
  it('детерминирован, без сетевых ссылок, бандл встроен с экранированным </script>', () => {
    const first = renderDesignHtml(doc(), BUNDLE);
    assert.equal(first, renderDesignHtml(doc(), BUNDLE));
    assert.doesNotMatch(first, /(src|href)="https?:/);
    assert.match(first, /<pre class="mermaid">flowchart LR\n {2}A --&gt; B<\/pre>/);
    assert.ok(first.includes('<\\/script> внутри бандла'));
    assert.match(first, /<section class="decision" id="d1">/);
    assert.match(first, /<a href="#d1">d1<\/a>/);
    assert.match(first, /securityLevel: 'strict'/);
  });

  it('экранирует текст документа', () => {
    const html = renderDesignHtml(doc({ summary: '<script>alert(1)</script>', diagrams: [] }), undefined);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.doesNotMatch(html, /<script/);
  });

  it('без диаграмм скрипта нет, а с диаграммами без бандла — отказ', () => {
    assert.doesNotMatch(renderDesignHtml(doc({ diagrams: [] }), undefined), /<script/);
    assert.throws(() => renderDesignHtml(doc(), undefined), BurnexError);
  });

  it('пометки итога и решений', () => {
    const html = renderDesignHtml(doc({ agreed: false, unresolved: ['d2'], changed_by_aggregator: ['d1'], diagrams: [] }), undefined);
    assert.match(html, /Итог не согласован\. Несогласованные точки: d2\./);
    assert.match(html, /Изменено агрегатором: d1\./);
    assert.match(html, /id="d1">.*изменено агрегатором/s);
    assert.match(html, /id="d2">.*не согласовано/s);
  });

  it('рендер берёт бандл, поставленный сборкой', () => {
    assert.ok(existsSync(mermaidBundlePath()), `нет ${mermaidBundlePath()}`);
    assert.match(renderDesign(doc(), 'html'), /mermaid\.initialize/);
  });
});

describe('design-render: OpenSpec design.md', () => {
  it('разделы по шаблону, пустые опущены', () => {
    const md = renderDesignOpenSpec(doc());
    assert.equal(md, renderDesignOpenSpec(doc()));
    for (const heading of ['# Лимит входа', '## Context', '## Decisions', '### d1. Где хранить?', '## Diagrams', '## Risks / Trade-offs']) {
      assert.ok(md.includes(`${heading}\n`), heading);
    }
    assert.ok(!md.includes('## Open Questions'));
    assert.ok(md.includes('- Redis (skeptic) — Нет в окружении'));
    assert.ok(md.includes('```mermaid\nflowchart LR\n  A --> B\n```'));
    assert.ok(md.includes('- **[Всплеск на стыке окон]** → Документировать'));
    assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'));
  });

  it('ограда длиннее бэктиков исходника; пометка несогласованного итога', () => {
    const md = renderDesignOpenSpec(
      doc({ agreed: false, unresolved: [], diagrams: [{ id: 'g1', title: 'T', kind: 'mermaid', source: 'note\n```\nx', decisions: [] }] }),
    );
    assert.ok(md.includes('````mermaid\nnote\n```\nx\n````'));
    assert.ok(md.includes('> **Итог не согласован.**'));
  });
});

describe('design-render: команда burnex render', () => {
  const parse = (argv: readonly string[]) => parseArgs(['render', ...argv], { render: row.command.spec });

  it('stdout без --out и файл с --out', () => {
    const dir = tempDir('render-');
    writeFileSync(join(dir, 'out.json'), JSON.stringify(doc()));
    const lines: string[] = [];
    runRenderCommand(parse(['design', 'out.json', '--format', 'openspec']), (line) => lines.push(line), dir);
    assert.equal(lines.join('\n'), renderDesignOpenSpec(doc()).replace(/\n$/, ''));

    const written: string[] = [];
    runRenderCommand(parse(['design', 'out.json', '--format', 'html', '--out', 'site/design.html']), (line) => written.push(line), dir);
    assert.deepEqual(written, [join(dir, 'site/design.html')]);
    assert.match(readFileSync(join(dir, 'site/design.html'), 'utf8'), /^<!doctype html>/);
  });

  it('отказы: вид, формат, файл', () => {
    const dir = tempDir('render-');
    const run = (argv: readonly string[]) => () => runRenderCommand(parse(argv), () => undefined, dir);
    assert.throws(run(['diagram', 'x.json', '--format', 'html']), /неизвестный вид рендера/);
    assert.throws(run(['design', 'x.json']), (error: unknown) => error instanceof BurnexError && /html, openspec/.test(error.hint ?? ''));
    assert.throws(run(['design', 'x.json', '--format', 'pdf']), /неизвестный формат «pdf»/);
    assert.throws(run(['design', 'x.json', '--format', 'html']), /не найден/);
    writeFileSync(join(dir, 'bad.json'), '{');
    assert.throws(run(['design', 'bad.json', '--format', 'html']), /не разбирается как JSON/);
  });
});
