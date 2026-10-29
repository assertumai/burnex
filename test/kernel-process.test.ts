import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { isProcessAlive } from '../src/kernel/process.js';

describe('isProcessAlive', () => {
  it('живой процесс — true', () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it('pid завершившегося процесса — false', () => {
    // Дочерний процесс завершён и собран `spawnSync`, поэтому его pid свободен.
    const child = spawnSync(process.execPath, ['-e', '']);
    assert.ok(child.pid !== undefined);
    assert.equal(isProcessAlive(child.pid), false);
  });

  it('since раньше загрузки системы — false даже для живого pid', () => {
    assert.equal(isProcessAlive(process.pid, 0), false);
  });

  it('since после загрузки или нечисловой не мешает живому pid', () => {
    assert.equal(isProcessAlive(process.pid, Date.now()), true);
    assert.equal(isProcessAlive(process.pid, Number.NaN), true);
  });
});
