import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Context } from 'cordis';

import type { BackendView, Overview, PipelineView, RunOverview, RunSnapshot } from '../src/api';
import { RunLaunchForm } from '../src/components/RunLaunchDialog';
import { Runs } from '../src/pages/Runs';
import { RunDetail } from '../src/pages/RunDetail';
import { bindRouterKernel } from '../src/router';
import {
  agentImpact,
  buildLaunchBody,
  initialPipeline,
  launchBlocker,
  submitLaunch,
  type LaunchDraft,
  type LaunchPayload,
} from '../src/runLaunch';
import { envOfRows, parseEnvLines } from '../src/runLaunchEnv';

/**
 * Диалог запуска прогона (`ui-run-launch-dialog`). Щелчков в тестах витрины
 * нет, поэтому решения формы проверяются чистыми функциями (`runLaunch.ts`,
 * `runLaunchEnv.ts`), а то, что форма показывает пользователю, — статическим
 * рендером тела диалога с предвыбором.
 */

const TABLE = [{ id: 'r-run', path: '/runs/:projectKey/:runId', target: { kind: 'screen', id: 'screen-run' } }];
bindRouterKernel({ routes: { get: () => ({ table: TABLE }) } } as unknown as Context);

function step(id: string, origin: 'config' | 'pipeline' | 'job' | 'step', kind: 'agent' | 'run' = 'agent'): PipelineView['jobs'][number]['steps'][number] {
  return kind === 'run'
    ? { id, kind }
    : { id, kind, agent: 'claude', agentOrigin: { layer: origin } };
}

function pipeline(overrides: Partial<PipelineView> = {}): PipelineView {
  return {
    projectKey: 'proj',
    projectPath: '/work/proj',
    file: '.burnex/pipelines/p.yml',
    name: 'p',
    jobs: [
      {
        id: 'work',
        needs: [],
        on: 'success',
        publishesOutput: false,
        agentEntryJob: 'work',
        steps: [step('free', 'config'), step('pinned', 'step'), step('local', 'config', 'run')],
      },
    ],
    inputs: [],
    envNames: ['MODE'],
    shadow: { ready: true },
    ...overrides,
  };
}

const BACKENDS: BackendView[] = [
  backend('claude', true),
  backend('codex', true),
  backend('gemini', false),
];

function backend(name: string, available: boolean): BackendView {
  return {
    name,
    command: name,
    enabled: true,
    available,
    defaultModelSource: 'built-in',
    modelTiers: {},
    modelTierSources: {},
    modelTierEffortSources: {},
  };
}

function form(pipelines: readonly PipelineView[], preselect: Parameters<typeof RunLaunchForm>[0]['preselect'] = {}): string {
  return renderToStaticMarkup(
    <RunLaunchForm pipelines={pipelines} backends={BACKENDS} preselect={preselect} onClose={() => undefined} />,
  );
}

function draft(overrides: Partial<LaunchDraft> = {}): LaunchDraft {
  return { project: 'proj', pipeline: '.burnex/pipelines/p.yml', inputs: {}, envText: '', shadow: false, agent: '', ...overrides };
}

describe('ui-run-launch-dialog: правила строк env', () => {
  const declared = ['MODE'];
  const errorOf = (line: string, names = declared): string | undefined => parseEnvLines([line], names)[0]?.error;

  // Те же примеры, что в тесте схемы демона (test/run-launch.test.ts, ui-server.test.ts).
  it('имя: буквы, цифры, подчёркивание, без цифры в начале', () => {
    assert.equal(errorOf('MODE=fast'), undefined);
    assert.match(errorOf('bad-name=x', ['bad-name']) ?? '', /Name/);
    assert.match(errorOf('1MODE=x', ['1MODE']) ?? '', /Name/);
    assert.match(errorOf('MO-DE=x', ['MO-DE']) ?? '', /Name/);
  });

  it('значение однострочно и не длиннее 500 символов', () => {
    assert.match(errorOf('MODE=a\nb') ?? '', /single line/);
    assert.equal(errorOf(`MODE=${'x'.repeat(500)}`), undefined);
    assert.match(errorOf(`MODE=${'x'.repeat(501)}`) ?? '', /500/);
  });

  it('ключ вне объявленных — ошибка с перечнем объявленных', () => {
    assert.match(errorOf('TOKEN=x') ?? '', /TOKEN is not declared.*MODE/);
    assert.match(errorOf('TOKEN=x', []) ?? '', /no env/);
  });

  it('делит по первому «=», пустое значение допустимо, строка без «=» — ошибка', () => {
    assert.equal(parseEnvLines(['MODE=a=b'], declared)[0]?.value, 'a=b');
    assert.equal(parseEnvLines(['MODE='], declared)[0]?.value, '');
    assert.match(errorOf('MODE') ?? '', /KEY=VALUE/);
  });

  it('повтор ключа — ошибка второй строки; пустые строки пропускаются', () => {
    const rows = parseEnvLines(['MODE=a', '', 'MODE=b'], declared);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.error, undefined);
    assert.match(rows[1]?.error ?? '', /twice/);
    assert.equal(rows[1]?.line, 2);
    assert.deepEqual(envOfRows(rows), { MODE: 'a' });
  });
});

describe('ui-run-launch-dialog: тело запроса', () => {
  it('со всеми полями: входы, env, shadow и агент', () => {
    const p = pipeline({ inputs: ['item', 'note'] });
    const body = buildLaunchBody(
      draft({ inputs: { item: 'foo', note: 'hi' }, envText: 'MODE=fast', shadow: true, agent: 'codex' }),
      p,
    );
    assert.deepEqual(body, {
      project: 'proj',
      pipeline: p.file,
      inputs: { item: 'foo', note: 'hi' },
      env: { MODE: 'fast' },
      shadow: true,
      agent: 'codex',
    });
  });

  it('пустые поля в запрос не попадают', () => {
    const p = pipeline({ inputs: ['item', 'note'] });
    const body = buildLaunchBody(draft({ inputs: { item: 'foo', note: '' } }), p);
    assert.deepEqual(body, { project: 'proj', pipeline: p.file, inputs: { item: 'foo' } });
    assert.deepEqual(buildLaunchBody(draft(), pipeline()), { project: 'proj', pipeline: pipeline().file });
  });

  it('shadow неготового пайплайна в запрос не идёт', () => {
    const p = pipeline({ shadow: { ready: false, steps: ['work.push'] } });
    assert.equal('shadow' in buildLaunchBody(draft({ shadow: true }), p), false);
    assert.match(launchBlocker(draft({ shadow: true }), p) ?? '', /shadow/);
  });

  it('ошибочная строка env блокирует запуск', () => {
    const p = pipeline();
    assert.equal(launchBlocker(draft({ envText: 'MODE=fast' }), p), undefined);
    assert.match(launchBlocker(draft({ envText: 'TOKEN=x' }), p) ?? '', /error/);
  });

  it('запуск пункта foo без других полей шлёт только inputs.item', () => {
    const p = pipeline({ inputs: ['item'] });
    const preselected = initialPipeline([p], 'foo');
    assert.equal(preselected?.file, p.file);
    const body = buildLaunchBody(draft({ inputs: { item: 'foo' } }), p);
    assert.deepEqual(body, { project: 'proj', pipeline: p.file, inputs: { item: 'foo' } });
    for (const key of ['env', 'shadow', 'agent']) assert.equal(key in body, false);
  });

  it('пункту доски предвыбирается пайплайн со входом item, а не первый по порядку', () => {
    const first = pipeline({ file: 'a.yml' });
    const withItem = pipeline({ file: 'b.yml', inputs: ['item'] });
    assert.equal(initialPipeline([first, withItem], 'foo')?.file, 'b.yml');
    assert.equal(initialPipeline([first, withItem], undefined)?.file, 'a.yml');
  });
});

describe('ui-run-launch-dialog: отправка', () => {
  const body: LaunchPayload = { project: 'proj', pipeline: 'p.yml' };

  it('202: диалог закрывается', async () => {
    const sent: LaunchPayload[] = [];
    const outcome = await submitLaunch(body, async (payload) => {
      sent.push(payload);
      return { ok: true };
    });
    assert.deepEqual(outcome, { ok: true });
    assert.deepEqual(sent, [body]);
  });

  it('400: фраза демона возвращается текстом, диалог остаётся открытым', async () => {
    const outcome = await submitLaunch(body, async () => {
      throw new Error('Request body does not match the format: agent must be a string');
    });
    assert.deepEqual(outcome, { ok: false, error: 'Request body does not match the format: agent must be a string' });
  });
});

describe('ui-run-launch-dialog: что форма показывает', () => {
  it('агент: число затронутых шагов считается по слою config', () => {
    assert.deepEqual(agentImpact(pipeline()), { affected: 1, agentSteps: 2 });
    const html = form([pipeline()]);
    assert.match(html, /Applies to 1 of 2 agent steps/);
  });

  it('агент корня документа уступает флагу только под agent_policy: fallback', () => {
    const steps = [step('root', 'pipeline'), step('job', 'job'), step('free', 'config')];
    const rooted = (agentPolicy?: 'force' | 'fallback') =>
      pipeline({
        jobs: [{ ...pipeline().jobs[0]!, steps }],
        ...(agentPolicy === undefined ? {} : { agentPolicy }),
      });
    assert.deepEqual(agentImpact(rooted()), { affected: 1, agentSteps: 3 });
    assert.deepEqual(agentImpact(rooted('force')), { affected: 1, agentSteps: 3 });
    assert.deepEqual(agentImpact(rooted('fallback')), { affected: 2, agentSteps: 3 });
  });

  it('пайплайн, который выбор не меняет, получает подсказку, поле остаётся', () => {
    const pinned = pipeline({
      jobs: [{ ...pipeline().jobs[0]!, steps: [step('pinned', 'step')] }],
    });
    const html = form([pinned]);
    assert.match(html, /does not change this pipeline/);
    assert.match(html, /aria-label="Agent"/);
  });

  it('shadow выключен у неготового пайплайна, причина называет адреса шагов', () => {
    const html = form([pipeline({ shadow: { ready: false, steps: ['work.push', 'work.tag'] } })]);
    assert.match(html, /external is not declared for work\.push, work\.tag/);
    assert.match(html, /role="switch"[^>]*disabled/);
  });

  it('shadow готового пайплайна доступен', () => {
    const html = form([pipeline()]);
    assert.doesNotMatch(html, /role="switch"[^>]*disabled/);
  });

  it('env: названы объявленные имена; у пайплайна без env — сказано, что их нет', () => {
    assert.match(form([pipeline()]), /declared: MODE/);
    assert.match(form([pipeline({ envNames: [] })]), /declares no env/);
  });

  it('предвыбор из доски: проект не выбирается, вход item получает слаг пункта', () => {
    const html = form([pipeline({ inputs: ['item'] })], {
      projectKey: 'proj',
      item: { slug: 'foo', title: 'Foo item' },
    });
    assert.doesNotMatch(html, /aria-label="Project"/);
    assert.match(html, /value="foo"/);
  });

  it('без предвыбора проект выбирается в форме', () => {
    assert.match(form([pipeline()]), /aria-label="Project"/);
  });

  it('сломанный пайплайн показан с причиной, выбрать его нельзя', () => {
    const html = form([pipeline(), pipeline({ file: 'broken.yml', name: 'broken', error: 'bad yaml' })]);
    assert.match(html, /bad yaml/);
    assert.doesNotMatch(html, /value="broken\.yml"/);
  });
});

describe('ui-run-launch-dialog: бейдж shadow-прогона', () => {
  const run = (runId: string, extra: Partial<RunOverview> = {}): RunOverview => ({
    runId,
    shortId: runId,
    pipeline: 'demo',
    status: 'success',
    running: false,
    abandoned: false,
    swept: false,
    filesGone: false,
    unreadable: false,
    ...extra,
  });
  const overview: Overview = {
    generatedAt: '2026-11-01T00:00:00Z',
    projects: [{ key: 'proj', path: '/work/proj', runs: [run('r-shadow', { mode: 'shadow' }), run('r-plain')] }],
  };

  it('в списке бейдж есть у shadow-прогона и нет у обычного', () => {
    const html = renderToStaticMarkup(<Runs overview={overview} navigate={() => undefined} />);
    assert.equal(html.match(/>shadow</g)?.length, 1);
    assert.match(html, /New run/);
  });

  const snapshot = (extra: Partial<RunSnapshot> = {}): RunSnapshot => ({
    runId: 'r-1',
    projectKey: 'proj',
    pipeline: 'demo',
    status: 'success',
    jobs: [],
    graph: { nodes: [], edges: [], columns: 0 },
    swept: false,
    filesGone: false,
    ...extra,
  });
  const detail = (current: RunSnapshot): string =>
    renderToStaticMarkup(<RunDetail projectKey="proj" runId="r-1" snapshot={current} navigate={() => undefined} />);

  it('в шапке прогона — бейдж режима и агент; у обычного прогона их нет', () => {
    const shadowed = detail(snapshot({ mode: 'shadow', agentOverride: 'codex' }));
    assert.match(shadowed, />shadow</);
    assert.match(shadowed, /agent: codex/);
    const plain = detail(snapshot());
    assert.doesNotMatch(plain, />shadow</);
    assert.doesNotMatch(plain, /agent: /);
  });
});
