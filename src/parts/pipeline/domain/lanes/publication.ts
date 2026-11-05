import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createGitAnchorer } from '../anchor/git.js';
import { StepcastError } from '../../../../kernel/errors.js';
import { withBacklogLock } from '../backlog/index.js';
import type { MergeEventWriter } from './mergeEvents.js';
import { addWorktree, removeWorktree } from '../../run/worktrees.js';

/** Подготовленный перенос локального слоя поверх коммита результата. */
export interface PreparedPublication {
  readonly base: string;
  readonly target: string;
  /** Итоговый индекс после переноса staged-слоя на target. */
  readonly indexTree: string;
  /** Итоговое видимое дерево после переноса staged и unstaged слоёв. */
  readonly worktreeTree: string;
  readonly changedPaths: readonly string[];
  readonly fingerprint: string;
  /** Исходное состояние нужно для повторной проверки и аварийного возврата. */
  readonly sourceHead: string;
  readonly sourceIndexTree: string;
  readonly sourceWorktreeTree: string;
}

interface GitOptions {
  readonly indexFile?: string;
  readonly input?: string;
}

function git(dir: string, args: readonly string[], options: GitOptions = {}): string {
  return execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(options.input === undefined ? {} : { input: options.input }),
    env: {
      ...process.env,
      ...(options.indexFile === undefined ? {} : { GIT_INDEX_FILE: options.indexFile }),
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Burnex',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'stepcast@localhost',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Burnex',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'stepcast@localhost',
    },
  });
}

function oid(dir: string, expression: string): string {
  return git(dir, ['rev-parse', expression]).trim();
}

function pathsBetween(dir: string, from: string, to: string): string[] {
  if (from === to) return [];
  return git(dir, ['diff-tree', '-r', '--name-only', '--no-commit-id', '-z', from, to])
    .split('\0')
    .filter((path) => path !== '');
}

function fingerprint(state: { readonly head: string; readonly indexTree: string; readonly worktreeTree: string }): string {
  return createHash('sha256')
    .update(state.head)
    .update('\0')
    .update(state.indexTree)
    .update('\0')
    .update(state.worktreeTree)
    .digest('hex');
}

function captureCurrent(repoDir: string, stateDir: string): {
  readonly head: string;
  readonly indexTree: string;
  readonly worktreeTree: string;
  readonly fingerprint: string;
} {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const head = oid(repoDir, 'HEAD');
  const indexTree = git(repoDir, ['write-tree']).trim();
  const indexFile = join(stateDir, `capture-${randomUUID()}.index`);
  const anchorer = createGitAnchorer({ dir: repoDir, indexFile });
  try {
    const captured = anchorer.capture();
    if (captured.kind !== 'git') throw new StepcastError('Внутренняя ошибка: git-якорь вернул чужой вид состояния');
    const worktreeTree = captured.id;
    return { head, indexTree, worktreeTree, fingerprint: fingerprint({ head, indexTree, worktreeTree }) };
  } finally {
    anchorer.dispose();
  }
}

/** Заменить объявленные live-пути их версиями из базового коммита. */
function withoutPaths(
  repoDir: string,
  tree: string,
  base: string,
  exclude: readonly string[],
  stateDir: string,
): string {
  if (exclude.length === 0) return tree;
  const indexFile = join(stateDir, `exclude-${randomUUID()}.index`);
  try {
    git(repoDir, ['read-tree', tree], { indexFile });
    git(repoDir, ['reset', '-q', base, '--', ...exclude], { indexFile });
    return git(repoDir, ['write-tree'], { indexFile }).trim();
  } finally {
    rmSync(indexFile, { force: true });
  }
}

function syntheticCommit(repoDir: string, tree: string, parent: string, message: string): string {
  return git(repoDir, ['commit-tree', tree, '-p', parent, '-m', message]).trim();
}

function conflictPaths(dir: string): string[] {
  return git(dir, ['diff', '--name-only', '--diff-filter=U', '-z'])
    .split('\0')
    .filter((path) => path !== '');
}

function errorText(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return String(error);
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' ? stderr.trim() : String(error);
}

/**
 * Проверить в одноразовом worktree, что локальные staged/unstaged изменения
 * переносятся поверх результата. Исходный checkout не меняется.
 */
export function preparePublication(options: {
  readonly repoDir: string;
  readonly base: string;
  readonly target: string;
  readonly stateDir: string;
  readonly exclude: readonly string[];
}): PreparedPublication {
  const { repoDir, base, target, stateDir, exclude } = options;
  const source = captureCurrent(repoDir, stateDir);
  if (source.head !== base) {
    throw new StepcastError('Ветка сдвинулась после начала прогона', {
      file: repoDir,
      hint: `Ожидался ${base}, сейчас ${source.head}; результат сохранён в ${target}`,
    });
  }

  const stagedTree = withoutPaths(repoDir, source.indexTree, base, exclude, stateDir);
  const visibleTree = withoutPaths(repoDir, source.worktreeTree, base, exclude, stateDir);
  const stagedCommit = syntheticCommit(repoDir, stagedTree, base, 'burnex local staged overlay');
  const visibleCommit = syntheticCommit(repoDir, visibleTree, stagedCommit, 'burnex local unstaged overlay');
  const worktree = join(stateDir, `preflight-${randomUUID()}`);
  addWorktree({ repoDir, path: worktree, ref: target });

  try {
    if (stagedTree !== oid(repoDir, `${base}^{tree}`)) {
      try {
        git(worktree, ['cherry-pick', '--quiet', stagedCommit]);
      } catch (error) {
        const conflicts = conflictPaths(worktree);
        throw new StepcastError(
          `Конфликт локальных staged-изменений с результатом${conflicts.length === 0 ? '' : `: ${conflicts.join(', ')}`}`,
          { file: repoDir, cause: error },
        );
      }
    }
    const indexTree = oid(worktree, 'HEAD^{tree}');

    if (visibleTree !== stagedTree) {
      try {
        git(worktree, ['cherry-pick', '--quiet', visibleCommit]);
      } catch (error) {
        const conflicts = conflictPaths(worktree);
        throw new StepcastError(
          `Конфликт локальных unstaged-изменений с результатом${conflicts.length === 0 ? '' : `: ${conflicts.join(', ')}`}`,
          { file: repoDir, cause: error },
        );
      }
    }
    const worktreeTree = oid(worktree, 'HEAD^{tree}');
    return {
      base,
      target,
      indexTree,
      worktreeTree,
      changedPaths: pathsBetween(repoDir, source.worktreeTree, worktreeTree),
      fingerprint: source.fingerprint,
      sourceHead: source.head,
      sourceIndexTree: source.indexTree,
      sourceWorktreeTree: source.worktreeTree,
    };
  } finally {
    removeWorktree({ repoDir, path: worktree, runDir: stateDir });
  }
}

function materialize(
  repoDir: string,
  tree: string,
  paths: readonly string[],
  stateDir: string,
): void {
  if (paths.length === 0) return;
  const present = new Set(
    git(repoDir, ['ls-tree', '-r', '--name-only', '-z', tree])
      .split('\0')
      .filter((path) => path !== ''),
  );
  const indexFile = join(stateDir, `materialize-${randomUUID()}.index`);
  try {
    git(repoDir, ['read-tree', tree], { indexFile });
    for (const path of paths) {
      if (!present.has(path)) rmSync(join(repoDir, path), { recursive: true, force: true });
    }
    const restore = paths.filter((path) => present.has(path));
    if (restore.length > 0) git(repoDir, ['checkout-index', '--force', '--', ...restore], { indexFile });
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/** Опубликовать уже проверенный результат, сохранив локальные слои индекса и дерева. */
export function publishPrepared(options: {
  readonly repoDir: string;
  readonly prepared: PreparedPublication;
  readonly stateDir: string;
}): void {
  const { repoDir, prepared, stateDir } = options;
  const current = captureCurrent(repoDir, stateDir);
  if (current.fingerprint !== prepared.fingerprint) {
    throw new StepcastError('Рабочее дерево изменилось после проверки публикации', {
      file: repoDir,
      hint: `Результат сохранён в коммите ${prepared.target}; повторите публикацию после завершения параллельных правок`,
    });
  }

  const recovery = join(stateDir, 'publication-recovery.json');
  writeFileSync(recovery, `${JSON.stringify({ repoDir, ...prepared }, null, 2)}\n`, { mode: 0o600 });
  let refUpdated = false;
  try {
    git(repoDir, ['update-ref', 'HEAD', prepared.target, prepared.base]);
    refUpdated = true;
    git(repoDir, ['read-tree', prepared.indexTree]);
    materialize(repoDir, prepared.worktreeTree, prepared.changedPaths, stateDir);
    rmSync(recovery, { force: true });
  } catch (error) {
    try {
      if (refUpdated) git(repoDir, ['update-ref', 'HEAD', prepared.sourceHead, prepared.target]);
      git(repoDir, ['read-tree', prepared.sourceIndexTree]);
      const rollbackPaths = pathsBetween(repoDir, prepared.worktreeTree, prepared.sourceWorktreeTree);
      materialize(repoDir, prepared.sourceWorktreeTree, rollbackPaths, stateDir);
    } catch (rollbackError) {
      throw new StepcastError('Публикация прервалась, автоматический возврат не завершён', {
        file: recovery,
        hint: `Данные восстановления сохранены; исходная ошибка: ${errorText(error)}; ошибка возврата: ${errorText(rollbackError)}`,
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Обратить уже завершённую публикацию одного репозитория. Вызывается только
 * агрегатором составной публикации, если следующий репозиторий не смог
 * опубликоваться; CAS не позволяет стереть правку, случившуюся после неё.
 */
export function rollbackPrepared(options: {
  readonly repoDir: string;
  readonly prepared: PreparedPublication;
  readonly stateDir: string;
}): void {
  const { repoDir, prepared, stateDir } = options;
  const current = captureCurrent(repoDir, stateDir);
  const publishedFingerprint = fingerprint({
    head: prepared.target,
    indexTree: prepared.indexTree,
    worktreeTree: prepared.worktreeTree,
  });
  if (current.fingerprint !== publishedFingerprint) {
    throw new StepcastError('Опубликованное дерево изменилось до составного возврата', {
      file: repoDir,
      hint: `Ожидался коммит ${prepared.target}; данные восстановления оставлены на диске`,
    });
  }
  git(repoDir, ['update-ref', 'HEAD', prepared.sourceHead, prepared.target]);
  git(repoDir, ['read-tree', prepared.sourceIndexTree]);
  const rollbackPaths = pathsBetween(repoDir, prepared.worktreeTree, prepared.sourceWorktreeTree);
  materialize(repoDir, prepared.sourceWorktreeTree, rollbackPaths, stateDir);
}

/**
 * Рабочая копия, где выложена ветка, — `undefined`, если ни в одной не
 * выложена (тогда двигается один ref). Основная копия и worktree отвечают
 * одинаково: список общий для репозитория.
 */
export function findBranchWorktree(repoDir: string, branch: string): string | undefined {
  const listing = git(repoDir, ['worktree', 'list', '--porcelain']);
  for (const record of listing.split(/\n\n+/u)) {
    const lines = record.split('\n');
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined || !lines.includes(`branch refs/heads/${branch}`)) continue;
    // Запись об удалённом каталоге ещё не вычищена `worktree prune`: выкладывать некуда.
    if (!existsSync(path)) continue;
    return path;
  }
  return undefined;
}

/**
 * Пути копии, по которым она грязна вне `allow`: отслеживаемые и
 * неотслеживаемые изменения, игнорируемое не в счёт. `allow` — пути
 * относительно корня копии (файлы очереди).
 */
export function dirtyPaths(copy: string, allow: readonly string[]): string[] {
  const entries = git(copy, ['status', '--porcelain', '-z', '--untracked-files=all']).split('\0');
  const allowed = new Set(allow);
  const dirty = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as string;
    if (entry === '') continue;
    const paths = [entry.slice(3)];
    // Переименование и копирование несут второй путь отдельной записью.
    if (/[RC]/u.test(entry.slice(0, 2))) {
      index += 1;
      paths.push(entries[index] as string);
    }
    for (const path of paths) if (!allowed.has(path)) dirty.add(path);
  }
  return [...dirty].sort();
}

/** Время и сон ожидания; подменяются в тестах, чтобы четверть часа не ждать вживую. */
export interface WaitClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface WaitOptions {
  /** Как часто копия опрашивается. */
  readonly pollMs?: number;
  /** Как часто повторяется `merge.dirty_waiting`, пока грязь держится. */
  readonly repeatMs?: number;
  readonly clock?: WaitClock;
  readonly events?: MergeEventWriter;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_REPEAT_MS = 10 * 60_000;

const realClock: WaitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

/**
 * Дождаться, пока копия станет чистой вне `allow`. События: `dirty_waiting`
 * в начале и затем раз в `repeatMs`, `dirty_resolved` — один раз при очистке.
 * Lock очереди между опросами не держится: ожидание длится минуты, и `pick`
 * соседа упёрся бы в предел.
 */
export async function waitForCleanCopy(
  copy: string,
  allow: readonly string[],
  options: WaitOptions = {},
): Promise<void> {
  const { events } = options;
  const clock = options.clock ?? realClock;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const repeatMs = options.repeatMs ?? DEFAULT_REPEAT_MS;
  let startedAt: number | undefined;
  let nextReportAt = 0;
  for (;;) {
    const dirty = dirtyPaths(copy, allow);
    const now = clock.now();
    if (dirty.length === 0) {
      if (startedAt !== undefined) events?.emit({ kind: 'merge.dirty_resolved', waited_ms: now - startedAt });
      return;
    }
    if (startedAt === undefined) {
      startedAt = now;
      nextReportAt = now + repeatMs;
      events?.emit({ kind: 'merge.dirty_waiting', paths: dirty, waited_ms: 0 });
    } else if (now >= nextReportAt) {
      nextReportAt += repeatMs;
      events?.emit({ kind: 'merge.dirty_waiting', paths: dirty, waited_ms: now - startedAt });
    }
    await clock.sleep(pollMs);
  }
}

/** Ветка ушла из-под ожидаемого значения: публикация не состоялась, ветка и копия не тронуты. */
export interface BranchMoved {
  readonly kind: 'branch_moved';
  readonly expected: string;
  readonly actual: string;
}

export interface PublishOntoOptions extends WaitOptions {
  readonly repoDir: string;
  readonly branch: string;
  /** Вершина, которую ветка обязана иметь сейчас (CAS). */
  readonly expected: string;
  /** Коммит дорожки, потомок `expected`. */
  readonly commit: string;
  /** Копия, где выложена ветка (`findBranchWorktree`). */
  readonly copy: string | undefined;
  /** Файлы очереди относительно корня копии: их грязь допустима, их байты не перезаписываются. */
  readonly queuePaths: readonly string[];
  /** Живой файл очереди: по нему берётся lock очереди. */
  readonly queueFile: string;
  readonly stateDir: string;
  /** Запись восстановления: пишется до `update-ref`, стирается после. */
  readonly recoveryPath: string;
  readonly recovery: Readonly<Record<string, unknown>>;
  /** Отметка пункта в живой очереди — последним шагом, под тем же lock'ом. */
  readonly onPublished: () => void;
}

/**
 * Опубликовать коммит дорожки в ветку: ждать чистой копии, затем под lock'ом
 * очереди повторить проверку чистоты и сдвинуть ref с проверкой старого
 * значения. Копия получает индекс и файлы нового коммита, кроме файлов
 * очереди: их байты — незакоммиченные отметки соседних прогонов, и менять в
 * них можно только отметку своего пункта (`onPublished`).
 */
export async function publishOntoBranch(
  options: PublishOntoOptions,
): Promise<{ readonly kind: 'published' } | BranchMoved> {
  const { repoDir, branch, expected, commit, copy, queuePaths, stateDir } = options;
  const ref = `refs/heads/${branch}`;
  for (;;) {
    if (copy !== undefined) await waitForCleanCopy(copy, queuePaths, options);

    const attempt = withBacklogLock(options.queueFile, 'merge-lanes', () => {
      // Проверка до lock'а ничего не гарантирует: копию могли испачкать, пока
      // шло ожидание lock'а очереди.
      if (copy !== undefined && dirtyPaths(copy, queuePaths).length > 0) return { kind: 'dirty' as const };
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        options.recoveryPath,
        `${JSON.stringify({ ...options.recovery, branch, expected, commit, copy }, null, 2)}\n`,
        { mode: 0o600 },
      );
      try {
        git(repoDir, ['update-ref', ref, commit, expected]);
      } catch (error) {
        const actual = oid(repoDir, ref);
        if (actual === expected) throw error;
        rmSync(options.recoveryPath, { force: true });
        return { kind: 'branch_moved' as const, expected, actual };
      }
      if (copy !== undefined) {
        git(copy, ['read-tree', commit]);
        const queue = new Set(queuePaths);
        const changed = pathsBetween(repoDir, expected, commit).filter((path) => !queue.has(path));
        materialize(copy, commit, changed, stateDir);
      }
      options.onPublished();
      rmSync(options.recoveryPath, { force: true });
      return { kind: 'published' as const };
    });
    if (attempt.kind !== 'dirty') return attempt;
  }
}
