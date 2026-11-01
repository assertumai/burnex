import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ExitCode } from '../src/kernel/errors.js';
import type { ParsedArgs } from '../src/kernel/cli/types.js';
import { runRunCommand } from '../src/parts/pipeline/commands/run.js';
import { runResumeCommand } from '../src/parts/pipeline/commands/resume.js';
import { projectKey, runPaths } from '../src/parts/pipeline/run/journal/paths.js';
import { listRuns, readManifest } from '../src/parts/pipeline/run/journal/reader.js';
import { makeProject, withHome, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * `run --scheduled / --schedule-entry / --catchup` (`ui-schedule-view`):
 * происхождение прогона по расписанию пишется в манифест, а всякий отказ
 * случается до создания каталога прогона.
 */

const PIPELINE = `
version: 1
kind: pipeline
name: nightly
triggers:
  schedule:
    - { cron: '0 4 * * *', timezone: Europe/Berlin }
jobs:
  build:
    steps:
      - { id: compile, run: [echo, ok] }
`;

const MOMENT = '2026-11-01T03:00:00Z';

interface Bed {
  readonly project: Project;
  readonly runsRoot: string;
  readonly lines: string[];
}

function bed(): Bed {
  const project = makeProject({ 'stepcast.yml': PIPELINE });
  const runsRoot = tempDir('runs-');
  writeFileSync(join(project.home, '.stepcast', 'config.yml'), `runs:\n  root: ${runsRoot}\n`);
  return { project, runsRoot, lines: [] };
}

function run(b: Bed, flags: ParsedArgs['flags']): Promise<number> {
  return withHome(b.project.home, () =>
    runRunCommand({ command: 'run', positional: ['stepcast.yml'], flags }, (line) => b.lines.push(line), b.project.root),
  );
}

function manifestOf(b: Bed, runId: string) {
  return readManifest(runPaths(b.runsRoot, projectKey(b.project.root), runId));
}

function refused(b: Bed, flags: ParsedArgs['flags'], pattern: RegExp): Promise<void> {
  return run(b, flags).then((code) => {
    assert.equal(code, ExitCode.configError);
    assert.match(b.lines.join('\n'), pattern);
    assert.deepEqual(listRuns(b.runsRoot, b.project.root), [], 'каталог прогона не создан');
  });
}

describe('run --scheduled', () => {
  it('пишет trigger в run.json: запуск по расписанию', async () => {
    const b = bed();
    assert.equal(await run(b, { scheduled: MOMENT, 'schedule-entry': '0' }), ExitCode.ok);
    const id = listRuns(b.runsRoot, b.project.root)[0] as string;
    assert.deepEqual(manifestOf(b, id).trigger, {
      kind: 'schedule',
      entry: 0,
      cron: '0 4 * * *',
      timezone: 'Europe/Berlin',
      moment: MOMENT,
      catchup: false,
    });
  });

  it('--catchup помечает догон', async () => {
    const b = bed();
    assert.equal(await run(b, { scheduled: MOMENT, 'schedule-entry': '0', catchup: true }), ExitCode.ok);
    const id = listRuns(b.runsRoot, b.project.root)[0] as string;
    assert.equal(manifestOf(b, id).trigger?.catchup, true);
  });

  it('прогон без флагов идёт без trigger', async () => {
    const b = bed();
    assert.equal(await run(b, {}), ExitCode.ok);
    const id = listRuns(b.runsRoot, b.project.root)[0] as string;
    assert.equal('trigger' in manifestOf(b, id), false);
  });

  it('номер записи вне расписания отклоняется с названным номером', async () => {
    await refused(bed(), { scheduled: MOMENT, 'schedule-entry': '3' }, /Запись расписания 3 не существует/);
  });

  it('нецелый номер записи отклоняется', async () => {
    await refused(bed(), { scheduled: MOMENT, 'schedule-entry': 'x' }, /Запись расписания x не существует/);
  });

  it('--catchup без пары отклоняется', async () => {
    await refused(bed(), { catchup: true }, /--catchup допустим только вместе с --scheduled/);
  });

  it('--scheduled без --schedule-entry называет недостающий флаг', async () => {
    await refused(bed(), { scheduled: MOMENT }, /--schedule-entry/);
  });

  it('--schedule-entry без --scheduled называет недостающий флаг', async () => {
    await refused(bed(), { 'schedule-entry': '0' }, /--scheduled <момент>/);
  });

  it('неразборчивый момент и момент без пояса отклоняются', async () => {
    await refused(bed(), { scheduled: 'вчера', 'schedule-entry': '0' }, /ISO 8601 с поясом/);
    await refused(bed(), { scheduled: '2026-11-01T03:00:00', 'schedule-entry': '0' }, /ISO 8601 с поясом/);
    await refused(bed(), { scheduled: '2026-13-45T03:00:00Z', 'schedule-entry': '0' }, /ISO 8601 с поясом/);
  });

  it('несуществующая дата и время отклоняются, а не переносятся на соседний день', async () => {
    for (const moment of [
      '2026-02-30T03:00:00Z',
      '2026-02-29T03:00:00Z',
      '2026-04-31T03:00:00+02:00',
      '2026-11-01T24:00:00Z',
      '2026-11-01T03:60:00Z',
      '2026-11-01T03:00:00+25:00',
    ]) {
      await refused(bed(), { scheduled: moment, 'schedule-entry': '0' }, /ISO 8601 с поясом/);
    }
  });

  it('29 февраля високосного года принимается', async () => {
    const b = bed();
    const leap = '2028-02-29T03:00:00Z';
    assert.equal(await run(b, { scheduled: leap, 'schedule-entry': '0' }), ExitCode.ok);
    const id = listRuns(b.runsRoot, b.project.root)[0] as string;
    assert.equal(manifestOf(b, id).trigger?.moment, leap);
  });

  it('отказ и при --dry-run', async () => {
    await refused(bed(), { scheduled: MOMENT, 'schedule-entry': '9', 'dry-run': true }, /не существует/);
  });

  it('resume не наследует trigger исходного прогона', async () => {
    const b = bed();
    assert.equal(await run(b, { scheduled: MOMENT, 'schedule-entry': '0' }), ExitCode.ok);
    const sourceId = listRuns(b.runsRoot, b.project.root)[0] as string;

    const code = await withHome(b.project.home, () =>
      runResumeCommand(
        { command: 'resume', positional: [sourceId], flags: { from: 'build' } },
        (line) => b.lines.push(line),
        b.project.root,
      ),
    );
    assert.equal(code, ExitCode.ok);
    const resumedId = listRuns(b.runsRoot, b.project.root).find((id) => id !== sourceId) as string;
    const resumed = manifestOf(b, resumedId);
    assert.equal(resumed.resumed_from, manifestOf(b, sourceId).run_id);
    assert.equal('trigger' in resumed, false);
  });
});
