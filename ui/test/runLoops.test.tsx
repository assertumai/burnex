import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Context } from 'cordis';

import { idClipWidth } from '../src/components/JobGraph';
import { RunDetail, shownPass, stepOutputKey, stepPass } from '../src/pages/RunDetail';
import { bindRouterKernel } from '../src/router';
import { fetchStepOutput, type GraphLoop, type GraphNode, type JobLoop, type JobSnapshot, type RunSnapshot } from '../src/api';

// `TargetLink` внутри карточки шага читает таблицу маршрутов — как в runResume.test.tsx.
bindRouterKernel({ routes: { get: () => ({ table: [] }) } } as unknown as Context);

/**
 * Циклы по группе работ на странице прогона: метка прохода в узле графа и
 * переключатель проходов в карточке работы. Клика в тестах нет, поэтому
 * разметка проверяется статическим рендером, а выбор прохода — чистыми
 * `shownPass`/`stepPass` и запросом вывода шага со стабом `fetch`.
 */

const USAGE = { billableTokens: 0, wallclockMs: 0, costUsd: null };

function loopOf(overrides: Partial<JobLoop> = {}): JobLoop {
  return {
    id: 'refine',
    iterations: 3,
    maxIterations: 5,
    current: 3,
    status: 'running',
    passes: [1, 2, 3],
    ...overrides,
  };
}

function job(id: string, loop?: JobLoop): JobSnapshot {
  return {
    id,
    needs: [],
    on: 'success',
    context: [],
    inputs: [],
    outputDeclared: false,
    ...(loop === undefined ? {} : { loop }),
    steps: [
      {
        id: 'think',
        kind: 'run',
        attemptModels: [],
        attempts: 2,
        context: [],
        files: [{ name: 'prompt.txt', path: 'jobs/x/prompt.txt', bytes: 3 }],
        usage: USAGE,
      },
    ],
    usage: USAGE,
  };
}

function node(id: string, loop?: GraphLoop): GraphNode {
  return {
    id,
    column: 0,
    row: 0,
    needs: [],
    on: 'success',
    conditional: false,
    blockedBy: [],
    ...(loop === undefined ? {} : { loop }),
  };
}

function render(jobs: readonly JobSnapshot[], nodes: readonly GraphNode[]): string {
  const current: RunSnapshot = {
    runId: 'run-1',
    projectKey: 'proj',
    pipeline: 'demo',
    status: 'running',
    jobs,
    graph: { nodes, edges: [], columns: 1 },
    swept: false,
    filesGone: false,
  };
  return renderToStaticMarkup(<RunDetail projectKey="proj" runId="run-1" snapshot={current} navigate={() => undefined} />);
}

describe('ui-run-graph-loops: метка прохода в узле', () => {
  it('узел участника идущего цикла показывает pass 2/5', () => {
    const loop = loopOf({ iterations: 2, current: 2 });
    const html = render([job('build', loop)], [node('build', loop)]);

    assert.match(html, /class="loop-label"[^>]*>pass 2\/5</);
    assert.match(html, /loop refine: up to 5 passes/);
  });

  it('узел законченного цикла называет число проходов и вердикт, но не текущий проход', () => {
    const { current: _current, ...rest } = loopOf({ iterations: 5, status: 'failed', verdict: 'exhausted' });
    const loop: JobLoop = rest;
    const html = render([job('build', loop)], [node('build', loop)]);

    assert.match(html, /class="loop-label failed"[^>]*>5 passes · exhausted</);
    assert.doesNotMatch(html, /pass 5\/5/);
  });

  it('узел ещё не начатого цикла показывает 0/max', () => {
    const loop = loopOf({ iterations: 0, passes: [] });
    const { current: _current, ...rest } = loop;
    const html = render([job('build', rest)], [node('build', rest)]);

    assert.match(html, />0\/5</);
  });

  it('узел вне цикла метки не имеет', () => {
    const html = render([job('build')], [node('build')]);

    assert.doesNotMatch(html, /loop-label/);
    assert.doesNotMatch(html, /job-node-id-/);
  });

  it('имя работы над подписью обрезано по левый край метки, а не по рамке узла', () => {
    const { current: _current, ...rest } = loopOf({ iterations: 5, status: 'failed', verdict: 'exhausted' });
    const html = render([job('a-rather-long-job-name', rest)], [node('a-rather-long-job-name', rest)]);
    const width = idClipWidth('5 passes · exhausted');

    assert.match(html, new RegExp(`<clipPath id="job-node-id-0"><rect width="${width}"`));
    assert.match(html, /clip-path="url\(#job-node-id-0\)"[^>]*>a-rather-long-job-name</);
    // Метка и обрезанное имя не пересекаются: 10 — отступ имени и метки от краёв.
    assert.ok(width + '5 passes · exhausted'.length * 6 <= 168 - 10);
  });
});

describe('ui-run-graph-loops: карточка участника', () => {
  it('при трёх проходах показывает строку цикла и переключатель, последний выбран', () => {
    const loop = loopOf();
    const html = render([job('build', loop)], [node('build', loop)]);

    assert.match(html, /Loop refine: pass 3 of 5/);
    assert.match(html, />pass 1</);
    assert.match(html, />pass 2</);
    assert.match(html, /class="[^"]*active[^"]*"[^>]*disabled=""[^>]*>pass 3</);
  });

  it('при одном проходе переключателя нет', () => {
    const loop = loopOf({ iterations: 1, current: 1, passes: [1] });
    const html = render([job('build', loop)], [node('build', loop)]);

    assert.match(html, /Loop refine/);
    assert.doesNotMatch(html, /class="passes"/);
  });

  it('вывод шага с его переключателем попыток остаётся в карточке', () => {
    const loop = loopOf();
    const html = render([job('build', loop)], [node('build', loop)]);

    assert.match(html, /step output/);
    assert.match(html, /attempts: 2/);
  });

  it('пока выбран последний проход, шаги не получают pass; прошлый уходит им номером', () => {
    const loop = loopOf();

    assert.equal(stepPass(loop, undefined), undefined);
    assert.equal(stepPass(loop, 3), undefined);
    assert.equal(stepPass(loop, 1), 1);
    assert.equal(stepPass(undefined, 1), undefined);
  });

  it('новый проход переключает показ, только если был выбран последний', () => {
    const before = loopOf({ passes: [1, 2] });
    const after = loopOf({ passes: [1, 2, 3] });

    assert.equal(shownPass(before, undefined), 2);
    assert.equal(shownPass(after, undefined), 3, 'шёл за последним — идёт за новым');
    assert.equal(shownPass(after, 1), 1, 'выбран прошлый — остаётся на нём');
    assert.equal(shownPass(loopOf({ passes: [2, 3] }), 1), 3, 'каталог выбранного прохода исчез');
  });

  it('ключ вывода шага меняется с приходом нового прохода, хотя pass остаётся пустым', () => {
    const before = loopOf({ passes: [1, 2] });
    const after = loopOf({ passes: [1, 2, 3] });

    // Без смены ключа StepOutput не сбросил бы вывод и смещения прохода 2.
    assert.equal(stepPass(before, undefined), stepPass(after, undefined));
    assert.notEqual(stepOutputKey(before, undefined), stepOutputKey(after, undefined));
    assert.equal(stepOutputKey(before, 1), stepOutputKey(after, 1), 'выбран прошлый — вывод не сбрасывается');
    assert.notEqual(stepOutputKey(after, 1), stepOutputKey(after, undefined), 'переключение прохода сбрасывает вывод');
    assert.equal(stepOutputKey(undefined, undefined), stepOutputKey(undefined, 2), 'работа вне цикла — ключ постоянный');
  });
});

describe('ui-run-graph-loops: запрос вывода шага', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ attempts: [], done: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return urls;
  }

  it('выбор прохода 1 уходит параметром pass=1 вместе с попыткой', async () => {
    const urls = stubFetch();
    await fetchStepOutput({ address: 'proj/run-1', jobId: 'build', stepId: 'think', pass: 1, attempt: 2, stdoutOffset: 0 });

    const query = new URL(urls[0] ?? '', 'http://x').searchParams;
    assert.equal(query.get('pass'), '1');
    assert.equal(query.get('attempt'), '2');
  });

  it('без прохода параметра pass в запросе нет', async () => {
    const urls = stubFetch();
    await fetchStepOutput({ address: 'proj/run-1', jobId: 'build', stepId: 'think', stdoutOffset: 0 });

    assert.equal(new URL(urls[0] ?? '', 'http://x').searchParams.has('pass'), false);
  });
});
