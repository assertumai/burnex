import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { mergeLockPath, withMergeLockAsync } from '../src/parts/pipeline/domain/lanes/mergeLock.js';
import { gitCommit, gitInit } from './helpers.js';
import { tempDir } from './tmp.js';

const FAST = { intervalMs: 5 } as const;

function gitRepo(): string {
  const dir = tempDir('merge-lock-');
  gitInit(dir);
  writeFileSync(join(dir, 'backlog.md'), '# Очередь\n');
  gitCommit(dir, 'начальный');
  return dir;
}

function writeLock(path: string, owner: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(owner)}\n`);
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

describe('mergeLockPath', () => {
  it('основная копия и worktree делят один lock в общем каталоге git', () => {
    const main = gitRepo();
    const tree = join(tempDir('merge-lock-tree-'), 'wt');
    spawnSync('git', ['-C', main, 'worktree', 'add', '--detach', '--quiet', tree], { stdio: 'pipe' });

    assert.equal(mergeLockPath(tree), mergeLockPath(main));
    assert.equal(mergeLockPath(main), join(realpathSync(main), '.git', 'stepcast-merge.lock'));
  });
});

describe('withMergeLockAsync', () => {
  it('второй захват ждёт, пока первый не отпустит, и сообщает владельца один раз', async () => {
    const repo = gitRepo();
    const path = mergeLockPath(repo);
    const order: string[] = [];
    const busy: unknown[] = [];

    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const first = withMergeLockAsync(repo, 'первый', async () => {
      order.push('первый взял');
      await gate;
      order.push('первый отпускает');
    }, FAST);
    // Первый обязан успеть создать файл раньше второго.
    while (!existsSync(path)) await new Promise((done) => setTimeout(done, 1));

    const second = withMergeLockAsync(repo, 'второй', () => {
      order.push('второй взял');
    }, { ...FAST, onBusy: (owner) => busy.push(owner) });

    await new Promise((done) => setTimeout(done, 60));
    assert.deepEqual(order, ['первый взял']);
    assert.equal(busy.length, 1);
    assert.equal((busy[0] as { command: string }).command, 'первый');

    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['первый взял', 'первый отпускает', 'второй взял']);
    assert.equal(existsSync(path), false);
  });

  it('пишет владельца из четырёх полей', async () => {
    const repo = gitRepo();
    const path = mergeLockPath(repo);
    await withMergeLockAsync(repo, 'merge-lanes --onto main', () => {
      const owner = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(Object.keys(owner).sort(), ['acquired_at', 'command', 'host', 'pid']);
      assert.equal(owner['pid'], process.pid);
    });
  });

  it('брошенный lock своей машины снимается без ожидания и без onBusy', async () => {
    const repo = gitRepo();
    const path = mergeLockPath(repo);
    writeLock(path, { pid: deadPid(), host: hostname(), command: 'умерший', acquired_at: new Date().toISOString() });
    let busy = 0;
    let ran = false;

    await withMergeLockAsync(repo, 'живой', () => {
      ran = true;
    }, { ...FAST, onBusy: () => (busy += 1) });

    assert.equal(ran, true);
    assert.equal(busy, 0);
    assert.equal(existsSync(path), false);
  });

  it('lock чужой машины не снимается', async () => {
    const repo = gitRepo();
    const path = mergeLockPath(repo);
    writeLock(path, { pid: deadPid(), host: `${hostname()}-чужая`, command: 'чужой', acquired_at: new Date().toISOString() });
    let ran = false;

    const waiting = withMergeLockAsync(repo, 'живой', () => {
      ran = true;
    }, FAST);
    await new Promise((done) => setTimeout(done, 80));

    assert.equal(ran, false);
    assert.equal(existsSync(path), true);
    // Освобождаем руками, чтобы ожидание завершилось.
    unlinkSync(path);
    await waiting;
    assert.equal(ran, true);
  });

  it('исключение в fn отпускает lock', async () => {
    const repo = gitRepo();
    await assert.rejects(
      withMergeLockAsync(repo, 'падает', () => {
        throw new Error('отказ');
      }),
      /отказ/u,
    );
    assert.equal(existsSync(mergeLockPath(repo)), false);
  });
});
