import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ExitCode, BurnexError } from '../src/kernel/errors.js';
import {
  backlogLockPath,
  BacklogLockTimeoutError,
  withBacklogLock,
  withBacklogLockAsync,
} from '../src/parts/pipeline/domain/backlog/index.js';
import { gitCommit, gitInit } from './helpers.js';
import { tempDir } from './tmp.js';

const FAST = { intervalMs: 5, timeoutMs: 300 } as const;
const MODULE_URL = new URL('../src/parts/pipeline/domain/backlog/index.js', import.meta.url).href;

function gitRepo(): string {
  const dir = tempDir('backlog-lock-');
  gitInit(dir);
  writeFileSync(join(dir, 'backlog.md'), '# Очередь\n');
  gitCommit(dir, 'начальный');
  return dir;
}

function writeLock(path: string, owner: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(owner)}\n`);
}

/** pid завершившегося процесса: дочерний собран, номер свободен. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

function ownerOf(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('backlogLockPath', () => {
  it('основная копия и worktree делят один lock в общем каталоге git', () => {
    const main = gitRepo();
    const tree = join(tempDir('backlog-lock-tree-'), 'wt');
    spawnSync('git', ['-C', main, 'worktree', 'add', '--detach', '--quiet', tree], { stdio: 'pipe' });
    writeFileSync(join(tree, 'backlog.md'), '# Очередь\n');

    const fromMain = backlogLockPath(join(main, 'backlog.md'));
    const fromTree = backlogLockPath(join(tree, 'backlog.md'));

    assert.equal(fromMain, fromTree);
    assert.equal(fromMain, join(realpathSync(main), '.git', 'burnex-backlog.lock'));
  });

  it('archived.md того же каталога делит lock с backlog.md', () => {
    const main = gitRepo();
    assert.equal(backlogLockPath(join(main, 'archived.md')), backlogLockPath(join(main, 'backlog.md')));
  });

  it('вне git lock лежит рядом с файлом очереди', () => {
    const dir = tempDir('backlog-lock-');
    assert.equal(backlogLockPath(join(dir, 'backlog.md')), join(dir, '.backlog.lock'));
  });

  it('каталога файла может ещё не быть — путь всё равно отдаётся', () => {
    const dir = join(tempDir('backlog-lock-'), 'нет', 'такого');
    assert.equal(backlogLockPath(join(dir, 'backlog.md')), join(dir, '.backlog.lock'));
  });
});

describe('withBacklogLock: захват и освобождение', () => {
  it('пока fn работает, в lock-файле владелец из четырёх полей; после — файла нет', () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');
    const path = backlogLockPath(file);

    withBacklogLock(file, 'backlog pick', () => {
      const owner = ownerOf(path);
      assert.deepEqual(Object.keys(owner).sort(), ['acquired_at', 'command', 'host', 'pid']);
      assert.equal(owner['pid'], process.pid);
      assert.equal(owner['host'], hostname());
      assert.equal(owner['command'], 'backlog pick');
      assert.ok(!Number.isNaN(Date.parse(String(owner['acquired_at']))));
    });

    assert.equal(existsSync(path), false);
  });

  it('бросок из fn lock освобождает', () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');

    assert.throws(
      () =>
        withBacklogLock(file, 'test', () => {
          throw new Error('отказ');
        }),
      /отказ/u,
    );

    assert.equal(existsSync(backlogLockPath(file)), false);
  });

  it('вложенный вызов того же файла выполняется сразу и не трогает диск', () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');
    const path = backlogLockPath(file);

    withBacklogLock(file, 'outer', () => {
      const before = readFileSync(path, 'utf8');
      withBacklogLock(file, 'inner', () => {
        assert.equal(readFileSync(path, 'utf8'), before);
      });
      assert.equal(existsSync(path), true, 'внутренний выход lock не снимает');
    });

    assert.equal(existsSync(path), false);
  });

  it('чужой lock, подменённый во время работы, освобождение не удаляет', () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');
    const path = backlogLockPath(file);
    const foreign = { pid: process.pid, host: hostname(), command: 'другой', acquired_at: '2001-01-01T00:00:00.000Z' };

    withBacklogLock(file, 'test', () => {
      writeLock(path, foreign);
    });

    assert.deepEqual(ownerOf(path), foreign);
  });
});

describe('withBacklogLock: ожидание и предел', () => {
  it('lock, который держит живой процесс и отпускает, берётся после освобождения', async () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');
    const path = backlogLockPath(file);
    // Держатель — этот же процесс (pid жив), снимает файл по таймеру.
    writeLock(path, { pid: process.pid, host: hostname(), command: 'holder', acquired_at: new Date().toISOString() });
    setTimeout(() => unlinkSync(path), 50);

    const got = await withBacklogLockAsync(file, 'waiter', () => 'ok', { intervalMs: 5, timeoutMs: 2000 });

    assert.equal(got, 'ok');
    assert.equal(existsSync(path), false);
  });

  it('по пределу — BurnexError с кодом 2, владелец в сообщении, очередь не тронута', async () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');
    writeFileSync(file, '# Очередь\n');
    const path = backlogLockPath(file);
    const acquiredAt = new Date().toISOString();
    writeLock(path, { pid: process.pid, host: hostname(), command: 'backlog pick', acquired_at: acquiredAt });
    let ran = false;

    await assert.rejects(
      withBacklogLockAsync(file, 'backlog finish', () => {
        ran = true;
      }, FAST),
      (error: unknown) => {
        assert.ok(error instanceof BacklogLockTimeoutError);
        assert.ok(error instanceof BurnexError);
        assert.equal(error.exitCode, ExitCode.configError);
        for (const part of [path, 'backlog pick', String(process.pid), hostname(), acquiredAt]) {
          assert.ok(error.message.includes(part), `в сообщении нет «${part}»: ${error.message}`);
        }
        assert.ok(error.hint !== undefined);
        return true;
      },
    );

    assert.equal(ran, false);
    assert.equal(readFileSync(file, 'utf8'), '# Очередь\n');
    assert.equal(existsSync(path), true, 'чужой lock остаётся');
  });
});

describe('withBacklogLock: брошенный lock', () => {
  it('lock своего host с pid завершившегося процесса снимается сразу', () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');
    const path = backlogLockPath(file);
    writeLock(path, { pid: deadPid(), host: hostname(), command: 'умер', acquired_at: new Date().toISOString() });
    const started = Date.now();

    const got = withBacklogLock(file, 'test', () => 'ok', { intervalMs: 50, timeoutMs: 5000 });

    assert.equal(got, 'ok');
    assert.ok(Date.now() - started < 2000, 'снятие не должно ждать предела');
    assert.equal(existsSync(path), false);
  });

  it('lock другого host не снимается, итог — отказ с кодом 2', () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');
    const path = backlogLockPath(file);
    const foreign = { pid: deadPid(), host: 'other-host', command: 'чужой', acquired_at: '2001-01-01T00:00:00.000Z' };
    writeLock(path, foreign);

    assert.throws(
      () => withBacklogLock(file, 'test', () => undefined, FAST),
      (error: unknown) => error instanceof BurnexError && error.exitCode === ExitCode.configError,
    );

    assert.deepEqual(ownerOf(path), foreign);
  });

  it('нечитаемый lock не снимается', () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');
    const path = backlogLockPath(file);
    writeFileSync(path, '{не json');

    assert.throws(() => withBacklogLock(file, 'test', () => undefined, FAST), BurnexError);
    assert.equal(readFileSync(path, 'utf8'), '{не json');

    writeFileSync(path, '');
    assert.throws(() => withBacklogLock(file, 'test', () => undefined, FAST), BurnexError);
    assert.equal(existsSync(path), true);
  });

  it('несвежий .break снимается', () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');
    const path = backlogLockPath(file);
    writeLock(path, { pid: deadPid(), host: hostname(), command: 'умер', acquired_at: new Date().toISOString() });
    writeFileSync(`${path}.break`, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.break`, old, old);

    const got = withBacklogLock(file, 'test', () => 'ok', { intervalMs: 5, timeoutMs: 3000 });

    assert.equal(got, 'ok');
    assert.equal(existsSync(`${path}.break`), false);
  });

  it('свежий чужой .break — обычное ожидание: сон, предел, цикл событий отзывается', async () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');
    const path = backlogLockPath(file);
    writeLock(path, { pid: deadPid(), host: hostname(), command: 'умер', acquired_at: new Date().toISOString() });
    // Владелец .break будто убит посреди снятия: файл свежий, устареет лишь через 10 с.
    writeFileSync(`${path}.break`, '');
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 20);
    const started = Date.now();

    await assert.rejects(
      withBacklogLockAsync(file, 'waiter', () => undefined, FAST),
      (error: unknown) => error instanceof BacklogLockTimeoutError,
    );

    assert.ok(Date.now() - started < 3000, 'отказ по пределу, а не по устареванию .break');
    assert.equal(ticked, true);
    assert.equal(existsSync(`${path}.break`), true, 'свежий .break не снимается');
  });

  it('двое ожидающих над одним брошенным lock\'ом оба выполняют правку', async () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');
    const path = backlogLockPath(file);
    writeFileSync(file, '');
    writeLock(path, { pid: deadPid(), host: hostname(), command: 'умер', acquired_at: new Date().toISOString() });
    const script = join(tempDir('backlog-lock-script-'), 'writer.mjs');
    // Правка — «прочитать → подождать → записать»: без исключения одна из двух
    // пропала бы. Пока правка идёт, lock обязан оставаться своим: снятый
    // соседом свежий lock — код 3, даже если обе правки по случайности уцелели.
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync } from 'node:fs';
import { withBacklogLock } from ${JSON.stringify(MODULE_URL)};
const [file, lock, tag] = process.argv.slice(2);
withBacklogLock(file, 'writer ' + tag, () => {
  const before = readFileSync(file, 'utf8');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  let owner;
  try { owner = JSON.parse(readFileSync(lock, 'utf8')); } catch { process.exit(3); }
  if (owner.pid !== process.pid) process.exit(3);
  writeFileSync(file, before + tag + '\\n');
}, { intervalMs: 5, timeoutMs: 8000 });
`,
    );
    // Скрипт ссылается на собранный модуль: тесты исполняются из dist/test.
    const children = ['a', 'b'].map(
      (tag) =>
        new Promise<number | null>((done) => {
          const child = spawn(process.execPath, [script, file, path, tag], { stdio: 'inherit' });
          child.on('exit', done);
        }),
    );

    assert.deepEqual(await Promise.all(children), [0, 0]);
    assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').sort(), ['a', 'b']);
    assert.equal(existsSync(path), false);
  });
});

describe('withBacklogLockAsync', () => {
  it('два параллельных вызова исключают друг друга', async () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');
    const order: string[] = [];
    const run = (tag: string): Promise<void> =>
      withBacklogLockAsync(
        file,
        tag,
        async () => {
          order.push(`${tag}:start`);
          await new Promise((done) => setTimeout(done, 40));
          order.push(`${tag}:end`);
        },
        { intervalMs: 5, timeoutMs: 3000 },
      );

    await Promise.all([run('a'), run('b')]);

    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('пока ждёт, цикл событий отзывается', async () => {
    const dir = tempDir('backlog-lock-');
    const file = join(dir, 'backlog.md');
    const path = backlogLockPath(file);
    writeLock(path, { pid: process.pid, host: hostname(), command: 'holder', acquired_at: new Date().toISOString() });
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 20);

    await assert.rejects(withBacklogLockAsync(file, 'waiter', () => undefined, FAST), BurnexError);

    assert.equal(ticked, true);
  });
});
