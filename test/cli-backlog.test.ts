import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { run, type CliIo } from '../src/parts/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/kernel/errors.js';
import { findPackageRoot } from '../src/parts/pipeline/domain/package-schema.js';
import { findProjectRoot, shortRunId } from '../src/parts/pipeline/run/journal/paths.js';
import { RunJournal } from '../src/parts/pipeline/run/journal/writer.js';
import { gitCommit, gitInit, withHome } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * `burnex backlog` не требует ни `stepcast.yml`, ни `.stepcast/`, ни
 * конфигурации — проверки идут `run(argv, io)` в обычном временном каталоге,
 * без каркаса `makeProject`, который заводит их специально для команд,
 * зависящих от проекта.
 */

interface Result {
  readonly code: ExitCodeValue;
  readonly stdout: string;
  readonly stderr: string;
}

async function backlog(cwd: string, argv: readonly string[]): Promise<Result> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    cwd,
  };
  const code = await run(['backlog', ...argv], io);
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function item(slug: string, fields: Readonly<Record<string, string>>): string {
  const body = Object.entries(fields)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
  return `## ${slug}\n\n${body}\n`;
}

const COMPLETE = { status: 'todo', title: 'т', why: 'з', done_when: 'к' } as const;

function bed(...items: readonly string[]): string {
  const dir = tempDir('backlog-cli-');
  writeFileSync(join(dir, 'backlog.md'), `# Очередь\n\n${items.join('\n')}`);
  return dir;
}

/** Тот же bed, но репозиторий git с закоммиченной очередью — для проверок settle-коммита. */
function gitBed(...items: readonly string[]): string {
  const dir = bed(...items);
  gitInit(dir);
  gitCommit(dir, 'начальный');
  return dir;
}

function headMessageAt(dir: string): string {
  return execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
}

function headFiles(dir: string): string[] {
  return execFileSync('git', ['-C', dir, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((line) => line !== '');
}

function commitCountAt(dir: string): number {
  return Number(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
}

function porcelainAt(dir: string): string {
  return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
}

function fieldOf(text: string, slug: string, name: string): string | undefined {
  const section = text.split(`## ${slug}\n`)[1]?.split('\n## ')[0] ?? '';
  return new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(section)?.[1];
}

describe('CLI: burnex backlog list', () => {
  it('печатает пункты и не правит файл', async () => {
    const dir = bed(item('an-item', COMPLETE));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const result = await backlog(dir, ['list']);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as readonly { slug: string }[];
    assert.deepEqual(parsed.map((entry) => entry.slug), ['an-item']);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('отказывает ошибкой конфигурации, если файла нет', async () => {
    const dir = tempDir('backlog-cli-');
    const result = await backlog(dir, ['list']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.stderr, /backlog\.md/);
  });

  it('в каталоге без stepcast.yml и .stepcast/ отрабатывает штатно', async () => {
    const dir = bed(item('an-item', COMPLETE));
    assert.equal(existsSync(join(dir, 'stepcast.yml')), false);
    assert.equal(existsSync(join(dir, '.stepcast')), false);

    const result = await backlog(dir, ['list']);
    assert.equal(result.code, ExitCode.ok);
  });
});

describe('CLI: burnex backlog pick', () => {
  it('берёт пункт и проставляет status и started_at', async () => {
    const dir = bed(item('an-item', COMPLETE));

    const result = await backlog(dir, ['pick']);

    assert.equal(result.code, ExitCode.ok);
    const [entry] = JSON.parse(result.stdout) as readonly { slug: string }[];
    assert.equal(entry?.slug, 'an-item');

    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    assert.equal(fieldOf(text, 'an-item', 'status'), 'in_progress');
    assert.ok(fieldOf(text, 'an-item', 'started_at'));
  });

  it('--slots 2 берёт два пункта разных групп одной меткой started_at', async () => {
    const dir = bed(item('a', { ...COMPLETE, group: 'a' }), item('b', { ...COMPLETE, group: 'b' }));

    const result = await backlog(dir, ['pick', '--slots', '2']);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as readonly { slug: string }[];
    assert.deepEqual(parsed.map((entry) => entry.slug), ['a', 'b']);

    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    const startedA = fieldOf(text, 'a', 'started_at');
    const startedB = fieldOf(text, 'b', 'started_at');
    assert.ok(startedA);
    assert.equal(startedA, startedB);
  });

  it('--lanes раздаёт дорожки, незаполненная присутствует с filled: false', async () => {
    const dir = bed(item('a', { ...COMPLETE, group: 'a' }));
    const runDir = tempDir('backlog-rundir-');

    const result = await backlog(dir, ['pick', '--lanes', 'a-lane,b-lane', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as {
      lanes: Record<string, { filled: boolean; slug: string; item: unknown }>;
    };
    assert.equal(parsed.lanes['a-lane']?.filled, true);
    assert.equal(parsed.lanes['a-lane']?.slug, 'a');
    assert.equal(parsed.lanes['b-lane']?.filled, false);
    assert.equal(parsed.lanes['b-lane']?.item, null);

    assert.ok(existsSync(join(runDir, 'item-a-lane.json')));
    assert.equal(existsSync(join(runDir, 'item-b-lane.json')), false);
  });

  it('вес пункта доезжает до дорожки плоским полем и до файла дорожки', async () => {
    // Плоским полем — потому что условие `if` пайплайна читает его прямо у
    // дорожки, не заходя внутрь item; у незаполненной — пусто, как слаг.
    const dir = bed(item('a', { ...COMPLETE, track: 'express' }));
    const runDir = tempDir('backlog-rundir-');

    const result = await backlog(dir, ['pick', '--lanes', 'a-lane,b-lane', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as {
      lanes: Record<string, { track: string; item: { track?: string } | null }>;
    };
    assert.equal(parsed.lanes['a-lane']?.track, 'express');
    assert.equal(parsed.lanes['a-lane']?.item?.track, 'express');
    assert.equal(parsed.lanes['b-lane']?.track, '');

    const written = JSON.parse(readFileSync(join(runDir, 'item-a-lane.json'), 'utf8')) as { track: string };
    assert.equal(written.track, 'express');
  });

  it('пункт без поля track доезжает до дорожки с пустой меткой', async () => {
    const dir = bed(item('a', COMPLETE));

    const result = await backlog(dir, ['pick', '--lanes', 'a-lane']);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as { lanes: Record<string, { track: string }> };
    assert.equal(parsed.lanes['a-lane']?.track, '');
  });

  it('пустая очередь: код 0, пустая выдача, файл не изменён', async () => {
    const dir = bed(item('done-item', { ...COMPLETE, status: 'done' }));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const result = await backlog(dir, ['pick']);

    assert.equal(result.code, ExitCode.ok);
    assert.deepEqual(JSON.parse(result.stdout), []);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('пустая очередь по дорожкам: обе дорожки filled: false, файл не изменён', async () => {
    const dir = bed(item('done-item', { ...COMPLETE, status: 'done' }));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const result = await backlog(dir, ['pick', '--lanes', 'a,b']);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as { lanes: Record<string, { filled: boolean }> };
    assert.equal(parsed.lanes['a']?.filled, false);
    assert.equal(parsed.lanes['b']?.filled, false);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('--file вне текущего каталога правит именно этот файл', async () => {
    const dir = tempDir('backlog-cli-');
    const elsewhere = tempDir('backlog-elsewhere-');
    const file = join(elsewhere, 'queue.md');
    writeFileSync(file, `# Очередь\n\n${item('an-item', COMPLETE)}`);

    const result = await backlog(dir, ['pick', '--file', file]);

    assert.equal(result.code, ExitCode.ok);
    assert.equal(fieldOf(readFileSync(file, 'utf8'), 'an-item', 'status'), 'in_progress');
  });

  it('ошибочный перечень дорожек отказывает ошибкой конфигурации', async () => {
    const dir = bed(item('an-item', COMPLETE));

    for (const lanes of ['', 'a,a', 'Дорожка A']) {
      const result = await backlog(dir, ['pick', '--lanes', lanes]);
      assert.equal(result.code, ExitCode.configError, `lanes=${lanes}`);
    }
  });

  it('--lanes вместе с --slots отклоняется, а не выбирает форму молча', async () => {
    const dir = bed(item('an-item', COMPLETE));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const result = await backlog(dir, ['pick', '--lanes', 'a-lane', '--slots', '2']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.stderr, /--lanes/);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('относительный --run-dir разрешается от рабочего каталога вызова, а не процесса', async () => {
    const dir = bed(item('an-item', COMPLETE));

    const result = await backlog(dir, ['pick', '--lanes', 'a-lane', '--run-dir', 'lanes']);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.ok(existsSync(join(dir, 'lanes', 'item-a-lane.json')));
  });

  it('недоступный --run-dir отказывает до правки очереди', async () => {
    const dir = bed(item('an-item', COMPLETE));
    // Не каталог, а обычный файл: подготовить каталог дорожек по этому пути
    // нечем, и отказ обязан случиться раньше, чем пункт помечен взятым.
    const occupied = join(dir, 'occupied');
    writeFileSync(occupied, 'не каталог');
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const result = await backlog(dir, ['pick', '--lanes', 'a-lane', '--run-dir', occupied]);

    assert.equal(result.code, ExitCode.configError);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });
});

describe('CLI: burnex backlog pick --only', () => {
  it('берёт названный пункт, а не первый свободный', async () => {
    const dir = bed(item('first-item', COMPLETE), item('named-item', COMPLETE));

    const result = await backlog(dir, ['pick', '--only', 'named-item']);

    assert.equal(result.code, ExitCode.ok);
    const [entry] = JSON.parse(result.stdout) as readonly { slug: string }[];
    assert.equal(entry?.slug, 'named-item');

    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    assert.equal(fieldOf(text, 'named-item', 'status'), 'in_progress');
    assert.equal(fieldOf(text, 'first-item', 'status'), 'todo');
  });

  it('заполняет названным пунктом первую дорожку, остальные остаются пустыми', async () => {
    const dir = bed(item('first-item', COMPLETE), item('named-item', COMPLETE));

    const result = await backlog(dir, ['pick', '--lanes', 'a,b', '--only', 'named-item']);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as { lanes: Record<string, { filled: boolean; slug: string }> };
    assert.equal(parsed.lanes.a?.slug, 'named-item');
    assert.equal(parsed.lanes.b?.filled, false);
  });

  it('неизвестный слаг — отказ, а не пустая выдача', async () => {
    const dir = bed(item('an-item', COMPLETE));

    const result = await backlog(dir, ['pick', '--only', 'no-such-item']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.stderr, /no-such-item/);
    assert.equal(fieldOf(readFileSync(join(dir, 'backlog.md'), 'utf8'), 'an-item', 'status'), 'todo');
  });

  it('несвободный пункт — отказ с названным статусом', async () => {
    const dir = bed(item('an-item', { ...COMPLETE, status: 'done' }));

    const result = await backlog(dir, ['pick', '--only', 'an-item']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.stderr, /done/);
  });

  it('пункт занятой группы не берётся даже по имени', async () => {
    const dir = bed(
      item('busy-item', {
        ...COMPLETE,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        group: 'shared',
      }),
      item('named-item', { ...COMPLETE, group: 'shared' }),
    );

    const result = await backlog(dir, ['pick', '--only', 'named-item']);

    assert.equal(result.code, ExitCode.ok);
    assert.deepEqual(JSON.parse(result.stdout), []);
    assert.equal(fieldOf(readFileSync(join(dir, 'backlog.md'), 'utf8'), 'named-item', 'status'), 'todo');
  });
});

describe('CLI: зависимости needs', () => {
  function slugsOf(stdout: string): string[] {
    return (JSON.parse(stdout) as readonly { slug: string }[]).map((entry) => entry.slug);
  }

  for (const status of ['todo', 'postponed', 'failed', 'in_progress']) {
    it(`зависимость в статусе ${status} не даёт взять пункт, в том числе по имени`, async () => {
      // `in_progress` — свежий: зависший пункт отбор взял бы снова, а здесь
      // проверяется именно то, что идущая работа зависимость не выполняет.
      const extra =
        status === 'failed'
          ? { reason: 'п' }
          : status === 'in_progress'
            ? { started_at: new Date().toISOString() }
            : {};
      const dir = bed(item('a', { ...COMPLETE, status, ...extra }), item('b', { ...COMPLETE, needs: 'a' }));
      const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

      const only = await backlog(dir, ['pick', '--only', 'b']);
      assert.equal(only.code, ExitCode.configError);
      assert.match(only.stderr, /пункт «b» ждёт зависимостей: a \(/);
      assert.match(only.stderr, new RegExp(status));
      assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);

      const picked = await backlog(dir, ['pick', '--slots', '2']);
      assert.equal(picked.code, ExitCode.ok);
      assert.deepEqual(slugsOf(picked.stdout), status === 'todo' ? ['a'] : []);
      assert.notEqual(fieldOf(readFileSync(join(dir, 'backlog.md'), 'utf8'), 'b', 'status'), 'in_progress');
    });
  }

  it('done в очереди выполняет зависимость', async () => {
    const dir = bed(item('a', { ...COMPLETE, status: 'done' }), item('b', { ...COMPLETE, needs: 'a' }));
    const result = await backlog(dir, ['pick', '--only', 'b']);
    assert.equal(result.code, ExitCode.ok);
    assert.deepEqual(slugsOf(result.stdout), ['b']);
  });

  it('done в archived.md выполняет зависимость', async () => {
    const dir = bed(item('b', { ...COMPLETE, needs: 'a' }));
    writeFileSync(join(dir, 'archived.md'), `# Архив\n\n${item('a', { ...COMPLETE, status: 'done' })}`);
    const result = await backlog(dir, ['pick']);
    assert.equal(result.code, ExitCode.ok);
    assert.deepEqual(slugsOf(result.stdout), ['b']);
  });

  it('ждущий и postponed пункт группу не занимают', async () => {
    const dir = bed(
      item('a', { ...COMPLETE, status: 'postponed' }),
      item('b', { ...COMPLETE, needs: 'a', group: 'shared' }),
      item('p', { ...COMPLETE, status: 'postponed', group: 'shared' }),
      item('c', { ...COMPLETE, group: 'shared' }),
    );
    const result = await backlog(dir, ['pick']);
    assert.equal(result.code, ExitCode.ok);
    assert.deepEqual(slugsOf(result.stdout), ['c']);
  });

  for (const [name, items, fragment] of [
    ['неизвестный слаг', [item('b', { ...COMPLETE, needs: 'nope' })], /«b».*«nope»/],
    [
      'цикл',
      [item('a', { ...COMPLETE, needs: 'b' }), item('b', { ...COMPLETE, needs: 'a' })],
      /a → b → a/,
    ],
  ] as const) {
    for (const argv of [['list'], ['pick']]) {
      it(`${name}: ${argv[0]} отказывает кодом 2, очередь нетронута`, async () => {
        const dir = bed(...items);
        const before = readFileSync(join(dir, 'backlog.md'), 'utf8');
        const result = await backlog(dir, argv);
        assert.equal(result.code, ExitCode.configError);
        assert.match(result.stderr, fragment);
        assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
      });
    }
  }

  it('неразбираемый archived.md отказывает, называя файл архива', async () => {
    const dir = bed(item('b', { ...COMPLETE, needs: 'a' }));
    writeFileSync(join(dir, 'archived.md'), '## a\n\nне поле\n');
    const result = await backlog(dir, ['list']);
    assert.equal(result.code, ExitCode.configError);
    assert.match(result.stderr, /archived\.md/);
  });

  it('finish при битом needs у другого пункта проставляет исход', async () => {
    const dir = bed(item('a', { ...COMPLETE, status: 'in_progress' }), item('b', { ...COMPLETE, needs: 'nope' }));
    const result = await backlog(dir, ['finish', 'a', '--status', 'done']);
    assert.equal(result.code, ExitCode.ok);
    assert.equal(fieldOf(readFileSync(join(dir, 'backlog.md'), 'utf8'), 'a', 'status'), 'done');
  });

  it('выдача list и pick --lanes несёт needs', async () => {
    const dir = bed(item('a', { ...COMPLETE, status: 'done' }), item('b', { ...COMPLETE, needs: 'a' }));
    const listed = JSON.parse((await backlog(dir, ['list'])).stdout) as readonly { needs: string[] }[];
    assert.deepEqual(listed.map((entry) => entry.needs), [[], ['a']]);

    const lanes = await backlog(dir, ['pick', '--lanes', 'x']);
    const parsed = JSON.parse(lanes.stdout) as { lanes: Record<string, { item: { needs: string[] } }> };
    assert.deepEqual(parsed.lanes.x?.item.needs, ['a']);
  });
});

describe('CLI: материалы пункта goal и details', () => {
  function materials(dir: string, ...files: readonly string[]): void {
    mkdirSync(join(dir, 'backlog', 'b'), { recursive: true });
    for (const name of files) writeFileSync(join(dir, name), 'материал\n');
  }

  it('пункт с отсутствующим файлом пропущен, группа не занята, ниже взят, строка в stderr', async () => {
    const dir = bed(
      item('b', { ...COMPLETE, group: 'queue', goal: 'backlog/b/goal.md', details: 'backlog/b/d.md' }),
      item('c', { ...COMPLETE, group: 'queue' }),
    );
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');
    const result = await backlog(dir, ['pick']);
    assert.equal(result.code, ExitCode.ok);
    const picked = JSON.parse(result.stdout) as { slug: string }[];
    assert.deepEqual(picked.map((entry) => entry.slug), ['c']);
    assert.match(result.stderr, /«b».*backlog\/b\/goal\.md/);
    const after = readFileSync(join(dir, 'backlog.md'), 'utf8');
    assert.equal(fieldOf(after, 'b', 'status'), 'todo');
    assert.equal(fieldOf(after, 'c', 'status'), 'in_progress');
    assert.notEqual(after, before);
  });

  it('все файлы на месте — пункт взят, запись несёт goal и details', async () => {
    const dir = bed(item('b', { ...COMPLETE, goal: 'backlog/b/goal.md', details: 'backlog/b/d.md' }));
    materials(dir, 'backlog/b/goal.md', 'backlog/b/d.md');
    const runDir = join(dir, 'lanes');
    const result = await backlog(dir, ['pick', '--lanes', 'a', '--run-dir', runDir]);
    assert.equal(result.code, ExitCode.ok);
    assert.doesNotMatch(result.stderr, /пропущен/);
    const written = JSON.parse(readFileSync(join(runDir, 'item-a.json'), 'utf8')) as { goal: string; details: string[] };
    assert.equal(written.goal, 'backlog/b/goal.md');
    assert.deepEqual(written.details, ['backlog/b/d.md']);
  });

  it('--only на пункт с отсутствующими путями: код 2, все пути в сообщении, очередь прежняя', async () => {
    const dir = bed(item('b', { ...COMPLETE, goal: 'backlog/b/goal.md', details: 'backlog/b/d.md' }));
    const before = readFileSync(join(dir, 'backlog.md'));
    const result = await backlog(dir, ['pick', '--only', 'b']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /backlog\/b\/goal\.md/);
    assert.match(result.stderr, /backlog\/b\/d\.md/);
    assert.deepEqual(readFileSync(join(dir, 'backlog.md')), before);
  });

  it('list с отсутствующим файлом ничего не проверяет', async () => {
    const dir = bed(item('b', { ...COMPLETE, goal: 'backlog/b/goal.md' }));
    const result = await backlog(dir, ['list']);
    assert.equal(result.code, ExitCode.ok);
    assert.equal((JSON.parse(result.stdout) as { goal: string }[])[0]?.goal, 'backlog/b/goal.md');
  });
});

describe('CLI: burnex backlog pick публикует данные работы', () => {
  /** Каталог работы с объявлением — тот же вид, что заводит движок до первого шага. */
  function jobDirWithDeclaration(declared: readonly string[]): string {
    const dir = tempDir('backlog-jobdir-');
    writeFileSync(join(dir, 'resolved.json'), JSON.stringify({ id: 'slots', data: declared }));
    return dir;
  }

  /** Позвать backlog с заданным (или отсутствующим) `BURNEX_JOB_DIR`, восстановив окружение после. */
  async function backlogAsStep(
    cwd: string,
    argv: readonly string[],
    jobDir: string | undefined,
  ): Promise<Result> {
    const previous = process.env.BURNEX_JOB_DIR;
    if (jobDir === undefined) delete process.env.BURNEX_JOB_DIR;
    else process.env.BURNEX_JOB_DIR = jobDir;
    try {
      return await backlog(cwd, argv);
    } finally {
      if (previous === undefined) delete process.env.BURNEX_JOB_DIR;
      else process.env.BURNEX_JOB_DIR = previous;
    }
  }

  // Сценарий: «Выбор публикуется работой slots»
  it('внутри работы, объявившей ключи выбора, публикует title, title-<дорожка> и slug-<дорожка>', async () => {
    const dir = bed(item('a', { ...COMPLETE, group: 'a' }));
    const jobDir = jobDirWithDeclaration(['title', 'title-a-lane', 'slug-a-lane']);

    const result = await backlogAsStep(dir, ['pick', '--lanes', 'a-lane'], jobDir);

    assert.equal(result.code, ExitCode.ok);
    assert.equal(result.stderr, '');
    const data = JSON.parse(readFileSync(join(jobDir, 'data.json'), 'utf8')) as Record<string, string>;
    assert.equal(data['slug-a-lane'], 'a');
    assert.ok(data['title-a-lane']);
    assert.ok(data['title']);
  });

  // Сценарий: «Публикация отклонена объявлением»
  it('внутри работы без объявления — выбор состоялся, код 0, а stderr называет работу и ключ', async () => {
    const dir = bed(item('a', { ...COMPLETE, group: 'a' }));
    const jobDir = jobDirWithDeclaration([]);

    const result = await backlogAsStep(dir, ['pick', '--lanes', 'a-lane'], jobDir);

    assert.equal(result.code, ExitCode.ok);
    assert.match(result.stderr, /подпись выбора не опубликована/);
    assert.match(result.stderr, /slots/);
    assert.equal(existsSync(join(jobDir, 'data.json')), false);
    assert.equal(fieldOf(readFileSync(join(dir, 'backlog.md'), 'utf8'), 'a', 'status'), 'in_progress');
  });

  // Сценарий: «Вызов вне прогона»
  it('вне шага прогона ничего не публикует и ни о чём не сообщает', async () => {
    const dir = bed(item('a', { ...COMPLETE, group: 'a' }));

    const result = await backlogAsStep(dir, ['pick', '--lanes', 'a-lane'], undefined);

    assert.equal(result.code, ExitCode.ok);
    assert.equal(result.stderr, '');
  });
});

describe('CLI: burnex backlog finish', () => {
  it('finish done проставляет исход', async () => {
    const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress' }));

    const result = await backlog(dir, ['finish', 'an-item', '--status', 'done']);

    assert.equal(result.code, ExitCode.ok);
    assert.equal(fieldOf(readFileSync(join(dir, 'backlog.md'), 'utf8'), 'an-item', 'status'), 'done');
  });

  it('finish failed --reason проставляет исход и причину', async () => {
    const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress' }));

    const result = await backlog(dir, ['finish', 'an-item', '--status', 'failed', '--reason', 'проверка красная']);

    assert.equal(result.code, ExitCode.ok);
    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    assert.equal(fieldOf(text, 'an-item', 'status'), 'failed');
    assert.equal(fieldOf(text, 'an-item', 'reason'), 'проверка красная');
  });

  it('многострочная причина сводится в одну строку, очередь остаётся разбираемой', async () => {
    const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress' }));

    // Ровно то, что собирает reasonWithOutput (src/parts/pipeline/domain/lanes/merge.ts) из
    // stderr красной проверки.
    const result = await backlog(dir, [
      'finish',
      'an-item',
      '--status',
      'failed',
      '--reason',
      'проверка после наложения не прошла:\n  test/backlog.test.ts:12\n  1 failing',
    ]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    assert.equal(
      fieldOf(text, 'an-item', 'reason'),
      'проверка после наложения не прошла: test/backlog.test.ts:12 1 failing',
    );

    // Следующее чтение очереди обязано пройти: многострочное значение сделало
    // бы неразбираемым весь файл, а не один пункт.
    const listed = await backlog(dir, ['list']);
    assert.equal(listed.code, ExitCode.ok, listed.stderr);
  });

  it('длинная причина урезается: очередь читает человек', async () => {
    const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress' }));

    const result = await backlog(dir, [
      'finish',
      'an-item',
      '--status',
      'failed',
      '--reason',
      'ш'.repeat(5000),
    ]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    const reason = fieldOf(readFileSync(join(dir, 'backlog.md'), 'utf8'), 'an-item', 'reason') ?? '';
    assert.ok(reason.length < 600, `причина длиной ${reason.length} осталась неурезанной`);
    assert.match(reason, /…$/);
  });

  it('повторный finish не меняет файл и завершается кодом 0', async () => {
    const dir = bed(item('an-item', { ...COMPLETE, status: 'done' }));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const result = await backlog(dir, ['finish', 'an-item', '--status', 'failed', '--reason', 'поздно']);

    assert.equal(result.code, ExitCode.ok);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('failed без --reason отказывает ошибкой конфигурации', async () => {
    const dir = bed(item('an-item', COMPLETE));
    const result = await backlog(dir, ['finish', 'an-item', '--status', 'failed']);
    assert.equal(result.code, ExitCode.configError);
  });

  it('отсутствующий слаг отказывает ошибкой конфигурации', async () => {
    const dir = bed(item('an-item', COMPLETE));
    const result = await backlog(dir, ['finish', 'missing-item', '--status', 'done']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.stderr, /missing-item/);
  });
});

describe('CLI: burnex backlog settle', () => {
  function itemFile(runDir: string, lane: string, slug: string): void {
    writeFileSync(join(runDir, `item-${lane}.json`), JSON.stringify({ slug, title: `Улучшение ${slug}` }));
  }

  it('незакрытый пункт помечается failed с причиной', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const runDir = tempDir('backlog-rundir-');
    itemFile(runDir, 'a', 'a-item');

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    assert.equal(fieldOf(text, 'a-item', 'status'), 'failed');
    assert.match(fieldOf(text, 'a-item', 'reason') ?? '', /не дошёл/);
    assert.match(result.stdout, /a-item/);
  });

  it('уже закрытый пункт остаётся нетронутым', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'done' }));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');
    const runDir = tempDir('backlog-rundir-');
    itemFile(runDir, 'a', 'a-item');

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('пустой каталог прогона (без item-*.json) даёт код 0 и не правит очередь', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');
    const runDir = tempDir('backlog-rundir-');

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.match(result.stdout, /проставлять нечего/);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('отсутствующий каталог прогона отказывает кодом 2', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const result = await backlog(dir, ['settle', '--run-dir', join(dir, 'нет-такого')]);
    assert.equal(result.code, ExitCode.configError);
  });

  it('--run-dir не задан отказывает кодом 2', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const result = await backlog(dir, ['settle']);
    assert.equal(result.code, ExitCode.configError);
  });

  it('файл дорожки без слага отказывает кодом 2', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const runDir = tempDir('backlog-rundir-');
    writeFileSync(join(runDir, 'item-a.json'), JSON.stringify({ title: 'без слага' }));

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.configError);
  });

  it('две дорожки: одна done остаётся нетронутой, другая in_progress становится failed', async () => {
    const dir = bed(
      item('a-item', { ...COMPLETE, status: 'done' }),
      item('b-item', { ...COMPLETE, status: 'in_progress' }),
    );
    const runDir = tempDir('backlog-rundir-');
    itemFile(runDir, 'a', 'a-item');
    itemFile(runDir, 'b', 'b-item');

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    assert.equal(fieldOf(text, 'a-item', 'status'), 'done');
    assert.equal(fieldOf(text, 'a-item', 'reason'), undefined);
    assert.equal(fieldOf(text, 'b-item', 'status'), 'failed');
  });

  it('коммитит адресно только файл очереди, сообщением с коротким id прогона', async () => {
    const dir = gitBed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const runDir = tempDir('backlog-rundir-42abcd');
    itemFile(runDir, 'a', 'a-item');
    const before = commitCountAt(dir);

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.equal(commitCountAt(dir), before + 1);
    assert.deepEqual(headFiles(dir), ['backlog.md']);
    assert.equal(headMessageAt(dir), `backlog: исходы дорожек прогона ${shortRunId(basename(runDir))}`);
    assert.equal(porcelainAt(dir), '', 'дерево чисто после коммита');
    assert.match(result.stdout, /закоммичена/);
  });

  it('без правок коммита нет: уже закрытый пункт ничего не меняет', async () => {
    const dir = gitBed(item('a-item', { ...COMPLETE, status: 'done' }));
    const runDir = tempDir('backlog-rundir-');
    itemFile(runDir, 'a', 'a-item');
    const before = commitCountAt(dir);

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.equal(commitCountAt(dir), before, 'коммита нет — settle ничего в очередь не проставил');
  });

  it('файл очереди вне git-репозитория — коммита нет, вывод это называет', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const runDir = tempDir('backlog-rundir-');
    itemFile(runDir, 'a', 'a-item');

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.match(result.stdout, /не закоммичена/);
  });

  it('посторонняя правка рабочего дерева в коммит не попадает', async () => {
    const dir = gitBed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const runDir = tempDir('backlog-rundir-');
    itemFile(runDir, 'a', 'a-item');
    writeFileSync(join(dir, 'stray.txt'), 'чужая правка\n');

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.deepEqual(headFiles(dir), ['backlog.md']);
    assert.match(porcelainAt(dir), /stray\.txt/, 'посторонний файл остаётся незакоммиченным');
  });
});

describe('CLI: владелец пункта --owner', () => {
  const OLD = '2020-01-01T00:00:00.000Z';

  /** `backlog` с подменённым HOME: корень журнала прогонов — каталог внутри него. */
  async function ownerBacklog(dir: string, home: string, argv: readonly string[]): Promise<Result> {
    return withHome(home, () => backlog(dir, argv));
  }

  function runsRootOf(home: string): string {
    return join(home, '.stepcast', 'runs');
  }

  /** Прогон проекта очереди в журнале под HOME; `pid` живой — свой, мёртвый — несуществующий. */
  function makeRun(
    dir: string,
    home: string,
    runId: string,
    spec: { readonly status: 'running' | 'success'; readonly alive: boolean; readonly resumedFrom?: string },
  ): void {
    const projectRoot = findProjectRoot(dir);
    const journal = RunJournal.create({ runsRoot: runsRootOf(home), projectRoot, runId });
    journal.writeManifest({
      run_id: runId,
      pipeline: 'demo',
      pipeline_file: join(projectRoot, 'stepcast.yml'),
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: new Date().toISOString(),
      pid: spec.alive ? process.pid : 999_999_999,
      ...(spec.resumedFrom === undefined ? {} : { resumed_from: spec.resumedFrom }),
    });
    journal.writeStatus({
      run_id: runId,
      pipeline: 'demo',
      lock_hash: 'abc',
      status: spec.status,
      workspace: { mode: 'cwd' },
      inputs: {},
      jobs: [],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: new Date().toISOString(),
    });
  }

  const read = (dir: string): string => readFileSync(join(dir, 'backlog.md'), 'utf8');

  describe('pick', () => {
    it('--owner run:R1 пишет claimed_by вместе со status и started_at', async () => {
      const dir = bed(item('an-item', COMPLETE));
      const result = await backlog(dir, ['pick', '--owner', 'run:R1']);

      assert.equal(result.code, ExitCode.ok, result.stderr);
      assert.equal(fieldOf(read(dir), 'an-item', 'claimed_by'), 'run:R1');
      assert.equal(fieldOf(read(dir), 'an-item', 'status'), 'in_progress');
      assert.ok(fieldOf(read(dir), 'an-item', 'started_at'));
      const [entry] = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
      assert.ok(entry !== undefined && !('claimed_by' in entry), 'в запись пункта владелец не входит');
    });

    it('--owner run:R2 по зависшему пункту заменяет владельца', async () => {
      const home = tempDir('backlog-home-');
      const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress', started_at: OLD, claimed_by: 'run:R1' }));
      const result = await ownerBacklog(dir, home, ['pick', '--owner', 'run:R2']);

      assert.equal(result.code, ExitCode.ok, result.stderr);
      assert.equal(fieldOf(read(dir), 'an-item', 'claimed_by'), 'run:R2');
    });

    it('pick без --owner снимает claimed_by', async () => {
      const home = tempDir('backlog-home-');
      const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress', started_at: OLD, claimed_by: 'run:R1' }));
      const result = await ownerBacklog(dir, home, ['pick']);

      assert.equal(result.code, ExitCode.ok, result.stderr);
      assert.equal(fieldOf(read(dir), 'an-item', 'status'), 'in_progress');
      assert.equal(fieldOf(read(dir), 'an-item', 'claimed_by'), undefined);
    });

    it('неверная форма --owner — код 2, файл не тронут', async () => {
      const dir = bed(item('an-item', COMPLETE));
      const before = read(dir);
      for (const owner of ['R1', 'run:', 'run:a/b', 'run:a b']) {
        const result = await backlog(dir, ['pick', '--owner', owner]);
        assert.equal(result.code, ExitCode.configError, owner);
        assert.match(result.stderr, /--owner/);
        assert.equal(read(dir), before, owner);
      }
    });

    it('мёртвый владелец освобождает свежий пункт', async () => {
      const home = tempDir('backlog-home-');
      const dir = bed(
        item('an-item', { ...COMPLETE, status: 'in_progress', started_at: new Date().toISOString(), claimed_by: 'run:R1' }),
      );
      makeRun(dir, home, 'R1', { status: 'success', alive: false });

      const result = await ownerBacklog(dir, home, ['pick', '--owner', 'run:R2']);

      assert.equal(result.code, ExitCode.ok, result.stderr);
      assert.equal(fieldOf(read(dir), 'an-item', 'claimed_by'), 'run:R2');
    });

    it('живой владелец держит пункт старше порога, --only отказывает «не свободен»', async () => {
      const home = tempDir('backlog-home-');
      const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress', started_at: OLD, claimed_by: 'run:R1' }));
      makeRun(dir, home, 'R1', { status: 'running', alive: true });
      const before = read(dir);

      const free = await ownerBacklog(dir, home, ['pick', '--owner', 'run:R2']);
      assert.equal(free.code, ExitCode.ok, free.stderr);
      assert.deepEqual(JSON.parse(free.stdout), []);

      const named = await ownerBacklog(dir, home, ['pick', '--only', 'an-item', '--owner', 'run:R2']);
      assert.equal(named.code, ExitCode.configError);
      assert.match(named.stderr, /не свободен/);
      assert.equal(read(dir), before);
    });

    it('очередь без владельцев работает в каталоге без конфигурации проекта', async () => {
      const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress', started_at: OLD }));
      assert.equal(existsSync(join(dir, '.stepcast')), false);

      const result = await backlog(dir, ['pick', '--owner', 'run:R2']);

      assert.equal(result.code, ExitCode.ok, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(fieldOf(read(dir), 'an-item', 'claimed_by'), 'run:R2');
    });
  });

  describe('finish', () => {
    it('свой пункт получает исход', async () => {
      const home = tempDir('backlog-home-');
      const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress', claimed_by: 'run:R1' }));
      const result = await ownerBacklog(dir, home, ['finish', 'an-item', '--status', 'done', '--owner', 'run:R1']);

      assert.equal(result.code, ExitCode.ok, result.stderr);
      assert.equal(fieldOf(read(dir), 'an-item', 'status'), 'done');
    });

    it('пункт предка по resume получает исход', async () => {
      const home = tempDir('backlog-home-');
      const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress', claimed_by: 'run:R0' }));
      makeRun(dir, home, 'R0', { status: 'success', alive: false });
      makeRun(dir, home, 'R1', { status: 'running', alive: true, resumedFrom: 'R0' });

      const result = await ownerBacklog(dir, home, ['finish', 'an-item', '--status', 'done', '--owner', 'run:R1']);

      assert.equal(result.code, ExitCode.ok, result.stderr);
      assert.equal(fieldOf(read(dir), 'an-item', 'status'), 'done');
    });

    it('пункт без владельца получает исход', async () => {
      const home = tempDir('backlog-home-');
      const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress' }));
      const result = await ownerBacklog(dir, home, ['finish', 'an-item', '--status', 'done', '--owner', 'run:R1']);

      assert.equal(result.code, ExitCode.ok, result.stderr);
      assert.equal(fieldOf(read(dir), 'an-item', 'status'), 'done');
    });

    it('чужой пункт не тронут: код 0, stderr называет владельца', async () => {
      const home = tempDir('backlog-home-');
      const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress', claimed_by: 'run:R2' }));
      const before = read(dir);
      const result = await ownerBacklog(dir, home, [
        'finish', 'an-item', '--status', 'failed', '--reason', 'п', '--owner', 'run:R1',
      ]);

      assert.equal(result.code, ExitCode.ok, result.stderr);
      assert.match(result.stderr, /an-item/);
      assert.match(result.stderr, /run:R2/);
      assert.equal(read(dir), before);
    });

    it('already-final раньше проверки владельца', async () => {
      const home = tempDir('backlog-home-');
      const dir = bed(item('an-item', { ...COMPLETE, status: 'done', claimed_by: 'run:R2' }));
      const result = await ownerBacklog(dir, home, ['finish', 'an-item', '--status', 'failed', '--reason', 'п', '--owner', 'run:R1']);

      assert.equal(result.code, ExitCode.ok, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(fieldOf(read(dir), 'an-item', 'status'), 'done');
    });

    it('неверная форма --owner — код 2', async () => {
      const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress' }));
      const result = await backlog(dir, ['finish', 'an-item', '--status', 'done', '--owner', 'R1']);
      assert.equal(result.code, ExitCode.configError);
    });
  });

  describe('settle', () => {
    function itemFile(runDir: string, lane: string, slug: string): void {
      writeFileSync(join(runDir, `item-${lane}.json`), JSON.stringify({ slug, title: `Улучшение ${slug}` }));
    }

    it('пункт, перехваченный другим прогоном, остаётся in_progress с его владельцем', async () => {
      const home = tempDir('backlog-home-');
      const dir = gitBed(item('an-item', { ...COMPLETE, status: 'in_progress', claimed_by: 'run:R2' }));
      const runDir = tempDir('backlog-rundir-');
      itemFile(runDir, 'a', 'an-item');
      const before = read(dir);

      const result = await ownerBacklog(dir, home, ['settle', '--run-dir', runDir]);

      assert.equal(result.code, ExitCode.ok, result.stderr);
      assert.equal(read(dir), before);
      assert.equal(fieldOf(read(dir), 'an-item', 'claimed_by'), 'run:R2');
      assert.match(result.stdout, /пропущен/);
      assert.doesNotMatch(result.stdout, /помечен failed/);
      assert.doesNotMatch(result.stdout, /все взятые пункты уже свели свой исход/);
      assert.match(result.stdout, /забранных другим прогоном пунктов 1/);
    });

    it('свой пункт закрывается от имени прогона своего каталога', async () => {
      const home = tempDir('backlog-home-');
      const runDir = tempDir('backlog-rundir-');
      const dir = gitBed(item('an-item', { ...COMPLETE, status: 'in_progress', claimed_by: `run:${basename(runDir)}` }));
      itemFile(runDir, 'a', 'an-item');

      const result = await ownerBacklog(dir, home, ['settle', '--run-dir', runDir]);

      assert.equal(result.code, ExitCode.ok, result.stderr);
      assert.equal(fieldOf(read(dir), 'an-item', 'status'), 'failed');
    });
  });
});

describe('CLI: очередь под lock-файлом', () => {
  const cliBin = join(findPackageRoot(fileURLToPath(new URL('.', import.meta.url))), 'dist', 'src', 'bin.js');

  /** Отдельный процесс бинаря: гонку писателей можно проверить только между процессами. */
  function spawnBacklog(cwd: string, argv: readonly string[]): Promise<{ code: number | null; stdout: string }> {
    return new Promise((done) => {
      const child = spawn(process.execPath, [cliBin, 'backlog', ...argv], {
        cwd,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on('exit', (code) => done({ code, stdout }));
    });
  }

  function statusOf(text: string, slug: string): string | undefined {
    const block = text.split(/^## /mu).find((part) => part.startsWith(slug));
    return /^status: (.*)$/mu.exec(block ?? '')?.[1];
  }

  it('два одновременных pick над двумя свободными пунктами выдают разные пункты', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const dir = bed(item('one', COMPLETE), item('two', COMPLETE));

      const results = await Promise.all([spawnBacklog(dir, ['pick']), spawnBacklog(dir, ['pick'])]);

      assert.deepEqual(results.map((r) => r.code), [0, 0]);
      const slugs = results.map((r) => (JSON.parse(r.stdout) as readonly { slug: string }[]).map((e) => e.slug));
      assert.deepEqual(slugs.flat().sort(), ['one', 'two']);
      const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
      assert.equal(statusOf(text, 'one'), 'in_progress');
      assert.equal(statusOf(text, 'two'), 'in_progress');
    }
  });

  it('два одновременных finish разным пунктам — оба исхода в файле', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const dir = bed(
        item('one', { ...COMPLETE, status: 'in_progress' }),
        item('two', { ...COMPLETE, status: 'in_progress' }),
      );

      const results = await Promise.all([
        spawnBacklog(dir, ['finish', 'one', '--status', 'done']),
        spawnBacklog(dir, ['finish', 'two', '--status', 'failed', '--reason', 'красная']),
      ]);

      assert.deepEqual(results.map((r) => r.code), [0, 0]);
      const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
      assert.equal(statusOf(text, 'one'), 'done');
      assert.equal(statusOf(text, 'two'), 'failed');
    }
  });

  it('отказавший finish не оставляет lock-файла', async () => {
    const dir = bed(item('one', COMPLETE));

    const result = await backlog(dir, ['finish', 'нет-такого', '--status', 'done']);

    assert.equal(result.code, ExitCode.configError);
    assert.equal(existsSync(join(dir, '.backlog.lock')), false);
  });

  it('list при занятом lock-файле отвечает сразу и других lock-файлов не создаёт', async () => {
    const dir = bed(item('one', COMPLETE));
    const lock = join(dir, '.backlog.lock');
    const held = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      command: 'backlog pick',
      acquired_at: new Date().toISOString(),
    });
    writeFileSync(lock, held);
    const started = Date.now();

    const result = await backlog(dir, ['list']);

    assert.equal(result.code, ExitCode.ok);
    assert.ok(Date.now() - started < 5000, 'list не ждёт писателя');
    assert.deepEqual(readdirSync(dir).sort(), ['.backlog.lock', 'backlog.md']);
    assert.equal(readFileSync(lock, 'utf8'), held);
  });
});

describe('CLI: burnex backlog add', () => {
  const NEW = ['--title', 'Новый', '--why', 'Затем', '--done-when', 'Готово'];

  function queue(dir: string): string {
    return readFileSync(join(dir, 'backlog.md'), 'utf8');
  }

  it('добавляет пункт в конец, прежний текст не меняется, list показывает его', async () => {
    const dir = bed(item('first-item', COMPLETE), item('second-item', COMPLETE));
    const before = queue(dir);

    const result = await backlog(dir, ['add', 'new-item', ...NEW]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    const after = queue(dir);
    assert.ok(after.startsWith(before.replace(/\n*$/u, '')));
    assert.match(after, /\n## new-item\n\nstatus: todo\ntitle: Новый\nwhy: Затем\ndone_when: Готово\n$/u);
    const listed = JSON.parse((await backlog(dir, ['list'])).stdout) as { slug: string }[];
    assert.deepEqual(listed.map((entry) => entry.slug), ['first-item', 'second-item', 'new-item']);
  });

  it('--after ставит пункт сразу за названным, опциональные поля попадают в запись', async () => {
    const dir = bed(item('first-item', COMPLETE), item('second-item', COMPLETE));
    writeFileSync(join(dir, 'goal.md'), 'цель');

    const result = await backlog(dir, [
      'add', 'new-item', ...NEW,
      '--after', 'first-item', '--group', 'grp', '--track', 'express', '--needs', 'second-item', '--goal', 'goal.md',
    ]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    const listed = JSON.parse((await backlog(dir, ['list'])).stdout) as Record<string, unknown>[];
    assert.deepEqual(listed.map((entry) => entry['slug']), ['first-item', 'new-item', 'second-item']);
    assert.equal(listed[1]?.['group'], 'grp');
    assert.equal(listed[1]?.['track'], 'express');
    assert.deepEqual(listed[1]?.['needs'], ['second-item']);
    assert.equal(listed[1]?.['goal'], 'goal.md');
  });

  it('--status postponed записывает статус, и pick пункт не берёт', async () => {
    const dir = bed();

    const added = await backlog(dir, ['add', 'new-item', ...NEW, '--status', 'postponed']);
    const picked = await backlog(dir, ['pick']);

    assert.equal(added.code, ExitCode.ok, added.stderr);
    assert.match(queue(dir), /status: postponed/u);
    assert.deepEqual(JSON.parse(picked.stdout), []);
  });

  it('отказы кодом 2 оставляют файл нетронутым', async () => {
    const dir = bed(item('first-item', COMPLETE));
    writeFileSync(join(dir, 'archived.md'), `# Архив\n\n${item('old-item', { ...COMPLETE, status: 'done' })}`);
    const before = queue(dir);
    const cases: readonly (readonly string[])[] = [
      ['first-item', ...NEW],
      ['old-item', ...NEW],
      ['Bad_Slug', ...NEW],
      ['new-item', '--why', 'з', '--done-when', 'к'],
      ['new-item', '--title', '', '--why', 'з', '--done-when', 'к'],
      ['new-item', ...NEW, '--needs', 'ghost'],
      ['new-item', ...NEW, '--track', 'Не Слаг'],
      ['new-item', ...NEW, '--goal', 'нет-файла.md'],
      ['new-item', ...NEW, '--status', 'done'],
      ['new-item', ...NEW, '--after', 'ghost'],
      ['new-item', '--title', 'две\nстроки', '--why', 'з', '--done-when', 'к'],
    ];

    for (const argv of cases) {
      const result = await backlog(dir, ['add', ...argv]);
      assert.equal(result.code, ExitCode.configError, argv.join(' '));
      assert.equal(queue(dir), before, argv.join(' '));
    }
    assert.deepEqual(readdirSync(dir).sort(), ['archived.md', 'backlog.md']);
  });

  it('без слага отказывает', async () => {
    const dir = bed();

    const result = await backlog(dir, ['add', ...NEW]);

    assert.equal(result.code, ExitCode.configError);
  });

  it('зависимость на архивный пункт допустима', async () => {
    const dir = bed();
    writeFileSync(join(dir, 'archived.md'), `# Архив\n\n${item('old-item', { ...COMPLETE, status: 'done' })}`);

    const result = await backlog(dir, ['add', 'new-item', ...NEW, '--needs', 'old-item']);

    assert.equal(result.code, ExitCode.ok, result.stderr);
  });

  it('два одновременных add несут оба пункта', async () => {
    const cliBin = join(findPackageRoot(fileURLToPath(new URL('.', import.meta.url))), 'dist', 'src', 'bin.js');
    const spawnAdd = (cwd: string, slug: string): Promise<number | null> =>
      new Promise((done) => {
        const child = spawn(process.execPath, [cliBin, 'backlog', 'add', slug, ...NEW], { cwd, stdio: 'ignore' });
        child.on('exit', (code) => done(code));
      });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const dir = bed(item('first-item', COMPLETE));

      const codes = await Promise.all([spawnAdd(dir, 'one-new'), spawnAdd(dir, 'two-new')]);

      assert.deepEqual(codes, [0, 0]);
      const slugs = (JSON.parse((await backlog(dir, ['list'])).stdout) as { slug: string }[]).map((e) => e.slug);
      assert.deepEqual(slugs.sort(), ['first-item', 'one-new', 'two-new']);
    }
  });
});

describe('CLI: burnex backlog show', () => {
  it('печатает запись пункта и не правит файл', async () => {
    const dir = bed(item('first-item', COMPLETE), item('second-item', { ...COMPLETE, track: 'express' }));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const result = await backlog(dir, ['show', 'second-item']);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    const listed = JSON.parse((await backlog(dir, ['list'])).stdout) as unknown[];
    assert.deepEqual(JSON.parse(result.stdout), listed[1]);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('--run-dir пишет ту же запись в item-a.json', async () => {
    const dir = bed(item('first-item', COMPLETE));
    const runDir = join(dir, 'run', 'nested');

    const result = await backlog(dir, ['show', 'first-item', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'item-a.json'), 'utf8')), JSON.parse(result.stdout));
  });

  it('отсутствующий слаг: код 2, item-a.json не создаётся', async () => {
    const dir = bed(item('first-item', COMPLETE));
    const runDir = join(dir, 'run');

    const result = await backlog(dir, ['show', 'ghost', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.configError);
    assert.equal(existsSync(join(runDir, 'item-a.json')), false);
  });

  it('без слага отказывает', async () => {
    const dir = bed(item('first-item', COMPLETE));

    assert.equal((await backlog(dir, ['show'])).code, ExitCode.configError);
  });
});
