import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { gitCommit, gitInit, makeProject, testBaseEnv } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * `scripts/self-improve-loop.sh` гоняется на одноразовом репозитории с
 * поддельным движком: `build` кладёт в `dist/src/bin.js` крошечную программу,
 * которая по файлу-сценарию (вне репозитория) коммитит в копию либо нет и
 * выходит заданным кодом. Настоящий stepcast, сеть и зависимости не нужны:
 * пакет без зависимостей и пустой lockfile.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/self-improve-loop.sh', import.meta.url));

// Строка сценария — «<действие> <код выхода>»; действие commit коммитит
// пустой коммит, commit-lock — правку lockfile, commit-improve — правку
// исходника движка (метки), drop-branch — удаляет ветку копии, none — ничего.
const FAKE_BIN = [
  "const { readFileSync, writeFileSync, appendFileSync, existsSync } = require('node:fs');",
  "const { execFileSync } = require('node:child_process');",
  "const MARK = 'committed';",
  'const counter = process.env.COUNTER_FILE;',
  "const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;",
  'writeFileSync(counter, String(n));',
  "appendFileSync(process.env.CALLS_LOG, JSON.stringify({ n, mark: MARK, argv: process.argv.slice(2) }) + '\\n');",
  "const line = readFileSync(process.env.SCENARIO_FILE, 'utf8').trim().split('\\n')[n - 1];",
  'if (line === undefined) process.exit(99);',
  "const [action, code] = line.split(' ');",
  "const git = (...args) => execFileSync('git', args, { stdio: 'ignore' });",
  "if (action === 'commit') git('commit', '--allow-empty', '-m', 'итерация ' + n);",
  "if (action === 'commit-lock') {",
  "  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));",
  '  lock.touched = n;',
  "  writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\\n');",
  "  git('add', 'package-lock.json');",
  "  git('commit', '-m', 'lock ' + n);",
  '}',
  "if (action === 'commit-improve') {",
  "  writeFileSync('fake-bin.js', readFileSync('fake-bin.js', 'utf8').replace(\"'committed'\", \"'improved'\"));",
  "  git('add', 'fake-bin.js');",
  "  git('commit', '-m', 'улучшение ' + n);",
  '}',
  "if (action === 'drop-branch') {",
  "  git('checkout', '--quiet', '--detach');",
  "  git('branch', '-D', 'main');",
  '}',
  'process.exit(Number(code));',
  '',
].join('\n');

interface Bed {
  readonly repo: string;
  readonly engine: string;
  readonly scratch: string;
  readonly script: string;
}

interface Run {
  readonly status: number;
  readonly stderr: string;
}

/** Репозиторий с копией скрипта в `scripts/` и каталогом движка вне него. */
function makeBed(options: { build?: string } = {}): Bed {
  const project = makeProject({
    'package.json':
      JSON.stringify(
        {
          name: 'fake-engine',
          version: '1.0.0',
          private: true,
          // Локальная зависимость нужна затем, что `npm ci` пакета вовсе без
          // зависимостей node_modules не создаёт, а скрипт его отсутствие
          // читает как повод ставить заново.
          dependencies: { dep: 'file:./dep' },
          scripts: {
            preinstall: `node -e "require('fs').appendFileSync(process.env.NPM_CI_LOG, 'x'); if (process.env.NPM_CI_FAIL) process.exit(1)"`,
            build: options.build ?? 'mkdir -p dist/src && cp fake-bin.js dist/src/bin.js',
          },
        },
        null,
        2,
      ) + '\n',
    'dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0' }) + '\n',
    'fake-bin.js': FAKE_BIN,
  });
  // Lockfile пишет сам npm: ни сети, ни реестра для зависимости-каталога не нужно.
  execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund', '--ignore-scripts'], {
    cwd: project.root,
    stdio: 'ignore',
  });
  mkdirSync(project.path('scripts'), { recursive: true });
  const script = project.path('scripts/self-improve-loop.sh');
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);
  gitInit(project.root);
  gitCommit(project.root, 'начальный');

  const holder = tempDir('loop-script-');
  return { repo: project.root, engine: join(holder, 'engine'), scratch: holder, script };
}

function run(bed: Bed, scenario: readonly string[], env: Record<string, string> = {}, cwd = bed.repo): Run {
  writeFileSync(join(bed.scratch, 'scenario'), scenario.join('\n') + '\n');
  const result = spawnSync('bash', [bed.script], {
    cwd,
    encoding: 'utf8',
    env: {
      ...testBaseEnv(),
      BURNEX_LOOP_ENGINE_DIR: bed.engine,
      SCENARIO_FILE: join(bed.scratch, 'scenario'),
      COUNTER_FILE: join(bed.scratch, 'counter'),
      CALLS_LOG: join(bed.scratch, 'calls.log'),
      NPM_CI_LOG: join(bed.scratch, 'npm-ci.log'),
      ...env,
    },
  });
  return { status: result.status ?? -1, stderr: result.stderr };
}

function calls(bed: Bed): { n: number; mark: string; argv: string[] }[] {
  const log = join(bed.scratch, 'calls.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { n: number; mark: string; argv: string[] });
}

function npmCiCount(bed: Bed): number {
  const log = join(bed.scratch, 'npm-ci.log');
  return existsSync(log) ? readFileSync(log, 'utf8').length : 0;
}

describe('scripts/self-improve-loop.sh', () => {
  it('движок коммитит каждый раз, MAX_RUNS=2 → две итерации, код 0', () => {
    const bed = makeBed();
    const result = run(bed, ['commit 0', 'commit 0'], { MAX_RUNS: '2' });

    assert.equal(result.status, 0);
    assert.match(result.stderr, /self-improve-loop: остановка — исчерпан MAX_RUNS \(итераций выполнено: 2\)/);
    const seen = calls(bed);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0]!.argv, ['run', '.burnex/pipelines/self-improve.yml', '--input', 'onto=main']);
  });

  it('нет коммита при коде прогона 0 → остановка с кодом 0', () => {
    const bed = makeBed();
    const result = run(bed, ['none 0']);

    assert.equal(result.status, 0);
    assert.match(result.stderr, /остановка — прогон ничего не закоммитил \(итераций выполнено: 1\)/);
    assert.equal(calls(bed).length, 1);
  });

  it('нет коммита при коде прогона 3 → код выхода 3', () => {
    const bed = makeBed();
    const result = run(bed, ['none 3']);

    assert.equal(result.status, 3);
    assert.match(result.stderr, /код прогона 3/);
  });

  it('коммит при красном прогоне (код 1) не останавливает петлю', () => {
    const bed = makeBed();
    const result = run(bed, ['commit 1', 'none 0']);

    assert.equal(result.status, 0);
    assert.equal(calls(bed).length, 2);
  });

  it('сломанная сборка → код 1, прогон не звался', () => {
    const bed = makeBed({ build: 'exit 1' });
    const result = run(bed, ['commit 0']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /остановка — не удалась подготовка движка/);
    assert.deepEqual(calls(bed), []);
  });

  it('отделённый HEAD → код 2', () => {
    const bed = makeBed();
    execFileSync('git', ['-C', bed.repo, 'checkout', '--quiet', '--detach'], { stdio: 'ignore' });
    const result = run(bed, ['commit 0']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /HEAD копии отделён/);
    assert.deepEqual(calls(bed), []);
  });

  for (const bad of ['abc', '0', '-3']) {
    it(`MAX_RUNS=«${bad}» → код 2`, () => {
      const bed = makeBed();
      const result = run(bed, ['commit 0'], { MAX_RUNS: bad });

      assert.equal(result.status, 2);
      assert.match(result.stderr, /MAX_RUNS/);
      assert.deepEqual(calls(bed), []);
    });
  }

  it('npm ci не повторяется при неизменном lockfile', () => {
    const bed = makeBed();
    run(bed, ['commit 0', 'commit 0'], { MAX_RUNS: '2' });

    assert.equal(npmCiCount(bed), 1);
  });

  it('npm ci повторяется после коммита, меняющего lockfile', () => {
    const bed = makeBed();
    run(bed, ['commit 0', 'commit-lock 0', 'commit 0'], { MAX_RUNS: '3' });

    assert.equal(npmCiCount(bed), 2);
  });

  it('незакоммиченная правка исходника движка в копии в итерацию не попадает', () => {
    const bed = makeBed();
    const source = join(bed.repo, 'fake-bin.js');
    writeFileSync(source, readFileSync(source, 'utf8').replace("'committed'", "'dirty'"));
    const result = run(bed, ['none 0']);

    assert.equal(result.status, 0);
    assert.deepEqual(
      calls(bed).map((call) => call.mark),
      ['committed'],
    );
  });

  it('закоммиченное итерацией улучшение движка работает в следующей итерации', () => {
    const bed = makeBed();
    const result = run(bed, ['commit-improve 0', 'none 0']);

    assert.equal(result.status, 0);
    assert.deepEqual(
      calls(bed).map((call) => call.mark),
      ['committed', 'improved'],
    );
  });

  it('упавший npm ci → код 1, прогон не звался', () => {
    const bed = makeBed();
    const result = run(bed, ['commit 0'], { NPM_CI_FAIL: '1' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /остановка — не удалась подготовка движка/);
    assert.deepEqual(calls(bed), []);
  });

  it('без BURNEX_LOOP_ENGINE_DIR worktree движка лежит в <git common dir>/burnex-loop-engine', () => {
    const bed = makeBed();
    const result = run(bed, ['none 0'], { BURNEX_LOOP_ENGINE_DIR: '' });

    assert.equal(result.status, 0);
    assert.ok(existsSync(join(bed.repo, '.git/burnex-loop-engine/dist/src/bin.js')));
    assert.equal(calls(bed).length, 1);
  });

  it('относительный BURNEX_LOOP_ENGINE_DIR считается от текущего каталога, а не от корня копии', () => {
    const bed = makeBed();
    const result = run(bed, ['none 0'], { BURNEX_LOOP_ENGINE_DIR: 'engine-rel' }, bed.scratch);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(bed.scratch, 'engine-rel/dist/src/bin.js')));
    assert.ok(!existsSync(join(bed.repo, 'engine-rel')));
    assert.equal(calls(bed).length, 1);
  });

  it('каталог движка, удалённый руками, пересоздаётся следующим запуском', () => {
    const bed = makeBed();
    assert.equal(run(bed, ['none 0']).status, 0);
    rmSync(bed.engine, { recursive: true, force: true });
    const result = run(bed, ['none 0', 'none 0']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls(bed).length, 2);
  });

  it('порождённое прошлой сборкой в dist/ следующую итерацию не переживает', () => {
    const bed = makeBed();
    assert.equal(run(bed, ['none 0']).status, 0);
    const orphan = join(bed.engine, 'dist/src/orphan.js');
    writeFileSync(orphan, '// осиротевший\n');
    assert.equal(run(bed, ['none 0', 'none 0']).status, 0);

    assert.ok(!existsSync(orphan));
  });

  it('ветка пропала посреди петли → код 1 с причиной', () => {
    const bed = makeBed();
    const result = run(bed, ['drop-branch 0']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /остановка — вершина ветки main не читается после прогона \(код прогона 0\) \(итераций выполнено: 1\)/);
  });

  it('имя ветки с символами оболочки → код 2, прогон не звался', () => {
    const bed = makeBed();
    execFileSync('git', ['-C', bed.repo, 'checkout', '--quiet', '-b', 'a$(id);b"c'], { stdio: 'ignore' });
    const result = run(bed, ['commit 0']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /вне набора/);
    assert.deepEqual(calls(bed), []);
  });

  it('незакоммиченный файл в копии не останавливает петлю', () => {
    const bed = makeBed();
    writeFileSync(join(bed.repo, 'черновик.txt'), 'правка человека\n');
    writeFileSync(join(bed.repo, 'package.json'), readFileSync(join(bed.repo, 'package.json'), 'utf8') + '\n');
    const result = run(bed, ['commit 0', 'none 0']);

    assert.equal(result.status, 0);
    assert.equal(calls(bed).length, 2);
    assert.match(result.stderr, /прогон ничего не закоммитил \(итераций выполнено: 2\)/);
  });
});
