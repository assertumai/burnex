import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  envName,
  isEngineVariable,
  legacyEnvName,
  readEngineEnv,
  resetEngineEnvWarnings,
  withLegacyNames,
} from '../src/kernel/env-names.js';

/** Перехват stderr на время вызова: предупреждение о прежнем имени печатается туда. */
function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

describe('kernel/env-names: имена переменных движка', () => {
  afterEach(() => resetEngineEnvWarnings());

  it('новое имя — BURNEX_*, прежнее — STEPCAST_*', () => {
    assert.equal(envName('JOB_DIR'), 'BURNEX_JOB_DIR');
    assert.equal(legacyEnvName('JOB_DIR'), 'STEPCAST_JOB_DIR');
  });

  it('движку принадлежат оба префикса', () => {
    assert.equal(isEngineVariable('BURNEX_RUN_ID'), true);
    assert.equal(isEngineVariable('STEPCAST_RUN_ID'), true);
    assert.equal(isEngineVariable('NEEDS_BUILD_SHA'), false);
    assert.equal(isEngineVariable('GH_TOKEN'), false);
  });

  it('withLegacyNames даёт каждой BURNEX_* двойника STEPCAST_* с тем же значением, чужие имена не трогает', () => {
    assert.deepEqual(withLegacyNames({ BURNEX_JOB: 'build', NEEDS_X_Y: '1' }), {
      BURNEX_JOB: 'build',
      STEPCAST_JOB: 'build',
      NEEDS_X_Y: '1',
    });
  });

  it('readEngineEnv предпочитает новое имя', () => {
    const out = captureStderr(() => {
      assert.equal(readEngineEnv({ BURNEX_HOME: '/new', STEPCAST_HOME: '/old' }, 'HOME'), '/new');
    });
    assert.equal(out, '');
  });

  it('пустое значение считается отсутствующим — как ${X:-…} в оболочке', () => {
    assert.equal(readEngineEnv({ BURNEX_HOME: '', STEPCAST_HOME: '' }, 'HOME', { warn: false }), undefined);
    assert.equal(readEngineEnv({ BURNEX_HOME: '', STEPCAST_HOME: '/old' }, 'HOME', { warn: false }), '/old');
  });

  it('прежнее имя читается с предупреждением в stderr — одним на процесс для каждой переменной', () => {
    const out = captureStderr(() => {
      assert.equal(readEngineEnv({ STEPCAST_HOME: '/old' }, 'HOME'), '/old');
      assert.equal(readEngineEnv({ STEPCAST_HOME: '/old' }, 'HOME'), '/old');
      assert.equal(readEngineEnv({ STEPCAST_BIN_DIR: '/bin' }, 'BIN_DIR'), '/bin');
    });
    const lines = out.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', /^burnex: переменная STEPCAST_HOME переименована в BURNEX_HOME/);
    assert.match(lines[1] ?? '', /STEPCAST_BIN_DIR .* BURNEX_BIN_DIR/);
  });

  it('warn: false читает прежнее имя молча — для переменных, которые движок сам выставил шагу', () => {
    const out = captureStderr(() => {
      assert.equal(readEngineEnv({ STEPCAST_JOB_DIR: '/j' }, 'JOB_DIR', { warn: false }), '/j');
    });
    assert.equal(out, '');
  });
});
