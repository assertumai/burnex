import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  cabinetDir,
  defaultPipelineFile,
  defaultPipelineName,
  hasLegacyCabinet,
  homeRoot,
  migrateHomeRoot,
} from '../src/kernel/dirs.js';
import { parseArgs } from '../src/kernel/cli/args.js';
import { ExitCode } from '../src/kernel/errors.js';
import { row as lintRow, runLintCommand } from '../src/parts/pipeline/commands/lint.js';
import { findProjectRoot } from '../src/parts/pipeline/run/journal/paths.js';
import { withHome } from './helpers.js';
import { tempDir } from './tmp.js';

const LINT_SPEC = lintRow.command.spec;

describe('kernel/dirs: кабинет проекта', () => {
  it('новый проект — .burnex, даже когда каталога ещё нет', () => {
    const root = tempDir('dirs-');
    assert.equal(cabinetDir(root), join(root, '.burnex'));
    assert.equal(hasLegacyCabinet(root), false);
  });

  it('проект с одним лишь .stepcast читается из него и считается прежним', () => {
    const root = tempDir('dirs-');
    mkdirSync(join(root, '.stepcast'));
    assert.equal(cabinetDir(root), join(root, '.stepcast'));
    assert.equal(hasLegacyCabinet(root), true);
  });

  it('при обоих каталогах побеждает .burnex', () => {
    const root = tempDir('dirs-');
    mkdirSync(join(root, '.stepcast'));
    mkdirSync(join(root, '.burnex'));
    assert.equal(cabinetDir(root), join(root, '.burnex'));
    assert.equal(hasLegacyCabinet(root), false);
  });

  it('корень проекта находится по прежнему маркеру .stepcast/config.yml', () => {
    const root = tempDir('dirs-');
    mkdirSync(join(root, '.stepcast'));
    writeFileSync(join(root, '.stepcast', 'config.yml'), '');
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    assert.equal(findProjectRoot(nested), realpathSync(root));
  });
});

describe('kernel/dirs: пайплайн по умолчанию', () => {
  it('burnex.yml, при его отсутствии — stepcast.yml, без обоих — burnex.yml', () => {
    const cwd = tempDir('dirs-');
    assert.equal(defaultPipelineName(cwd), 'burnex.yml');
    writeFileSync(join(cwd, 'stepcast.yml'), 'kind: pipeline\n');
    assert.equal(defaultPipelineFile(cwd), join(cwd, 'stepcast.yml'));
    assert.equal(defaultPipelineName(cwd), 'stepcast.yml');
    writeFileSync(join(cwd, 'burnex.yml'), 'kind: pipeline\n');
    assert.equal(defaultPipelineName(cwd), 'burnex.yml');
  });
});

describe('kernel/dirs: домашний каталог', () => {
  it('~/.burnex, при его отсутствии — существующий ~/.stepcast; чтение ничего не переносит', () => {
    const home = tempDir('dirs-home-');
    assert.equal(homeRoot(home), join(home, '.burnex'));
    mkdirSync(join(home, '.stepcast'));
    assert.equal(homeRoot(home), join(home, '.stepcast'));
    assert.equal(existsSync(join(home, '.burnex')), false);
  });

  it('перенос: ~/.stepcast переименован в ~/.burnex, на прежнем месте ссылка, содержимое доступно по обоим путям', () => {
    const home = tempDir('dirs-home-');
    mkdirSync(join(home, '.stepcast', 'releases'), { recursive: true });
    writeFileSync(join(home, '.stepcast', 'install.json'), '{}');

    const outcome = migrateHomeRoot(home);
    assert.deepEqual(outcome, { from: join(home, '.stepcast'), to: join(home, '.burnex') });
    assert.equal(readFileSync(join(home, '.burnex', 'install.json'), 'utf8'), '{}');
    assert.equal(lstatSync(join(home, '.stepcast')).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(home, '.stepcast')), '.burnex');
    assert.equal(readFileSync(join(home, '.stepcast', 'install.json'), 'utf8'), '{}');
    assert.equal(homeRoot(home), join(home, '.burnex'));
  });

  it('переносить нечего: нет прежнего, уже есть новый, либо прежний — ссылка', () => {
    const empty = tempDir('dirs-home-');
    assert.equal(migrateHomeRoot(empty), undefined);

    const both = tempDir('dirs-home-');
    mkdirSync(join(both, '.stepcast'));
    mkdirSync(join(both, '.burnex'));
    assert.equal(migrateHomeRoot(both), undefined);
    assert.equal(lstatSync(join(both, '.stepcast')).isDirectory(), true);

    const linked = tempDir('dirs-home-');
    mkdirSync(join(linked, '.stepcast'));
    assert.notEqual(migrateHomeRoot(linked), undefined);
    assert.equal(migrateHomeRoot(linked), undefined);
  });
});

describe('burnex lint: кабинет под прежним именем', () => {
  it('предупреждает и называет команду переименования; ошибкой не считается', () => {
    const base = tempDir('dirs-lint-');
    const root = join(base, 'work');
    const home = join(base, 'home');
    mkdirSync(join(root, '.stepcast'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(root, '.stepcast', 'config.yml'), '');
    writeFileSync(
      join(root, 'stepcast.yml'),
      'version: 1\nkind: pipeline\nname: legacy\nbudget: { tokens: 1000 }\njobs:\n  a:\n    steps:\n      - { id: s, run: [echo, ok] }\n',
    );
    const lines: string[] = [];
    const status = withHome(home, () => runLintCommand(parseArgs(['lint'], { lint: LINT_SPEC }), (line) => lines.push(line), root));
    assert.equal(status, ExitCode.ok);
    const text = lines.join('\n');
    assert.match(text, /\.stepcast\/ — прежним именем/);
    assert.match(text, /git mv \.stepcast \.burnex/);
    assert.match(text, /ok: stepcast\.yml \(предупреждений \d+\)/);
  });
});
