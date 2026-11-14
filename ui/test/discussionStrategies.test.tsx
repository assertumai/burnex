import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Context } from 'cordis';
import { renderToStaticMarkup } from 'react-dom/server';

import type { BackendView, ReviewStrategiesOverview, Settings, StrategyView } from '../src/api';
import {
  DiscussionStrategiesView,
  DiscussionStrategyEditor,
  discussionCourse,
  discussionDocumentOf,
  discussionDraftOf,
  emptyDiscussionDraft,
  type DiscussionDraft,
  type DiscussionStrategiesViewProps,
} from '../src/pages/DiscussionStrategies';
import { sameValue } from '../src/pages/StrategyScreen';
import { bindRouterKernel } from '../src/router';

/**
 * Экран «Discussion strategies» (`ui-discussion-strategies`): черновик ↔
 * документ, редактор, список и использование шагами `discuss:` —
 * статическим рендером, как прочие тесты витрины.
 */

bindRouterKernel({ routes: { get: () => ({ table: [] }) } } as unknown as Context);

const backend = (name: string): BackendView => ({
  name, command: name, enabled: true, available: true, defaultModelSource: 'built-in default',
  modelTiers: {}, modelTierSources: {}, modelTierEffortSources: {},
});

const settings: Settings = {
  agent: { value: 'claude', source: 'built-in default' },
  model: { source: 'built-in default' },
  effort: { source: 'built-in default' },
  profiles: [],
  modelTiers: ['max', 'balance'],
  backends: [backend('claude'), backend('codex')],
  file: '/home/u/.burnex/config.yml',
};

const DOCUMENT = {
  version: 1,
  kind: 'discussion-strategy',
  name: 'panel',
  participants: [
    { id: 'pragmatist', agent: 'codex', model: 'gpt-5.6-terra', focus: 'Простота' },
    { id: 'skeptic', agent: 'claude', model_tier: 'balance', focus: 'file:./skeptic.md' },
  ],
  author: { agent: 'claude', prompt: 'Своди честно' },
  aggregator: { agent: 'claude', model_tier: 'max' },
};

const PANEL: StrategyView = {
  name: 'panel',
  layer: 'project',
  path: '/p/.burnex/discussion-strategies/panel.yml',
  text: 'version: 1\n',
  document: DOCUMENT,
  usage: [{ pipeline: 'design', file: '.burnex/pipelines/design.yml', job: 'plan', step: 'talk' }],
};

const overview = (strategies: readonly StrategyView[]): ReviewStrategiesOverview => ({
  projectDir: '/p/.burnex/discussion-strategies',
  homeDir: '/home/u/.burnex/discussion-strategies',
  strategies,
  generatedAt: '2026-11-14T00:00:00.000Z',
});

function view(props: Partial<DiscussionStrategiesViewProps>): string {
  const strategies = props.overview?.strategies ?? [PANEL];
  const selected = props.selected ?? strategies[0];
  const draft = props.draft ?? (selected?.document === undefined ? undefined : discussionDraftOf(selected.document));
  return renderToStaticMarkup(
    <DiscussionStrategiesView
      overview={overview(strategies)}
      settings={settings}
      selected={selected}
      creating={undefined}
      draft={draft}
      problem={undefined}
      dirty={false}
      busy={false}
      navigate={() => undefined}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onCreateLayer={() => undefined}
      onDraft={() => undefined}
      onSave={() => undefined}
      onDelete={() => undefined}
      {...props}
    />,
  );
}

function editor(draft: DiscussionDraft, problem?: { message: string; at?: string }): string {
  return renderToStaticMarkup(
    <DiscussionStrategyEditor draft={draft} settings={settings} strategy={PANEL} problem={problem} readOnly={false}
      navigate={() => undefined} onChange={() => undefined} />,
  );
}

describe('ui-discussion-strategies: черновик и документ', () => {
  it('нетронутый черновик даёт тот же документ: rounds по умолчанию не дописывается', () => {
    const draft = discussionDraftOf(DOCUMENT);
    assert.equal(draft.rounds, 1);
    assert.equal(draft.participants[1]!.modelKind, 'tier');
    assert.ok(sameValue(discussionDocumentOf(draft, DOCUMENT), DOCUMENT));
  });

  it('правка раундов, автора и участника попадает в документ; пустая роль снимается', () => {
    const draft = discussionDraftOf(DOCUMENT);
    const edited: DiscussionDraft = {
      ...draft,
      rounds: 3,
      author: { ...draft.author, agent: '', prompt: '' },
      participants: [...draft.participants, { ...draft.participants[0]!, id: 'architect', model: '', focus: '' }],
    };
    const document = discussionDocumentOf(edited, DOCUMENT);
    assert.equal(document.rounds, 3);
    assert.equal(document.author, undefined);
    assert.deepEqual((document.participants as unknown[])[2], { id: 'architect', agent: 'codex' });
    assert.equal(document.kind, 'discussion-strategy');
  });

  it('новая стратегия — два участника и документ вида discussion-strategy', () => {
    const document = discussionDocumentOf({ ...emptyDiscussionDraft(), name: 'fresh' });
    assert.deepEqual(document, {
      version: 1,
      kind: 'discussion-strategy',
      name: 'fresh',
      participants: [{ id: 'pragmatist' }, { id: 'skeptic' }],
    });
  });

  it('схема хода называет фазы и раунды', () => {
    assert.match(discussionCourse(1).join(' | '), /≤ 1 round \|/);
    assert.match(discussionCourse(3)[3]!, /≤ 3 rounds/);
  });
});

describe('ui-discussion-strategies: редактор и экран', () => {
  it('редактор: автор, агрегатор, участники, file:-фокус путём, схема хода и использование', () => {
    const html = editor(discussionDraftOf(DOCUMENT));
    assert.match(html, /How the discussion runs/);
    assert.match(html, />author</);
    assert.match(html, />aggregator</);
    assert.match(html, /Своди честно/);
    assert.match(html, /\.\/skeptic\.md <span class="dim">\(file, relative to the strategy/);
    assert.match(html, /design \/ plan \/ talk/);
  });

  it('отказ демона показывается у поля участника', () => {
    const html = editor(discussionDraftOf(DOCUMENT), { message: 'id author занят ролью author', at: 'participants.1.id' });
    assert.match(html, /id author занят ролью author/);
  });

  it('список: число участников и раундов; пустое состояние называет каталог', () => {
    const html = view({ overview: overview([{ ...PANEL, document: { ...DOCUMENT, rounds: 2 } }]) } as Partial<DiscussionStrategiesViewProps>);
    assert.match(html, /2 participant\(s\) · 2 rounds/);
    assert.match(html, /Discussion strategies/);
    const empty = view({ overview: overview([]), selected: undefined } as Partial<DiscussionStrategiesViewProps>);
    assert.match(empty, /No discussion strategies yet/);
    assert.match(empty, /\.burnex\/discussion-strategies\//);
  });
});
