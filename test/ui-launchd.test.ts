import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { daemonEntryPath } from '../src/parts/install/entry.js';
import type { InstallManifest } from '../src/parts/install/manifest.js';
import { runDownCommand } from '../src/parts/ui/commands/down.js';
import { runUpCommand } from '../src/parts/ui/commands/up.js';
import {
  agentPlistPath,
  renderPlist,
  type LaunchdHost,
  type PlistOptions,
} from '../src/parts/ui/daemon/launchd.js';
import type { ParsedArgs } from '../src/kernel/cli/args.js';
import { StepcastError } from '../src/kernel/errors.js';
import { tempDir } from './tmp.js';

function args(command: string, flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command, positional: [], flags };
}

function plistOptions(env: PlistOptions['env']): PlistOptions {
  return {
    execPath: '/usr/local/bin/node',
    binPath: '/opt/stepcast/bin.js',
    workingDirectory: '/work/proj',
    logFile: '/home/.stepcast/ui.log',
    env,
  };
}

/** Хозяин с записью вызовов `launchctl`: настоящий launchd тест не трогает. */
function fakeHost(platform: NodeJS.Platform): { host: LaunchdHost; calls: string[][]; home: string } {
  const home = tempDir('launchd-');
  const calls: string[][] = [];
  const host: LaunchdHost = {
    platform,
    home,
    uid: 501,
    launchctl: (argv) => {
      calls.push([...argv]);
      return { status: 0, stderr: '' };
    },
  };
  return { host, calls, home };
}

describe('launchd: plist', () => {
  it('несёт RunAtLoad, KeepAlive, PATH и SSH_AUTH_SOCK оболочки', () => {
    const plist = renderPlist(plistOptions({ PATH: '/a:/b', SSH_AUTH_SOCK: '/tmp/agent.sock' }));

    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(plist, /<key>PATH<\/key>\s*<string>\/a:\/b<\/string>/);
    assert.match(plist, /<key>SSH_AUTH_SOCK<\/key>\s*<string>\/tmp\/agent.sock<\/string>/);
    assert.match(plist, /<string>up<\/string>\s*<string>--foreground<\/string>/);
    assert.match(plist, /<key>Label<\/key>\s*<string>ai.stepcast.daemon<\/string>/);
  });

  it('не пишет незаданную или пустую переменную', () => {
    const plist = renderPlist(plistOptions({ PATH: '/a', SSH_AUTH_SOCK: '' }));

    assert.equal(plist.includes('SSH_AUTH_SOCK'), false);
    assert.equal(plist.includes('<key>PATH</key>'), true);
  });

  it('экранирует XML в путях', () => {
    const plist = renderPlist({ ...plistOptions({ PATH: '/a' }), workingDirectory: '/work/a&b <c>' });

    assert.equal(plist.includes('/work/a&amp;b &lt;c&gt;'), true);
    assert.equal(plist.includes('a&b'), false);
  });
});

describe('launchd: команды', () => {
  it('up --install пишет plist и вызывает bootstrap; повторная перезаписывает', async () => {
    const { host, calls, home } = fakeHost('darwin');
    const out: string[] = [];

    await runUpCommand(args('up', { install: true }), (line) => out.push(line), tempDir('cwd-'), host);
    const plist = agentPlistPath(home);
    assert.equal(existsSync(plist), true);
    assert.deepEqual(calls.at(-1), ['bootstrap', 'gui/501', plist]);
    assert.equal(out.some((line) => line.includes(plist)), true);

    writeFileSync(plist, 'устарел');
    await runUpCommand(args('up', { install: true }), () => undefined, tempDir('cwd-'), host);
    assert.equal(readFileSync(plist, 'utf8').includes('RunAtLoad'), true);
    assert.equal(calls.filter((call) => call[0] === 'bootstrap').length, 2);
    assert.equal(calls.filter((call) => call[0] === 'bootout').length, 2);
  });

  it('down выгружает агент и оставляет plist; --uninstall удаляет', async () => {
    const { host, calls, home } = fakeHost('darwin');
    await runUpCommand(args('up', { install: true }), () => undefined, tempDir('cwd-'), host);
    calls.length = 0;

    runDownCommand(args('down'), () => undefined, '.', host);
    assert.deepEqual(calls, [['bootout', `gui/501/ai.stepcast.daemon`]]);
    assert.equal(existsSync(agentPlistPath(home)), true);

    runDownCommand(args('down', { uninstall: true }), () => undefined, '.', host);
    assert.equal(existsSync(agentPlistPath(home)), false);
  });

  it('down --uninstall без plist сообщает об этом и завершается успешно', () => {
    const { host, calls } = fakeHost('darwin');
    const out: string[] = [];

    runDownCommand(args('down', { uninstall: true }), (line) => out.push(line), '.', host);

    assert.equal(out.includes('автозапуск не установлен'), true);
    assert.deepEqual(calls, []);
  });

  it('вне macOS --install и --uninstall отказывают без файлов и launchctl', async () => {
    const { host, calls, home } = fakeHost('linux');

    await assert.rejects(
      runUpCommand(args('up', { install: true }), () => undefined, tempDir('cwd-'), host),
      (error: unknown) => error instanceof StepcastError && error.message.includes('macOS'),
    );
    assert.throws(() => runDownCommand(args('down', { uninstall: true }), () => undefined, '.', host), StepcastError);

    assert.deepEqual(calls, []);
    assert.equal(existsSync(join(home, 'Library')), false);
  });

  it('обычный down вне macOS работает без launchctl', () => {
    const { host, calls, home } = fakeHost('linux');
    // Даже при наличии plist на чужой системе launchd не зовётся.
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });

    runDownCommand(args('down'), () => undefined, '.', host);

    assert.deepEqual(calls, []);
  });
});

const MANAGED = (releasesDir: string): InstallManifest => ({
  method: 'managed',
  repo: 'https://example.com/stepcast.git',
  ref: 'v0.3.0',
  version: '0.3.0',
  releases_dir: releasesDir,
});

describe('launchd: устойчивый путь входа через current', () => {
  const identity = (path: string): string => path;

  it('managed и движок внутри releases_dir — путь через current', () => {
    const entry = daemonEntryPath({
      engineRoot: '/h/.stepcast/releases/0.3.0',
      manifest: MANAGED('/h/.stepcast/releases'),
      fallback: '/h/.stepcast/releases/0.3.0/dist/src/bin.js',
      realpath: identity,
    });
    assert.equal(entry, '/h/.stepcast/releases/current/dist/src/bin.js');
  });

  it('движок вне releases_dir, другой способ или нет паспорта — прежний путь', () => {
    const fallback = '/work/stepcast/dist/src/bin.js';
    const base = { engineRoot: '/work/stepcast', fallback, realpath: identity };
    assert.equal(daemonEntryPath({ ...base, manifest: MANAGED('/h/.stepcast/releases') }), fallback);
    assert.equal(daemonEntryPath({ ...base, manifest: { method: 'checkout', dir: '/work/stepcast' } }), fallback);
    assert.equal(daemonEntryPath({ ...base, manifest: undefined }), fallback);
  });

  it('up --install кладёт в ProgramArguments путь через current при managed', async () => {
    const { host, home } = fakeHost('darwin');
    const releases = join(home, '.stepcast', 'releases');
    const engineRoot = join(releases, '0.3.0');
    mkdirSync(engineRoot, { recursive: true });
    writeFileSync(join(home, '.stepcast', 'install.json'), JSON.stringify(MANAGED(releases)));

    await withoutStepcastHome(() =>
      runUpCommand(args('up', { install: true }), () => undefined, tempDir('cwd-'), host, engineRoot),
    );

    const plist = readFileSync(agentPlistPath(home), 'utf8');
    assert.ok(plist.includes(`<string>${join(releases, 'current', 'dist', 'src', 'bin.js')}</string>`));
  });

  it('без паспорта в ProgramArguments прежний путь, а битый паспорт up не ломает', async () => {
    const { host, home } = fakeHost('darwin');
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    writeFileSync(join(home, '.stepcast', 'install.json'), '{не json');

    await withoutStepcastHome(() =>
      runUpCommand(args('up', { install: true }), () => undefined, tempDir('cwd-'), host),
    );

    const plist = readFileSync(agentPlistPath(home), 'utf8');
    assert.equal(plist.includes('/current/dist/src/bin.js'), false);
    assert.ok(plist.includes('bin.js'));
  });
});

async function withoutStepcastHome<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.STEPCAST_HOME;
  delete process.env.STEPCAST_HOME;
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env.STEPCAST_HOME = saved;
  }
}
