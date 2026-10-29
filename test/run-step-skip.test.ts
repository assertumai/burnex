import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { executeRunStep } from '../src/parts/pipeline/run/exec/runStep.js';
import type { Attempts, RunStep } from '../src/parts/pipeline/document/model.js';
import type { PredicateResult } from '../src/parts/pipeline/run/journal/schema.js';
import { tempDir } from './tmp.js';

/**
 * Код пропуска шага (`skip_exit_code`) на уровне исполнителя: проверяется до
 * `evaluate`, терминален и не тратит повторы.
 */

const ONE: Attempts = { max: 1, escalation: [] };

function makeStep(overrides: Partial<RunStep> = {}): RunStep {
  return {
    kind: 'run',
    id: 'c',
    index: 1,
    env: {},
    context: [],
    contextInherit: true,
    contextExclude: [],
    timeoutMs: 5_000,
    expect: [],
    attempts: ONE,
    command: 'exit 78',
    ...overrides,
  } as RunStep;
}

/** Шпион вместо `evaluate`: считает вызовы и отдаёт успех. */
function spy(): { calls: number; evaluate: () => PredicateResult[] } {
  const state = {
    calls: 0,
    evaluate: (): PredicateResult[] => {
      state.calls += 1;
      return [{ predicate: 'exit_code', passed: true, hard: true }];
    },
  };
  return state;
}

const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? '' });

describe('step-execution: код пропуска', () => {
  it('выход кодом пропуска — skipped, evaluate не вызывается', async () => {
    const dir = tempDir('skip-');
    const s = spy();
    const reported: PredicateResult[] = [];
    const result = await executeRunStep({
      step: makeStep({ skipExitCode: 78 }),
      cwd: dir,
      stepDir: dir,
      env,
      evaluate: s.evaluate,
      onExpectFailed: (_plan, item) => reported.push(item),
    });

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'шаг объявил пропуск: код 78');
    assert.equal(s.calls, 0);
    assert.deepEqual(reported, [], 'expect.failed не пишется');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]?.status, 'skipped');
    assert.equal(result.attempts[0]?.exit_code, 78);
    assert.deepEqual(result.results, [
      [{ predicate: 'skip_exit_code', passed: true, hard: true, expected: 78, actual: 78 }],
    ]);
  });

  it('attempts.max: 3 даёт одну попытку', async () => {
    const dir = tempDir('skip-');
    const result = await executeRunStep({
      step: makeStep({ skipExitCode: 78, attempts: { max: 3, escalation: [] } }),
      cwd: dir,
      stepDir: dir,
      env,
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.attempts.length, 1);
  });

  it('неудача, затем пропуск — две записи и skipped', async () => {
    const dir = tempDir('skip-');
    // Первая попытка падает кодом 1, вторая выходит кодом пропуска.
    const result = await executeRunStep({
      step: makeStep({
        skipExitCode: 78,
        attempts: { max: 3, escalation: [] },
        command: ['sh', '-c', 'if [ "$STEPCAST_ATTEMPT" = 1 ]; then exit 1; else exit 78; fi'],
      }),
      cwd: dir,
      stepDir: dir,
      env: (plan) => ({ ...env(), STEPCAST_ATTEMPT: String(plan.attempt) }),
    });
    assert.equal(result.status, 'skipped');
    assert.deepEqual(
      result.attempts.map((a) => a.status),
      ['failed', 'skipped'],
    );
  });

  it('другой ненулевой код оценивается как прежде', async () => {
    const dir = tempDir('skip-');
    const s = spy();
    const result = await executeRunStep({
      step: makeStep({ skipExitCode: 78, command: 'exit 1' }),
      cwd: dir,
      stepDir: dir,
      env,
      evaluate: s.evaluate,
    });
    assert.equal(s.calls, 1);
    assert.equal(result.status, 'success', 'итог даёт evaluate, а не пропуск');
  });

  it('без объявленного кода выход 78 — failed', async () => {
    const dir = tempDir('skip-');
    const result = await executeRunStep({ step: makeStep(), cwd: dir, stepDir: dir, env });
    assert.equal(result.status, 'failed');
    assert.equal(result.attempts[0]?.status, 'failed');
  });

  it('таймаут — не пропуск', async () => {
    const dir = tempDir('skip-');
    const result = await executeRunStep({
      step: makeStep({ skipExitCode: 78, command: ['sleep', '5'], timeoutMs: 120 }),
      cwd: dir,
      stepDir: dir,
      env,
      graceMs: 150,
    });
    assert.equal(result.status, 'failed');
  });
});
