import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Context } from 'cordis';

import { RunDetail, requestResume } from '../src/pages/RunDetail';
import { bindRouterKernel } from '../src/router';
import type { JobSnapshot, RunSnapshot } from '../src/api';

// `TargetLink` внутри карточки шага читает таблицу маршрутов — как в decisions.test.tsx.
bindRouterKernel({ routes: { get: () => ({ table: [] }) } } as unknown as Context);

/**
 * Кнопка «Resume from this job» на странице прогона. У витрины нет клика в
 * тестах, поэтому наличие кнопки проверяется статическим рендером, а нажатие —
 * чистой `requestResume` со стабом вызова демона.
 */

function job(id: string): JobSnapshot {
  return {
    id,
    needs: [],
    on: 'success',
    context: [],
    inputs: [],
    outputDeclared: false,
    steps: [],
    usage: { billableTokens: 0, wallclockMs: 0, costUsd: null },
  };
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: 'run-1',
    projectKey: 'proj',
    pipeline: 'demo',
    status: 'failed',
    jobs: [job('build')],
    graph: { nodes: [], edges: [], columns: 0 },
    swept: false,
    filesGone: false,
    ...overrides,
  };
}

function render(current: RunSnapshot): string {
  return renderToStaticMarkup(<RunDetail projectKey="proj" runId="run-1" snapshot={current} navigate={() => undefined} />);
}

describe('resume-from-dashboard-button: страница прогона', () => {
  it('у завершённого прогона есть кнопка возобновления', () => {
    assert.match(render(snapshot()), /Resume from this job/);
  });

  it('у прогона с живым процессом кнопки нет', () => {
    assert.doesNotMatch(render(snapshot({ status: 'running', alive: true })), /Resume from this job/);
  });

  it('у прогона без каталога кнопки нет', () => {
    assert.doesNotMatch(render(snapshot({ filesGone: true })), /Resume from this job/);
  });
});

describe('resume-from-dashboard-button: нажатие', () => {
  it('шлёт адрес прогона и работу и сообщает о запуске', async () => {
    const sent: unknown[] = [];
    const note = await requestResume('proj/run-1', 'build', async (payload) => {
      sent.push(payload);
      return { ok: true };
    });

    assert.deepEqual(sent, [{ run: 'proj/run-1', from: 'build' }]);
    assert.equal(note.failed, false);
    assert.match(note.text, /build/);
  });

  it('отказ демона выводится его же фразой', async () => {
    const note = await requestResume('proj/run-1', 'нет', async () => {
      throw new Error('Работа нет в пайплайне не объявлена');
    });

    assert.deepEqual(note, { text: 'Работа нет в пайплайне не объявлена', failed: true });
  });
});
