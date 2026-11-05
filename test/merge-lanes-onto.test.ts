import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run as runCli, type CliIo } from '../src/parts/cli/main.js';
import { ExitCode, BurnexError, type ExitCodeValue } from '../src/kernel/errors.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { mergeLanes, type LaneMergeResult } from '../src/parts/pipeline/domain/lanes/merge.js';
import { mergeLockPath, mergeRecoveryPath } from '../src/parts/pipeline/domain/lanes/mergeLock.js';
import { readLaneMerge } from '../src/parts/pipeline/domain/lanes/mergeRecord.js';
import { runPipeline, type RunResult } from '../src/parts/pipeline/run/runner.js';
import { gitCommit, gitInit, makeProject, withHome, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * `merge-lanes --onto` на настоящих прогонах: временный репозиторий с веткой
 * `main`, два прогона от одной базы, настоящий `applyRun` и файл очереди.
 * Прогон B заводится вторым пайплайном `stepcast-b.yml`, закоммиченным в той же
 * базе: переписать `burnex.yml` после старта значило бы испачкать копию.
 */

function pipeline(lane: string, command: string): string {
  return `
version: 1
kind: pipeline
name: прогон-${lane}
workspace: { mode: worktree }
jobs:
  work-${lane}:
    lane: ${lane}
    steps: [{ id: шаг, run: [sh, -c, '${command}'], expect: [{ exit_code: 0 }] }]
`;
}

function twoLanes(aCommand: string, bCommand: string): string {
  return `
version: 1
kind: pipeline
name: две-дорожки
workspace: { mode: worktree }
concurrency: 2
fail_fast: false
jobs:
  work-a:
    lane: a
    steps: [{ id: шаг, run: [sh, -c, '${aCommand}'], expect: [{ exit_code: 0 }] }]
  work-b:
    lane: b
    steps: [{ id: шаг, run: [sh, -c, '${bCommand}'], expect: [{ exit_code: 0 }] }]
`;
}

function item(slug: string, status = 'in_progress', extra = ''): string {
  return `## ${slug}\n\nstatus: ${status}\n${extra}title: Улучшение ${slug}\nwhy: з\ndone_when: к\n`;
}

const BACKLOG = `# Очередь\n\n${item('a-item')}\n${item('b-item')}`;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function statusOf(text: string, slug: string): string | undefined {
  const section = text.split(`## ${slug}\n`)[1]?.split('\n## ')[0] ?? '';
  return /^status:\s*(.*)$/m.exec(section)?.[1];
}

function repository(files: Readonly<Record<string, string>>): Project {
  const project = makeProject({ 'backlog.md': BACKLOG, 'shared.txt': 'base\n', 'code.txt': 'base\n', ...files });
  gitInit(project.root);
  gitCommit(project.root, 'начальный');
  return project;
}

async function startRun(project: Project, file = 'burnex.yml'): Promise<RunResult> {
  const runsRoot = tempDir('onto-runs-');
  writeFileSync(join(project.home, '.burnex', 'config.yml'), `runs:\n  root: ${runsRoot}\n`);
  const expanded = expandPipeline({ pipelinePath: project.path(file), config: project.config });
  return runPipeline({
    expanded,
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
}

function takeItem(result: RunResult, lane: string, slug: string): void {
  writeFileSync(join(result.journal.paths.dir, `item-${lane}.json`), JSON.stringify({ slug, title: slug }));
}

interface OntoRun {
  readonly lines: string[];
  readonly results: Promise<readonly LaneMergeResult[]>;
}

function mergeOnto(
  project: Project,
  result: RunResult,
  lanes: readonly string[],
  { withoutOnto = false, ...extra }: Partial<Parameters<typeof mergeLanes>[0]> & { withoutOnto?: boolean } = {},
): OntoRun {
  const lines: string[] = [];
  const results = mergeLanes({
    paths: result.journal.paths,
    cwd: project.root,
    lanes,
    check: 'exit 0',
    file: project.path('backlog.md'),
    ...(withoutOnto ? {} : { onto: 'main' }),
    write: (line) => lines.push(line),
    tuning: { lockIntervalMs: 10, wait: { pollMs: 5 } },
    ...extra,
  });
  return { lines, results };
}

function kinds(results: readonly LaneMergeResult[]): string[] {
  return results.map((entry) => entry.kind);
}

function main(project: Project): string {
  return git(project.root, 'rev-parse', 'refs/heads/main');
}

const SUCCESS_A = 'printf "от a\\n" > a.txt';
const SUCCESS_B = 'printf "от b\\n" > b.txt';

describe('mergeLanes --onto: сведение на текущую вершину ветки', () => {
  it('прогоны A и B от одной базы сводятся друг за другом: коммит B — потомок коммита A, копия чиста', async () => {
    const project = repository({
      'burnex.yml': pipeline('a', SUCCESS_A),
      'stepcast-b.yml': pipeline('b', SUCCESS_B),
    });
    const base = main(project);
    const runA = await startRun(project);
    const runB = await startRun(project, 'stepcast-b.yml');
    takeItem(runA, 'a', 'a-item');
    takeItem(runB, 'b', 'b-item');

    const first = await mergeOnto(project, runA, ['a']).results;
    const commitA = main(project);
    const second = await mergeOnto(project, runB, ['b']).results;

    assert.deepEqual(kinds(first), ['merged']);
    assert.deepEqual(kinds(second), ['merged']);
    assert.notEqual(commitA, base);
    assert.equal(git(project.root, 'rev-parse', 'main~1'), commitA);
    assert.equal(git(project.root, 'rev-parse', 'main~2'), base);
    const committed = git(project.root, 'show', 'main:backlog.md');
    assert.equal(statusOf(committed, 'a-item'), 'done');
    assert.equal(statusOf(committed, 'b-item'), 'done');
    const live = readFileSync(project.path('backlog.md'), 'utf8');
    assert.equal(statusOf(live, 'a-item'), 'done');
    assert.equal(statusOf(live, 'b-item'), 'done');
    assert.equal(existsSync(project.path('a.txt')) && existsSync(project.path('b.txt')), true);
    assert.equal(git(project.root, 'status', '--porcelain'), '');
    assert.equal(existsSync(mergeLockPath(project.root)), false);
  });

  it('две дорожки одного прогона: второй коммит лежит на первом', async () => {
    const project = repository({ 'burnex.yml': twoLanes(SUCCESS_A, SUCCESS_B) });
    const base = main(project);
    const run = await startRun(project);
    takeItem(run, 'a', 'a-item');
    takeItem(run, 'b', 'b-item');

    const results = await mergeOnto(project, run, ['a', 'b']).results;

    assert.deepEqual(kinds(results), ['merged', 'merged']);
    assert.equal(git(project.root, 'rev-parse', 'main~2'), base);
    assert.equal(git(project.root, 'log', '-1', '--format=%s', 'main~1').startsWith('a-item'), true);
    assert.equal(git(project.root, 'log', '-1', '--format=%s', 'main').startsWith('b-item'), true);
  });

  it('пересекающиеся диффы: B получает conflict, ветка остаётся на A; без --keep-claim пункт failed', async () => {
    const project = repository({
      'burnex.yml': pipeline('a', 'printf "A\\n" > shared.txt'),
      'stepcast-b.yml': pipeline('b', 'printf "B\\n" > shared.txt'),
    });
    const runA = await startRun(project);
    const runB = await startRun(project, 'stepcast-b.yml');
    takeItem(runA, 'a', 'a-item');
    takeItem(runB, 'b', 'b-item');

    await mergeOnto(project, runA, ['a']).results;
    const commitA = main(project);
    const results = await mergeOnto(project, runB, ['b']).results;

    assert.deepEqual(kinds(results), ['conflict']);
    assert.equal(main(project), commitA);
    assert.equal(readFileSync(project.path('shared.txt'), 'utf8'), 'A\n');
    assert.equal(statusOf(readFileSync(project.path('backlog.md'), 'utf8'), 'b-item'), 'failed');
  });

  it('с --keep-claim пункт несведённой дорожки остаётся in_progress, причина — в merge-<дорожка>.json', async () => {
    const project = repository({
      'burnex.yml': pipeline('a', 'printf "A\\n" > shared.txt'),
      'stepcast-b.yml': pipeline('b', 'printf "B\\n" > shared.txt'),
    });
    const runA = await startRun(project);
    const runB = await startRun(project, 'stepcast-b.yml');
    takeItem(runA, 'a', 'a-item');
    takeItem(runB, 'b', 'b-item');
    await mergeOnto(project, runA, ['a']).results;

    const results = await mergeOnto(project, runB, ['b'], { keepClaim: true }).results;

    assert.deepEqual(kinds(results), ['conflict']);
    assert.equal(statusOf(readFileSync(project.path('backlog.md'), 'utf8'), 'b-item'), 'in_progress');
    const record = readLaneMerge(runB.journal.paths.dir, 'b');
    assert.equal(record?.kind, 'conflict');
    assert.ok((record?.reason ?? '') !== '');
  });

  it('ветку сдвинули между чтением вершины и публикацией: publication_conflict, повтор с --keep-claim сводит', async () => {
    const project = repository({ 'burnex.yml': pipeline('a', SUCCESS_A) });
    const run = await startRun(project);
    takeItem(run, 'a', 'a-item');
    const base = main(project);

    // Проверка идёт после чтения вершины и до публикации — чужой коммит ложится ровно между ними.
    const first = await mergeOnto(project, run, ['a'], {
      keepClaim: true,
      check: `git -C "${project.root}" commit --allow-empty -q -m чужой`,
    }).results;

    const foreign = main(project);
    assert.deepEqual(kinds(first), ['publication_conflict']);
    const reason = (first[0] as { reason: string }).reason;
    assert.ok(reason.includes(base) && reason.includes(foreign), reason);
    assert.equal(git(project.root, 'log', '-1', '--format=%s'), 'чужой');
    assert.equal(statusOf(readFileSync(project.path('backlog.md'), 'utf8'), 'a-item'), 'in_progress');
    assert.equal(existsSync(mergeRecoveryPath(project.root)), false);

    const second = await mergeOnto(project, run, ['a'], { keepClaim: true }).results;

    assert.deepEqual(kinds(second), ['merged']);
    assert.equal(git(project.root, 'rev-parse', 'main~1'), foreign);
    assert.equal(statusOf(readFileSync(project.path('backlog.md'), 'utf8'), 'a-item'), 'done');
  });

  it('publication_conflict без --keep-claim: пункт failed с причиной', async () => {
    const project = repository({ 'burnex.yml': pipeline('a', SUCCESS_A) });
    const run = await startRun(project);
    takeItem(run, 'a', 'a-item');

    const results = await mergeOnto(project, run, ['a'], {
      check: `git -C "${project.root}" commit --allow-empty -q -m чужой`,
    }).results;

    assert.deepEqual(kinds(results), ['publication_conflict']);
    assert.equal(git(project.root, 'log', '-1', '--format=%s'), 'чужой');
    const live = readFileSync(project.path('backlog.md'), 'utf8');
    assert.equal(statusOf(live, 'a-item'), 'failed');
    assert.match(live, /сдвинулась/u);
  });

  it('дорожка, правящая файлы очереди, не сводится; соседняя дорожка обхода сводится', async () => {
    const project = repository({
      'burnex.yml': twoLanes(`printf "\\n## new-item\\n\\nstatus: todo\\n" >> backlog.md`, SUCCESS_B),
    });
    const base = main(project);
    const run = await startRun(project);
    takeItem(run, 'a', 'a-item');
    takeItem(run, 'b', 'b-item');

    const results = await mergeOnto(project, run, ['a', 'b']).results;

    assert.deepEqual(kinds(results), ['conflict', 'merged']);
    assert.match((results[0] as { reason: string }).reason, /файлы очереди \(backlog\.md\)/u);
    assert.equal(git(project.root, 'rev-parse', 'main~1'), base);
    assert.equal(git(project.root, 'show', 'main:backlog.md').includes('new-item'), false);
    const live = readFileSync(project.path('backlog.md'), 'utf8');
    assert.equal(statusOf(live, 'a-item'), 'failed');
    assert.equal(statusOf(live, 'b-item'), 'done');
  });

  it('правка archived.md дорожкой тоже отклоняется: копия не расходится с веткой', async () => {
    const project = repository({ 'burnex.yml': pipeline('a', 'printf "# Архив\\n" > archived.md') });
    const base = main(project);
    const run = await startRun(project);
    takeItem(run, 'a', 'a-item');

    const results = await mergeOnto(project, run, ['a'], { keepClaim: true }).results;

    assert.deepEqual(kinds(results), ['conflict']);
    assert.match((results[0] as { reason: string }).reason, /archived\.md/u);
    assert.equal(main(project), base);
    assert.equal(existsSync(project.path('archived.md')), false);
    assert.equal(statusOf(readFileSync(project.path('backlog.md'), 'utf8'), 'a-item'), 'in_progress');
  });

  it('чужой незакоммиченный in_progress не попадает в коммит и остаётся в живом файле', async () => {
    const backlog = `# Очередь\n\n${item('a-item', 'todo')}\n${item('b-item', 'todo')}`;
    const project = repository({ 'burnex.yml': pipeline('a', SUCCESS_A), 'backlog.md': backlog });
    const run = await startRun(project);
    takeItem(run, 'a', 'a-item');
    const live = `# Очередь\n\n${item('a-item')}\n${item('b-item', 'in_progress', 'claimed_by: run-b\n')}`;
    writeFileSync(project.path('backlog.md'), live);

    const results = await mergeOnto(project, run, ['a']).results;

    assert.deepEqual(kinds(results), ['merged']);
    const committed = git(project.root, 'show', 'main:backlog.md');
    assert.equal(statusOf(committed, 'a-item'), 'done');
    assert.equal(statusOf(committed, 'b-item'), 'todo');
    assert.ok(!committed.includes('claimed_by'));
    const after = readFileSync(project.path('backlog.md'), 'utf8');
    assert.equal(statusOf(after, 'a-item'), 'done');
    assert.equal(statusOf(after, 'b-item'), 'in_progress');
    assert.ok(after.includes('claimed_by: run-b'));
    assert.equal(git(project.root, 'status', '--porcelain'), 'M backlog.md');
  });
});

describe('mergeLanes --onto: грязная копия ветки', () => {
  it('грязный файл вне очереди: ожидание с событиями, очистка без коммита — публикация', async () => {
    const project = repository({ 'burnex.yml': pipeline('a', SUCCESS_A) });
    const run = await startRun(project);
    takeItem(run, 'a', 'a-item');
    const base = main(project);
    writeFileSync(project.path('dirty.txt'), 'черновик\n');
    let sleeps = 0;

    const lines: string[] = [];
    const results = await mergeLanes({
      paths: run.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: project.path('backlog.md'),
      onto: 'main',
      write: (line) => lines.push(line),
      tuning: {
        lockIntervalMs: 10,
        wait: {
          pollMs: 1,
          clock: {
            now: () => Date.now(),
            sleep: async () => {
              sleeps += 1;
              assert.equal(main(project), base, 'пока копия грязна, ветка не двигается');
              if (sleeps === 3) unlinkSync(project.path('dirty.txt'));
            },
          },
        },
      },
    });

    assert.deepEqual(kinds(results), ['merged']);
    const events = readFileSync(run.journal.paths.mergeEvents, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; paths?: string[] });
    assert.deepEqual(
      events.map((event) => event.kind),
      ['merge.dirty_waiting', 'merge.dirty_resolved'],
    );
    assert.deepEqual(events[0]?.paths, ['dirty.txt']);
    assert.ok(lines.some((line) => line.includes('dirty.txt')));
    assert.equal(git(project.root, 'status', '--porcelain'), '');
  });

  it('грязен только backlog.md: без ожидания и без событий', async () => {
    const project = repository({ 'burnex.yml': pipeline('a', SUCCESS_A) });
    const run = await startRun(project);
    takeItem(run, 'a', 'a-item');
    writeFileSync(project.path('backlog.md'), `${BACKLOG}\n${item('c-item')}`);

    const results = await mergeOnto(project, run, ['a']).results;

    assert.deepEqual(kinds(results), ['merged']);
    assert.equal(existsSync(run.journal.paths.mergeEvents), false);
  });
});

describe('mergeLanes --onto: merge lock', () => {
  it('два одновременных сведения выстраиваются lock-ом: второй читает вершину первого', async () => {
    const project = repository({
      'burnex.yml': pipeline('a', SUCCESS_A),
      'stepcast-b.yml': pipeline('b', SUCCESS_B),
    });
    const runA = await startRun(project);
    const runB = await startRun(project, 'stepcast-b.yml');
    takeItem(runA, 'a', 'a-item');
    takeItem(runB, 'b', 'b-item');

    const first = mergeOnto(project, runA, ['a'], { check: 'sleep 0.3' });
    const second = mergeOnto(project, runB, ['b']);
    const [a, b] = await Promise.all([first.results, second.results]);

    assert.deepEqual(kinds(a), ['merged']);
    assert.deepEqual(kinds(b), ['merged']);
    const commitA = (a[0] as { commits: Record<string, string> }).commits['.'];
    assert.equal(git(project.root, 'rev-parse', 'main~1'), commitA);
    assert.ok(second.lines.some((line) => line.includes('merge lock занят')), second.lines.join('\n'));
    assert.deepEqual(first.lines, []);
  });
});

describe('mergeLanes --onto: отказы кодом 2 до первой правки', () => {
  async function prepared(extraFiles: Readonly<Record<string, string>> = {}): Promise<{
    project: Project;
    run: RunResult;
    snapshot: () => string;
  }> {
    const project = repository({ 'burnex.yml': pipeline('a', SUCCESS_A), ...extraFiles });
    const run = await startRun(project);
    takeItem(run, 'a', 'a-item');
    const snapshot = (): string =>
      [main(project), git(project.root, 'status', '--porcelain'), readFileSync(project.path('backlog.md'), 'utf8')].join('\n--\n');
    return { project, run, snapshot };
  }

  async function refused(
    setup: Awaited<ReturnType<typeof prepared>>,
    extra: Parameters<typeof mergeOnto>[3],
    pattern: RegExp,
  ): Promise<void> {
    const before = setup.snapshot();
    await assert.rejects(mergeOnto(setup.project, setup.run, ['a'], extra).results, (error: unknown) => {
      assert.ok(error instanceof BurnexError);
      assert.equal(error.exitCode, ExitCode.configError);
      assert.match(error.message, pattern);
      return true;
    });
    assert.equal(setup.snapshot(), before);
    assert.equal(existsSync(join(setup.run.journal.paths.dir, 'integration')), false);
    assert.equal(existsSync(mergeLockPath(setup.project.root)), false);
  }

  it('--keep-claim без --onto', async () => {
    await refused(await prepared(), { withoutOnto: true, keepClaim: true }, /--keep-claim/u);
  });

  it('--onto при project.nested_repos', async () => {
    await refused(await prepared(), { nestedRepos: ['backend'] }, /nested_repos/u);
  });

  it('anchor_kind не git', async () => {
    const setup = await prepared();
    const manifest = JSON.parse(readFileSync(setup.run.journal.paths.manifest, 'utf8')) as Record<string, unknown>;
    manifest['anchor_kind'] = 'manifest';
    writeFileSync(setup.run.journal.paths.manifest, JSON.stringify(manifest));
    await refused(setup, {}, /якор/u);
  });

  it('ветка выложена в другой рабочей копии, чем каталог запуска', async () => {
    const setup = await prepared();
    git(setup.project.root, 'checkout', '-q', '-b', 'side');
    const copy = join(tempDir('onto-copy-'), 'copy');
    git(setup.project.root, 'worktree', 'add', '-q', copy, 'main');
    await refused(setup, {}, /другой рабочей копии/u);
    assert.equal(git(copy, 'status', '--porcelain'), '');
  });

  it('прерванная публикация другого прогона того же репозитория', async () => {
    const setup = await prepared();
    const recovery = mergeRecoveryPath(setup.project.root);
    writeFileSync(recovery, JSON.stringify({ version: 2, mode: 'onto', run_dir: '/другой/прогон' }));
    await refused(setup, {}, /прервалась/u);
    assert.equal(existsSync(recovery), true);
  });

  it('ветки нет — причина называет ветку', async () => {
    await refused(await prepared(), { onto: 'нет-такой' }, /нет-такой/u);
  });

  it('live_files помимо файла очереди', async () => {
    const pipelineWithNotes = `
version: 1
kind: pipeline
name: с-живым-файлом
workspace:
  mode: worktree
  source: commit
  preserve_local_changes: true
  live_files:
    - { path: backlog.md, writeback: always, commit_on_success: true }
    - { path: notes.md, writeback: always, commit_on_success: false }
jobs:
  work-a:
    lane: a
    steps: [{ id: шаг, run: [sh, -c, '${SUCCESS_A}'], expect: [{ exit_code: 0 }] }]
`;
    await refused(await prepared({ 'burnex.yml': pipelineWithNotes, 'notes.md': 'заметки\n' }), {}, /notes\.md/u);
  });
});

describe('CLI: merge-lanes --onto', () => {
  async function cli(project: Project, argv: readonly string[]): Promise<{ code: ExitCodeValue; stdout: string; stderr: string }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = { out: (line) => stdout.push(line), err: (line) => stderr.push(line), cwd: project.root };
    const code = await withHome(project.home, () => runCli(['merge-lanes', ...argv], io));
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  it('--keep-claim без --onto отклоняется кодом 2', async () => {
    const project = repository({ 'burnex.yml': pipeline('a', SUCCESS_A) });
    const run = await startRun(project);
    takeItem(run, 'a', 'a-item');

    const out = await cli(project, [run.journal.paths.runId, '--lanes', 'a', '--check', 'exit 0', '--keep-claim']);

    assert.equal(out.code, ExitCode.configError);
    assert.match(out.stderr, /--keep-claim/u);
  });

  it('publication_conflict даёт код отказа работы', async () => {
    const project = repository({ 'burnex.yml': pipeline('a', SUCCESS_A) });
    const run = await startRun(project);
    takeItem(run, 'a', 'a-item');

    const out = await cli(project, [
      run.journal.paths.runId,
      '--lanes',
      'a',
      '--check',
      `git -C "${project.root}" commit --allow-empty -q -m чужой`,
      '--onto',
      'main',
      '--keep-claim',
    ]);

    assert.equal(out.code, ExitCode.jobFailed, out.stderr);
    assert.match(out.stdout, /publication|сдвинулась/u);
  });
});
