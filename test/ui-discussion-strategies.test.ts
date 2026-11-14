import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { get, request } from 'node:http';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { resolveConfig } from '../src/parts/pipeline/config/resolve.js';
import { createUiServer, LOOPBACK, type UiServer } from '../src/parts/ui/daemon/server.js';
import { projectPipelines } from '../src/parts/ui/pipelines.js';
import { deleteStrategy, DISCUSSION_STRATEGY, readStrategies, saveStrategy, StrategyRejected } from '../src/parts/ui/strategies.js';
import { tempDir } from './tmp.js';

/**
 * Экран «Discussion strategies» (`ui-discussion-strategies`), серверная
 * половина: слои `discussion-strategies`, отказ разбора движка с путём ключа,
 * запись правкой документа, использование шагами `discuss:` и маршрут
 * `/api/discussion-strategies`.
 */

const BACKENDS = ['claude', 'codex'];

function bed() {
  const root = tempDir('ui-discussion-');
  const home = join(root, 'home');
  const projectRoot = join(root, 'project');
  const homeDir = join(home, '.burnex', 'discussion-strategies');
  const projectDir = join(projectRoot, '.burnex', 'discussion-strategies');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  return { home, projectRoot, homeDir, projectDir };
}

const PANEL = `# Панель обсуждения
version: 1
kind: discussion-strategy
name: panel
participants:
  - id: pragmatist
    agent: codex # дешевле
    focus: Простота
  - id: skeptic
    agent: claude
author:
  agent: claude
`;

describe('ui-discussion-strategies: слои и использование', () => {
  it('обе стратегии слоёв, перекрытие, отказ разбора у ключа и шаг discuss: в использовании', async () => {
    const { home, projectRoot, homeDir, projectDir } = bed();
    writeFileSync(join(projectDir, 'panel.yml'), PANEL);
    writeFileSync(join(homeDir, 'panel.yml'), PANEL);
    writeFileSync(join(homeDir, 'bad.yml'), PANEL.replace('name: panel', 'name: bad').replace('id: skeptic', 'id: author'));
    mkdirSync(join(projectRoot, '.git'));
    mkdirSync(join(projectRoot, '.burnex', 'pipelines'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.burnex', 'pipelines', 'design.yml'),
      `version: 1
kind: pipeline
name: design
jobs:
  plan:
    steps:
      - id: talk
        discuss: panel
        prompt: Спроектируй
        output_schema: burnex:design-doc
`,
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const { pipelines } = await projectPipelines('k', projectRoot, config, { home });
    assert.equal(pipelines[0]?.error, undefined);

    const { strategies } = readStrategies(DISCUSSION_STRATEGY, { home, projectRoot, backendNames: BACKENDS, pipelines });

    assert.deepEqual(
      strategies.map((entry) => [entry.name, entry.layer, entry.shadowed ?? false]),
      [['panel', 'project', false], ['bad', 'home', false], ['panel', 'home', true]],
    );
    assert.deepEqual(strategies[0]?.usage, [{ pipeline: 'design', file: '.burnex/pipelines/design.yml', job: 'plan', step: 'talk' }]);
    assert.deepEqual(strategies[2]?.usage, []);
    assert.equal(strategies[1]?.error?.at, 'participants.1.id');
  });
});

describe('ui-discussion-strategies: запись', () => {
  it('раунды пишутся с сохранением комментариев; зарезервированный id отклоняется у поля, файл прежний', () => {
    const { home, projectRoot, projectDir } = bed();
    const path = join(projectDir, 'panel.yml');
    writeFileSync(path, PANEL);
    const document = readStrategies(DISCUSSION_STRATEGY, { home, projectRoot, backendNames: BACKENDS }).strategies[0]!.document!;

    saveStrategy(DISCUSSION_STRATEGY, { layer: 'project', name: 'panel', document: { ...document, rounds: 3 } }, { home, projectRoot, backendNames: BACKENDS });
    const saved = readFileSync(path, 'utf8');
    assert.match(saved, /^# Панель обсуждения/);
    assert.match(saved, /agent: codex # дешевле/);
    assert.match(saved, /rounds: 3/);

    const participants = (document.participants as Record<string, unknown>[]).map((entry, index) => (index === 0 ? { ...entry, id: 'aggregator' } : entry));
    assert.throws(
      () => saveStrategy(DISCUSSION_STRATEGY, { layer: 'project', name: 'panel', document: { ...document, participants } }, { home, projectRoot, backendNames: BACKENDS }),
      (error: unknown) => error instanceof StrategyRejected && error.at === 'participants.0.id',
    );
    assert.equal(readFileSync(path, 'utf8'), saved);
    assert.throws(
      () => saveStrategy(DISCUSSION_STRATEGY, { layer: 'project', name: 'panel', document: { ...document, rounds: 9 } }, { home, projectRoot, backendNames: BACKENDS }),
      (error: unknown) => error instanceof StrategyRejected && error.at === 'rounds',
    );
  });

  it('новая стратегия создаётся в домашнем слое и удаляется', () => {
    const { home, homeDir } = bed();
    const document = { version: 1, kind: 'discussion-strategy', name: 'solo', participants: [{ id: 'one' }] };
    saveStrategy(DISCUSSION_STRATEGY, { layer: 'home', name: 'solo', document, create: true }, { home, backendNames: BACKENDS });
    assert.ok(existsSync(join(homeDir, 'solo.yml')));
    deleteStrategy(DISCUSSION_STRATEGY, 'home', 'solo', { home });
    assert.ok(!existsSync(join(homeDir, 'solo.yml')));
  });
});

async function startServer(t: TestContext, options: { runsRoot: string; home: string; projectRoot: string }): Promise<UiServer> {
  const server = await createUiServer({ ...options, port: 0 });
  t.after(() => server.close());
  return server;
}

function send(server: UiServer, method: string, path: string, body?: unknown): Promise<{ code: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = (method === 'GET' ? get : request)(
      { host: LOOPBACK, port: server.port, path, method, headers: payload === undefined ? {} : { 'content-type': 'application/json' } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ code: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> }));
      },
    );
    req.on('error', reject);
    if (method !== 'GET') req.end(payload);
  });
}

describe('ui-discussion-strategies: маршрут', () => {
  it('GET перечисляет, PUT с отказом даёт 400 и путь ключа, DELETE снимает файл', async (t) => {
    const { home, projectRoot, projectDir } = bed();
    writeFileSync(join(projectDir, 'panel.yml'), PANEL);
    const server = await startServer(t, { runsRoot: join(home, 'runs'), home, projectRoot });

    const listed = await send(server, 'GET', '/api/discussion-strategies');
    assert.equal(listed.code, 200);
    const strategies = listed.json.strategies as { name: string; document: Record<string, unknown> }[];
    assert.deepEqual(strategies.map((entry) => entry.name), ['panel']);

    const rejected = await send(server, 'PUT', '/api/discussion-strategies', {
      layer: 'project',
      name: 'panel',
      document: { ...strategies[0]!.document, rounds: 0 },
    });
    assert.equal(rejected.code, 400);
    assert.equal(rejected.json.at, 'rounds');

    assert.equal((await send(server, 'DELETE', '/api/discussion-strategies?layer=project&name=panel')).code, 200);
    assert.ok(!existsSync(join(projectDir, 'panel.yml')));
  });
});
