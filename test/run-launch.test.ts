import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { readEvents, readManifest, readStatus, readUsage } from '../src/parts/pipeline/run/journal/reader.js';
import { projectKey, runPaths } from '../src/parts/pipeline/run/journal/paths.js';
import { finalizeInterruptedRun } from '../src/parts/pipeline/run/journal/recover.js';
import { launchRun, retryInterruptedRunRecovery } from '../src/parts/ui/runLaunch.js';
import { makeJournalBed, seedRun } from './helpers.js';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('истёк срок ожидания результата runner');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('ui-daemon: надзор за runner', () => {
  it('завершает оставшийся running журнал диагностическим отказом после выхода runner', async () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const runId = 'runner-lost';
    const key = projectKey(projectRoot);
    const paths = runPaths(runsRoot, key, runId);
    const executable = join(projectRoot, 'abrupt-runner');

    writeFileSync(
      executable,
      `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const dir = ${JSON.stringify(paths.dir)};
mkdirSync(dir + '/jobs', { recursive: true });
mkdirSync(dir + '/artifacts', { recursive: true });
mkdirSync(dir + '/anchors', { recursive: true });
const started = new Date().toISOString();
writeFileSync(dir + '/run.json', JSON.stringify({
  run_id: ${JSON.stringify(runId)}, pipeline: 'demo', pipeline_file: ${JSON.stringify(join(projectRoot, 'burnex.yml'))},
  lock_hash: 'abc', project_root: ${JSON.stringify(projectRoot)}, workspace: { mode: 'cwd' }, inputs: {},
  git: {}, backends: {}, started_at: started, pid: process.pid, format: 10
}, null, 2) + '\\n');
writeFileSync(dir + '/status.json', JSON.stringify({
  run_id: ${JSON.stringify(runId)}, pipeline: 'demo', lock_hash: 'abc', status: 'running',
  workspace: { mode: 'cwd' }, inputs: {},
  jobs: [{ id: 'implement', status: 'running', steps: [], started_at: started }],
  budget: { tokens_used: 0, wallclock_ms: 0 }, updated_at: started
}, null, 2) + '\\n');
writeFileSync(dir + '/usage.json', JSON.stringify({
  run_id: ${JSON.stringify(runId)}, partial: true,
  total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 0, wallclock_ms: 0 },
  unreported: [], jobs: {}
}, null, 2) + '\\n');
writeFileSync(dir + '/events.ndjson', [
  { ts: started, seq: 0, kind: 'run.started', pipeline: 'demo', run_id: ${JSON.stringify(runId)} },
  { ts: started, seq: 1, kind: 'job.started', job: 'implement' },
  { ts: started, seq: 2, kind: 'step.started', job: 'implement', step: 'write-code', attempt: 1 }
].map((event) => JSON.stringify(event)).join('\\n') + '\\n');
appendFileSync(dir + '/events.ndjson', '{"ts":"оборвано');
process.exit(17);
`,
    );
    chmodSync(executable, 0o700);

    launchRun({
      cwd: projectRoot,
      pipeline: 'burnex.yml',
      runsRoot,
      projectKey: key,
      execPath: executable,
    });

    await waitFor(() => {
      try {
        return readStatus(paths).status === 'failed';
      } catch {
        return false;
      }
    });

    const status = readStatus(paths);
    const manifest = readManifest(paths);
    const events = readEvents(paths);
    const interrupted = events.find((event) => event.kind === 'run.interrupted');

    assert.equal(status.status, 'failed');
    assert.equal(status.jobs[0]?.status, 'failed');
    assert.match(status.jobs[0]?.reason ?? '', /runner.*завершился/i);
    assert.equal(manifest.status, 'failed');
    assert.equal(manifest.exit_code, 17);
    assert.deepEqual(interrupted, {
      ts: interrupted?.ts,
      seq: 3,
      kind: 'run.interrupted',
      pid: interrupted?.pid,
      exit_code: 17,
      signal: null,
      detail: 'runner завершился без терминальной записи журнала',
    });
    assert.equal(events.at(-1)?.kind, 'run.finished');
    assert.equal(
      finalizeInterruptedRun(runsRoot, key, {
        pid: interrupted?.pid ?? 1,
        exitCode: 17,
        signal: null,
      }),
      false,
      'повторное наблюдение не должно множить терминальные события',
    );
    assert.equal(readEvents(paths).length, events.length);
  });

  it('shadow превращается в флаг --shadow дочернего burnex run, без него argv прежний', async () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const executable = join(projectRoot, 'argv-dump');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
require('node:fs').writeFileSync(process.argv[1] + '.' + (process.argv.includes('--shadow') ? 'shadow' : 'plain'), JSON.stringify(process.argv.slice(2)));
`,
    );
    chmodSync(executable, 0o700);

    launchRun({ cwd: projectRoot, pipeline: 'burnex.yml', runsRoot, projectKey: key, execPath: executable });
    launchRun({ cwd: projectRoot, pipeline: 'burnex.yml', runsRoot, projectKey: key, execPath: executable, shadow: true });
    await waitFor(() => existsSync(`${executable}.plain`) && existsSync(`${executable}.shadow`));

    const argvOf = (suffix: string): string[] => JSON.parse(readFileSync(`${executable}.${suffix}`, 'utf8'));
    assert.deepEqual(argvOf('plain').slice(-2), ['run', 'burnex.yml']);
    assert.deepEqual(argvOf('shadow').slice(-3), ['run', 'burnex.yml', '--shadow']);
  });

  it('agent превращается в --agent <имя>, без него флага нет', async () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const executable = join(projectRoot, 'argv-dump-agent');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
require('node:fs').writeFileSync(process.argv[1] + '.' + (process.argv.includes('--agent') ? 'agent' : 'plain'), JSON.stringify(process.argv.slice(2)));
`,
    );
    chmodSync(executable, 0o700);

    launchRun({ cwd: projectRoot, pipeline: 'burnex.yml', runsRoot, projectKey: key, execPath: executable });
    launchRun({ cwd: projectRoot, pipeline: 'burnex.yml', runsRoot, projectKey: key, execPath: executable, agent: 'codex' });
    await waitFor(() => existsSync(`${executable}.plain`) && existsSync(`${executable}.agent`));

    const argvOf = (suffix: string): string[] => JSON.parse(readFileSync(`${executable}.${suffix}`, 'utf8'));
    assert.deepEqual(argvOf('plain').slice(-2), ['run', 'burnex.yml']);
    assert.deepEqual(argvOf('agent').slice(-4), ['run', 'burnex.yml', '--agent', 'codex']);
  });

  it('scheduled превращается во флаги --scheduled/--schedule-entry, а догон добавляет --catchup', async () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const executable = join(projectRoot, 'argv-dump-scheduled');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
require('node:fs').writeFileSync(process.argv[1] + '.' + (process.argv.includes('--catchup') ? 'catchup' : 'ontime'), JSON.stringify(process.argv.slice(2)));
`,
    );
    chmodSync(executable, 0o700);

    const base = { cwd: projectRoot, pipeline: 'burnex.yml', runsRoot, projectKey: key, execPath: executable };
    launchRun({ ...base, scheduled: { entry: 2, moment: '2026-11-01T03:00:00Z', catchup: false } });
    launchRun({ ...base, scheduled: { entry: 2, moment: '2026-11-01T03:00:00Z', catchup: true } });
    await waitFor(() => existsSync(`${executable}.ontime`) && existsSync(`${executable}.catchup`));

    const argvOf = (suffix: string): string[] => JSON.parse(readFileSync(`${executable}.${suffix}`, 'utf8'));
    assert.deepEqual(argvOf('ontime').slice(-6), [
      'run', 'burnex.yml', '--scheduled', '2026-11-01T03:00:00Z', '--schedule-entry', '2',
    ]);
    assert.deepEqual(argvOf('catchup').slice(-7), [
      'run', 'burnex.yml', '--scheduled', '2026-11-01T03:00:00Z', '--schedule-entry', '2', '--catchup',
    ]);
  });

  it('достраивает терминальный журнал после обрыва посреди восстановления', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const pid = 424_242;
    const journal = seedRun(runsRoot, projectRoot, {
      runId: 'half-recovered',
      status: 'failed',
      manifest: {
        started_at: new Date().toISOString(),
        finished_at: undefined,
        status: undefined,
        exit_code: undefined,
        pid,
      },
      usage: {
        run_id: 'half-recovered',
        partial: true,
        total: {
          tokens_in: 0,
          tokens_out: 0,
          cache_read: 0,
          cache_write: 0,
          billable_tokens: 0,
          wallclock_ms: 0,
        },
        unreported: [],
        jobs: {},
      },
    });
    journal.event({
      kind: 'run.interrupted',
      pid,
      exit_code: null,
      signal: 'SIGKILL',
      detail: 'runner завершился без терминальной записи журнала',
    });

    assert.equal(
      finalizeInterruptedRun(runsRoot, key, { pid, exitCode: null, signal: 'SIGKILL' }),
      true,
    );
    assert.equal(readManifest(journal.paths).status, 'failed');
    assert.ok(readManifest(journal.paths).finished_at !== undefined);
    assert.equal(readUsage(journal.paths).partial, undefined);
    assert.equal(readEvents(journal.paths).at(-1)?.kind, 'run.finished');
  });

  it('повторяет прерванное восстановление и сообщает только окончательный отказ', async () => {
    let attempts = 0;
    const reported: Error[] = [];

    await retryInterruptedRunRecovery(
      () => {
        attempts += 1;
        if (attempts < 3) throw new Error(`временный отказ ${attempts}`);
      },
      (error) => reported.push(error),
      [0, 0, 0],
    );

    assert.equal(attempts, 3);
    assert.equal(reported.length, 0);

    await retryInterruptedRunRecovery(
      () => {
        throw new Error('постоянный отказ');
      },
      (error) => reported.push(error),
      [0, 0],
    );
    assert.equal(reported.length, 1);
    assert.match(reported[0]?.message ?? '', /постоянный отказ/);
  });
});
