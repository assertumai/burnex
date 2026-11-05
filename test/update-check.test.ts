import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ParsedArgs } from '../src/kernel/cli/args.js';
import { StepcastError } from '../src/kernel/errors.js';
import { runUpdateCommand, type UpdateHost } from '../src/parts/install/commands/update.js';
import { parseInstallManifest } from '../src/parts/install/manifest.js';
import { CHECK_TIMEOUT_MS, checkUpdate, type UpdateStep } from '../src/parts/install/plan.js';

const SHA = 'a'.repeat(40);

const managed = parseInstallManifest(
  JSON.stringify({ method: 'managed', repo: '/srv/sc.git', ref: 'v0.3.0', version: '0.3.0', releases_dir: '/h/.burnex/releases' }),
);
const checkout = parseInstallManifest('{"method":"checkout","dir":"/work/sc"}');
const npm = parseInstallManifest('{"method":"npm","package":"stepcast"}');

interface Answers {
  tags?: readonly string[] | 'fail';
  porcelain?: string | 'fail';
  detached?: boolean;
  fetch?: 'fail';
  behind?: string | 'fail';
  npmVersion?: string | 'fail';
}

/** Поддельный хозяин: записывает вызовы и пределы времени, ни git, ни npm не трогает. */
function probe(answers: Answers): { capture: (step: UpdateStep, timeoutMs?: number) => string | undefined; calls: string[]; timeouts: (number | undefined)[] } {
  const calls: string[] = [];
  const timeouts: (number | undefined)[] = [];
  const capture = (step: UpdateStep, timeoutMs?: number): string | undefined => {
    calls.push([step.cmd, ...step.args].join(' '));
    timeouts.push(timeoutMs);
    const verb = step.cmd === 'npm' ? 'npm-view' : step.args[0];
    switch (verb) {
      case 'ls-remote':
        return answers.tags === 'fail' ? undefined : (answers.tags ?? []).map((tag) => `${SHA}\trefs/tags/${tag}`).join('\n');
      case 'status':
        return answers.porcelain === 'fail' ? undefined : (answers.porcelain ?? '');
      case 'symbolic-ref':
        return answers.detached === true ? undefined : 'refs/heads/main\n';
      case 'fetch':
        return answers.fetch === 'fail' ? undefined : '';
      case 'rev-list':
        return answers.behind === 'fail' ? undefined : `${answers.behind ?? '0'}\n`;
      case 'npm-view':
        return answers.npmVersion === 'fail' ? undefined : `${answers.npmVersion ?? '0.0.0'}\n`;
      default:
        return undefined;
    }
  };
  return { capture, calls, timeouts };
}

describe('update-check: checkUpdate', async () => {
  it('managed: новый тег — available с текущим и последним', async () => {
    const host = probe({ tags: ['v0.3.0', 'v0.10.0'] });
    assert.deepEqual(await checkUpdate(managed, host), { status: 'available', current: 'v0.3.0', latest: 'v0.10.0' });
  });

  it('managed: стоит последний тег — up-to-date', async () => {
    assert.deepEqual(await checkUpdate(managed, probe({ tags: ['v0.3.0'] })), { status: 'up-to-date', version: '0.3.0' });
  });

  it('managed: тегов нет — no-tags со словами плана', async () => {
    const result = await checkUpdate(managed, probe({ tags: [] }));
    assert.equal(result.status, 'no-tags');
    assert.match((result as { reason: string }).reason, /нет тегов vX\.Y\.Z/);
  });

  it('managed: ls-remote не ответил — unknown; предел передаётся команде', async () => {
    const host = probe({ tags: 'fail' });
    const result = await checkUpdate(managed, host, { timeoutMs: CHECK_TIMEOUT_MS, now: () => 0 });
    assert.equal(result.status, 'unknown');
    assert.match((result as { reason: string }).reason, /список тегов/);
    assert.deepEqual(host.timeouts, [CHECK_TIMEOUT_MS]);
  });

  it('без timeoutMs команды идут без предела — так проверяет burnex update', async () => {
    const host = probe({ tags: ['v0.3.0'] });
    await checkUpdate(managed, host);
    assert.deepEqual(host.timeouts, [undefined]);
  });

  it('checkout: предел общий на всю проверку — каждая команда получает остаток, исчерпанный предел — unknown без новых команд', async () => {
    let clock = 0;
    const answers = probe({ behind: '2' });
    const spent: Record<string, number> = { status: 3_000, 'symbolic-ref': 2_000, fetch: 16_000 };
    const host = {
      capture: (step: UpdateStep, timeoutMs?: number): string | undefined => {
        const out = answers.capture(step, timeoutMs);
        clock += spent[step.args[0] ?? ''] ?? 0;
        return out;
      },
    };
    const result = await checkUpdate(checkout, host, { timeoutMs: 20_000, now: () => clock });
    assert.deepEqual(answers.timeouts, [20_000, 17_000, 15_000]);
    assert.equal(result.status, 'unknown');
    assert.equal(answers.calls.includes('git rev-list --count HEAD..@{u}'), false);
  });

  it('асинхронный хозяин: ожидание ответа не держит цикл событий', async () => {
    let ticked = false;
    const host = {
      capture: (step: UpdateStep): Promise<string | undefined> =>
        new Promise((settle) => setTimeout(() => settle(step.args[0] === 'ls-remote' ? `${SHA}\trefs/tags/v0.4.0` : undefined), 20)),
    };
    const pending = checkUpdate(managed, host, { timeoutMs: CHECK_TIMEOUT_MS });
    setTimeout(() => {
      ticked = true;
    }, 0);
    assert.deepEqual(await pending, { status: 'available', current: 'v0.3.0', latest: 'v0.4.0' });
    assert.equal(ticked, true);
  });

  it('managed с --ref не ходит в сеть: стоит ровно этот тег — up-to-date', async () => {
    const host = probe({ tags: 'fail' });
    assert.deepEqual(await checkUpdate(managed, host, { ref: 'v0.3.0' }), { status: 'up-to-date', version: '0.3.0' });
    assert.deepEqual(host.calls, []);
  });

  it('checkout: позади на коммиты — available с числом после fetch', async () => {
    const host = probe({ behind: '3' });
    assert.deepEqual(await checkUpdate(checkout, host, { engineVersion: '1.2.3' }), { status: 'available', current: '1.2.3', commits: 3 });
    assert.equal(host.calls.includes('git fetch'), true);
    assert.ok(host.calls.indexOf('git fetch') < host.calls.indexOf('git rev-list --count HEAD..@{u}'));
  });

  it('checkout: не позади — up-to-date', async () => {
    assert.equal((await checkUpdate(checkout, probe({ behind: '0' }), { engineVersion: '1.2.3' })).status, 'up-to-date');
  });

  it('checkout: грязное дерево и отцеплённый HEAD — blocked, fetch не зовётся', async () => {
    const dirty = probe({ porcelain: ' M a.ts\n' });
    const dirtyResult = await checkUpdate(checkout, dirty);
    assert.equal(dirtyResult.status, 'blocked');
    assert.match((dirtyResult as { reason: string }).reason, /незакоммиченные/);
    assert.equal(dirty.calls.includes('git fetch'), false);

    const detached = probe({ detached: true });
    const detachedResult = await checkUpdate(checkout, detached);
    assert.equal(detachedResult.status, 'blocked');
    assert.match((detachedResult as { reason: string }).reason, /отцеплен/);
  });

  it('checkout: git status не удался, fetch не удался, нет вышестоящей — unknown', async () => {
    assert.equal((await checkUpdate(checkout, probe({ porcelain: 'fail' }))).status, 'unknown');
    assert.equal((await checkUpdate(checkout, probe({ fetch: 'fail' }))).status, 'unknown');
    const noUpstream = await checkUpdate(checkout, probe({ behind: 'fail' }));
    assert.equal(noUpstream.status, 'unknown');
    assert.match((noUpstream as { reason: string }).reason, /вышестоящей/);
  });

  it('checkout без remote: только локальные проверки', async () => {
    const host = probe({});
    assert.equal((await checkUpdate(checkout, host, { remote: false })).status, 'available');
    assert.equal(host.calls.includes('git fetch'), false);
  });

  it('npm: другая версия в реестре — available; та же — up-to-date; реестр молчит — unknown', async () => {
    assert.deepEqual(await checkUpdate(npm, probe({ npmVersion: '2.0.0' }), { engineVersion: '1.0.0' }), {
      status: 'available',
      current: '1.0.0',
      latest: '2.0.0',
    });
    assert.deepEqual(await checkUpdate(npm, probe({ npmVersion: '1.0.0' }), { engineVersion: '1.0.0' }), { status: 'up-to-date', version: '1.0.0' });
    assert.equal((await checkUpdate(npm, probe({ npmVersion: 'fail' }), { engineVersion: '1.0.0' })).status, 'unknown');
  });

  it('npm: установлена версия новее latest реестра — up-to-date, а не предложение откатиться', async () => {
    assert.deepEqual(await checkUpdate(npm, probe({ npmVersion: '1.0.0' }), { engineVersion: '1.1.0' }), {
      status: 'up-to-date',
      version: '1.1.0',
    });
    assert.deepEqual(await checkUpdate(npm, probe({ npmVersion: '1.0.0' }), { engineVersion: '1.0.1-rc.1' }), {
      status: 'up-to-date',
      version: '1.0.1-rc.1',
    });
    // Пререлиз младше своего выпуска: выпуск в реестре — обновление.
    assert.equal((await checkUpdate(npm, probe({ npmVersion: '1.1.0' }), { engineVersion: '1.1.0-rc.2' })).status, 'available');
  });

  it('npm с --ref: названная версия ставится, даже если она старее установленной', async () => {
    assert.equal(
      (await checkUpdate(npm, probe({ npmVersion: '0.9.0' }), { engineVersion: '1.0.0', ref: '0.9.0' })).status,
      'available',
    );
  });

  it('npm: спрашивает `npm view <пакет> version` без ссылки и с ней', async () => {
    const plain = probe({});
    await checkUpdate(npm, plain, { engineVersion: '1.0.0' });
    assert.deepEqual(plain.calls, ['npm view stepcast version']);

    const tagged = probe({});
    await checkUpdate(npm, tagged, { engineVersion: '1.0.0', ref: 'next' });
    assert.deepEqual(tagged.calls, ['npm view stepcast@next version']);
  });
});

/** Хозяин команды `update` на тех же ответах: решения экрана и команды обязаны совпасть. */
function commandHost(manifest: string, answers: Answers): { host: UpdateHost; executed: string[] } {
  const executed: string[] = [];
  const { capture } = probe(answers);
  const host: UpdateHost = {
    engineRoot: '/h/.burnex/releases/0.3.0',
    manifestPath: '/h/.burnex/install.json',
    probes: { isGitTree: () => false, readPackageName: () => undefined, releasesDir: '/h/.burnex/releases' },
    readManifest: () => manifest,
    exec: (step) => {
      executed.push([step.cmd, ...step.args].join(' '));
      return 0;
    },
    capture,
    restart: {
      platform: 'linux',
      home: '/h',
      uid: 501,
      launchctl: () => ({ status: 1, stdout: '', stderr: '' }),
      runningDaemon: () => undefined,
      stopDaemon: async () => undefined,
      spawnUp: () => true,
      readAgentPlist: () => undefined,
    },
  };
  return { host, executed };
}

function args(): ParsedArgs {
  return { command: 'update', positional: [], flags: { 'no-restart': true } };
}

describe('update-check: решение совпадает с командой update', () => {
  it('up-to-date экрана — «обновлять нечего» команды, ни одного шага', async () => {
    const answers: Answers = { tags: ['v0.3.0'] };
    assert.equal((await checkUpdate(managed, probe(answers))).status, 'up-to-date');

    const { host, executed } = commandHost(JSON.stringify(managed), answers);
    const out: string[] = [];
    await runUpdateCommand(args(), (line) => out.push(line), host);
    assert.equal(out.some((line) => line.includes('обновлять нечего')), true);
    assert.deepEqual(executed, []);
  });

  it('available экрана — команда запускает install.sh на том же теге', async () => {
    const answers: Answers = { tags: ['v0.3.0', 'v0.4.0'] };
    assert.deepEqual(await checkUpdate(managed, probe(answers)), { status: 'available', current: 'v0.3.0', latest: 'v0.4.0' });

    const { host, executed } = commandHost(JSON.stringify(managed), answers);
    await runUpdateCommand(args(), () => undefined, host);
    assert.equal(executed[0]?.endsWith('--ref v0.4.0'), true);
  });

  it('blocked экрана — отказ команды теми же словами', async () => {
    const answers: Answers = { porcelain: ' M a.ts\n' };
    const check = await checkUpdate(checkout, probe(answers));
    assert.equal(check.status, 'blocked');

    const { host, executed } = commandHost(JSON.stringify(checkout), answers);
    await assert.rejects(
      runUpdateCommand(args(), () => undefined, host),
      (error: unknown) => error instanceof StepcastError && error.message === (check as { reason: string }).reason,
    );
    assert.deepEqual(executed, []);
  });

  it('команда update не ставит командам предела времени: медленная сеть — не отказ', async () => {
    const answers = probe({ tags: ['v0.3.0'] });
    const { host } = commandHost(JSON.stringify(managed), {});
    await runUpdateCommand(args(), () => undefined, { ...host, capture: answers.capture });
    assert.deepEqual(answers.timeouts, [undefined]);
  });

  it('unknown экрана — отказ команды: теги не получены', async () => {
    const { host } = commandHost(JSON.stringify(managed), { tags: 'fail' });
    await assert.rejects(
      runUpdateCommand(args(), () => undefined, host),
      (error: unknown) => error instanceof StepcastError && /список тегов/.test(error.message),
    );
  });
});
