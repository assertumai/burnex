import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { savePipelineAgent, type PipelineJobView, type PipelinesOverview, type PipelineView } from '../src/api';
import { JobCard } from '../src/pages/Pipelines';
import {
  agentChoices,
  draftOf,
  entryMarkLabel,
  modelOriginLabel,
  selectionPatch,
} from '../src/pages/PipelineAgents';

/**
 * Карточка пайплайна и шага: выбор агента, tier или модели и effort
 * (`agent-policy-and-pipeline-agents`, design.md, решение 8). Страница
 * рендерится на сервере (`renderToStaticMarkup`), поэтому щелчок заменяет вызов
 * клиента с подставным `fetch` — то же, что делает кнопка «Apply».
 */

const FILE = '/home/me/.burnex/config.yml';

function jobOf(step: Record<string, unknown>): PipelineJobView {
  return {
    id: 'implement',
    needs: [],
    on: 'success',
    publishesOutput: false,
    agentEntryJob: 'implement',
    steps: [{ id: 'code', kind: 'agent', agent: 'claude', ...step }],
  };
}

const CHOICES = {
  agents: ['claude', 'codex'],
  tiers: ['max', 'deep', 'fast'],
  models: ['opus', 'sonnet'],
};

function installFetch(respond: (url: string, init: RequestInit | undefined) => unknown): {
  readonly calls: Array<{ url: string; init: RequestInit | undefined }>;
  restore: () => void;
} {
  const previous = (globalThis as { fetch?: unknown }).fetch;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  (globalThis as { fetch?: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const body = JSON.stringify(respond(String(input), init));
    return { ok: true, status: 200, json: async () => JSON.parse(body) as unknown };
  };
  return {
    calls,
    restore: () => {
      (globalThis as { fetch?: unknown }).fetch = previous;
    },
  };
}

describe('ui-pipelines: выбор агента на карточке шага', () => {
  it('выбор модели отправляет запрос, а после ответа карточка видит модель с источником step_agents', async () => {
    const answered: PipelinesOverview = {
      generatedAt: '2026-10-29T00:00:00.000Z',
      pipelines: [
        {
          projectKey: 'proj', projectPath: '/proj', file: 'p.yml', name: 'p', inputs: [], envNames: [], shadow: { ready: true },
          agentPolicy: 'force', agentPolicyFile: 'built-in',
          jobs: [
            jobOf({
              model: 'sonnet',
              modelOrigin: { layer: 'step_agents', file: FILE },
              agentEntry: { key: 'step_agents.p.implement.code', model: { value: 'sonnet', file: FILE } },
            }),
          ],
        } as PipelineView,
      ],
    };
    const fake = installFetch(() => answered);
    try {
      const patch = selectionPatch(undefined, { agent: '', model: 'sonnet', tier: '', effort: '' });
      assert.deepEqual(patch, { model: 'sonnet' });
      const response = await savePipelineAgent({ pipeline: 'p', job: 'implement', step: 'code' }, patch ?? null);

      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0]?.url, '/api/pipelines/agents');
      assert.equal(fake.calls[0]?.init?.method, 'PUT');
      assert.deepEqual(JSON.parse(String(fake.calls[0]?.init?.body)), {
        pipeline: 'p', job: 'implement', step: 'code', selection: { model: 'sonnet' },
      });

      const job = response.pipelines[0]!.jobs[0]!;
      const html = renderToStaticMarkup(<JobCard job={job} pipeline="p" agentPolicy="force" choices={CHOICES} onApply={() => undefined} />);
      assert.match(html, /claude · sonnet/);
      assert.match(html, /step_agents · \/home\/me\/\.burnex\/config\.yml/);
    } finally {
      fake.restore();
    }
  });

  it('снятие записи отправляет selection: null', async () => {
    const fake = installFetch(() => ({ pipelines: [], generatedAt: 'now' }));
    try {
      await savePipelineAgent({ pipeline: 'p' }, null);
      assert.deepEqual(JSON.parse(String(fake.calls[0]?.init?.body)), { pipeline: 'p', selection: null });
    } finally {
      fake.restore();
    }
  });

  it('запись, проигрывающая документу, помечена словами, а модель шага прежняя', () => {
    const job = jobOf({
      model: 'opus',
      modelOrigin: { layer: 'step' },
      agentEntry: { key: 'step_agents.p.implement.code', model: { value: 'sonnet', file: FILE }, mark: 'loses_to_document' },
    });
    const html = renderToStaticMarkup(<JobCard job={job} pipeline="p" agentPolicy="force" choices={CHOICES} onApply={() => undefined} />);
    assert.match(html, /claude · opus/);
    assert.match(html, /declared by the step/);
    assert.match(html, /loses to the pipeline document under agent_policy: force/);
  });

  it('у агентского шага есть поля выбора с вариантами из настроек, у остальных нет', () => {
    const agent = renderToStaticMarkup(<JobCard job={jobOf({})} pipeline="p" choices={CHOICES} onApply={() => undefined} />);
    assert.match(agent, /aria-label="agent p-implement-code"/);
    assert.match(agent, /<option value="codex">codex<\/option>/);
    assert.match(agent, /<option value="deep">deep<\/option>/);
    assert.match(agent, />Apply</);

    const run: PipelineJobView = { ...jobOf({}), steps: [{ id: 'build', kind: 'run', command: 'make' }] };
    assert.doesNotMatch(
      renderToStaticMarkup(<JobCard job={run} pipeline="p" choices={CHOICES} onApply={() => undefined} />),
      /aria-label="agent/,
    );
  });

  it('шаг дорожки адресует запись работой до раскрытия, а не копией дорожки', () => {
    const lane: PipelineJobView = { ...jobOf({}), id: 'implement-a', agentEntryJob: 'implement' };
    const html = renderToStaticMarkup(<JobCard job={lane} pipeline="p" choices={CHOICES} onApply={() => undefined} />);
    assert.match(html, /aria-label="agent p-implement-code"/);
    assert.doesNotMatch(html, /aria-label="agent p-implement-a-code"/);
  });

  it('без доступа к настройкам карточка только читает: подписи слоёв остаются, полей выбора нет', () => {
    const job = jobOf({ agentOrigin: { layer: 'pipeline_agents', file: FILE } });
    const html = renderToStaticMarkup(<JobCard job={job} pipeline="p" />);
    assert.match(html, /agent pipeline_agents · /);
    assert.doesNotMatch(html, /aria-label="agent/);
  });
});

describe('ui-pipelines: правка записи из черновика', () => {
  const entry = {
    key: 'step_agents.p.implement.code',
    agent: { value: 'codex', file: FILE },
    model: { value: 'sonnet', file: FILE },
  };

  it('не тронутое поле в правку не попадает, очищенное снимается', () => {
    assert.equal(selectionPatch(entry, draftOf(entry)), undefined);
    assert.deepEqual(selectionPatch(entry, { ...draftOf(entry), model: '', effort: 'high' }), { model: null, effort: 'high' });
  });

  it('выбор tier вместо модели снимает модель той же правкой', () => {
    assert.deepEqual(selectionPatch(entry, { ...draftOf(entry), model: '', tier: 'fast' }), { model: null, model_tier: 'fast' });
  });

  it('варианты берутся из настроек без пробы CLI: подключённые агенты, tier и известные модели', () => {
    const choices = agentChoices({
      agent: { source: 'x' }, model: { source: 'x' }, effort: { source: 'x' },
      modelTiers: ['max', 'fast'],
      file: FILE,
      backends: [
        {
          name: 'claude', command: 'claude', enabled: true, available: true, defaultModel: 'sonnet',
          defaultModelSource: 'x', modelTiers: { fast: { model: 'haiku' } }, modelTierSources: {}, modelTierEffortSources: {},
        },
        {
          name: 'codex', command: 'codex', enabled: true, available: false,
          defaultModelSource: 'x', modelTiers: {}, modelTierSources: {}, modelTierEffortSources: {},
        },
      ],
    });
    assert.deepEqual(choices, { agents: ['claude'], tiers: ['max', 'fast'], models: ['haiku', 'sonnet'] });
  });

  it('подписи: отброшенная модель называет слой, из которого пришла', () => {
    assert.match(
      modelOriginLabel({ layer: 'backend', backend: 'codex', dropped: { model: 'opus', layer: 'pipeline' } }),
      /dropped opus from the pipeline: it belongs to another agent/,
    );
    assert.match(entryMarkLabel('shadowed_by_project', 'force'), /project file/);
    assert.match(entryMarkLabel('no_agent_steps', 'force'), /no agent steps/);
    assert.doesNotMatch(entryMarkLabel('no_agent_steps', 'force'), /loses to the pipeline document/);
  });
});
