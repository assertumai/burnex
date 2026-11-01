import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { restartDaemon, type RestartHost, type RestartOptions } from '../src/parts/install/restart.js';
import { StepcastError } from '../src/kernel/errors.js';
import type { DaemonRecord } from '../src/parts/ui/daemon/daemon.js';

interface Bed {
  readonly host: RestartHost;
  readonly calls: string[];
  readonly out: string[];
}

function bed(options: {
  agentLoaded?: boolean;
  daemon?: DaemonRecord;
  plist?: string;
  kickstartStatus?: number;
  spawnOk?: boolean;
  platform?: NodeJS.Platform;
}): Bed {
  const calls: string[] = [];
  const host: RestartHost = {
    platform: options.platform ?? 'darwin',
    home: '/h',
    uid: 501,
    launchctl: (args) => {
      calls.push(`launchctl ${args.join(' ')}`);
      if (args[0] === 'print') return { status: options.agentLoaded === true ? 0 : 113, stdout: '', stderr: '' };
      return { status: options.kickstartStatus ?? 0, stdout: '', stderr: '' };
    },
    runningDaemon: () => options.daemon,
    stopDaemon: async () => {
      calls.push('stop');
    },
    spawnUp: (entry, cwd) => {
      calls.push(`up ${entry} @ ${cwd}`);
      return options.spawnOk ?? true;
    },
    readAgentPlist: () => options.plist,
  };
  return { host, calls, out: [] };
}

const OPTIONS: RestartOptions = { newEntry: '/r/current/dist/src/bin.js', stableEntry: true, noRestart: false, updateOk: true };

const RECORD: DaemonRecord = { pid: 10, port: 7717, started_at: '' };

describe('install-restart: выбор перезапуска', () => {
  it('агент launchd загружен — kickstart -k, демон из ui.pid не трогается', async () => {
    const { host, calls, out } = bed({ agentLoaded: true, daemon: { ...RECORD, cwd: '/p' }, plist: '/r/current/dist/src/bin.js' });

    assert.equal(await restartDaemon(host, OPTIONS, (line) => out.push(line)), 'kickstarted');
    assert.deepEqual(calls, [
      'launchctl print gui/501/ai.stepcast.daemon',
      'launchctl kickstart -k gui/501/ai.stepcast.daemon',
    ]);
    assert.equal(out.some((line) => line.includes('up --install')), false);
  });

  it('plist не ведёт в current — печатается подсказка про up --install', async () => {
    const { host, out } = bed({ agentLoaded: true, plist: '/r/releases/0.2.0/dist/src/bin.js' });

    await restartDaemon(host, OPTIONS, (line) => out.push(line));

    assert.equal(out.some((line) => line.includes('up --install')), true);
  });

  it('checkout или npm — подсказки про current нет: путь через current к ним не относится', async () => {
    const { host, out } = bed({ agentLoaded: true, plist: '/work/stepcast/dist/src/bin.js' });

    await restartDaemon(host, { ...OPTIONS, stableEntry: false }, (line) => out.push(line));

    assert.equal(out.some((line) => line.includes('up --install')), false);
  });

  it('отсоединённый демон с cwd — остановка и up новой версии в этом каталоге', async () => {
    const { host, calls } = bed({ daemon: { ...RECORD, cwd: '/p' } });

    assert.equal(await restartDaemon(host, OPTIONS, () => undefined), 'restarted');
    assert.deepEqual(calls.slice(1), ['stop', `up ${OPTIONS.newEntry} @ /p`]);
  });

  it('демон без cwd не трогается, печатается подсказка', async () => {
    const { host, calls, out } = bed({ daemon: RECORD });

    assert.equal(await restartDaemon(host, OPTIONS, (line) => out.push(line)), 'manual');
    assert.equal(calls.includes('stop'), false);
    assert.equal(out.some((line) => line.includes('stepcast down && stepcast up')), true);
  });

  it('не поднятый демон не поднимается', async () => {
    const { host, calls } = bed({});

    assert.equal(await restartDaemon(host, OPTIONS, () => undefined), 'none');
    assert.deepEqual(calls, ['launchctl print gui/501/ai.stepcast.daemon']);
  });

  it('вне macOS launchctl не зовётся', async () => {
    const { host, calls } = bed({ platform: 'linux', daemon: { ...RECORD, cwd: '/p' } });

    await restartDaemon(host, OPTIONS, () => undefined);

    assert.equal(calls.some((call) => call.startsWith('launchctl')), false);
  });

  it('--no-restart и неуспешное обновление не делают ни одного вызова хоста', async () => {
    for (const options of [
      { ...OPTIONS, noRestart: true },
      { ...OPTIONS, updateOk: false },
    ]) {
      const { host, calls } = bed({ agentLoaded: true, daemon: { ...RECORD, cwd: '/p' } });
      assert.equal(await restartDaemon(host, options, () => undefined), 'skipped');
      assert.deepEqual(calls, []);
    }
  });

  it('отказ kickstart и неподнявшийся up — отказы с объяснением, а не тишина', async () => {
    await assert.rejects(
      restartDaemon(bed({ agentLoaded: true, kickstartStatus: 1 }).host, OPTIONS, () => undefined),
      StepcastError,
    );
    await assert.rejects(
      restartDaemon(bed({ daemon: { ...RECORD, cwd: '/p' }, spawnOk: false }).host, OPTIONS, () => undefined),
      StepcastError,
    );
  });
});
