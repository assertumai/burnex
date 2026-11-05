import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ParsedArgs } from '../src/kernel/cli/args.js';
import { ExitCode, StepcastError } from '../src/kernel/errors.js';
import { runUpdateCommand, type UpdateHost } from '../src/parts/install/commands/update.js';
import type { UpdateStep } from '../src/parts/install/plan.js';
import type { RestartHost } from '../src/parts/install/restart.js';

const MANAGED = JSON.stringify({
  method: 'managed',
  repo: '/srv/stepcast.git',
  ref: 'v0.3.0',
  version: '0.3.0',
  releases_dir: '/h/.burnex/releases',
});

const SHA = 'a'.repeat(40);

function args(flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command: 'update', positional: [], flags };
}

interface Bed {
  readonly host: UpdateHost;
  readonly executed: string[];
  readonly restartCalls: string[];
  readonly out: string[];
}

function bed(options: {
  manifest?: string;
  tags?: readonly string[];
  porcelain?: string;
  failOn?: string;
  agentLoaded?: boolean;
  engineRoot?: string;
  detached?: boolean;
}): Bed {
  const executed: string[] = [];
  const restartCalls: string[] = [];
  const line = (step: UpdateStep): string => [step.cmd, ...step.args].join(' ');
  const restart: RestartHost = {
    platform: 'darwin',
    home: '/h',
    uid: 501,
    launchctl: (argv) => {
      restartCalls.push(`launchctl ${argv.join(' ')}`);
      return { status: options.agentLoaded === true ? 0 : 1, stdout: '', stderr: '' };
    },
    runningDaemon: () => undefined,
    stopDaemon: async () => undefined,
    spawnUp: () => true,
    readAgentPlist: () => undefined,
  };
  const host: UpdateHost = {
    engineRoot: options.engineRoot ?? '/h/.burnex/releases/0.3.0',
    manifestPath: '/h/.burnex/install.json',
    probes: { isGitTree: () => false, readPackageName: () => undefined, releasesDir: '/h/.burnex/releases' },
    readManifest: () => options.manifest,
    exec: (step) => {
      executed.push(line(step));
      return options.failOn !== undefined && line(step).startsWith(options.failOn) ? 7 : 0;
    },
    capture: (step) => {
      if (step.args[0] === 'ls-remote') return (options.tags ?? []).map((tag) => `${SHA}\trefs/tags/${tag}`).join('\n');
      if (step.args[0] === 'status') return options.porcelain ?? '';
      if (step.args[0] === 'symbolic-ref') return options.detached === true ? undefined : 'refs/heads/main\n';
      return undefined;
    },
    restart,
  };
  return { host, executed, restartCalls, out: [] };
}

describe('install-update: команда update', () => {
  it('managed без новой версии — код 0 и ни одного шага', async () => {
    const { host, executed, restartCalls, out } = bed({ manifest: MANAGED, tags: ['v0.3.0'] });

    assert.equal(await runUpdateCommand(args(), (l) => out.push(l), host), ExitCode.ok);
    assert.deepEqual(executed, []);
    assert.deepEqual(restartCalls, []);
    assert.equal(out.some((l) => l.includes('managed (паспорт')), true);
  });

  it('managed с новым тегом запускает install.sh и затем перезапускает демон', async () => {
    const { host, executed, restartCalls } = bed({ manifest: MANAGED, tags: ['v0.3.0', 'v0.10.0'], agentLoaded: true });

    assert.equal(await runUpdateCommand(args(), () => undefined, host), ExitCode.ok);
    assert.deepEqual(executed, ['bash /h/.burnex/releases/current/install.sh --repo /srv/stepcast.git --ref v0.10.0']);
    assert.equal(restartCalls.some((c) => c.startsWith('launchctl kickstart')), true);
  });

  it('managed-паспорт, а движок запущен из чекаута — install.sh всё равно из current', async () => {
    const { host, executed } = bed({ manifest: MANAGED, tags: ['v0.4.0'], engineRoot: '/work/stepcast' });

    assert.equal(await runUpdateCommand(args(), () => undefined, host), ExitCode.ok);
    assert.deepEqual(executed, ['bash /h/.burnex/releases/current/install.sh --repo /srv/stepcast.git --ref v0.4.0']);
  });

  it('checkout с отцеплённым HEAD без --ref — отказ до шагов', async () => {
    const { host, executed } = bed({ manifest: '{"method":"checkout","dir":"/work/sc"}', detached: true });

    await assert.rejects(
      runUpdateCommand(args(), () => undefined, host),
      (error: unknown) => error instanceof StepcastError && /отцеплен/.test(error.message),
    );
    assert.deepEqual(executed, []);
  });

  it('провал шага — ненулевой код, демон не тронут', async () => {
    const { host, restartCalls } = bed({ manifest: MANAGED, tags: ['v0.4.0'], failOn: 'bash', agentLoaded: true });

    assert.equal(await runUpdateCommand(args(), () => undefined, host), ExitCode.jobFailed);
    assert.deepEqual(restartCalls, []);
  });

  it('--no-restart обновляет и не зовёт хост перезапуска', async () => {
    const { host, executed, restartCalls } = bed({ manifest: MANAGED, tags: ['v0.4.0'], agentLoaded: true });

    assert.equal(await runUpdateCommand(args({ 'no-restart': true }), () => undefined, host), ExitCode.ok);
    assert.equal(executed.length, 1);
    assert.deepEqual(restartCalls, []);
  });

  it('checkout с грязным деревом отказывает до шагов', async () => {
    const { host, executed } = bed({ manifest: '{"method":"checkout","dir":"/work/sc"}', porcelain: ' M src/a.ts\n' });

    await assert.rejects(
      runUpdateCommand(args(), () => undefined, host),
      (error: unknown) => error instanceof StepcastError && /незакоммиченные/.test(error.message),
    );
    assert.deepEqual(executed, []);
  });

  it('без паспорта и без распознаваемого места — отказ с подсказкой про install.sh', async () => {
    const { host } = bed({});

    await assert.rejects(
      runUpdateCommand(args(), () => undefined, host),
      (error: unknown) => error instanceof StepcastError && /install\.sh/.test(error.hint ?? ''),
    );
  });

  it('managed без тегов и без --ref — отказ, не молчаливый успех', async () => {
    const { host } = bed({ manifest: MANAGED, tags: [] });

    await assert.rejects(runUpdateCommand(args(), () => undefined, host), /нет тегов/);
  });
});
