import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../src/parts/pipeline/config/resolve.js';
import { buildSchedule, type ProjectScheduleView, type ScheduleEntryView } from '../src/parts/ui/schedule.js';
import { makeJournalBed, seedRun } from './helpers.js';

/**
 * Экран «Schedule» (`ui-schedule-view`): расписание раскрытого пайплайна,
 * ошибки записей словами линта, последний запуск по записи. `now` задан, чтобы
 * «ближайший момент» не зависел от часов.
 */

const NOW = new Date('2026-11-01T00:00:00Z');

const SCHEDULED = `kind: pipeline
name: nightly
triggers:
  schedule:
    - { cron: '0 4 * * *', timezone: Europe/Berlin }
    - { cron: '30 6 * * *' }
    - { cron: '0 0 30 2 *' }
jobs:
  build:
    steps:
      - { id: compile, run: [echo, ok] }
`;

const PLAIN = `kind: pipeline
name: plain
jobs:
  build:
    steps:
      - { id: compile, run: [echo, ok] }
`;

const BROKEN = `kind: pipeline
name: broken
triggers:
  schedule:
    - { cron: '0 4 * * *' }
jobs: нет
`;

function trigger(entry: number, cron: string, timezone: string | undefined, moment: string, catchup: boolean) {
  return {
    kind: 'schedule' as const,
    entry,
    cron,
    ...(timezone === undefined ? {} : { timezone }),
    moment,
    catchup,
  };
}

async function build() {
  const { runsRoot, projectRoot, home } = makeJournalBed();
  const dir = join(projectRoot, '.burnex', 'pipelines');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nightly.yml'), SCHEDULED);
  writeFileSync(join(dir, 'plain.yml'), PLAIN);
  writeFileSync(join(dir, 'broken.yml'), BROKEN);
  const file = join(dir, 'nightly.yml');
  const base = { pipeline: 'nightly', pipeline_file: file };

  seedRun(runsRoot, projectRoot, { runId: '2026-10-30T00-00-00Z-manual', manifest: base });
  seedRun(runsRoot, projectRoot, {
    runId: '2026-10-30T03-00-00Z-first',
    manifest: {
      ...base,
      started_at: '2026-10-30T03:00:01.000Z',
      trigger: trigger(0, '0 4 * * *', 'Europe/Berlin', '2026-10-30T03:00:00Z', false),
    },
    status: 'failed',
  });
  seedRun(runsRoot, projectRoot, {
    runId: '2026-10-31T09-00-00Z-catchup',
    manifest: {
      ...base,
      started_at: '2026-10-31T09:00:00.000Z',
      trigger: trigger(0, '0 4 * * *', 'Europe/Berlin', '2026-10-31T03:00:00Z', true),
    },
    status: 'success',
  });
  // Прежнее выражение той же записи: номер тот же, а выражение другое — записи не засчитывается.
  seedRun(runsRoot, projectRoot, {
    runId: '2026-10-31T10-00-00Z-old',
    manifest: {
      ...base,
      started_at: '2026-10-31T10:00:00.000Z',
      trigger: trigger(0, '0 3 * * *', 'Europe/Berlin', '2026-10-31T02:00:00Z', false),
    },
  });

  const { config } = resolveConfig({ cwd: home, home, projectPath: null });
  const overview = await buildSchedule(runsRoot, config, { home, now: NOW });
  assert.equal(overview.projects.length, 1);
  return { overview, project: overview.projects[0] as ProjectScheduleView, projectRoot };
}

describe('ui-schedule: buildSchedule', () => {
  it('в ответ попадают только пайплайны с расписанием', async () => {
    const { project } = await build();
    assert.deepEqual(project.pipelines.map((entry) => entry.pipeline), ['.burnex/pipelines/nightly.yml']);
  });

  it('запись с явным поясом и запись с умолчательным различимы, у обеих есть ближайший момент', async () => {
    const { project } = await build();
    const [berlin, local] = project.pipelines[0]?.entries as ScheduleEntryView[];

    assert.equal(berlin?.timezone, 'Europe/Berlin');
    assert.equal(berlin?.defaultTimezone, false);
    // 04:00 по Берлину 1 ноября (CET, UTC+1) — 03:00 UTC.
    assert.equal(berlin?.next, '2026-11-01T03:00:00.000Z');

    assert.equal(local?.defaultTimezone, true);
    assert.equal(local?.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.ok(local?.next !== undefined && Date.parse(local.next) > NOW.getTime());
  });

  it('невыполнимая запись несёт текст линта и не несёт момента', async () => {
    const { project } = await build();
    const bad = project.pipelines[0]?.entries[2];
    assert.equal(bad?.error, 'Запись расписания 2: расписание невыполнимо — такой день в этом месяце не наступает');
    assert.equal(bad?.next, undefined);
  });

  it('нераскрывшийся пайплайн даёт строку с причиной', async () => {
    const { project } = await build();
    assert.deepEqual(project.pipelineErrors.map((entry) => entry.pipeline), ['.burnex/pipelines/broken.yml']);
    assert.ok((project.pipelineErrors[0]?.error ?? '') !== '');
  });

  it('последний запуск — по записи: догон новее первого, ручной и прежнее выражение не засчитываются', async () => {
    const { project } = await build();
    const [berlin, local] = project.pipelines[0]?.entries as ScheduleEntryView[];

    assert.deepEqual(berlin?.lastRun, {
      runId: '2026-10-31T09-00-00Z-catchup',
      moment: '2026-10-31T03:00:00Z',
      catchup: true,
      status: 'success',
    });
    assert.equal(local?.lastRun, undefined);
  });

  it('прогон, записавший путь к пайплайну через симлинк, засчитывается записи', async () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const dir = join(projectRoot, '.burnex', 'pipelines');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'nightly.yml'), SCHEDULED);
    // Тот же проект под другим написанием пути — как `/var` и `/private/var` на macOS.
    const alias = `${projectRoot}-alias`;
    symlinkSync(projectRoot, alias, 'dir');
    seedRun(runsRoot, projectRoot, {
      runId: '2026-10-31T03-00-00Z-alias',
      manifest: {
        pipeline: 'nightly',
        pipeline_file: join(alias, '.burnex', 'pipelines', 'nightly.yml'),
        started_at: '2026-10-31T03:00:01.000Z',
        trigger: trigger(0, '0 4 * * *', 'Europe/Berlin', '2026-10-31T03:00:00Z', false),
      },
      status: 'success',
    });

    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const overview = await buildSchedule(runsRoot, config, { home, now: NOW });
    const berlin = overview.projects[0]?.pipelines[0]?.entries[0];
    assert.equal(berlin?.lastRun?.runId, '2026-10-31T03-00-00Z-alias');
  });

  it('сервиса триггеров нет: present false', async () => {
    const { overview } = await build();
    assert.deepEqual(overview.service, { present: false });
    assert.equal(overview.generatedAt, NOW.toISOString());
  });
});
