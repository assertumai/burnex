import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { parseArgs } from '../src/kernel/cli/args.js';
import { row, runDataCommand } from '../src/parts/pipeline/commands/data.js';
import { readRunData, runDataPath } from '../src/parts/pipeline/run/journal/runData.js';
import { cleanupRun } from '../src/parts/pipeline/run/cleanup.js';
import { createWatcher } from '../src/parts/ui/daemon/watcher.js';
import { makeJournalBed, seedRun } from './helpers.js';

function publish(dir: string, args: readonly string[]): string[] {
  const lines: string[] = [];
  runDataCommand(parseArgs(['data', '--run', ...args], { data: row.command.spec }),
    (line) => lines.push(line), { BURNEX_RUN_DIR: dir });
  return lines;
}

describe('run publications', () => {
  it('streams independent publications while status is unchanged and retains them after cleanup', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'live', status: 'running' });
    const before = readFileSync(journal.paths.status, 'utf8');
    const watcher = createWatcher({ runsRoot, intervalMs: 60_000 });
    try {
      let updates = 0;
      watcher.subscribe(() => { updates += 1; });
      const current = () => watcher.current().projects[0]?.runs[0];
      assert.equal(current()?.description, undefined);
      publish(journal.paths.dir, ['set', 'description', 'Building']);
      watcher.poll();
      assert.equal(current()?.description, 'Building');
      publish(journal.paths.dir, ['set', 'result', '[Report](https://example.org/report)']);
      watcher.poll();
      assert.equal(current()?.result, '[Report](https://example.org/report)');
      assert.equal(current()?.description, 'Building');
      publish(journal.paths.dir, ['set', 'description', 'Checking']);
      watcher.poll();
      assert.equal(current()?.description, 'Checking');
      assert.equal(updates, 3);
      assert.equal(readFileSync(journal.paths.status, 'utf8'), before);
      assert.deepEqual(publish(journal.paths.dir, ['get', 'description']), ['Checking']);
      publish(journal.paths.dir, ['set', 'description', '']);
      watcher.poll();
      assert.equal(current()?.description, '');
      cleanupRun(journal.paths);
      assert.equal(readRunData(journal.paths.dir).result, '[Report](https://example.org/report)');
    } finally { watcher.dispose(); }
  });

  it('validates every merge field before writing, rejects unknown keys and requires run context', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const { paths } = seedRun(runsRoot, projectRoot);
    publish(paths.dir, ['merge', '--json', '{"description":"Work","result":"Done"}']);
    for (const json of ['{"description":"Changed","other":"x"}', '{"result":2}', '[]', 'null', '{']) {
      assert.throws(() => publish(paths.dir, ['merge', '--json', json]));
      assert.deepEqual(readRunData(paths.dir), { description: 'Work', result: 'Done' });
    }
    assert.throws(() => publish(paths.dir, ['set', '../status', 'bad']));
    assert.throws(() => runDataCommand(parseArgs(['data', '--run', 'get'], { data: row.command.spec }), () => {}, {}), /BURNEX_RUN_DIR/);
    writeFileSync(runDataPath(paths.dir, 'description'), '{broken');
    assert.deepEqual(readRunData(paths.dir), { result: 'Done' });
  });

  it('concurrent CLI processes publishing different fields do not lose either value', async () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const { paths } = seedRun(runsRoot, projectRoot);
    const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
    const call = (key: string, value: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [bin, 'data', '--run', 'set', key, value], {
        env: { ...process.env, BURNEX_RUN_DIR: paths.dir }, stdio: 'pipe',
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    });
    await Promise.all([call('description', 'Checking'), call('result', 'https://example.org/report')]);
    assert.deepEqual(readRunData(paths.dir), { description: 'Checking', result: 'https://example.org/report' });
  });
});
