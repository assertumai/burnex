import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import plugin, { AGENT_MODES, createAntigravityAdapter, MAX_ARG_BYTES } from '../src/parts/backends/antigravity/index.js';
import type { BackendConfig } from '../src/parts/pipeline/surface.js';
import type { AgentInvocation, BackendEvent } from '../src/parts/pipeline/backend/types.js';
import { BurnexError } from '../src/kernel/errors.js';

/**
 * Адаптер проверяется на фикстурах `test/fixtures/antigravity/`, составленных
 * по документации CLI: живого `agy` в среде не было (README фикстур).
 */
const FIXTURES = fileURLToPath(new URL('../../test/fixtures/antigravity/', import.meta.url));

function fixture(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((line) => line.trim() !== '');
}

const CONFIG: BackendConfig = {
  command: 'agy',
  enabled: true,
  defaultModel: undefined,
  concurrency: 2,
  cacheReadWeight: 0.1,
  sessions: true,
  structuredOutput: true,
  strictPermissions: false,
  mcp: false,
  permissions: undefined,
  env: {},
};

function invocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return { prompt: 'сделай', cwd: '/tmp/work', resumeSession: false, ...overrides };
}

describe('antigravity-backend: плагин и возможности', () => {
  it('умолчания вклада', () => {
    assert.deepEqual(plugin.backends?.antigravity?.defaults, {
      command: 'agy',
      sessions: true,
      structured_output: true,
      strict_permissions: false,
      mcp: false,
      concurrency: 2,
    });
  });

  // Сценарий: «Защитник при имплементаторе на Antigravity» — форка нет.
  it('возможности по документации, форка нет', () => {
    assert.deepEqual(createAntigravityAdapter(CONFIG).capabilities, {
      sessions: true,
      sessionIdSource: 'backend',
      structuredOutput: true,
      schemaFromText: true,
      strictPermissions: false,
      mcp: false,
      effort: true,
      reportsCost: false,
    });
    assert.equal(createAntigravityAdapter({ ...CONFIG, structuredOutput: false }).capabilities.structuredOutput, false);
  });
});

describe('antigravity-backend: сборка запуска', () => {
  const adapter = createAntigravityAdapter(CONFIG);

  // Сценарий: «Ревьюер со схемой»
  it('модель, effort, схема; пропуск подтверждений без режима; промпт последним', () => {
    const launch = adapter.launch(
      invocation({ model: 'gemini-3.1-pro-high', effort: 'high', outputSchemaPath: '/s/findings.json' }),
    );
    assert.deepEqual(launch.command, [
      'agy', '--output-format', 'stream-json', '--model', 'gemini-3.1-pro-high', '--effort', 'high',
      '--json-schema', '/s/findings.json', '--dangerously-skip-permissions', '--prompt=сделай',
    ]);
    assert.equal(launch.stdin, '');
  });

  it('схема не передаётся при выключенном structured_output', () => {
    const launch = createAntigravityAdapter({ ...CONFIG, structuredOutput: false }).launch(
      invocation({ outputSchemaPath: '/s/x.json' }),
    );
    assert.ok(!launch.command.includes('--json-schema'));
  });

  // Сценарий: «Продолжение»
  it('продолжение — --conversation, без сессий — нет', () => {
    const resume = adapter.launch(invocation({ sessionId: 'c-1', resumeSession: true }));
    assert.equal(resume.command[resume.command.indexOf('--conversation') + 1], 'c-1');
    const off = createAntigravityAdapter({ ...CONFIG, sessions: false }).launch(
      invocation({ sessionId: 'c-1', resumeSession: true }),
    );
    assert.ok(!off.command.includes('--conversation'));
  });

  it('permissions.mode — --mode без пропуска подтверждений; прочее отклоняется', () => {
    for (const mode of AGENT_MODES) {
      const launch = adapter.launch(invocation({ permissions: { mode } }));
      assert.equal(launch.command[launch.command.indexOf('--mode') + 1], mode);
      assert.ok(!launch.command.includes('--dangerously-skip-permissions'));
    }
    assert.throws(() => adapter.launch(invocation({ permissions: { mode: 'bypass' } })), /не знает режима доступа bypass/);
    assert.throws(() => adapter.launch(invocation({ permissions: { allow: ['Read'] } })), /не применяет permissions\.allow/);
    assert.throws(() => adapter.launch(invocation({ permissions: { enforce: 'strict' } })), /enforce: strict/);
  });

  it('промпт с «-» в начале остаётся значением; слишком длинный — отказ', () => {
    assert.equal(adapter.launch(invocation({ prompt: '--help' })).command.at(-1), '--prompt=--help');
    assert.throws(
      () => adapter.launch(invocation({ prompt: 'я'.repeat(MAX_ARG_BYTES) })),
      (error: unknown) => error instanceof BurnexError && /antigravity/.test(error.message),
    );
  });
});

describe('antigravity-backend: разбор потока', () => {
  const adapter = createAntigravityAdapter(CONFIG);
  const events = (lines: readonly string[]): BackendEvent[] => lines.map((line) => adapter.parseLine(line));

  // Сценарий: «Успешный итог со схемой»
  it('new.jsonl: init с сессией, один завершённый инструмент, итог со структурой и расходом', () => {
    const list = events(fixture('new.jsonl'));
    const init = list.find((event) => event.kind === 'init');
    assert.equal(init?.kind === 'init' ? init.sessionId : undefined, 'c-5f1a');
    const tools = list.filter((event) => event.kind === 'tool_use');
    assert.deepEqual(tools, [{ kind: 'tool_use', name: 'read_file', input: { path: 'README.md' } }]);
    const result = list.find((event) => event.kind === 'result');
    assert.deepEqual(result, {
      kind: 'result',
      text: '{"summary":"ок","findings":[]}',
      structured: { summary: 'ок', findings: [] },
      usage: { tokens_in: 1000, tokens_out: 120, cache_read: 200 },
    });
    assert.equal(list.filter((event) => event.kind === 'usage').length, 0, 'пошаговый расход не учитывается');
  });

  it('error.jsonl: итог failed без отказа; незнакомые записи и мусор', () => {
    const [result] = events(fixture('error.jsonl'));
    assert.equal(result?.kind, 'result');
    assert.equal(result?.kind === 'result' ? result.failed : undefined, true);
    assert.equal(result?.kind === 'result' ? result.refusal : 'x', undefined);
    assert.deepEqual(adapter.parseLine('{"event":"future"}'), { kind: 'ignored' });
    assert.deepEqual(adapter.parseLine('не json'), { kind: 'unparsed', line: 'не json' });
  });

  // Сценарий: «Отказ аутентификации»
  it('отказы аутентификации и лимита классифицируются', () => {
    const line = (error: string) => JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '', error } });
    const auth = adapter.parseLine(line('authentication required'));
    assert.equal(auth.kind === 'result' ? auth.refusal?.class : undefined, 'unauthenticated');
    const limit = adapter.parseLine(line('Weekly quota exhausted'));
    assert.equal(limit.kind === 'result' ? limit.refusal?.class : undefined, 'rate_limit');
  });
});
