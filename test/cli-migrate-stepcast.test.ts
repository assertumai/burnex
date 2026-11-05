import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseArgs } from '../src/kernel/cli/args.js';
import { ExitCode } from '../src/kernel/errors.js';
import { collectMigrationFindings, homeFindings, row, runMigrateStepcastCommand } from '../src/parts/pipeline/commands/migrate-stepcast.js';
import { tempDir } from './tmp.js';

const SPEC = { 'migrate-stepcast': row.command.spec };

function project(files: Readonly<Record<string, string>>): string {
  const root = tempDir('migrate-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('burnex migrate-stepcast: отсылки проекта на прежнее имя', () => {
  it('каталог .stepcast/ и stepcast.yml в корне — переименовать', () => {
    const root = project({ '.stepcast/config.yml': '', 'stepcast.yml': 'kind: pipeline\n' });
    const findings = collectMigrationFindings(root);
    const fixes = findings.map((f) => `${f.where} ${f.fix}`);
    assert.ok(fixes.includes('.stepcast/ git mv .stepcast .burnex'), fixes.join('\n'));
    assert.ok(fixes.includes('stepcast.yml git mv stepcast.yml burnex.yml'), fixes.join('\n'));
  });

  it('при обоих каталогах просит объединить, а не переименовать', () => {
    const root = project({ '.stepcast/a': '', '.burnex/b': '' });
    const [cabinet] = collectMigrationFindings(root).filter((f) => f.where === '.stepcast/');
    assert.match(cabinet?.fix ?? '', /рядом уже есть \.burnex\//);
  });

  it('в тексте находит переменные, адреса, подпути, модули, вызовы, права, пути и метку — каждое с заменой и строкой', () => {
    const root = project({
      '.burnex/pipelines/p.yml': [
        'kind: pipeline',
        'env: { X: "$STEPCAST_JOB_DIR" }',
        'schema: stepcast:step-script',
        'plugins: [stepcast/backends/codex]',
        'run: [sh, -c, "stepcast data set k v"]',
        'allow: ["Bash(stepcast data *)"]',
        '# см. .stepcast/jobs и ~/.stepcast/config.yml, ai.stepcast.daemon, node_modules/stepcast',
        'uses: stepcast.yml',
      ].join('\n'),
      '.burnex/widgets/w.tsx': "import { slot } from '@stepcast/slots';\n",
    });
    const findings = collectMigrationFindings(root);
    const pairs = findings.map((f) => [f.where, f.line, f.found, f.fix] as const);
    const expect = (found: string, fix: string, line: number) =>
      assert.ok(
        pairs.some((p) => p[2] === found && p[3] === fix && p[1] === line),
        `нет находки ${found} ${fix} в строке ${line}; есть:\n${pairs.map((p) => p.join(' ')).join('\n')}`,
      );
    expect('STEPCAST_JOB_DIR', '→ BURNEX_JOB_DIR', 2);
    expect('stepcast:step-script', '→ burnex:step-script', 3);
    expect('stepcast/backends', '→ burnex/backends', 4);
    expect('stepcast ', '→ burnex ', 5);
    expect('Bash(stepcast', '→ Bash(burnex', 6);
    expect('.stepcast', '→ .burnex', 7);
    expect('ai.stepcast.daemon', '→ ai.burnex.daemon', 7);
    expect('node_modules/stepcast', '→ node_modules/burnex', 7);
    expect('stepcast.yml', '→ burnex.yml', 8);
    expect('@stepcast/slots', '→ @burnex/slots', 1);
    // Дважды одно место не считается: `~/.stepcast/config.yml` даёт одну находку `.stepcast`, а не ещё и по пути.
    assert.equal(pairs.filter((p) => p[1] === 7 && p[2] === '.stepcast').length, 2);
  });

  it('слово stepcast в прозе и имя burnex-after-stepcast.md отсылками не считаются; .git и node_modules не читаются', () => {
    const root = project({
      'docs/burnex-after-stepcast.md': 'Движок stepcast был переименован. Stepcast — прежнее имя.\n',
      'node_modules/x/index.js': 'process.env.STEPCAST_JOB\n',
      '.claude/worktrees/w/.stepcast/config.yml': 'runs: {}\n',
      '.git/config': 'stepcast.yml\n',
    });
    assert.deepEqual(collectMigrationFindings(root), []);
  });

  it('домашний каталог: ~/.stepcast без ~/.burnex и паспорт npm с пакетом stepcast', () => {
    const home = tempDir('migrate-home-');
    mkdirSync(join(home, '.stepcast'));
    writeFileSync(join(home, '.stepcast', 'install.json'), JSON.stringify({ method: 'npm', package: 'stepcast' }));
    const findings = homeFindings(home, {});
    assert.equal(findings.length, 2);
    assert.match(findings[0]?.fix ?? '', /install\.sh, burnex up или burnex update/);
    assert.match(findings[1]?.fix ?? '', /"package": "burnex"/);

    mkdirSync(join(home, '.burnex'));
    assert.equal(homeFindings(home, {}).filter((f) => f.where === '~/.stepcast').length, 0);
  });

  it('команда: чистый проект — ok и код 0, с находками — перечень, итог и код ошибки конфигурации; --json — машинно', () => {
    const clean = project({ '.burnex/config.yml': '', 'burnex.yml': 'kind: pipeline\n' });
    const home = tempDir('migrate-home-');
    const lines: string[] = [];
    assert.equal(runMigrateStepcastCommand(parseArgs(['migrate-stepcast'], SPEC), (l) => lines.push(l), clean, home), ExitCode.ok);
    assert.match(lines.join('\n'), /^ok: отсылок на stepcast/);

    const dirty = project({ '.stepcast/config.yml': 'runs:\n  root: ~/.stepcast/runs\n' });
    const out: string[] = [];
    const code = runMigrateStepcastCommand(parseArgs(['migrate-stepcast', dirty], SPEC), (l) => out.push(l), '/', home);
    assert.equal(code, ExitCode.configError);
    const text = out.join('\n');
    assert.match(text, /\.stepcast\/: кабинет проекта под прежним именем git mv \.stepcast \.burnex/);
    assert.match(text, /\.stepcast\/config\.yml:2: \.stepcast → \.burnex/);
    assert.match(text, /отсылок на stepcast 2$/m);

    const files: string[] = [];
    runMigrateStepcastCommand(parseArgs(['migrate-stepcast', dirty, '--files'], SPEC), (l) => files.push(l), '/', home);
    assert.equal(files[0], '.stepcast/: 1');
    assert.equal(files[1], '.stepcast/config.yml: 1');

    const json: string[] = [];
    runMigrateStepcastCommand(parseArgs(['migrate-stepcast', dirty, '--json'], SPEC), (l) => json.push(l), '/', home);
    const parsed = JSON.parse(json.join('\n')) as { root: string; findings: readonly { where: string }[] };
    assert.equal(parsed.findings.length, 2);
  });
});
