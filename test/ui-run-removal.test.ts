import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { removeRunOffLoop, removeRunsOffLoop } from '../src/parts/ui/screens/runs/removal.js';
import { tempDir } from './tmp.js';

/** Сколько раз цикл событий успел провернуться, пока шло ожидание. */
async function ticksDuring<T>(work: Promise<T>): Promise<{ result: T; ticks: number }> {
  let ticks = 0;
  let running = true;
  const spin = (): void => {
    ticks += 1;
    if (running) setImmediate(spin);
  };
  setImmediate(spin);
  try {
    return { result: await work, ticks };
  } finally {
    running = false;
  }
}

describe('ui: снятие прогонов вне цикла событий', () => {
  // Синхронное снятие в обработчике запроса останавливало витрину целиком:
  // цикл событий не проворачивался бы ни разу до самого итога.
  it('групповое снятие не занимает цикл событий демона', async () => {
    const runsRoot = tempDir('removal-');

    const { result, ticks } = await ticksDuring(
      removeRunsOffLoop(runsRoot, [{ key: 'aaaaaaaaaaaa', runId: 'missing' }], 'keep'),
    );

    assert.deepEqual(result, {
      outcomes: [{ address: 'aaaaaaaaaaaa/missing', outcome: 'skipped_missing' }],
      freedBytes: 0,
    });
    assert.ok(ticks > 0, 'цикл событий должен проворачиваться, пока идёт снятие');
  });

  it('снятия идут по одному и возвращают каждое свой итог', async () => {
    const runsRoot = tempDir('removal-');

    const [many, one] = await Promise.all([
      removeRunsOffLoop(runsRoot, [{ key: 'aaaaaaaaaaaa', runId: 'x' }], 'keep'),
      removeRunOffLoop(runsRoot, 'aaaaaaaaaaaa', 'y', 'keep'),
    ]);

    assert.equal(many.outcomes[0]?.outcome, 'skipped_missing');
    assert.equal(one.alive, false);
  });
});
