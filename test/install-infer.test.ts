import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  inferInstallMethod,
  isInsideDir,
  resolveInstallMethod,
  type InferProbes,
} from '../src/parts/install/infer.js';
import { StepcastError } from '../src/kernel/errors.js';

function probes(overrides: Partial<InferProbes> = {}): InferProbes {
  return {
    isGitTree: () => false,
    readPackageName: () => undefined,
    releasesDir: '/home/u/.stepcast/releases',
    ...overrides,
  };
}

describe('install-infer: вывод способа без паспорта', () => {
  it('сегмент node_modules — npm с именем из package.json', () => {
    const result = inferInstallMethod(
      '/usr/lib/node_modules/stepcast',
      probes({ readPackageName: () => '@acme/stepcast' }),
    );
    assert.deepEqual(result, { method: 'npm', package: '@acme/stepcast' });
  });

  it('git-дерево — checkout с этим корнем', () => {
    const result = inferInstallMethod('/work/stepcast', probes({ isGitTree: () => true }));
    assert.deepEqual(result, { method: 'checkout', dir: '/work/stepcast' });
  });

  it('каталог релизов — отказ с подсказкой install.sh, даже внутри git-дерева', () => {
    assert.throws(
      () => inferInstallMethod('/home/u/.stepcast/releases/0.3.0', probes({ isGitTree: () => true })),
      (error: unknown) => error instanceof StepcastError && /install\.sh/.test(error.hint ?? ''),
    );
  });

  it('прочее — тот же отказ', () => {
    assert.throws(() => inferInstallMethod('/opt/somewhere', probes()), /паспорта установки нет/);
  });
});

describe('install-infer: паспорт предпочтительнее вывода', () => {
  const root = '/work/stepcast';

  it('при наличии паспорта источник — manifest', () => {
    const result = resolveInstallMethod('{"method":"npm","package":"stepcast"}', root, probes({ isGitTree: () => true }));
    assert.equal(result.source, 'manifest');
    assert.equal(result.manifest.method, 'npm');
  });

  it('без паспорта источник — inferred', () => {
    const result = resolveInstallMethod(undefined, root, probes({ isGitTree: () => true }));
    assert.equal(result.source, 'inferred');
    assert.equal(result.manifest.method, 'checkout');
  });

  it('битый паспорт не заменяется выводом молча', () => {
    assert.throws(() => resolveInstallMethod('{', root, probes({ isGitTree: () => true })), StepcastError);
  });
});

describe('install-infer: isInsideDir', () => {
  it('различает вложенный путь, сам каталог и соседа с общим префиксом', () => {
    assert.equal(isInsideDir('/a/releases', '/a/releases/0.3.0'), true);
    assert.equal(isInsideDir('/a/releases', '/a/releases'), false);
    assert.equal(isInsideDir('/a/releases', '/a/releases-old/0.3.0'), false);
  });
});
