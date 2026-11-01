import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { CliIo } from '../src/kernel/cli/args.js';
import { run as runCli } from '../src/parts/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/kernel/errors.js';
import { makeProject, withHome, type Project } from './helpers.js';

/** `stepcast package list|new` (`packages-directory-layer`, Решение 9). */

interface Outcome {
  readonly code: ExitCodeValue;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(project: Project, argv: readonly string[]): Promise<Outcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    cwd: project.root,
  };
  const code = await withHome(project.home, () => runCli(argv, io));
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function manifest(name: string, extra = ''): string {
  return `version: 1\nkind: package\nname: ${name}\ndescription: Пример\npackage_version: 0.2.0\n${extra}`;
}

function writePackage(packagesDir: string, name: string, files: Record<string, string> = {}, text?: string): string {
  const dir = join(packagesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.yml'), text ?? manifest(name));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

const projectPackages = (project: Project): string => join(project.root, '.stepcast', 'packages');
const homePackages = (project: Project): string => join(project.home, '.stepcast', 'packages');

interface ListedPackage {
  readonly name: string;
  readonly layer: string;
  readonly status: string;
  readonly version?: string;
  readonly reason?: string;
  readonly shadowedBy?: string;
  readonly provides: readonly string[];
  readonly unmetNeeds?: Record<string, readonly string[]>;
}

describe('package list: перечень', () => {
  it('исправный, сломанный и затенённый пакеты — со слоем, версией, каталогом и статусом', async () => {
    const project = makeProject();
    const hello = writePackage(projectPackages(project), 'hello', {
      'pipelines/greet.yml': 'version: 1\nkind: pipeline\njobs: {}\n',
      'widgets/clock.tsx': 'export default 1;\n',
    });
    writePackage(homePackages(project), 'broken', {}, 'name: [oops\n');
    writePackage(homePackages(project), 'hello');

    const outcome = await cli(project, ['package', 'list']);
    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);

    const lines = outcome.stdout.split('\n');
    const helloLine = lines.find((line) => line.includes(hello));
    assert.match(helloLine ?? '', /^hello\s+проект\s+0\.2\.0\s/);
    assert.match(helloLine ?? '', /pipelines,widgets/);
    assert.match(helloLine ?? '', /действует$/);

    const brokenLine = lines.find((line) => line.startsWith('broken'));
    assert.match(brokenLine ?? '', /\shome\s/);
    assert.match(brokenLine ?? '', /сломан: .*package\.yml.*YAML/);

    const shadowedLine = lines.find((line) => line.startsWith('hello') && line.includes('home'));
    assert.match(shadowedLine ?? '', /затенён пакетом проекта$/);
  });

  it('--json отдаёт ту же модель машиночитаемо', async () => {
    const project = makeProject();
    writePackage(projectPackages(project), 'hello', { 'steps/greet/step.yml': 'x' });
    writePackage(homePackages(project), 'broken', {}, 'not: [valid');

    const outcome = await cli(project, ['package', 'list', '--json']);
    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);
    const listed = (JSON.parse(outcome.stdout) as { packages: ListedPackage[] }).packages;

    assert.deepEqual(listed.map((item) => [item.name, item.layer, item.status]), [
      ['hello', 'project', 'ok'],
      ['broken', 'home', 'broken'],
    ]);
    assert.equal(listed[0]?.version, '0.2.0');
    assert.deepEqual(listed[0]?.provides, ['steps']);
    assert.deepEqual((listed[0] as { contents?: unknown } | undefined)?.contents, { steps: ['greet'] });
    assert.match(listed[1]?.reason ?? '', /package\.yml/);
    assert.equal(listed[1]?.version, undefined);
  });

  it('без пакетов печатает «пакетов нет», код 0', async () => {
    const project = makeProject();
    const outcome = await cli(project, ['package', 'list']);
    assert.equal(outcome.code, ExitCode.ok);
    assert.equal(outcome.stdout, 'пакетов нет');
  });

  it('недостающая зависимость названа и статус пакета не меняет', async () => {
    const project = makeProject();
    writePackage(
      projectPackages(project),
      'hello',
      {},
      manifest('hello', 'needs:\n  packages: [tools, present]\n  backends: [claude, ghost]\n  mcp: [github]\n  secrets: [TOKEN]\n'),
    );
    writePackage(homePackages(project), 'present');

    const text = await cli(project, ['package', 'list']);
    assert.equal(text.code, ExitCode.ok, text.stderr);
    const helloLine = text.stdout.split('\n').find((line) => line.startsWith('hello'));
    assert.match(helloLine ?? '', /действует$/);
    const needsLine = text.stdout.split('\n').find((line) => line.includes('нужно:'));
    assert.match(needsLine ?? '', /packages: tools \(не найдены\)/);
    assert.match(needsLine ?? '', /backends: ghost \(не зарегистрированы\)/);
    assert.doesNotMatch(needsLine ?? '', /claude/);
    assert.match(needsLine ?? '', /mcp: github/);
    assert.match(needsLine ?? '', /secrets: TOKEN/);

    const json = await cli(project, ['package', 'list', '--json']);
    const listed = (JSON.parse(json.stdout) as { packages: ListedPackage[] }).packages;
    const hello = listed.find((item) => item.name === 'hello');
    assert.equal(hello?.status, 'ok');
    assert.deepEqual(hello?.unmetNeeds, { packages: ['tools'], backends: ['ghost'], mcp: ['github'], secrets: ['TOKEN'] });
  });

  it('работает, когда состав плагинов сломан', async () => {
    const project = makeProject({ '.stepcast/config.yml': 'plugins: ["./plugins/missing.mjs"]\n' });
    writePackage(projectPackages(project), 'hello', {}, manifest('hello', 'needs:\n  backends: [ghost]\n'));
    // Пакет home читается рядом с тем же глобальным конфигом, что и у
    // неудавшегося разрешения (`<home>/.stepcast/config.yml`).
    writePackage(homePackages(project), 'tools');

    // Остальные команды при таком составе отказывают…
    const status = await cli(project, ['status']);
    assert.notEqual(status.code, ExitCode.ok);

    // …а перечень пакетов печатается; реестра нет, backends не сверяются.
    const outcome = await cli(project, ['package', 'list']);
    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);
    assert.match(outcome.stdout, /^hello\s+проект\s+0\.2\.0/m);
    assert.match(outcome.stdout, /^tools\s+home\s+0\.2\.0/m);
    assert.doesNotMatch(outcome.stdout, /ghost/);
  });
});

describe('package new: заготовка', () => {
  it('создаёт пакет проекта с package.yml, проходящим схему, и list показывает его действующим', async () => {
    const project = makeProject();
    const outcome = await cli(project, ['package', 'new', 'greet']);
    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);

    const file = join(projectPackages(project), 'greet', 'package.yml');
    assert.ok(existsSync(file));
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^name: greet$/m);
    assert.match(text, /^package_version: 0\.1\.0$/m);

    const listed = await cli(project, ['package', 'list', '--json']);
    const item = (JSON.parse(listed.stdout) as { packages: ListedPackage[] }).packages[0];
    assert.deepEqual([item?.name, item?.status, item?.version], ['greet', 'ok', '0.1.0']);
  });

  it('--home заводит пакет в слое home', async () => {
    const project = makeProject();
    const outcome = await cli(project, ['package', 'new', 'tools', '--home']);
    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);
    assert.ok(existsSync(join(homePackages(project), 'tools', 'package.yml')));
    assert.equal(existsSync(join(projectPackages(project), 'tools')), false);

    const listed = await cli(project, ['package', 'list', '--json']);
    const item = (JSON.parse(listed.stdout) as { packages: ListedPackage[] }).packages[0];
    assert.deepEqual([item?.layer, item?.status], ['home', 'ok']);
  });

  it('существующий каталог не перезаписывается', async () => {
    const project = makeProject();
    const dir = writePackage(projectPackages(project), 'greet', { 'steps/keep.txt': 'мой' }, manifest('greet'));
    const before = readFileSync(join(dir, 'package.yml'), 'utf8');

    const outcome = await cli(project, ['package', 'new', 'greet']);
    assert.notEqual(outcome.code, ExitCode.ok);
    assert.match(outcome.stderr, /уже существует/);
    assert.equal(readFileSync(join(dir, 'package.yml'), 'utf8'), before);
    assert.equal(readFileSync(join(dir, 'steps', 'keep.txt'), 'utf8'), 'мой');
  });

  it('имя не по схеме и зарезервированное имя отказывают, каталог не создаётся', async () => {
    const project = makeProject();
    for (const name of ['Bad_Name', 'stepcast', 'builtin', 'a b']) {
      const outcome = await cli(project, ['package', 'new', name]);
      assert.notEqual(outcome.code, ExitCode.ok, name);
      assert.equal(existsSync(join(projectPackages(project), name)), false, name);
    }
    const reserved = await cli(project, ['package', 'new', 'stepcast']);
    assert.match(reserved.stderr, /зарезервировано/);
  });

  it('без имени и с неизвестным действием — отказ с подсказкой', async () => {
    const project = makeProject();
    const missing = await cli(project, ['package', 'new']);
    assert.notEqual(missing.code, ExitCode.ok);
    assert.match(missing.stderr, /Не назван пакет/);

    const unknown = await cli(project, ['package', 'drop']);
    assert.notEqual(unknown.code, ExitCode.ok);
    assert.match(unknown.stderr, /list, new/);
  });
});
