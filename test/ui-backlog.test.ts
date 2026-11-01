import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildBacklog, LOCK_PATH_RETRY_MS, lockPathOf } from '../src/parts/ui/backlog.js';
import { writeBoardColumns } from '../src/parts/ui/boardFile.js';
import { buildOverview } from '../src/parts/ui/overview.js';
import { projectKey } from '../src/parts/pipeline/run/journal/paths.js';
import { makeJournalBed, seedRun } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Фикстуры очереди — тот же приём, что в `test/backlog.test.ts`: заголовок
 * второго уровня плюс плоские поля.
 */
function item(slug: string, fields: Readonly<Record<string, string>>): string {
  const body = Object.entries(fields)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
  return `## ${slug}\n\n${body}\n`;
}

const BASE = { status: 'todo', title: 'т', why: 'з', done_when: 'к' } as const;

function backlogText(...items: readonly string[]): string {
  return `# Очередь\n\nПреамбула.\n\n${items.join('\n')}`;
}

/** Второй проект того же корня прогонов: свой каталог, свой прогон, своя очередь. */
function makeSecondProject(runsRoot: string, home: string): string {
  const projectRoot = join(home, '..', 'project-2');
  mkdirSync(projectRoot, { recursive: true });
  seedRun(runsRoot, projectRoot, { runId: 'b' });
  return projectRoot;
}

describe('ui-dashboard: сборка вида очереди (src/parts/ui/backlog.ts)', () => {
  it('показывает разделы двух проектов с их пунктами, в порядке файла', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText(item('third', BASE), item('first', BASE)));

    const projectRoot2 = makeSecondProject(runsRoot, home);
    writeFileSync(join(projectRoot2, 'backlog.md'), backlogText(item('second', BASE)));

    const backlog = buildBacklog(buildOverview(runsRoot));

    assert.equal(backlog.projects.length, 2);
    const bySlug = backlog.projects.flatMap((project) => project.items.map((entry) => entry.slug));
    assert.deepEqual(new Set(bySlug), new Set(['third', 'first', 'second']));

    const withThird = backlog.projects.find((project) => project.items.some((entry) => entry.slug === 'third'));
    assert.deepEqual(
      withThird?.items.map((entry) => entry.slug),
      ['third', 'first'],
      'порядок пунктов внутри раздела — порядок файла, а не пересортировка',
    );
  });

  it('объединяет пункты backlog.md и archived.md одним списком, backlog.md первым', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText(item('open-two', BASE), item('open-one', BASE)));
    writeFileSync(
      join(projectRoot, 'archived.md'),
      backlogText(item('done-two', { ...BASE, status: 'done' }), item('done-one', { ...BASE, status: 'done' })),
    );

    const backlog = buildBacklog(buildOverview(runsRoot));
    assert.equal(backlog.projects.length, 1);
    assert.deepEqual(
      backlog.projects[0]?.items.map((entry) => entry.slug),
      ['open-two', 'open-one', 'done-two', 'done-one'],
      'сперва пункты backlog.md в его порядке, затем archived.md в его',
    );
    assert.deepEqual(
      backlog.projects[0]?.items.map((entry) => entry.sourceFile),
      ['backlog.md', 'backlog.md', 'archived.md', 'archived.md'],
    );
    assert.deepEqual(backlog.projects[0]?.failures, []);
  });

  it('проект без backlog.md и без archived.md остаётся без раздела и это не считается ошибкой', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    // Ни один файл очереди не пишется вовсе.

    const backlog = buildBacklog(buildOverview(runsRoot));
    assert.deepEqual(backlog.projects, []);
  });

  it('отсутствие archived.md при наличии backlog.md не считается ошибкой', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText(item('only', BASE)));
    // archived.md не пишется вовсе.

    const backlog = buildBacklog(buildOverview(runsRoot));
    assert.equal(backlog.projects.length, 1);
    assert.deepEqual(backlog.projects[0]?.items.map((entry) => entry.slug), ['only']);
    assert.deepEqual(backlog.projects[0]?.failures, []);
  });

  it('проект без пути в указателе projects.json пропускается', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText(item('only', BASE)));

    // Указатель портится вручную: запись о проекте снимается, каталог прогона остаётся.
    const indexPath = join(runsRoot, 'projects.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
    delete index[projectKey(projectRoot)];
    writeFileSync(indexPath, JSON.stringify(index));

    const overview = buildOverview(runsRoot);
    assert.equal(overview.projects[0]?.path, undefined, 'обзор обязан остаться без пути');

    const backlog = buildBacklog(overview);
    assert.deepEqual(backlog.projects, [], 'без пути читать очередь неоткуда');
  });

  it('проект без единого прогона в вид не попадает, даже если каталог существует', () => {
    const { runsRoot } = makeJournalBed();
    // Пустой каталог проекта (без вложенных каталогов прогонов) buildOverview
    // уже отбрасывает — до buildBacklog он не доходит вовсе.
    mkdirSync(join(runsRoot, 'пустой-проект'), { recursive: true });

    const backlog = buildBacklog(buildOverview(runsRoot));
    assert.deepEqual(backlog.projects, []);
  });

  it('пункт без group показан со слагом в качестве действующей группы, пункт без track — с пустой дорожкой', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText(item('lonely', BASE)));

    const backlog = buildBacklog(buildOverview(runsRoot));
    const view = backlog.projects[0]?.items[0];
    assert.equal(view?.group, 'lonely');
    assert.equal(view?.track, '');
    assert.equal(view?.why, 'з');
    assert.equal(view?.doneWhen, 'к');
  });

  it('вид пункта несёт needs; без поля — пустой перечень', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(
      join(projectRoot, 'backlog.md'),
      backlogText(item('plain', BASE), item('waiting', { ...BASE, needs: 'plain, other' })),
    );

    const items = buildBacklog(buildOverview(runsRoot)).projects[0]?.items;
    assert.deepEqual(items?.map((view) => view.needs), [[], ['plain', 'other']]);
  });

  it('in_progress несёт момент взятия, failed несёт причину', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(
      join(projectRoot, 'backlog.md'),
      backlogText(
        item('taken', { ...BASE, status: 'in_progress', started_at: '2026-09-01T00:00:00.000Z' }),
        item('failed-one', { ...BASE, status: 'failed', reason: 'сеть недоступна' }),
      ),
    );

    const backlog = buildBacklog(buildOverview(runsRoot));
    const items = backlog.projects[0]?.items ?? [];
    const taken = items.find((entry) => entry.slug === 'taken');
    const failed = items.find((entry) => entry.slug === 'failed-one');

    assert.equal(taken?.status, 'in_progress');
    assert.equal(taken?.startedAt, '2026-09-01T00:00:00.000Z');
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.reason, 'сеть недоступна');
  });

  it('неразбираемая очередь даёт раздел с объяснением и не отменяет показа соседнего проекта', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    // Строка без «ключ: значение» внутри пункта — та же беда разбора, что и в ядре.
    writeFileSync(join(projectRoot, 'backlog.md'), `${backlogText(item('broken', BASE))}просто текст\n`);

    const projectRoot2 = makeSecondProject(runsRoot, home);
    writeFileSync(join(projectRoot2, 'backlog.md'), backlogText(item('healthy', BASE)));

    const backlog = buildBacklog(buildOverview(runsRoot));
    assert.equal(backlog.projects.length, 2);

    const broken = backlog.projects.find((project) => project.projectPath === projectRoot);
    assert.equal(broken?.items.length, 0);
    assert.equal(broken?.failures.length, 1);
    assert.equal(typeof broken?.failures[0]?.error, 'string');
    assert.equal(broken?.failures[0]?.sourceFile, 'backlog.md');
    assert.equal(broken?.failures[0]?.errorAt, 'broken');

    const healthy = backlog.projects.find((project) => project.projectPath === projectRoot2);
    assert.deepEqual(healthy?.failures, []);
    assert.deepEqual(
      healthy?.items.map((entry) => entry.slug),
      ['healthy'],
      'отказ разбора одного проекта не должен отменять показ другого',
    );
  });

  it('archived.md не разбирается, backlog.md исправен: пункты backlog.md показаны, отказ назван по archived.md', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText(item('healthy', BASE)));
    writeFileSync(join(projectRoot, 'archived.md'), `${backlogText(item('broken', BASE))}просто текст\n`);

    const backlog = buildBacklog(buildOverview(runsRoot));
    const project = backlog.projects[0];
    assert.deepEqual(
      project?.items.map((entry) => entry.slug),
      ['healthy'],
      'отказ разбора archived.md не должен скрывать пункты backlog.md',
    );
    assert.equal(project?.failures.length, 1);
    assert.equal(project?.failures[0]?.sourceFile, 'archived.md');
  });

  it('backlog.md не разбирается, archived.md исправен: пункты archived.md показаны, отказ назван по backlog.md', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), `${backlogText(item('broken', BASE))}просто текст\n`);
    writeFileSync(join(projectRoot, 'archived.md'), backlogText(item('healthy', { ...BASE, status: 'done' })));

    const backlog = buildBacklog(buildOverview(runsRoot));
    const project = backlog.projects[0];
    assert.deepEqual(
      project?.items.map((entry) => entry.slug),
      ['healthy'],
      'отказ разбора backlog.md не должен скрывать пункты archived.md',
    );
    assert.equal(project?.failures.length, 1);
    assert.equal(project?.failures[0]?.sourceFile, 'backlog.md');
  });

  it('оба файла не разбираются: два независимых отказа и ни одного пункта', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), `${backlogText(item('broken-open', BASE))}просто текст\n`);
    writeFileSync(join(projectRoot, 'archived.md'), `${backlogText(item('broken-done', BASE))}тоже текст\n`);

    const backlog = buildBacklog(buildOverview(runsRoot));
    const project = backlog.projects[0];
    assert.deepEqual(project?.items, []);
    assert.equal(project?.failures.length, 2);
    assert.deepEqual(
      new Set(project?.failures.map((failure) => failure.sourceFile)),
      new Set(['backlog.md', 'archived.md']),
    );
  });

  // Сценарий: «Файл очереди без единого пункта»
  it('файл очереди без пунктов даёт раздел с пустым списком и без отказа', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    // Все пункты разобраны в архив: остались заголовок и преамбула.
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText());

    const backlog = buildBacklog(buildOverview(runsRoot));
    assert.equal(backlog.projects.length, 1, 'файл есть — раздел проекта должен быть');
    assert.deepEqual(backlog.projects[0]?.items, []);
    assert.deepEqual(backlog.projects[0]?.failures, [], 'пустая очередь — не отказ разбора');
  });

  it('пункт с неизвестным полем показан, а не отвергнут', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText(item('odd', { ...BASE, weird_field: 'что-то' })));

    const backlog = buildBacklog(buildOverview(runsRoot));
    assert.deepEqual(
      backlog.projects[0]?.items.map((entry) => entry.slug),
      ['odd'],
    );
  });
  it('несёт раскладку колонок доски: без файла — встроенную, с файлом — его', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText(item('later', { ...BASE, status: 'postponed' })));

    let backlog = buildBacklog(buildOverview(runsRoot));
    assert.deepEqual(
      backlog.projects[0]?.columns.map((column) => column.id),
      ['todo', 'in_progress', 'done', 'archive'],
    );
    assert.equal(backlog.projects[0]?.items[0]?.status, 'postponed', 'незнакомый статус не ломает разбор');

    writeBoardColumns(projectRoot, [
      { id: 'todo' },
      { id: 'postponed', title: 'Отложено' },
      { id: 'in_progress' },
      { id: 'done' },
      { id: 'archive' },
    ]);
    backlog = buildBacklog(buildOverview(runsRoot));
    assert.deepEqual(backlog.projects[0]?.columns[1], { id: 'postponed', title: 'Отложено' });
    assert.deepEqual(backlog.projects[0]?.failures, []);
  });

  it('сломанная раскладка колонок — отказ рядом с очередью и встроенные колонки', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText(item('one', BASE)));
    mkdirSync(join(projectRoot, '.stepcast'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'board.yml'), 'columns:\n  - id: todo\n');

    const backlog = buildBacklog(buildOverview(runsRoot));
    assert.equal(backlog.projects[0]?.failures[0]?.sourceFile, '.stepcast/board.yml');
    assert.match(backlog.projects[0]?.failures[0]?.error ?? '', /in_progress/);
    assert.equal(backlog.projects[0]?.columns.length, 4);
    assert.deepEqual(backlog.projects[0]?.items.map((entry) => entry.slug), ['one']);
  });

  it('пункт с run:<id> несёт claimedBy и ownerRunId, иной владелец — только claimedBy, без владельца — ни одного', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(
      join(projectRoot, 'backlog.md'),
      backlogText(
        item('by-run', { ...BASE, status: 'in_progress', claimed_by: 'run:9169657a1513-abc' }),
        item('by-host', { ...BASE, status: 'in_progress', claimed_by: 'host:build-7' }),
        item('free', BASE),
      ),
    );

    const items = buildBacklog(buildOverview(runsRoot)).projects[0]?.items ?? [];
    const bySlug = (slug: string) => items.find((entry) => entry.slug === slug);
    assert.equal(bySlug('by-run')?.claimedBy, 'run:9169657a1513-abc');
    assert.equal(bySlug('by-run')?.ownerRunId, '9169657a1513-abc');
    assert.equal(bySlug('by-host')?.claimedBy, 'host:build-7');
    assert.ok(!('ownerRunId' in (bySlug('by-host') ?? {})), 'иная форма владельца не даёт ownerRunId');
    assert.ok(!('claimedBy' in (bySlug('free') ?? {})));
    assert.ok(!('ownerRunId' in (bySlug('free') ?? {})));
  });
});

describe('ui-dashboard: блокировка очереди в виде проекта', () => {
  function bedWithQueue() {
    const bed = makeJournalBed();
    seedRun(bed.runsRoot, bed.projectRoot, { runId: 'a' });
    writeFileSync(join(bed.projectRoot, 'backlog.md'), backlogText(item('one', BASE)));
    return bed;
  }

  function writeLock(projectRoot: string, owner: Record<string, unknown> | string): string {
    const path = lockPathOf(projectRoot);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof owner === 'string' ? owner : JSON.stringify(owner));
    return path;
  }

  function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', '']);
    assert.ok(child.pid !== undefined);
    return child.pid;
  }

  const ACQUIRED = '2026-01-01T00:00:00.000Z';

  it('файла нет — free', () => {
    const { runsRoot } = bedWithQueue();
    assert.deepEqual(buildBacklog(buildOverview(runsRoot)).projects[0]?.lock, { state: 'free' });
  });

  it('владелец — живой процесс: held без брошенности и без чужой машины', () => {
    const { runsRoot, projectRoot } = bedWithQueue();
    const path = writeLock(projectRoot, {
      pid: process.pid,
      host: hostname(),
      command: 'backlog pick',
      acquired_at: new Date(Date.now() - 1).toISOString(),
    });
    const lock = buildBacklog(buildOverview(runsRoot)).projects[0]?.lock;
    assert.equal(lock?.state, 'held');
    if (lock?.state !== 'held') return;
    assert.equal(lock.command, 'backlog pick');
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.host, hostname());
    assert.equal(lock.abandoned, false);
    assert.equal(lock.foreignHost, false);
    assert.equal(lock.path, path);
  });

  it('pid мёртвого процесса той же машины — abandoned', () => {
    const { runsRoot, projectRoot } = bedWithQueue();
    writeLock(projectRoot, { pid: deadPid(), host: hostname(), command: 'backlog pick', acquired_at: ACQUIRED });
    const lock = buildBacklog(buildOverview(runsRoot)).projects[0]?.lock;
    assert.equal(lock?.state === 'held' && lock.abandoned, true);
    assert.equal(lock?.state === 'held' && lock.foreignHost, false);
  });

  it('чужая машина — foreignHost, а не abandoned', () => {
    const { runsRoot, projectRoot } = bedWithQueue();
    writeLock(projectRoot, { pid: deadPid(), host: 'other-machine', command: 'backlog pick', acquired_at: ACQUIRED });
    const lock = buildBacklog(buildOverview(runsRoot)).projects[0]?.lock;
    assert.equal(lock?.state === 'held' && lock.foreignHost, true);
    assert.equal(lock?.state === 'held' && lock.abandoned, false);
  });

  it('мусор в файле — unreadable с путём', () => {
    const { runsRoot, projectRoot } = bedWithQueue();
    const path = writeLock(projectRoot, 'не json');
    assert.deepEqual(buildBacklog(buildOverview(runsRoot)).projects[0]?.lock, { state: 'unreadable', path });
  });

  it('путь в общем каталоге git запоминается по пути проекта: повторный вызов git не порождает', () => {
    const dir = realpathSync(tempDir('lockpath-'));
    assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
    const before = lockPathOf(dir, 0);
    assert.equal(before, join(dir, '.git', 'stepcast-backlog.lock'));
    // Если бы путь пересчитывался, без `.git` он ушёл бы в запасной.
    renameSync(join(dir, '.git'), join(dir, 'moved-git'));
    assert.equal(lockPathOf(dir, LOCK_PATH_RETRY_MS * 10), before);
  });

  it('запасной путь без репозитория перепроверяется не чаще предела: `git init` при живом демоне доходит', () => {
    const dir = realpathSync(tempDir('lockpath-'));
    const fallback = lockPathOf(dir, 0);
    assert.equal(fallback, join(dir, '.backlog.lock'));
    assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
    // До предела — прежний путь, без нового процесса git на каждом такте.
    assert.equal(lockPathOf(dir, LOCK_PATH_RETRY_MS - 1), fallback);
    assert.equal(lockPathOf(dir, LOCK_PATH_RETRY_MS), join(dir, '.git', 'stepcast-backlog.lock'));
  });
});
