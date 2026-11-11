import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { USAGE_STORE_FORMAT } from './format.js';
import { usageDatabasePath, usageStorePath } from './paths.js';
import { UsageRecordSchema, type UsageRecord } from './schema.js';

const SCHEMA_VERSION = 1;

export interface UsageStoreReadResult {
  readonly records: ReadonlyMap<string, UsageRecord>;
  readonly corrupted: number;
  readonly versionSkew: number;
}

export function usageRecordAddress(record: UsageRecord): string {
  return `${record.project.key}/${record.run_id}`;
}

function parseRecord(line: string): UsageRecord | undefined {
  try {
    const parsed = UsageRecordSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function initialize(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (version > SCHEMA_VERSION) throw new Error(`Unsupported usage database schema version: ${version}`);
  if (version === SCHEMA_VERSION) return;
  transaction(db, () => {
    // Другой процесс мог создать схему, пока мы ждали блокировку.
    const current = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (current > SCHEMA_VERSION) throw new Error(`Unsupported usage database schema version: ${current}`);
    if (current === SCHEMA_VERSION) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_records (
        address TEXT PRIMARY KEY,
        record TEXT,
        source TEXT NOT NULL CHECK (source IN ('legacy', 'native'))
      );
      CREATE TABLE IF NOT EXISTS usage_legacy_import (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        identity TEXT NOT NULL,
        offset INTEGER NOT NULL,
        size INTEGER NOT NULL,
        mtime TEXT NOT NULL,
        corrupted INTEGER NOT NULL,
        torn INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `);
  });
}

interface ImportState {
  identity: string;
  offset: number;
  size: number;
  mtime: string;
  corrupted: number;
  torn: number;
}

/**
 * Старые, уже запущенные движки продолжают дописывать NDJSON. Импортируем
 * только новый хвост; курсор и записи фиксируются одной транзакцией.
 * Исходный файл не меняем. При замене/усечении повторяем импорт, но записи
 * нового движка и явно снятые адреса (`record IS NULL`) имеют приоритет.
 */
function importLegacy(db: DatabaseSync, runsRoot: string): void {
  let fd: number;
  try {
    fd = openSync(usageStorePath(runsRoot), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const snapshot = () => {
      const info = fstatSync(fd, { bigint: true });
      return { identity: `${info.dev}:${info.ino}`, size: Number(info.size), mtime: String(info.mtimeNs) };
    };
    let { identity, size, mtime } = snapshot();
    const state = () => db.prepare('SELECT * FROM usage_legacy_import WHERE id = 1').get() as ImportState | undefined;
    const unchanged = (saved: ImportState | undefined) => saved?.identity === identity && saved.size === size && saved.mtime === mtime;
    if (unchanged(state())) return;

    transaction(db, () => {
      // За время ожидания другой процесс мог импортировать более свежий хвост.
      ({ identity, size, mtime } = snapshot());
      const saved = state();
      if (unchanged(saved)) return;
      const continuing = saved?.identity === identity && size > saved.size;
      const offset = continuing ? saved.offset : 0;
      let corrupted = continuing ? saved.corrupted : 0;
      let torn = 0;
      const buffer = Buffer.alloc(size - offset);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, offset + length);
        if (read === 0) break;
        length += read;
      }
      // Усечение одновременно с чтением: не фиксировать неполный снимок.
      if (length !== buffer.length) throw new Error('Legacy usage store changed during migration; retry');
      const put = db.prepare(`
        INSERT INTO usage_records (address, record, source) VALUES (?, ?, 'legacy')
        ON CONFLICT(address) DO UPDATE SET record = excluded.record
        WHERE usage_records.source = 'legacy' AND usage_records.record IS NOT excluded.record
      `);
      let start = 0;
      let consumed = 0;
      while (start < length) {
        const newline = buffer.indexOf(10, start);
        const end = newline === -1 ? length : newline;
        const line = buffer.subarray(start, end).toString('utf8');
        const record = line.trim() === '' ? undefined : parseRecord(line);
        if (record !== undefined) put.run(usageRecordAddress(record), JSON.stringify(record));
        else if (line.trim() !== '') {
          if (newline === -1) {
            // Недописанный JSON перечитается с начала строки при следующей
            // дозаписи. Счётчик порчи не растёт при каждом чтении хвоста.
            torn = 1;
            break;
          }
          corrupted += 1;
        }
        consumed = newline === -1 ? length : newline + 1;
        start = consumed;
      }
      db.prepare(`INSERT INTO usage_legacy_import VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET identity = excluded.identity, offset = excluded.offset,
        size = excluded.size, mtime = excluded.mtime, corrupted = excluded.corrupted, torn = excluded.torn
      `).run(identity, offset + consumed, size, mtime, corrupted, torn);
    });
  } finally {
    closeSync(fd);
  }
}

function withDatabase<T>(runsRoot: string, action: (db: DatabaseSync) => T): T {
  const path = usageDatabasePath(runsRoot);
  // SQLite создаёт файл с umask процесса; заранее задаём права журнала.
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    initialize(db);
    importLegacy(db, runsRoot);
    return action(db);
  } finally {
    db.close();
  }
}

function storeExists(runsRoot: string): boolean {
  return existsSync(usageDatabasePath(runsRoot)) || existsSync(usageStorePath(runsRoot));
}

function readWritableStore(runsRoot: string): UsageStoreReadResult {
  if (!storeExists(runsRoot)) return { records: new Map(), corrupted: 0, versionSkew: 0 };
  return withDatabase(runsRoot, (db) => {
    const records = new Map<string, UsageRecord>();
    const legacy = db.prepare('SELECT corrupted + torn AS count FROM usage_legacy_import WHERE id = 1').get();
    let corrupted = Number(legacy?.count ?? 0);
    let versionSkew = 0;
    for (const row of db.prepare('SELECT record FROM usage_records WHERE record IS NOT NULL').all()) {
      const record = parseRecord(String(row.record));
      if (record === undefined) { corrupted += 1; continue; }
      if (record.format > USAGE_STORE_FORMAT) versionSkew += 1;
      records.set(usageRecordAddress(record), record);
    }
    return { records, corrupted, versionSkew };
  });
}

/** Если миграция запрещена правами, история остаётся доступна для чтения. */
function readOnlyStore(runsRoot: string): UsageStoreReadResult {
  const records = new Map<string, UsageRecord>();
  let corrupted = 0;
  const legacyExists = existsSync(usageStorePath(runsRoot));
  if (legacyExists) {
    for (const line of readFileSync(usageStorePath(runsRoot), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const record = parseRecord(line);
      if (record === undefined) corrupted += 1;
      else records.set(usageRecordAddress(record), record);
    }
  }
  if (existsSync(usageDatabasePath(runsRoot))) {
    const db = new DatabaseSync(usageDatabasePath(runsRoot), { readOnly: true });
    try {
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (version > SCHEMA_VERSION) throw new Error(`Unsupported usage database schema version: ${version}`);
      // При отказе создания схемы может остаться пустой файл версии 0.
      if (version === SCHEMA_VERSION) {
        if (!legacyExists) {
          const count = db.prepare('SELECT corrupted + torn AS count FROM usage_legacy_import WHERE id = 1').get();
          corrupted += Number(count?.count ?? 0);
        }
        for (const row of db.prepare('SELECT address, record, source FROM usage_records').all()) {
          const address = String(row.address);
          if (row.record === null) { records.delete(address); continue; }
          const record = parseRecord(String(row.record));
          if (record === undefined) { corrupted += 1; continue; }
          if (row.source === 'native' || !records.has(address)) records.set(address, record);
        }
      }
    } finally { db.close(); }
  }
  return {
    records,
    corrupted,
    versionSkew: [...records.values()].filter((record) => record.format > USAGE_STORE_FORMAT).length,
  };
}

export function readUsageStore(runsRoot: string): UsageStoreReadResult {
  try {
    return readWritableStore(runsRoot);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { errcode?: number };
    // Только отказ записи: повреждение БД и незнакомую схему не скрываем.
    if (failure.code !== 'EACCES' && failure.code !== 'EROFS' && ((failure.errcode ?? 0) & 0xff) !== 8) throw error;
    return readOnlyStore(runsRoot);
  }
}

/** Автокоммит SQLite атомарно заменяет один агрегат, не переписывая историю. */
export function appendUsageRecord(runsRoot: string, record: UsageRecord): void {
  const parsed = UsageRecordSchema.parse(record);
  withDatabase(runsRoot, (db) => {
    db.prepare(`INSERT INTO usage_records (address, record, source) VALUES (?, ?, 'native')
      ON CONFLICT(address) DO UPDATE SET record = excluded.record, source = 'native'
      WHERE usage_records.record IS NOT excluded.record OR usage_records.source != 'native'
    `).run(usageRecordAddress(parsed), JSON.stringify(parsed));
  });
}

/** Снятый адрес остаётся маркером, чтобы старый файл не восстановил его. */
export function removeUsageRecords(runsRoot: string, addresses: readonly string[]): number {
  if (addresses.length === 0 || !storeExists(runsRoot)) return 0;
  return withDatabase(runsRoot, (db) => transaction(db, () => {
    const remove = db.prepare("UPDATE usage_records SET record = NULL, source = 'native' WHERE address = ? AND record IS NOT NULL");
    let removed = 0;
    for (const address of new Set(addresses)) removed += Number(remove.run(address).changes);
    return removed;
  }));
}
