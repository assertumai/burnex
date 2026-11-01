import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUNDLED_BACKENDS, bundledByBackend } from '../src/parts/backends/bundled.js';

describe('каталог поставляемых бэкендов', () => {
  it('совпадает с подпутями ./backends/* из exports пакета', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    const exported = Object.keys(pkg.exports)
      .filter((key) => key.startsWith('./backends/'))
      .map((key) => `stepcast/${key.slice(2)}`)
      .sort();
    assert.deepEqual(BUNDLED_BACKENDS.map((entry) => entry.specifier).sort(), exported);
  });

  it('не содержит встроенного claude и держит порядок карточек', () => {
    const names = BUNDLED_BACKENDS.flatMap((entry) => Object.keys(entry.plugin.backends ?? {}));
    assert.deepEqual(names, ['codex', 'cursor-agent', 'copilot']);
    assert.equal(bundledByBackend('claude'), undefined);
    assert.equal(bundledByBackend('cursor-agent')?.specifier, 'stepcast/backends/cursor');
  });
});
