import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createClaudeAdapter, USER_CONNECTORS_ENV } from '../src/parts/backends/claude/adapter.js';
import { createFakeBackend, resultLine } from '../src/parts/pipeline/backend/fake.js';
import { callSchemaMode, type BackendCapabilities } from '../src/parts/pipeline/backend/types.js';
import { resolveConfig, type BackendConfig, type Config } from '../src/parts/pipeline/config/resolve.js';
import type { AgentStep } from '../src/parts/pipeline/document/model.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { createSessionRegistry, executeAgentStep } from '../src/parts/pipeline/run/exec/agentStep.js';
import { runPipeline } from '../src/parts/pipeline/run/runner.js';
import { makeProject } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Начало запроса не меняется в цепочке сессий (`session-cache-stable-prefix`,
 * спека `agent-backend`): схема в тексте для вызовов в сессии и явная опция
 * `user_mcp`.
 */

const BACKEND: BackendConfig = {
  command: 'claude',
  enabled: true,
  defaultModel: 'sonnet',
  concurrency: 2,
  cacheReadWeight: 0.1,
  sessions: true,
  structuredOutput: true,
  strictPermissions: true,
  mcp: true,
  permissions: undefined,
  env: {},
};

const base: BackendCapabilities = {
  sessions: true,
  structuredOutput: true,
  strictPermissions: false,
  mcp: false,
  sessionIdSource: 'engine',
};

describe('callSchemaMode', () => {
  it('текст только при нативной схеме в начале запроса, текстовом пути и сессиях', () => {
    assert.equal(callSchemaMode({ ...base, schemaFromText: true, schemaInPrefix: true }), 'text');
    assert.equal(callSchemaMode({ ...base, schemaFromText: true, schemaInPrefix: true, sessions: false }), 'native');
    assert.equal(callSchemaMode({ ...base, schemaFromText: true }), 'native');
    assert.equal(callSchemaMode({ ...base, schemaInPrefix: true }), 'native');
    assert.equal(callSchemaMode({ ...base, structuredOutput: false, schemaFromText: true }), 'text');
    assert.equal(callSchemaMode({ ...base, structuredOutput: false }), undefined);
  });

  it('Claude объявляет текстовый путь, схему в начале запроса и изоляцию', () => {
    const { capabilities } = createClaudeAdapter(BACKEND);
    assert.equal(capabilities.schemaFromText, true);
    assert.equal(capabilities.schemaInPrefix, true);
    assert.equal(capabilities.isolateUserMcp, true);
    assert.equal(callSchemaMode(capabilities), 'text');
    assert.equal(callSchemaMode(createClaudeAdapter({ ...BACKEND, sessions: false }).capabilities), 'native');
  });
});

function schemaFile(): string {
  const path = join(tempDir('cache-prefix-'), 'schema.json');
  writeFileSync(path, JSON.stringify({ type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' } } }));
  return path;
}

function agentStep(overrides: Partial<AgentStep>): AgentStep {
  return {
    kind: 'agent',
    id: 'ask',
    index: 1,
    env: {},
    context: [],
    contextInherit: true,
    contextExclude: [],
    timeoutMs: 5_000,
    expect: [],
    attempts: { max: 1, escalation: [] },
    agent: 'fake',
    session: 'default',
    prompt: 'сделай',
    ...overrides,
  } as AgentStep;
}

async function runStep(capabilities: Partial<BackendCapabilities>, line: string) {
  const schema = schemaFile();
  const dir = tempDir('cache-prefix-step-');
  const backend = createFakeBackend({ lines: [line], capabilities });
  const result = await executeAgentStep({
    step: agentStep({ outputSchemaPath: schema }),
    adapter: backend.adapter,
    cwd: dir,
    stepDir: dir,
    sessions: createSessionRegistry(),
    buildPrompt: () => 'промпт',
    env: () => ({ PATH: process.env.PATH ?? '' }),
  });
  return { schema, result, invocation: backend.invocations[0] };
}

describe('агентский вызов в сессии', () => {
  // Сценарий: «Шаг со схемой на бэкенде с сессиями»
  it('схема уходит текстом, адаптеру не передаётся, структура из текста', async () => {
    const { result, invocation } = await runStep(
      { structuredOutput: true, schemaFromText: true, schemaInPrefix: true },
      resultLine({ text: 'Итог:\n```json\n{"verdict":"ok"}\n```' }),
    );
    assert.equal(result.status, 'success');
    assert.equal(invocation?.outputSchemaPath, undefined);
    assert.match(invocation?.prompt ?? '', /## Формат итогового ответа/);
    assert.deepEqual(result.last?.structured, { verdict: 'ok' });
  });

  // Сценарий: «Бэкенд без сессий»
  it('без сессий схема остаётся нативной', async () => {
    const { schema, result, invocation } = await runStep(
      { sessions: false, structuredOutput: true, schemaFromText: true, schemaInPrefix: true },
      resultLine({ structured: { verdict: 'ok' } }),
    );
    assert.equal(result.status, 'success');
    assert.equal(invocation?.outputSchemaPath, schema);
    assert.doesNotMatch(invocation?.prompt ?? '', /Формат итогового ответа/);
  });

  // Сценарий: «Адаптер без schemaInPrefix»
  it('адаптер без флага передаёт схему, как прежде', async () => {
    const { schema, invocation } = await runStep(
      { structuredOutput: true, schemaFromText: true },
      resultLine({ structured: { verdict: 'ok' } }),
    );
    assert.equal(invocation?.outputSchemaPath, schema);
  });
});

describe('user_mcp', () => {
  // Сценарий: «По умолчанию окружение пользователя не трогается»
  it('по умолчанию Claude не отсекает MCP и коннекторы пользователя', () => {
    const launch = createClaudeAdapter(BACKEND).launch({ prompt: 'p', cwd: '/tmp', resumeSession: false });
    assert.equal(launch.command.includes('--strict-mcp-config'), false);
    assert.equal(launch.env?.[USER_CONNECTORS_ENV], undefined);
  });

  // Сценарий: «Изоляция Claude»
  it('user_mcp: false — strict-mcp-config, коннекторы выключены, серверы шага остаются', () => {
    const launch = createClaudeAdapter({ ...BACKEND, userMcp: false }).launch({
      prompt: 'p',
      cwd: '/tmp',
      resumeSession: false,
      mcpServers: { assertum: { command: ['node', 'a.js'] } },
    } as Parameters<ReturnType<typeof createClaudeAdapter>['launch']>[0]);
    assert.equal(launch.command.filter((part) => part === '--strict-mcp-config').length, 1);
    assert.equal(launch.command.includes('--mcp-config'), true);
    assert.equal(launch.env?.[USER_CONNECTORS_ENV], 'false');
  });

  // Сценарий: «Явное значение переменной сильнее»
  it('явный env бэкенда сильнее', () => {
    const launch = createClaudeAdapter({ ...BACKEND, userMcp: false, env: { [USER_CONNECTORS_ENV]: 'true' } }).launch({
      prompt: 'p',
      cwd: '/tmp',
      resumeSession: false,
    });
    assert.equal(launch.env?.[USER_CONNECTORS_ENV], 'true');
  });

  it('конфигурация: ключ разбирается, умолчание — окружение не трогается', () => {
    const root = tempDir('cache-prefix-config-');
    const home = join(root, 'home');
    mkdirSync(join(home, '.burnex'), { recursive: true });
    writeFileSync(join(home, '.burnex', 'config.yml'), 'backends:\n  claude:\n    user_mcp: false\n');
    const resolved = resolveConfig({
      cwd: root,
      home,
      globalPath: join(home, '.burnex', 'config.yml'),
      projectPath: join(root, '.burnex', 'config.yml'),
    }).config;
    assert.equal(resolved.backends.claude?.userMcp, false);
    assert.notEqual(makeProject().config.backends.claude?.userMcp, false);
  });

  // Сценарий: «Адаптер не умеет изоляцию»
  it('прогон отказывает до старта, если адаптер изоляцию не умеет', async () => {
    const project = makeProject({
      'burnex.yml': `
kind: pipeline
name: p
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
`,
    });
    const agent = project.config.defaults.agent;
    const backends = project.config.backends;
    const config: Config = {
      ...project.config,
      backends: { ...backends, [agent]: { ...backends[agent]!, userMcp: false } },
      runs: { ...project.config.runs, root: tempDir('runs-') },
    };
    const run = (isolateUserMcp: boolean) =>
      runPipeline({
        expanded: expandPipeline({ pipelinePath: project.path('burnex.yml'), config }),
        config,
        projectRoot: project.root,
        cwd: project.root,
        adapterFor: () =>
          createFakeBackend({ capabilities: { isolateUserMcp }, lines: [resultLine({ text: 'готово' })] }).adapter,
      });

    await assert.rejects(run(false), (error: Error) => /user_mcp: false/.test(error.message) && error.message.includes(agent));
    await run(true);
  });
});
