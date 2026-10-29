import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  dirtyPaths,
  findBranchWorktree,
  publishOntoBranch,
  type WaitClock,
} from '../src/parts/pipeline/domain/lanes/publication.js';
import type { MergeEventInput, MergeEventWriter } from '../src/parts/pipeline/domain/lanes/mergeEvents.js';
import { gitCommit, gitInit } from './helpers.js';
import { tempDir } from './tmp.js';

const QUEUE = ['backlog.md', 'archived.md'];

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repository(): string {
  const dir = tempDir('publication-onto-');
  gitInit(dir);
  writeFileSync(join(dir, 'backlog.md'), '# Очередь\n');
  writeFileSync(join(dir, 'archived.md'), '# Архив\n');
  writeFileSync(join(dir, 'code.txt'), 'base\n');
  writeFileSync(join(dir, '.gitignore'), 'ignored.log\n');
  gitCommit(dir, 'base');
  return dir;
}

/** Коммит-потомок текущей вершины, собранный в одноразовом дереве: копия остаётся нетронутой. */
function childCommit(repo: string, parent: string, edit: (worktree: string) => void): string {
  const worktree = tempDir('publication-onto-child-');
  git(repo, 'worktree', 'add', '--detach', '--quiet', worktree, parent);
  try {
    edit(worktree);
    gitCommit(worktree, 'child');
    return git(worktree, 'rev-parse', 'HEAD');
  } finally {
    git(repo, 'worktree', 'remove', '--force', worktree);
  }
}

function recorder(): { readonly writer: MergeEventWriter; readonly events: MergeEventInput[] } {
  const events: MergeEventInput[] = [];
  return { writer: { emit: (event) => events.push(event) }, events };
}

/** Поддельные часы: сон двигает время и даёт тесту вмешаться. */
function fakeClock(onSleep: (elapsedMs: number) => void): WaitClock {
  let now = 1_000_000;
  const start = now;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      onSleep(now - start);
    },
  };
}

function publish(
  repo: string,
  expected: string,
  commit: string,
  extra: Partial<Parameters<typeof publishOntoBranch>[0]> = {},
): ReturnType<typeof publishOntoBranch> {
  const state = tempDir('publication-onto-state-');
  return publishOntoBranch({
    repoDir: repo,
    branch: 'main',
    expected,
    commit,
    copy: findBranchWorktree(repo, 'main'),
    queuePaths: QUEUE,
    queueFile: join(repo, 'backlog.md'),
    stateDir: join(state, 'publication'),
    recoveryPath: join(state, 'publication-recovery.json'),
    recovery: { version: 2 },
    onPublished: () => undefined,
    pollMs: 1,
    ...extra,
  });
}

describe('findBranchWorktree и dirtyPaths', () => {
  it('находит копию, где выложена ветка, и не находит, если ветка нигде не выложена', () => {
    const repo = repository();
    assert.equal(findBranchWorktree(repo, 'main'), realpathSync(repo));
    git(repo, 'checkout', '--quiet', '--detach');
    assert.equal(findBranchWorktree(repo, 'main'), undefined);
  });

  it('грязь: отслеживаемое и неотслеживаемое считаются, игнорируемое и файлы очереди — нет', () => {
    const repo = repository();
    writeFileSync(join(repo, 'code.txt'), 'правка\n');
    writeFileSync(join(repo, 'new.txt'), 'новый\n');
    writeFileSync(join(repo, 'ignored.log'), 'шум\n');
    writeFileSync(join(repo, 'backlog.md'), '# Очередь\n\n## x\n');
    assert.deepEqual(dirtyPaths(repo, QUEUE), ['code.txt', 'new.txt']);
  });
});

describe('publishOntoBranch', () => {
  it('ветка не выложена ни в одну копию — двигается только ref', async () => {
    const repo = repository();
    const base = git(repo, 'rev-parse', 'HEAD');
    const commit = childCommit(repo, base, (dir) => writeFileSync(join(dir, 'code.txt'), 'новый\n'));
    git(repo, 'checkout', '--quiet', '--detach');
    const before = readFileSync(join(repo, 'code.txt'), 'utf8');

    const outcome = await publish(repo, base, commit);

    assert.equal(outcome.kind, 'published');
    assert.equal(git(repo, 'rev-parse', 'refs/heads/main'), commit);
    assert.equal(readFileSync(join(repo, 'code.txt'), 'utf8'), before);
  });

  it('чистая вне очереди копия: индекс и файлы на новом коммите, байты очереди сохранены', async () => {
    const repo = repository();
    const base = git(repo, 'rev-parse', 'HEAD');
    const commit = childCommit(repo, base, (dir) => {
      writeFileSync(join(dir, 'code.txt'), 'новый\n');
      writeFileSync(join(dir, 'added.txt'), 'добавлен\n');
      writeFileSync(join(dir, 'backlog.md'), '# Очередь\n\n## mine\n\nstatus: done\n');
    });
    const live = '# Очередь\n\n## mine\n\nstatus: done\n\n## other\n\nstatus: in_progress\n';
    writeFileSync(join(repo, 'backlog.md'), live);
    let marked = 0;

    const outcome = await publish(repo, base, commit, { onPublished: () => (marked += 1) });

    assert.equal(outcome.kind, 'published');
    assert.equal(marked, 1);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), commit);
    assert.equal(readFileSync(join(repo, 'code.txt'), 'utf8'), 'новый\n');
    assert.equal(readFileSync(join(repo, 'added.txt'), 'utf8'), 'добавлен\n');
    assert.equal(readFileSync(join(repo, 'backlog.md'), 'utf8'), live);
    assert.equal(git(repo, 'status', '--porcelain'), 'M backlog.md');
  });

  it('грязный файл вне очереди — ожидание: ref не двигается, событие называет путь, очистка даёт resolved', async () => {
    const repo = repository();
    const base = git(repo, 'rev-parse', 'HEAD');
    const commit = childCommit(repo, base, (dir) => writeFileSync(join(dir, 'other.txt'), 'x\n'));
    writeFileSync(join(repo, 'code.txt'), 'моя правка\n');
    const { writer, events } = recorder();
    let sleeps = 0;
    const clock = fakeClock(() => {
      sleeps += 1;
      assert.equal(git(repo, 'rev-parse', 'refs/heads/main'), base);
      assert.equal(readFileSync(join(repo, 'code.txt'), 'utf8'), 'моя правка\n');
      if (sleeps === 3) git(repo, 'checkout', '--', 'code.txt');
    });

    const outcome = await publish(repo, base, commit, { events: writer, clock });

    assert.equal(outcome.kind, 'published');
    assert.deepEqual(
      events.map((event) => event.kind),
      ['merge.dirty_waiting', 'merge.dirty_resolved'],
    );
    assert.deepEqual((events[0] as { paths: string[] }).paths, ['code.txt']);
    assert.equal(git(repo, 'rev-parse', 'refs/heads/main'), commit);
  });

  it('неотслеживаемый файл вне очереди тоже ждёт', async () => {
    const repo = repository();
    const base = git(repo, 'rev-parse', 'HEAD');
    const commit = childCommit(repo, base, (dir) => writeFileSync(join(dir, 'other.txt'), 'x\n'));
    writeFileSync(join(repo, 'draft.txt'), 'черновик\n');
    const { writer, events } = recorder();
    let sleeps = 0;
    const clock = fakeClock(() => {
      sleeps += 1;
      if (sleeps === 2) unlinkSync(join(repo, 'draft.txt'));
    });

    await publish(repo, base, commit, { events: writer, clock });

    assert.equal((events[0] as { paths: string[] }).paths[0], 'draft.txt');
    assert.equal(existsSync(join(repo, 'draft.txt')), false);
  });

  it('игнорируемый файл и грязная очередь ожидания не вызывают', async () => {
    const repo = repository();
    const base = git(repo, 'rev-parse', 'HEAD');
    const commit = childCommit(repo, base, (dir) => writeFileSync(join(dir, 'other.txt'), 'x\n'));
    writeFileSync(join(repo, 'ignored.log'), 'шум\n');
    writeFileSync(join(repo, 'backlog.md'), '# Очередь\n\n## x\n');
    const { writer, events } = recorder();
    const clock = fakeClock(() => assert.fail('ожидания быть не должно'));

    const outcome = await publish(repo, base, commit, { events: writer, clock });

    assert.equal(outcome.kind, 'published');
    assert.deepEqual(events, []);
  });

  it('25 минут грязи дают ровно три merge.dirty_waiting: на 0, 10 и 20 минуте', async () => {
    const repo = repository();
    const base = git(repo, 'rev-parse', 'HEAD');
    const commit = childCommit(repo, base, (dir) => writeFileSync(join(dir, 'other.txt'), 'x\n'));
    writeFileSync(join(repo, 'code.txt'), 'моя правка\n');
    const { writer, events } = recorder();
    let cleaned = false;
    const clock = fakeClock((elapsed) => {
      if (!cleaned && elapsed >= 25 * 60_000) {
        cleaned = true;
        git(repo, 'checkout', '--', 'code.txt');
      }
    });

    await publish(repo, base, commit, { events: writer, clock, pollMs: 60_000, repeatMs: 10 * 60_000 });

    const waiting = events.filter((event) => event.kind === 'merge.dirty_waiting');
    assert.deepEqual(
      waiting.map((event) => (event as { waited_ms: number }).waited_ms),
      [0, 10 * 60_000, 20 * 60_000],
    );
    assert.equal(events.filter((event) => event.kind === 'merge.dirty_resolved').length, 1);
  });

  it('несовпадение старого значения ref — отказ с обеими вершинами, ветка и копия не тронуты', async () => {
    const repo = repository();
    const base = git(repo, 'rev-parse', 'HEAD');
    const mine = childCommit(repo, base, (dir) => writeFileSync(join(dir, 'code.txt'), 'моё\n'));
    // Ветку сдвинули мимо lock'а.
    writeFileSync(join(repo, 'code.txt'), 'чужое\n');
    gitCommit(repo, 'чужой коммит');
    const foreign = git(repo, 'rev-parse', 'HEAD');
    let marked = false;

    const outcome = await publish(repo, base, mine, { onPublished: () => (marked = true) });

    assert.deepEqual(outcome, { kind: 'branch_moved', expected: base, actual: foreign });
    assert.equal(git(repo, 'rev-parse', 'refs/heads/main'), foreign);
    assert.equal(readFileSync(join(repo, 'code.txt'), 'utf8'), 'чужое\n');
    assert.equal(marked, false);
  });
});
