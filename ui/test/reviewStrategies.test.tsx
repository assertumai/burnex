import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Context } from 'cordis';
import { renderToStaticMarkup } from 'react-dom/server';

import type { BackendView, ReviewStrategiesOverview, Settings, StrategyView } from '../src/api';
import {
  agentGroups,
  courseSteps,
  errorAt,
  ReviewStrategiesView,
  selectStrategy,
  StrategyEditor,
  strategyChanged,
  strategyDocumentOf,
  strategyDraftOf,
  strategyRemovalConfirmation,
  type ReviewStrategiesViewProps,
  type StrategyDraft,
} from '../src/pages/ReviewStrategies';
import { bindRouterKernel } from '../src/router';

/**
 * Экран «Review strategies» (`ui-review-strategies`). Как и прочие тесты
 * витрины, без щелчков: решения формы — чистые функции, показ — статический
 * рендер. Разбор и отказ приходят от демона; страница показывает его текст у
 * поля по пути ключа.
 */

// Ссылки использования (`TargetLink`) читают таблицу маршрутов ядра; без
// совпавшего маршрута ссылка рисует текст с причиной — для рендера этого хватает.
bindRouterKernel({ routes: { get: () => ({ table: [] }) } } as unknown as Context);

const backend = (name: string): BackendView => ({
  name, command: name, enabled: true, available: true, defaultModelSource: 'built-in default',
  modelTiers: {}, modelTierSources: {}, modelTierEffortSources: {},
});

const settings: Settings = {
  agent: { value: 'claude', source: 'built-in default' },
  model: { source: 'built-in default' },
  effort: { source: 'built-in default' },
  profiles: [{ name: 'reviewer-strict', profile: { backend: 'codex', model_tier: 'max' }, file: '/home/u/.burnex/config.yml' }],
  modelTiers: ['max', 'balance'],
  backends: [backend('claude'), backend('codex')],
  file: '/home/u/.burnex/config.yml',
};

const PANEL_DOCUMENT = {
  version: 1,
  kind: 'review-strategy',
  name: 'panel',
  profiles: { arch: { backend: 'claude', model_tier: 'max', context: [{ path: './rules.md' }] } },
  reviewers: [
    { id: 'security', agent: 'reviewer-strict', focus: 'Границы доверия' },
    { id: 'architecture', agent: 'arch', focus: 'file:./architecture-focus.md' },
  ],
  aggregator: { agent: 'claude', model_tier: 'max' },
  mode: 'independent',
};

const PANEL: StrategyView = {
  name: 'panel',
  layer: 'project',
  path: '/p/.burnex/review-strategies/panel.yml',
  text: 'version: 1\n',
  document: PANEL_DOCUMENT,
  usage: [{ pipeline: 'self-improve', file: '.burnex/pipelines/loop.yml', job: 'review', step: 'review-diff' }],
};

const DUO_HOME: StrategyView = {
  name: 'duo', layer: 'home', path: '/home/u/.burnex/review-strategies/duo.yml', text: '', usage: [],
  document: { version: 1, kind: 'review-strategy', name: 'duo', reviewers: [{ id: 'a' }], mode: 'independent' },
};

const PANEL_HOME: StrategyView = { ...PANEL, layer: 'home', path: '/home/u/.burnex/review-strategies/panel.yml', shadowed: true, usage: [] };

const BROKEN: StrategyView = {
  name: 'broken', layer: 'project', path: '/p/.burnex/review-strategies/broken.yml', text: 'reviewers: [}\n', usage: [],
  error: { message: 'документ не разбирается как YAML' },
};

const overview = (strategies: readonly StrategyView[]): ReviewStrategiesOverview => ({
  projectDir: '/p/.burnex/review-strategies',
  homeDir: '/home/u/.burnex/review-strategies',
  strategies,
  generatedAt: '2026-11-12T00:00:00.000Z',
});

function view(props: Partial<ReviewStrategiesViewProps>): string {
  const strategies = props.overview?.strategies ?? [PANEL];
  const selected = props.selected ?? strategies[0];
  const draft = props.draft ?? (selected?.document === undefined ? undefined : strategyDraftOf(selected.document));
  return renderToStaticMarkup(
    <ReviewStrategiesView
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

function editor(draft: StrategyDraft, problem?: { message: string; at?: string }): string {
  return renderToStaticMarkup(
    <StrategyEditor draft={draft} settings={settings} strategy={PANEL} problem={problem} readOnly={false}
      navigate={() => undefined} onChange={() => undefined} />,
  );
}

describe('ui-review-strategies: черновик и документ', () => {
  it('нетронутая стратегия даёт тот же документ: запись не тронет файл', () => {
    assert.deepEqual(strategyDocumentOf(strategyDraftOf(PANEL_DOCUMENT), PANEL_DOCUMENT), PANEL_DOCUMENT);
  });

  it('нетронутая стратегия не изменена при любом порядке ключей в файле; правка — изменена', () => {
    const shuffled = {
      ...PANEL_DOCUMENT,
      reviewers: PANEL_DOCUMENT.reviewers.map(({ id, agent, focus }) => ({ id, focus, agent })),
      aggregator: { model_tier: 'max', agent: 'claude' },
    };
    assert.equal(strategyChanged(strategyDraftOf(shuffled), shuffled), false);
    const draft = strategyDraftOf(shuffled);
    assert.equal(strategyChanged({ ...draft, description: 'новое' }, shuffled), true);
    assert.equal(strategyChanged(draft, undefined), true);
  });

  it('режим обсуждения пишет mode и discussion.max_messages, независимый снимает блок', () => {
    const draft = strategyDraftOf(PANEL_DOCUMENT);
    const discussion = strategyDocumentOf({ ...draft, mode: 'discussion', maxMessages: 6 }, PANEL_DOCUMENT);
    assert.equal(discussion.mode, 'discussion');
    assert.deepEqual(discussion.discussion, { max_messages: 6 });

    const back = strategyDocumentOf(strategyDraftOf(discussion), discussion);
    assert.deepEqual(back, discussion);
    const independent = strategyDocumentOf({ ...strategyDraftOf(discussion), mode: 'independent' }, discussion);
    assert.equal(independent.mode, 'independent');
    assert.equal('discussion' in independent, false);
  });

  it('правка focus меняет только этого ревьюера; file: остаётся ссылкой', () => {
    const draft = strategyDraftOf(PANEL_DOCUMENT);
    const edited = { ...draft, reviewers: [{ ...draft.reviewers[0]!, focus: 'Секреты в логах' }, draft.reviewers[1]!] };
    const document = strategyDocumentOf(edited, PANEL_DOCUMENT);
    assert.deepEqual(document.reviewers, [
      { id: 'security', agent: 'reviewer-strict', focus: 'Секреты в логах' },
      PANEL_DOCUMENT.reviewers[1],
    ]);
    assert.deepEqual(document.profiles, PANEL_DOCUMENT.profiles);
  });

  it('выбор агента делится на профили стратегии, профили настроек и бэкенды', () => {
    assert.deepEqual(agentGroups(strategyDraftOf(PANEL_DOCUMENT), settings), {
      strategy: ['arch'],
      settings: ['default', 'reviewer-strict'],
      backends: ['claude', 'codex'],
    });
    const html = editor(strategyDraftOf(PANEL_DOCUMENT));
    assert.match(html, /<optgroup label="Strategy profiles"><option value="arch">arch<\/option><\/optgroup>/);
    assert.match(html, /<optgroup label="Settings profiles"><option value="default">default<\/option><option value="reviewer-strict">/);
    assert.match(html, /<optgroup label="Backends"><option value="claude">claude<\/option><option value="codex">codex<\/option>/);
  });
});

describe('ui-review-strategies: режим и схема хода', () => {
  it('смена режима на обсуждение показывает лимит и меняет схему хода', () => {
    const draft = strategyDraftOf(PANEL_DOCUMENT);
    const independent = editor(draft);
    assert.doesNotMatch(independent, /max messages/);
    assert.match(independent, /The aggregator consolidates the findings/);

    const discussion = editor({ ...draft, mode: 'discussion', maxMessages: 7 });
    assert.match(discussion, /id="strategy-max-messages"[^>]*min="1"[^>]*max="50"[^>]*value="7"/);
    assert.match(discussion, /Discussion: ≤ 7 message\(s\) per reviewer/);
    assert.match(discussion, /Consensus\?/);
    assert.match(discussion, /no — the aggregator decides/);
  });

  it('схема хода зависит только от режима и лимита', () => {
    assert.deepEqual(courseSteps('independent', 5), ['Reviewers work in parallel', 'The aggregator consolidates the findings', 'Verdict']);
    assert.equal(courseSteps('discussion', 3).length, 4);
  });

  it('агрегатор — отдельная карточка с подписью роли; focus из file: показан путём', () => {
    const html = editor(strategyDraftOf(PANEL_DOCUMENT));
    assert.match(html, /aggregator.*Consolidates the findings and gives the verdict; accepts the consensus when there is one/s);
    assert.match(html, /\.\/architecture-focus\.md <span class="dim">\(file, relative to the strategy — edit it there\)/);
    assert.match(html, />Add reviewer</);
  });
});

describe('ui-review-strategies: ошибки разбора у полей', () => {
  it('повторный id показывается текстом разбора у поля id второго ревьюера', () => {
    const problem = { message: 'повторный id ревьюера security', at: 'reviewers.1.id' };
    assert.equal(errorAt(problem, 'reviewers.1.id'), problem.message);
    assert.equal(errorAt(problem, 'reviewers.0.id'), undefined);

    const html = editor(strategyDraftOf(PANEL_DOCUMENT), problem);
    assert.match(html, /id="reviewer-1-id"[^>]*>.*?<span class="strategy-field-error" role="alert">повторный id ревьюера security<\/span>/s);
    assert.doesNotMatch(html.split('id="reviewer-1-id"')[0]!, /повторный id/);
  });

  it('отказ режима и лимита обсуждения показывается у переключателя режима', () => {
    assert.equal(errorAt({ message: 'неизвестный ключ discussion', at: 'discussion' }, 'mode', 'discussion'), 'неизвестный ключ discussion');
    assert.equal(errorAt({ message: 'вне диапазона', at: 'discussion.max_messages' }, 'mode', 'discussion'), 'вне диапазона');
    const html = editor(strategyDraftOf(PANEL_DOCUMENT), { message: 'неизвестный режим', at: 'mode' });
    assert.match(html, /Review mode.*?<span class="strategy-field-error" role="alert">неизвестный режим<\/span>/s);
  });
});

describe('ui-review-strategies: список, перекрытие, удаление', () => {
  it('список показывает слой, число ревьюеров и режим; перекрытая — с пометкой', () => {
    const html = view({ overview: overview([PANEL, DUO_HOME, PANEL_HOME]) } as Partial<ReviewStrategiesViewProps>);
    assert.match(html, /panel<\/span><span[^>]*>project<\/span>/);
    assert.match(html, /duo<\/span><span[^>]*>mine<\/span>/);
    assert.match(html, /2 reviewer\(s\) · independent/);
    assert.match(html, /class="shadowed".*shadowed by the project/s);
  });

  it('адрес без имени открывает первую; имя с перекрытой — проектную, пока не выбран слой', () => {
    const strategies = [PANEL, DUO_HOME, PANEL_HOME];
    assert.equal(selectStrategy(strategies, undefined, undefined), PANEL);
    assert.equal(selectStrategy(strategies, 'panel', undefined), PANEL);
    assert.equal(selectStrategy(strategies, 'panel', 'home'), PANEL_HOME);
    assert.equal(selectStrategy([], undefined, undefined), undefined);
  });

  it('перекрытая стратегия открывается только для чтения: без Save и Delete', () => {
    const html = view({ overview: overview([PANEL, PANEL_HOME]), selected: PANEL_HOME } as Partial<ReviewStrategiesViewProps>);
    assert.match(html, /<fieldset class="strategy-editor" disabled="">/);
    assert.match(html, /Read-only: the project strategy of the same name wins/);
    const actions = html.split('<div class="agent-actions">')[1]!;
    assert.doesNotMatch(actions, />Save</);
    assert.doesNotMatch(actions, />Delete</);
  });

  it('сломанный файл открывается текстом с ошибкой разбора', () => {
    const html = view({ overview: overview([BROKEN]), selected: BROKEN } as Partial<ReviewStrategiesViewProps>);
    assert.match(html, /The file does not parse/);
    assert.match(html, /документ не разбирается как YAML/);
    assert.match(html, /<pre class="strategy-text">reviewers: \[}/);
  });

  it('пустой список — пустое состояние с действием создания', () => {
    const html = view({ overview: overview([]), selected: undefined } as Partial<ReviewStrategiesViewProps>);
    assert.match(html, /No review strategies yet/);
    assert.match(html, />Create strategy</);
  });

  it('редактор называет путь файла и использование шагами', () => {
    const html = view({});
    assert.match(html, /\/p\/\.burnex\/review-strategies\/panel\.yml/);
    assert.match(html, /used in 1 step\(s\)/);
    assert.match(html, /self-improve \/ review \/ review-diff/);
  });

  it('удаление используемой стратегии просит подтверждения и называет шаги', () => {
    assert.match(strategyRemovalConfirmation(PANEL), /used by 1 step\(s\): self-improve \/ review \/ review-diff/);
    assert.equal(strategyRemovalConfirmation(DUO_HOME), `Delete strategy duo (${DUO_HOME.path})?`);
  });
});
