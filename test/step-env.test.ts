import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildStepEnv, type EnvLayers } from '../src/parts/pipeline/run/exec/env.js';
import { tempDir } from './tmp.js';

/** Слои без секретов — тест добавляет только то, что проверяет. */
function layers(extra: Partial<EnvLayers>): EnvLayers {
  return { base: {}, envFiles: [], pipeline: {}, job: {}, step: {}, injected: {}, deny: [], cwd: '/tmp', ...extra };
}

/** Вызов под подменённой платформой: правило регистра читается в момент сборки окружения. */
function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return run();
  } finally {
    if (original !== undefined) Object.defineProperty(process, 'platform', original);
  }
}

describe('buildStepEnv: секреты', () => {
  it('секрет доходит мимо env_deny и не попадает в denied', () => {
    const { env, denied, withheld } = buildStepEnv(
      layers({ deny: ['*_TOKEN'], secrets: { GITHUB_TOKEN: 'значение-секрета' } }),
    );
    assert.equal(env.GITHUB_TOKEN, 'значение-секрета');
    assert.deepEqual(denied, []);
    assert.deepEqual(withheld, []);
  });

  it('секрет накладывается поверх env всех уровней и окружения процесса', () => {
    const { env } = buildStepEnv(
      layers({
        base: { API_KEY: 'из-процесса' },
        pipeline: { API_KEY: 'пайплайн' },
        step: { API_KEY: 'шаг' },
        secrets: { API_KEY: 'секрет-побеждает' },
      }),
    );
    assert.equal(env.API_KEY, 'секрет-побеждает');
  });

  it('переменная необъявленного секрета из env_files вычёркивается и попадает в withheld', () => {
    const dir = tempDir('step-env-');
    writeFileSync(join(dir, '.env'), 'GH_TOKEN=из-файла-12345\nKEEP=1\n');
    const { env, denied, withheld } = buildStepEnv(
      layers({ envFiles: ['.env'], cwd: dir, withheld: { GH_TOKEN: 'gh-token' } }),
    );
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.KEEP, '1');
    assert.deepEqual(withheld, [{ name: 'GH_TOKEN', secret: 'gh-token' }]);
    assert.deepEqual(denied, []);
  });

  it('переменная из окружения процесса вычёркивается тем же способом', () => {
    const { env, withheld } = buildStepEnv(
      layers({ base: { GH_TOKEN: 'из-процесса', PATH: '/bin' }, withheld: { GH_TOKEN: 'gh-token' } }),
    );
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.PATH, '/bin');
    assert.deepEqual(withheld, [{ name: 'GH_TOKEN', secret: 'gh-token' }]);
  });

  it('если переменной в окружении не было, withheld пуст', () => {
    const { env, withheld } = buildStepEnv(layers({ withheld: { GH_TOKEN: 'gh-token' } }));
    assert.equal('GH_TOKEN' in env, false);
    assert.deepEqual(withheld, []);
  });

  it('переменная, уже вычеркнутая env_deny, в withheld не попадает: о ней сообщает env.denied', () => {
    const { denied, withheld } = buildStepEnv(
      layers({ base: { GH_TOKEN: 'из-процесса' }, deny: ['*_TOKEN'], withheld: { GH_TOKEN: 'gh-token' } }),
    );
    assert.deepEqual(denied.map((item) => item.name), ['GH_TOKEN']);
    assert.deepEqual(withheld, []);
  });

  it('названный и необъявленный секреты в одном окружении: первый доходит, второй вычеркнут', () => {
    const { env, withheld } = buildStepEnv(
      layers({
        base: { NPM_TOKEN: 'чужой' },
        secrets: { GH_TOKEN: 'значение-секрета' },
        withheld: { NPM_TOKEN: 'npm-token' },
      }),
    );
    assert.equal(env.GH_TOKEN, 'значение-секрета');
    assert.equal(env.NPM_TOKEN, undefined);
    assert.deepEqual(withheld, [{ name: 'NPM_TOKEN', secret: 'npm-token' }]);
  });

  it('на Windows переменная секрета вычёркивается без учёта регистра, как и env_deny', () => {
    const { env, withheld } = onPlatform('win32', () =>
      buildStepEnv(layers({ base: { Gh_Token: 'из-процесса' }, withheld: { GH_TOKEN: 'gh-token' } })),
    );
    assert.equal(env.Gh_Token, undefined);
    assert.deepEqual(withheld, [{ name: 'Gh_Token', secret: 'gh-token' }]);
  });

  it('вне Windows регистр различается: Gh_Token — другая переменная', () => {
    const { env, withheld } = onPlatform('linux', () =>
      buildStepEnv(layers({ base: { Gh_Token: 'из-процесса' }, withheld: { GH_TOKEN: 'gh-token' } })),
    );
    assert.equal(env.Gh_Token, 'из-процесса');
    assert.deepEqual(withheld, []);
  });

  it('без секретов результат прежний', () => {
    const built = buildStepEnv(layers({ base: { PATH: '/bin' }, deny: ['*_KEY'] }));
    assert.deepEqual(built.env, { PATH: '/bin' });
    assert.deepEqual(built.withheld, []);
  });
});
