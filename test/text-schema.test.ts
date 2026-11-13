import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeBackend, resultLine } from '../src/parts/pipeline/backend/fake.js';
import { extractLastJson, structuredFromText } from '../src/parts/pipeline/backend/textSchema.js';
import { structuredOutputMode } from '../src/parts/pipeline/backend/types.js';
import type { AgentStep } from '../src/parts/pipeline/document/model.js';
import { createSessionRegistry, executeAgentStep } from '../src/parts/pipeline/run/exec/agentStep.js';
import { tempDir } from './tmp.js';

/**
 * Схема, которую держит движок по итоговому тексту (`backend-structured-output`,
 * спека `agent-backend`, «Схема по итоговому тексту держится движком»).
 */

describe('textSchema: извлечение последнего JSON', () => {
  it('последний огороженный блок главнее объектов в тексте', () => {
    const text = 'Было {"a":1}.\n```json\n{"b":2}\n```\nи ещё\n```\n{"c":3}\n```';
    assert.deepEqual(extractLastJson(text), { value: { c: 3 } });
  });

  it('блок, который не разбирается, пропускается в пользу предыдущего', () => {
    const text = '```json\n{"ok":true}\n```\n```ts\nconst x = {};\n```';
    assert.deepEqual(extractLastJson(text), { value: { ok: true } });
  });

  it('без блоков — последний внешний объект, в том числе склеенный со словом и со скобками в строках', () => {
    assert.deepEqual(extractLastJson('ГотовоDone{"x":{"y":"}{"}}'), { value: { x: { y: '}{' } } });
    assert.deepEqual(extractLastJson('сначала {"a":1} потом [1, {"b":2}]'), { value: [1, { b: 2 }] });
  });

  it('ничего похожего на JSON — undefined', () => {
    assert.equal(extractLastJson('просто текст {не json}'), undefined);
    assert.equal(extractLastJson(''), undefined);
  });
});

describe('textSchema: режим структурированного вывода', () => {
  const base = { sessions: true, strictPermissions: false, mcp: false, sessionIdSource: 'engine' as const };
  it('нативная схема главнее текста, без обеих — пусто', () => {
    assert.equal(structuredOutputMode({ ...base, structuredOutput: true, schemaFromText: true }), 'native');
    assert.equal(structuredOutputMode({ ...base, structuredOutput: false, schemaFromText: true }), 'text');
    assert.equal(structuredOutputMode({ ...base, structuredOutput: false }), undefined);
  });
});

function schemaFile(): string {
  const path = join(tempDir('text-schema-'), 'schema.json');
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

describe('textSchema: исполнение агентского шага', () => {
  it('проверка схемой: валидный и невалидный ответ', () => {
    const schema = schemaFile();
    assert.deepEqual(structuredFromText(schema, '```json\n{"verdict":"ok"}\n```').structured, { verdict: 'ok' });
    const invalid = structuredFromText(schema, '```json\n{"other":1}\n```');
    assert.equal(invalid.structured, undefined);
    assert.equal(invalid.result.passed, false);
    assert.match(invalid.result.detail ?? '', /verdict/);
    assert.match(structuredFromText(schema, 'нет json').result.detail ?? '', /не содержит JSON/);
  });

  // Сценарии: «Ответ JSON-блоком», «Ответ не прошёл схему»
  it('текстовый режим: схема в промпте, адаптеру не уходит, невалидный ответ даёт повтор с ошибкой схемы', async () => {
    const schema = schemaFile();
    const dir = tempDir('text-schema-step-');
    const backend = createFakeBackend({
      lines: (index) => [resultLine({ text: index === 0 ? 'думаю... {"other": 1}' : 'Итог:\n```json\n{"verdict":"ok"}\n```' })],
      capabilities: { structuredOutput: false, schemaFromText: true },
    });

    const result = await executeAgentStep({
      step: agentStep({ outputSchemaPath: schema, attempts: { max: 2, escalation: [{ includeFailure: true }] } }),
      adapter: backend.adapter,
      cwd: dir,
      stepDir: dir,
      sessions: createSessionRegistry(),
      buildPrompt: (_plan, failure) => (failure === undefined ? 'промпт' : `промпт\n\nПрошлая ошибка: ${failure}`),
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });

    assert.equal(result.status, 'success');
    assert.equal(backend.invocations.length, 2);
    for (const invocation of backend.invocations) {
      assert.equal(invocation.outputSchemaPath, undefined, 'схема адаптеру не уходит');
      assert.match(invocation.prompt, /## Формат итогового ответа[\s\S]*"required"/);
    }
    assert.match(backend.invocations[1]?.prompt ?? '', /Прошлая ошибка:[\s\S]*verdict/);
    assert.deepEqual(result.last?.structured, { verdict: 'ok' });
    assert.match(readFileSync(join(dir, 'prompt.2.txt'), 'utf8'), /Формат итогового ответа/);
  });

  // Сценарий: «Нативная схема главнее»
  it('нативный режим: схема уходит адаптеру, промпт без раздела схемы', async () => {
    const schema = schemaFile();
    const dir = tempDir('text-schema-native-');
    const backend = createFakeBackend({
      lines: [resultLine({ structured: { verdict: 'ok' } })],
      capabilities: { structuredOutput: true, schemaFromText: true },
    });

    const result = await executeAgentStep({
      step: agentStep({ outputSchemaPath: schema }),
      adapter: backend.adapter,
      cwd: dir,
      stepDir: dir,
      sessions: createSessionRegistry(),
      buildPrompt: () => 'промпт',
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });

    assert.equal(result.status, 'success');
    assert.equal(backend.invocations[0]?.outputSchemaPath, schema);
    assert.doesNotMatch(backend.invocations[0]?.prompt ?? '', /Формат итогового ответа/);
  });
});
