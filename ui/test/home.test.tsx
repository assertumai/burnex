import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Context } from 'cordis';

import { Home, homeStats, SECTIONS } from '../src/pages/Home';
import { BUILTIN_SCREENS } from '../src/screens/index';
import { bindRouterKernel } from '../src/router';
import type { Overview, ProposalsStreamEvent, RunUsageOverview } from '../src/api';

/**
 * Экран «Home» (`ui-home-screen`): стартовая страница — вводный текст, полоса
 * состояния по обзору и очереди предложений, карта разделов ссылками на цели.
 * Свёртка чисел — чистая функция, проверяется без DOM; разметка — статическим
 * рендером, как и у прочих страниц витрины.
 */

const TABLE = [
  { id: 'r-runs', path: '/runs', target: { kind: 'screen', id: 'screen-runs' } },
  { id: 'r-decisions', path: '/decisions', target: { kind: 'screen', id: 'screen-decisions' } },
];
bindRouterKernel({ routes: { get: () => ({ table: TABLE }) } } as unknown as Context);

const NOW = new Date('2026-10-31T12:00:00Z');

function overview(): Overview {
  return {
    generatedAt: NOW.toISOString(),
    projects: [
      {
        key: 'a',
        path: '/tmp/a',
        runs: [
          { runId: 'a-1', shortId: '1', pipeline: 'p', running: true, abandoned: false, swept: false, filesGone: false, unreadable: false, startedAt: '2026-10-31T10:00:00Z', usage: { billableTokens: 10, costUsd: 1.5 } as RunUsageOverview },
          { runId: 'a-2', shortId: '2', pipeline: 'p', running: false, abandoned: false, swept: false, filesGone: false, unreadable: false, startedAt: '2026-10-30T10:00:00Z', usage: { billableTokens: 10, costUsd: 9 } as RunUsageOverview },
        ],
      },
      {
        key: 'b',
        runs: [
          {
            runId: 'b-1', shortId: '1', pipeline: 'q', running: true, abandoned: false, swept: false, filesGone: false, unreadable: false,
            startedAt: '2026-10-31T11:00:00Z',
            awaiting: [{ step: 'ask', job: 'j', outcomes: [], askedAt: NOW.toISOString() } as unknown as NonNullable<Overview['projects'][number]['runs'][number]['awaiting']>[number]],
          },
        ],
      },
    ],
  };
}

function proposals(): ProposalsStreamEvent {
  const record = (id: string, state: 'pending' | 'accepted'): ProposalsStreamEvent['projects'][number]['records'][number] =>
    ({ id, target: 't', action: 'create', origin: {}, baseFingerprint: null, state, createdAt: NOW.toISOString() });
  return {
    projects: [
      { projectKey: 'a', records: [record('p1', 'pending'), record('p2', 'accepted')], invalid: [] },
      { projectKey: 'b', records: [record('p3', 'pending')], invalid: [] },
    ],
  };
}

describe('home: свёртка полосы состояния', () => {
  it('считает проекты, идущие прогоны, ожидания, предложения и сегодняшний расход', () => {
    assert.deepEqual(homeStats(overview(), proposals(), NOW), {
      projects: 2,
      running: 2,
      awaiting: 1,
      pendingProposals: 2,
      runsToday: 2,
      costToday: 1.5,
    });
  });

  it('без данных — нули, а не отказ', () => {
    assert.deepEqual(homeStats(undefined, undefined, NOW), {
      projects: 0, running: 0, awaiting: 0, pendingProposals: 0, runsToday: 0, costToday: 0,
    });
  });
});

describe('home: разметка', () => {
  it('ссылки карты и плиток собраны по действующей таблице; цель без маршрута называет причину', () => {
    const markup = renderToStaticMarkup(<Home overview={overview()} proposals={proposals()} navigate={() => {}} />);
    assert.match(markup, /href="\/runs"/);
    assert.match(markup, /href="\/decisions"/);
    // Маршрута на Pipelines в таблице нет — карточка остаётся с причиной, а не исчезает.
    assert.match(markup, /no route: no active route leads to target screen:screen-pipelines/);
    assert.match(markup, /awaiting a decision/);
    assert.match(markup, /\$1\.50/);
    assert.match(markup, /stepcast run/);
  });

  it('до прихода обзора числа — многоточие, а не нули', () => {
    const markup = renderToStaticMarkup(<Home overview={undefined} proposals={undefined} navigate={() => {}} />);
    assert.match(markup, /…/);
    assert.doesNotMatch(markup, /home-stat-value">0</);
  });

  it('карта разделов называет каждый встроенный экран с пунктом меню, и только их', () => {
    const mapped = SECTIONS.flatMap((group) => group.entries.map((entry) => entry.target.id)).sort();
    // Без `screen-home` (это сама страница) и `screen-run` (страница прогона без пункта меню).
    const expected = Object.keys(BUILTIN_SCREENS).filter((id) => id !== 'screen-home' && id !== 'screen-run').sort();
    assert.deepEqual(mapped, expected);
  });
});
