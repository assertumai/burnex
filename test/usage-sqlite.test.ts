import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { projectKey, usageStorePath } from '../src/parts/pipeline/run/journal/paths.js';
import { readManifest, readStatus, readUsage } from '../src/parts/pipeline/run/journal/reader.js';
import { appendUsageRecord, catchUpUsageStore, readUsageStore, removeUsageRecords, usageRecord } from '../src/parts/pipeline/run/journal/usageStore.js';
import { removeRunWithStats } from '../src/parts/pipeline/run/cleanup.js';
import { buildOverview } from '../src/parts/ui/overview.js';
import { buildUsage } from '../src/parts/ui/usage.js';
import { makeJournalBed, seedRun } from './helpers.js';

function fixture() {
  const { runsRoot, projectRoot } = makeJournalBed();
  const key = projectKey(projectRoot);
  const journal = seedRun(runsRoot, projectRoot, { runId: 'old' });
  const record = usageRecord(key, readManifest(journal.paths), readStatus(journal.paths), readUsage(journal.paths));
  return { runsRoot, key, journal, record, database: join(runsRoot, 'usage.sqlite') };
}

describe('usage-store: SQLite migration', () => {
  it('пишет агрегат в SQLite и обновляет одну запись по адресу', () => {
    const { runsRoot, key, record, database } = fixture();
    appendUsageRecord(runsRoot, record);
    appendUsageRecord(runsRoot, { ...record, total: { ...record.total, billable_tokens: 42 } });
    assert.ok(existsSync(database), 'новые записи должны храниться в SQLite');
    assert.equal(readFileSync(database).subarray(0, 16).toString(), 'SQLite format 3\0');
    assert.equal(statSync(database).mode & 0o777, 0o600);
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM usage_records WHERE record IS NOT NULL').get()?.n, 1);
      assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    } finally { db.close(); }
    assert.equal(readUsageStore(runsRoot).records.get(`${key}/old`)?.total.billable_tokens, 42);
    assert.equal(existsSync(usageStorePath(runsRoot)), false, 'новый движок не создаёт NDJSON');
  });

  it('мигрирует удалённые runs, дубликаты и неизвестные поля; повторное чтение не пишет БД', () => {
    const { runsRoot, key, journal, record, database } = fixture();
    const newer = { ...record, format: record.format + 1, future_field: 'сохранить', total: { ...record.total, billable_tokens: 73, cost_usd: 4 } };
    const legacy = `${JSON.stringify(record)}\nне JSON\n${JSON.stringify(newer)}\n`;
    writeFileSync(usageStorePath(runsRoot), legacy);
    rmSync(journal.paths.dir, { recursive: true });
    const first = readUsageStore(runsRoot);
    assert.ok(existsSync(database), 'чтение старой установки переносит статистику в SQLite');
    assert.equal(first.corrupted, 1);
    assert.equal(first.versionSkew, 1);
    assert.deepEqual(first.records.get(`${key}/old`), newer);
    const before = readFileSync(database);
    assert.deepEqual(readUsageStore(runsRoot), first);
    assert.deepEqual(readFileSync(database), before);
    assert.equal(readFileSync(usageStorePath(runsRoot), 'utf8'), legacy, 'исходный файл остаётся цел');
    const overview = buildOverview(runsRoot);
    assert.deepEqual(overview.projects, []);
    assert.equal(buildUsage(runsRoot, overview).total.billableTokens, 73);
    rmSync(usageStorePath(runsRoot));
    assert.deepEqual(readUsageStore(runsRoot).records, first.records, 'история больше не зависит от NDJSON');
  });

  it('подхватывает завершение старого процесса после миграции, включая дописанный хвост', () => {
    const { runsRoot, key, record } = fixture();
    writeFileSync(usageStorePath(runsRoot), `${JSON.stringify(record)}\n`);
    readUsageStore(runsRoot);
    const late = JSON.stringify({ ...record, run_id: 'late', total: { ...record.total, billable_tokens: 91 } });
    appendFileSync(usageStorePath(runsRoot), late.slice(0, 50));
    assert.equal(readUsageStore(runsRoot).corrupted, 1);
    assert.equal(readUsageStore(runsRoot).corrupted, 1, 'недописанный хвост не считается повторно');
    appendFileSync(usageStorePath(runsRoot), `${late.slice(50)}\n`);
    const result = readUsageStore(runsRoot);
    assert.equal(result.corrupted, 0);
    assert.equal(result.records.get(`${key}/late`)?.total.billable_tokens, 91);
  });

  it('повторный импорт после замены файла не воскрешает снятую статистику и не затирает новую', () => {
    const { runsRoot, key, record } = fixture();
    const legacy = `${JSON.stringify(record)}\n${JSON.stringify({ ...record, run_id: 'native' })}\n`;
    writeFileSync(usageStorePath(runsRoot), legacy);
    readUsageStore(runsRoot);
    assert.equal(removeUsageRecords(runsRoot, [`${key}/old`, `${key}/old`]), 1);
    appendUsageRecord(runsRoot, { ...record, run_id: 'native', total: { ...record.total, billable_tokens: 99 } });
    writeFileSync(`${usageStorePath(runsRoot)}.new`, legacy);
    renameSync(`${usageStorePath(runsRoot)}.new`, usageStorePath(runsRoot));
    const result = readUsageStore(runsRoot);
    assert.equal(result.records.has(`${key}/old`), false);
    assert.equal(result.records.get(`${key}/native`)?.total.billable_tokens, 99);
  });

  it('не удаляет файлы run при ошибке записи статистики', () => {
    const { runsRoot, key, journal, database } = fixture();
    writeFileSync(database, 'not a database');
    assert.throws(() => removeRunWithStats(runsRoot, key, 'old'));
    assert.ok(existsSync(journal.paths.manifest));
    assert.ok(existsSync(journal.paths.usage));
  });

  it('не меняет БД с неизвестной версией схемы', () => {
    const { runsRoot, database, record } = fixture();
    const db = new DatabaseSync(database);
    db.exec('PRAGMA user_version = 99; CREATE TABLE future (value TEXT);');
    db.close();
    const before = readFileSync(database);
    assert.throws(() => appendUsageRecord(runsRoot, record), /version|верси/i);
    assert.deepEqual(readFileSync(database), before);
  });

  it('читает старую установку без права миграции, но не удаляет её файлы без сохранения в БД', () => {
    const { runsRoot, key, journal, record, database } = fixture();
    writeFileSync(usageStorePath(runsRoot), `${JSON.stringify(record)}\n`);
    chmodSync(runsRoot, 0o500);
    try {
      assert.equal(readUsageStore(runsRoot).records.get(`${key}/old`)?.run_id, 'old');
      assert.doesNotThrow(() => catchUpUsageStore(runsRoot));
      assert.throws(() => removeRunWithStats(runsRoot, key, 'old'));
      assert.ok(existsSync(journal.paths.manifest));
      assert.equal(existsSync(database), false);
    } finally { chmodSync(runsRoot, 0o700); }
  });

  it('без права записи в БД читает поздний legacy-хвост и сохраняет приоритет native и удаления', () => {
    const { runsRoot, key, record, database } = fixture();
    writeFileSync(usageStorePath(runsRoot), `${JSON.stringify(record)}\n`);
    readUsageStore(runsRoot);
    removeUsageRecords(runsRoot, [`${key}/old`]);
    appendUsageRecord(runsRoot, { ...record, run_id: 'native', total: { ...record.total, billable_tokens: 55 } });
    appendFileSync(usageStorePath(runsRoot), `${JSON.stringify({ ...record, run_id: 'late' })}\n${JSON.stringify({ ...record, run_id: 'native' })}\n`);
    chmodSync(database, 0o400);
    try {
      const result = readUsageStore(runsRoot);
      assert.equal(result.records.has(`${key}/old`), false);
      assert.equal(result.records.has(`${key}/late`), true);
      assert.equal(result.records.get(`${key}/native`)?.total.billable_tokens, 55);
    } finally { chmodSync(database, 0o600); }
  });

  it('расход сохраняет адрес пайплайна пакета у существующего прогона', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'package', manifest: { pipeline_address: '@example/demo', pipeline_file: '/packages/demo/pipeline.yml' } });
    catchUpUsageStore(runsRoot);
    const overview = buildOverview(runsRoot);
    assert.equal(overview.projects[0]?.runs[0]?.pipelineFile, '@example/demo');
    assert.equal(buildUsage(runsRoot, overview).pipelines[0]?.pipelineFile, '@example/demo');
  });

  it('миграция и параллельные записи/удаления из разных процессов не теряют соседние записи', async () => {
    const { runsRoot, record, key, database } = fixture();
    writeFileSync(usageStorePath(runsRoot), `${JSON.stringify(record)}\n`);
    const module = new URL('../src/parts/pipeline/run/journal/usageStore.js', import.meta.url).href;
    const script = `
      const { appendUsageRecord, removeUsageRecords } = await import(process.argv[1]);
      const [root, prefix, json] = process.argv.slice(2);
      const record = JSON.parse(json);
      for (let i = 0; i < 12; i++) {
        appendUsageRecord(root, { ...record, run_id: prefix + i });
        if (i % 2 === 0) removeUsageRecords(root, [record.project.key + '/' + prefix + i]);
      }
    `;
    await Promise.all(['a', 'b', 'c'].map((prefix) => promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', script, module, runsRoot, prefix, JSON.stringify(record)],
    )));
    const { records } = readUsageStore(runsRoot);
    assert.equal(records.size, 19);
    for (const prefix of ['a', 'b', 'c']) {
      for (let i = 0; i < 12; i++) assert.equal(records.has(`${key}/${prefix}${i}`), i % 2 !== 0);
    }
    const db = new DatabaseSync(database, { readOnly: true });
    try { assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); }
    finally { db.close(); }
  });

  it('догон не фиксирует промежуточную статистику живого прогона', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'alive', status: 'running', manifest: { pid: process.pid, started_at: new Date().toISOString() } });
    catchUpUsageStore(runsRoot);
    assert.equal(readUsageStore(runsRoot).records.size, 0);
  });

  it('перед удалением обновляет ранее сохранённый промежуточный расход', () => {
    const { runsRoot, record, key, journal } = fixture();
    appendUsageRecord(runsRoot, { ...record, status: 'running', total: { ...record.total, billable_tokens: 1 } });
    const report = readUsage(journal.paths);
    writeFileSync(journal.paths.usage, JSON.stringify({ ...report, total: { ...report.total, billable_tokens: 88 } }));
    removeRunWithStats(runsRoot, key, 'old');
    assert.equal(readUsageStore(runsRoot).records.get(`${key}/old`)?.total.billable_tokens, 88);
    assert.equal(buildUsage(runsRoot, buildOverview(runsRoot)).total.billableTokens, 88);
  });
});
