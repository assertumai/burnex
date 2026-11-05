import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { createUiServer, LOOPBACK, type UiServer } from '../src/parts/ui/daemon/server.js';
import type { LaunchdHost } from '../src/parts/ui/daemon/launchd.js';
import type { ModelDiscoveryResult } from '../src/parts/pipeline/backend/models.js';
import { loadPriceCatalog } from '../src/parts/pipeline/run/budget/priceCatalog.js';
import type { LaunchMaintenance, LaunchMaintenanceOptions, MaintenanceKind } from '../src/parts/ui/runLaunch.js';
import {
  buildSystem,
  createUpdateHold,
  readUpdate,
  UPDATE_HOLD_MS,
  type DaemonSelf,
  type SystemHost,
  type SystemView,
} from '../src/parts/ui/system.js';
import { makeJournalBed, seedRun } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Экран «System» (`ui-system-health`): ответ собирается поддельным хозяином —
 * ни launchd, ни git, ни npm, ни настоящего диска установки тест не трогает.
 */

const SHA = 'a'.repeat(40);

const MANAGED = JSON.stringify({
  method: 'managed',
  repo: '/srv/stepcast.git',
  ref: 'v0.4.0',
  version: '0.4.0',
  releases_dir: '/h/.stepcast/releases',
  installed_at: '2026-10-01T00:00:00Z',
});

const SELF: DaemonSelf = {
  pid: 4242,
  startedAt: Date.parse('2026-11-01T08:00:00Z'),
  port: 7717,
  projectRoot: '/work/project',
  entry: '/fake/bin.js',
};

function launchdHost(options: { platform?: NodeJS.Platform; loaded?: boolean; pid?: number } = {}): LaunchdHost {
  return {
    platform: options.platform ?? 'darwin',
    home: tempDir('system-launchd-'),
    uid: 501,
    launchctl: () =>
      options.loaded === true
        ? { status: 0, stdout: `ai.stepcast.daemon = {\n\tpid = ${options.pid ?? 4242}\n}`, stderr: '' }
        : { status: 113, stdout: '', stderr: '' },
  };
}

function fakeHost(over: Partial<SystemHost> = {}): SystemHost {
  return {
    now: () => 1_000_000,
    launchd: launchdHost(),
    engineRoot: '/h/.stepcast/releases/0.4.0',
    engineVersion: () => '0.4.0',
    manifestPath: '/h/.stepcast/install.json',
    readManifest: () => MANAGED,
    installProbes: { releasesDir: '/h/.stepcast/releases', isGitTree: () => false, readPackageName: () => undefined },
    currentRelease: () => '0.4.0',
    findCommand: () => undefined,
    heldProbe: () => undefined,
    processEnv: { PATH: '/usr/bin' },
    priceCatalog: () => loadPriceCatalog(),
    capture: () => undefined,
    ...over,
  };
}

function bed(config = ''): { runsRoot: string; projectRoot: string; home: string } {
  const fixture = makeJournalBed();
  if (config !== '') {
    writeFileSync(join(fixture.home, '.stepcast', 'config.yml'), `runs:\n  root: ${fixture.runsRoot}\n${config}`);
  }
  return fixture;
}

function system(fixture: { runsRoot: string; home: string }, host: SystemHost): Promise<SystemView> {
  return buildSystem({ runsRoot: fixture.runsRoot, home: fixture.home, self: SELF }, host);
}

function backendRow(view: SystemView, id: string): SystemView['backends'][number] {
  const row = view.backends.find((candidate) => candidate.id === id);
  assert.ok(row, `строка бэкенда ${id}`);
  return row;
}

const CODEX = 'plugins:\n  - stepcast/backends/codex\n';

describe('ui-system: версия и способ установки', () => {
  it('managed: ссылка, версия и релиз, на который смотрит current', async () => {
    const view = await system(bed(), fakeHost());

    assert.equal(view.engine.version, '0.4.0');
    assert.equal(view.engine.method, 'managed');
    assert.equal(view.engine.source, 'manifest');
    assert.deepEqual(view.engine.managed, {
      ref: 'v0.4.0',
      version: '0.4.0',
      installedAt: '2026-10-01T00:00:00Z',
      release: '0.4.0',
    });
    assert.equal(view.engine.error, undefined);
  });

  it('движок в каталоге релизов без паспорта — причина словами resolveInstallMethod', async () => {
    const view = await system(bed(), fakeHost({ readManifest: () => undefined }));

    assert.equal(view.engine.method, undefined);
    assert.match(view.engine.error ?? '', /паспорта установки нет/);
  });

  it('без паспорта способ выводится по пути: чекаут', async () => {
    const view = await system(
      bed(),
      fakeHost({
        readManifest: () => undefined,
        engineRoot: '/work/stepcast',
        installProbes: { releasesDir: '/h/.stepcast/releases', isGitTree: () => true, readPackageName: () => undefined },
      }),
    );

    assert.equal(view.engine.method, 'checkout');
    assert.equal(view.engine.source, 'inferred');
    assert.equal(view.engine.checkoutDir, '/work/stepcast');
  });
});

describe('ui-system: демон и автозапуск', () => {
  it('под launchd без ui.pid: pid агента совпал с pid процесса', async () => {
    const view = await system(bed(), fakeHost({ launchd: launchdHost({ loaded: true }) }));

    assert.equal(view.daemon.pid, 4242);
    assert.equal(view.daemon.startedAt, '2026-11-01T08:00:00.000Z');
    assert.equal(view.daemon.port, 7717);
    assert.equal(view.daemon.projectRoot, '/work/project');
    assert.equal(view.daemon.entry, '/fake/bin.js');
    assert.equal(view.daemon.underLaunchd, true);
    assert.equal(view.autostart.supported && view.autostart.thisDaemon, true);
  });

  it('агент загружен, но его pid чужой, — демон не под launchd', async () => {
    const view = await system(bed(), fakeHost({ launchd: launchdHost({ loaded: true, pid: 99 }) }));

    assert.equal(view.daemon.underLaunchd, false);
    assert.equal(view.autostart.supported && view.autostart.loaded, true);
    assert.equal(view.autostart.supported && view.autostart.thisDaemon, false);
  });

  it('отсоединённый демон: агент не загружен', async () => {
    const view = await system(bed(), fakeHost());

    assert.equal(view.daemon.underLaunchd, false);
    assert.equal(view.autostart.supported && view.autostart.loaded, false);
  });

  it('не macOS: автозапуск не поддержан, причина словами requireMacos', async () => {
    const view = await system(bed(), fakeHost({ launchd: launchdHost({ platform: 'linux' }) }));

    assert.equal(view.autostart.supported, false);
    assert.match(view.autostart.supported ? '' : view.autostart.reason, /только на macOS/);
  });
});

describe('ui-system: бэкенды', () => {
  it('команда found с полным путём и missing; проба удержанная и not-probed', async () => {
    const held: ModelDiscoveryResult = { status: 'ok', models: [{ name: 'sonnet' }, { name: 'opus' }] };
    const view = await system(
      bed(),
      fakeHost({
        findCommand: (command) => (command === 'claude' ? '/usr/local/bin/claude' : undefined),
        heldProbe: (name) => (name === 'claude' ? held : undefined),
      }),
    );

    const claude = backendRow(view, 'claude');
    assert.deepEqual(claude.commandState, { status: 'found', path: '/usr/local/bin/claude' });
    assert.deepEqual(claude.probe, { status: 'ok', modelCount: 2 });
    assert.equal(claude.adapter, true);

    const codex = backendRow(view, 'codex');
    assert.deepEqual(codex.commandState, { status: 'missing' });
    assert.deepEqual(codex.probe, { status: 'not-probed' });
    assert.equal(codex.adapter, false);
  });

  it('команда ищется по PATH окружения шага: backends.<id>.env побеждает окружение демона', async () => {
    const searched: Array<string | undefined> = [];
    await system(
      bed('backends:\n  claude:\n    env:\n      PATH: /custom/bin\n'),
      fakeHost({
        findCommand: (command, pathEnv) => {
          if (command === 'claude') searched.push(pathEnv);
          return undefined;
        },
      }),
    );

    assert.deepEqual(searched, ['/custom/bin']);
  });

  it('удержанный отказ пробы показывается как есть', async () => {
    const view = await system(
      bed(),
      fakeHost({ heldProbe: (name) => (name === 'claude' ? { status: 'failed', message: 'not logged in' } : undefined) }),
    );

    assert.deepEqual(backendRow(view, 'claude').probe, { status: 'failed', message: 'not logged in' });
  });
});

/** Сводка расхода с одной попыткой названного бэкенда. */
function usageWithAttempt(runId: string, backend: string): Parameters<typeof seedRun>[2] {
  return {
    runId,
    usage: {
      run_id: runId,
      total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 0, wallclock_ms: 0 },
      unreported: [],
      jobs: {
        build: {
          billable_tokens: 0,
          wallclock_ms: 0,
          steps: {
            a: {
              billable_tokens: 0,
              wallclock_ms: 0,
              attempts: [{ attempt: 1, backend, billable_tokens: 0, wallclock_ms: 0 }],
            },
          },
        },
      },
    },
  };
}

describe('ui-system: последний отказ бэкенда из журналов', () => {
  it('отказ аутентификации приписан бэкенду из сводки расхода', async () => {
    const fixture = bed();
    const journal = seedRun(fixture.runsRoot, fixture.projectRoot, usageWithAttempt('run-a', 'claude'));
    journal.event({
      kind: 'backend.refused',
      job: 'build',
      step: 'a',
      attempt: 1,
      class: 'unauthenticated',
      status_code: 401,
      message: 'Please run /login',
    });

    const view = await system(fixture, fakeHost());

    const refusals = backendRow(view, 'claude').refusals;
    assert.equal(refusals.length, 1);
    const [refusal] = refusals;
    assert.equal(refusal?.class, 'unauthenticated');
    assert.equal(refusal?.run, 'run-a');
    assert.equal(refusal?.job, 'build');
    assert.equal(refusal?.step, 'a');
    assert.equal(refusal?.statusCode, 401);
    assert.equal(refusal?.message, 'Please run /login');
    assert.equal(view.unattributedRefusals.length, 0);
  });

  it('у события нет попытки в сводке — отдельная строка, бэкенду не приписана', async () => {
    const fixture = bed();
    // Сводка без попыток: бэкенд отказа неизвестен.
    const journal = seedRun(fixture.runsRoot, fixture.projectRoot, { runId: 'run-b' });
    journal.event({
      kind: 'backend.refused',
      job: 'build',
      step: 'a',
      attempt: 1,
      class: 'unauthenticated',
      message: 'Please run /login',
    });

    const view = await system(fixture, fakeHost());

    assert.equal(view.unattributedRefusals.length, 1);
    assert.equal(view.unattributedRefusals[0]?.backend, undefined);
    assert.equal(view.unattributedRefusals[0]?.run, 'run-b');
    assert.deepEqual(
      view.backends.flatMap((backend) => backend.refusals),
      [],
    );
  });

  it('читаются только 20 новейших прогонов проекта', async () => {
    const fixture = bed();
    // Самый старый прогон несёт отказ; за ним ещё двадцать чистых, более новых.
    const old = seedRun(fixture.runsRoot, fixture.projectRoot, usageWithAttempt('2026-01-00', 'claude'));
    old.event({ kind: 'backend.refused', job: 'build', step: 'a', attempt: 1, class: 'unauthenticated', message: 'old' });
    for (let i = 1; i <= 20; i += 1) {
      seedRun(fixture.runsRoot, fixture.projectRoot, { runId: `2026-01-${String(i).padStart(2, '0')}` });
    }

    const view = await system(fixture, fakeHost());

    assert.deepEqual(backendRow(view, 'claude').refusals, []);
  });
});

describe('ui-system: модели без цены', () => {
  it('модель, которой нет в каталоге, — со строкой бэкенда, путём и датой каталога', async () => {
    const view = await system(
      bed(`${CODEX}backends:\n  codex:\n    model_tiers: { fast: made-up-model, deep: gpt-5-codex }\n`),
      fakeHost(),
    );

    assert.equal(view.unpriced.asOf, loadPriceCatalog().asOf);
    const fast = view.unpriced.models.find((row) => row.path === 'backends.codex.model_tiers.fast');
    assert.deepEqual(fast, { backend: 'codex', model: 'made-up-model', path: 'backends.codex.model_tiers.fast' });
  });

  it('модель в каталоге в перечень не попадает; бэкенд, сообщающий цену, — тоже', async () => {
    const view = await system(
      bed(`${CODEX}backends:\n  codex:\n    model_tiers: { deep: gpt-5-codex }\n  claude:\n    model_tiers: { fast: made-up-model }\n`),
      fakeHost(),
    );

    assert.equal(view.unpriced.models.some((row) => row.model === 'gpt-5-codex'), false);
    assert.equal(view.unpriced.models.some((row) => row.backend === 'claude'), false);
  });

  it('defaults.model относится к бэкенду defaults.agent', async () => {
    const view = await system(bed(`${CODEX}defaults:\n  agent: codex\n  model: made-up-default\n`), fakeHost());

    assert.equal(
      view.unpriced.models.some((row) => row.backend === 'codex' && row.model === 'made-up-default' && row.path === 'defaults.model'),
      true,
    );
  });
});

describe('ui-system: проверка обновления и её удержание', () => {
  function countingHost(): { host: SystemHost; calls: string[]; clock: { now: number } } {
    const calls: string[] = [];
    const clock = { now: 1_000_000 };
    const host = fakeHost({
      now: () => clock.now,
      capture: (step) => {
        calls.push([step.cmd, ...step.args].join(' '));
        return `${SHA}\trefs/tags/v0.5.0\n`;
      },
    });
    return { host, calls, clock };
  }

  it('исход удерживается 10 минут; refresh и истечение проверяют заново', async () => {
    const { host, calls, clock } = countingHost();
    const hold = createUpdateHold();

    const first = await readUpdate(hold, host, { refresh: false });
    assert.deepEqual(first.check, { status: 'available', current: 'v0.4.0', latest: 'v0.5.0' });
    assert.equal(first.held, false);

    const second = await readUpdate(hold, host, { refresh: false });
    assert.equal(second.held, true);
    assert.equal(calls.length, 1, 'удержанный исход сеть не трогает');

    await readUpdate(hold, host, { refresh: true });
    assert.equal(calls.length, 2);

    clock.now += UPDATE_HOLD_MS + 1;
    assert.equal((await readUpdate(hold, host, { refresh: false })).held, false);
    assert.equal(calls.length, 3);
  });

  it('без способа установки проверять нечем: причина, сети нет', async () => {
    const { calls } = countingHost();
    const host = fakeHost({ readManifest: () => undefined, capture: (step) => (calls.push(step.cmd), undefined) });

    const view = await readUpdate(createUpdateHold(), host, { refresh: true });
    assert.match(view.error ?? '', /паспорта установки нет/);
    assert.equal(view.check, undefined);
    assert.deepEqual(calls, []);
  });

  it('проверка не держит цикл событий, а одновременные запросы ждут одну проверку', async () => {
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const host = fakeHost({
      capture: (step) =>
        new Promise((settle) => {
          calls.push(step.cmd);
          release = () => settle(`${SHA}\trefs/tags/v0.5.0\n`);
        }),
    });
    const hold = createUpdateHold();

    const first = readUpdate(hold, host, { refresh: true });
    const second = readUpdate(hold, host, { refresh: true });
    // Ответ ещё не пришёл, а таймеры демона идут.
    await new Promise((settle) => setTimeout(settle, 5));
    assert.equal(calls.length, 1);
    release?.();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(a.check?.status, 'available');
    assert.equal(hold.pending, undefined);
  });

  it('предел общий на проверку checkout: зависший fetch оставляет rev-list без запуска', async () => {
    const calls: string[] = [];
    const clock = { now: 0 };
    const host = fakeHost({
      now: () => clock.now,
      readManifest: () => '{"method":"checkout","dir":"/work/sc"}',
      capture: (step, timeoutMs) => {
        calls.push(`${step.args[0] ?? ''}:${timeoutMs ?? 'none'}`);
        if (step.args[0] === 'fetch') {
          clock.now += timeoutMs ?? 0;
          return undefined;
        }
        clock.now += 1_000;
        return step.args[0] === 'symbolic-ref' ? 'refs/heads/main\n' : '';
      },
    });

    const view = await readUpdate(createUpdateHold(), host, { refresh: true, timeoutMs: 10_000 });
    assert.equal(view.check?.status, 'unknown');
    assert.deepEqual(calls, ['status:10000', 'symbolic-ref:9000', 'fetch:8000']);
  });
});

// --- маршруты через createUiServer ------------------------------------------

interface Bench {
  readonly server: UiServer;
  readonly launched: LaunchMaintenanceOptions[];
  readonly logDir: string;
  busy: MaintenanceKind | undefined;
}

async function startServer(t: TestContext, host: SystemHost, config = ''): Promise<Bench> {
  const fixture = bed(config);
  const logDir = tempDir('system-logs-');
  const launched: LaunchMaintenanceOptions[] = [];
  const state: { busy: MaintenanceKind | undefined } = { busy: undefined };
  const maintenance: LaunchMaintenance = {
    launch: (options) => {
      launched.push(options);
      // Живой ребёнок: пока он не вышел, повторный запуск запрещён.
      state.busy = options.kind;
    },
    busy: () => state.busy,
    // Завершившийся ребёнок: `busy` снят, а исход последнего запуска виден в журнале.
    last: (kind) =>
      launched.some((options) => options.kind === kind)
        ? state.busy === kind
          ? { startedAt: '2026-11-01T10:00:00.000Z', running: true }
          : { startedAt: '2026-11-01T10:00:00.000Z', running: false, exitCode: 0, finishedAt: '2026-11-01T10:00:05.000Z' }
        : undefined,
    logPath: (kind) => join(logDir, `${kind}.log`),
  };
  const server = await createUiServer({
    runsRoot: fixture.runsRoot,
    home: fixture.home,
    projectRoot: fixture.projectRoot,
    port: 0,
    launchMaintenance: maintenance,
    systemHost: host,
    entry: '/fake/bin.js',
  });
  t.after(() => server.close());
  return {
    server,
    launched,
    logDir,
    get busy() {
      return state.busy;
    },
    set busy(value) {
      state.busy = value;
    },
  };
}

function call(
  server: UiServer,
  method: string,
  path: string,
  options: { body?: string; origin?: string } = {},
): Promise<{ code: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: LOOPBACK,
        port: server.port,
        path,
        method,
        headers: {
          ...(options.origin === undefined ? {} : { origin: options.origin }),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ code: res.statusCode ?? 0, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('ui-system: маршруты', () => {
  it('GET /api/system отдаёт сведения демона от самого процесса', async (t) => {
    const { server } = await startServer(t, fakeHost());

    const { code, json } = await call(server, 'GET', '/api/system');
    const view = json as unknown as SystemView;
    assert.equal(code, 200);
    assert.equal(view.daemon.pid, process.pid);
    assert.equal(view.daemon.port, server.port);
    assert.equal(view.daemon.entry, '/fake/bin.js');
    assert.equal(view.engine.method, 'managed');
  });

  it('GET /api/system/update: удержание и refresh', async (t) => {
    const calls: string[] = [];
    const { server } = await startServer(
      t,
      fakeHost({
        capture: (step) => {
          calls.push(step.args[0] ?? '');
          return `${SHA}\trefs/tags/v0.5.0\n`;
        },
      }),
    );

    const first = await call(server, 'GET', '/api/system/update');
    assert.deepEqual((first.json as { check: unknown }).check, { status: 'available', current: 'v0.4.0', latest: 'v0.5.0' });
    assert.equal((await call(server, 'GET', '/api/system/update')).json.held, true);
    assert.equal(calls.length, 1);

    await call(server, 'GET', '/api/system/update?refresh=1');
    assert.equal(calls.length, 2);
  });

  it('POST /api/system/update порождает burnex update той же точки входа в корне проекта', async (t) => {
    const bench = await startServer(t, fakeHost());

    const { code, json } = await call(bench.server, 'POST', '/api/system/update');

    assert.equal(code, 202);
    assert.equal(json.log, join(bench.logDir, 'update.log'));
    assert.equal(bench.launched.length, 1);
    const [launch] = bench.launched;
    assert.equal(launch?.kind, 'update');
    assert.equal(launch?.command, process.execPath);
    assert.deepEqual(launch?.args, ['/fake/bin.js', 'update']);
    assert.ok(launch?.cwd.endsWith('project'), 'рабочий каталог — корень проекта демона');
  });

  it('POST /api/system/update без способа установки — 409 с причиной, процесса нет', async (t) => {
    const bench = await startServer(t, fakeHost({ readManifest: () => undefined }));

    const { code, json } = await call(bench.server, 'POST', '/api/system/update');

    assert.equal(code, 409);
    assert.match(String(json.error), /паспорта установки нет/);
    assert.deepEqual(bench.launched, []);
  });

  it('живой процесс обслуживания: оба POST отвечают 409, второй не порождается', async (t) => {
    const bench = await startServer(t, fakeHost());
    await call(bench.server, 'POST', '/api/system/update');

    const update = await call(bench.server, 'POST', '/api/system/update');
    const autostart = await call(bench.server, 'POST', '/api/system/autostart', { body: '{"enabled":true}' });

    assert.equal(update.code, 409);
    assert.equal(autostart.code, 409);
    assert.equal(bench.launched.length, 1);

    bench.busy = undefined;
    assert.equal((await call(bench.server, 'POST', '/api/system/update')).code, 202);
  });

  it('автозапуск включается burnex up --install', async (t) => {
    const bench = await startServer(t, fakeHost());

    const { code, json } = await call(bench.server, 'POST', '/api/system/autostart', { body: '{"enabled":true}' });

    assert.equal(code, 202);
    assert.equal(json.log, join(bench.logDir, 'autostart.log'));
    assert.equal(bench.launched[0]?.command, process.execPath);
    assert.deepEqual(bench.launched[0]?.args, ['/fake/bin.js', 'up', '--install']);
  });

  it('автозапуск выключается down --uninstall и затем up одной оболочечной строкой', async (t) => {
    const bench = await startServer(t, fakeHost());

    const { code } = await call(bench.server, 'POST', '/api/system/autostart', { body: '{"enabled":false}' });

    assert.equal(code, 202);
    assert.equal(bench.launched[0]?.command, 'sh');
    assert.deepEqual(bench.launched[0]?.args, [
      '-c',
      '"$0" "$1" down --uninstall && "$0" "$1" up',
      process.execPath,
      '/fake/bin.js',
    ]);
  });

  it('вне macOS автозапуск — 409 с причиной, процесса нет', async (t) => {
    const bench = await startServer(t, fakeHost({ launchd: launchdHost({ platform: 'linux' }) }));

    const { code, json } = await call(bench.server, 'POST', '/api/system/autostart', { body: '{"enabled":true}' });

    assert.equal(code, 409);
    assert.match(String(json.error), /только на macOS/);
    assert.deepEqual(bench.launched, []);
  });

  it('тело без enabled — 400', async (t) => {
    const bench = await startServer(t, fakeHost());

    assert.equal((await call(bench.server, 'POST', '/api/system/autostart', { body: '{}' })).code, 400);
    assert.equal((await call(bench.server, 'POST', '/api/system/autostart', { body: 'не json' })).code, 400);
    assert.deepEqual(bench.launched, []);
  });

  it('запрос с чужим Origin отвергнут до обработчика, процесса нет', async (t) => {
    const bench = await startServer(t, fakeHost());

    const update = await call(bench.server, 'POST', '/api/system/update', { origin: 'https://evil.example' });
    const autostart = await call(bench.server, 'POST', '/api/system/autostart', {
      origin: 'https://evil.example',
      body: '{"enabled":true}',
    });

    assert.equal(update.code, 403);
    assert.equal(autostart.code, 403);
    assert.deepEqual(bench.launched, []);
  });

  it('GET /api/system/log отдаёт 200 последних строк журнала действия', async (t) => {
    const bench = await startServer(t, fakeHost());
    mkdirSync(bench.logDir, { recursive: true });
    writeFileSync(
      join(bench.logDir, 'update.log'),
      Array.from({ length: 250 }, (_, i) => `строка ${i + 1}`).join('\n') + '\n',
    );

    const { code, json } = await call(bench.server, 'GET', '/api/system/log?kind=update');

    assert.equal(code, 200);
    const lines = json.lines as string[];
    assert.equal(lines.length, 200);
    assert.equal(lines[0], 'строка 51');
    assert.equal(lines.at(-1), 'строка 250');
  });

  it('GET /api/system/log несёт исход порождённого процесса: идёт, затем завершён с кодом', async (t) => {
    const bench = await startServer(t, fakeHost());
    assert.equal((await call(bench.server, 'GET', '/api/system/log?kind=update')).json.run, undefined);

    assert.equal((await call(bench.server, 'POST', '/api/system/update')).code, 202);
    assert.deepEqual((await call(bench.server, 'GET', '/api/system/log?kind=update')).json.run, {
      startedAt: '2026-11-01T10:00:00.000Z',
      running: true,
    });

    bench.busy = undefined;
    const run = (await call(bench.server, 'GET', '/api/system/log?kind=update')).json.run as { running: boolean; exitCode: number };
    assert.equal(run.running, false);
    assert.equal(run.exitCode, 0);
  });

  it('GET /api/system/log: журнала ещё нет — пустой список; неизвестный kind — 400', async (t) => {
    const bench = await startServer(t, fakeHost());

    assert.deepEqual((await call(bench.server, 'GET', '/api/system/log?kind=autostart')).json.lines, []);
    assert.equal((await call(bench.server, 'GET', '/api/system/log?kind=other')).code, 400);
  });
});

describe('ui-system: журнал процессов обслуживания', () => {
  it('createMaintenance дописывает вывод в журнал и снимает busy по выходу ребёнка', async () => {
    const { createMaintenance } = await import('../src/parts/ui/runLaunch.js');
    const dir = tempDir('maintenance-');
    const maintenance = createMaintenance(dir);

    maintenance.launch({
      kind: 'update',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("привет из ребёнка\\n")'],
      cwd: dir,
    });
    assert.equal(maintenance.busy(), 'update');
    assert.equal(maintenance.last('update')?.running, true);
    assert.equal(maintenance.last('autostart'), undefined);

    const deadline = Date.now() + 10_000;
    while (maintenance.busy() !== undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(maintenance.busy(), undefined);
    assert.equal(maintenance.last('update')?.running, false);
    assert.equal(maintenance.last('update')?.exitCode, 0);

    const { readFileSync } = await import('node:fs');
    const log = readFileSync(maintenance.logPath('update'), 'utf8');
    assert.match(log, /--- .* /);
    assert.match(log, /привет из ребёнка/);
  });

  it('createMaintenance помнит ненулевой код выхода — действие кончилось без перезапуска', async () => {
    const { createMaintenance } = await import('../src/parts/ui/runLaunch.js');
    const dir = tempDir('maintenance-');
    const maintenance = createMaintenance(dir);

    maintenance.launch({ kind: 'autostart', command: process.execPath, args: ['-e', 'process.exit(3)'], cwd: dir });
    const deadline = Date.now() + 10_000;
    while (maintenance.busy() !== undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const run = maintenance.last('autostart');
    assert.equal(run?.running, false);
    assert.equal(run?.exitCode, 3);
    assert.notEqual(run?.finishedAt, undefined);
  });
});
