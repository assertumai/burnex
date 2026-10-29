import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MergeEventSchema, openMergeEvents } from '../src/parts/pipeline/domain/lanes/mergeEvents.js';
import { runPaths } from '../src/parts/pipeline/run/journal/paths.js';
import { tempDir } from './tmp.js';

function lines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

describe('merge-events.jsonl', () => {
  it('лежит в каталоге прогона рядом с events, но отдельным файлом', () => {
    const paths = runPaths('/root', 'key', 'run');
    assert.equal(paths.mergeEvents, '/root/key/run/merge-events.jsonl');
    assert.notEqual(paths.mergeEvents, paths.events);
  });

  it('дописывает построчно, каждая запись проходит схему, строка уходит в вывод', () => {
    const path = join(tempDir('merge-events-'), 'merge-events.jsonl');
    const printed: string[] = [];
    const writer = openMergeEvents(path, (line) => printed.push(line));

    writer.emit({ kind: 'merge.dirty_waiting', paths: ['src/a.ts'], waited_ms: 0 });
    writer.emit({ kind: 'merge.dirty_resolved', waited_ms: 4000 });

    const written = lines(path);
    assert.equal(written.length, 2);
    for (const event of written) assert.ok(MergeEventSchema.safeParse(event).success);
    assert.deepEqual(
      written.map((event) => (event as { seq: number }).seq),
      [0, 1],
    );
    assert.equal(printed.length, 2);
    assert.match(printed[0] as string, /src\/a\.ts/u);
  });

  it('seq продолжается после повторного открытия файла', () => {
    const path = join(tempDir('merge-events-'), 'merge-events.jsonl');
    openMergeEvents(path).emit({ kind: 'merge.dirty_resolved', waited_ms: 1 });
    openMergeEvents(path).emit({ kind: 'merge.dirty_resolved', waited_ms: 2 });

    assert.deepEqual(
      lines(path).map((event) => (event as { seq: number }).seq),
      [0, 1],
    );
  });

  it('events журнала прогона не трогается', () => {
    const dir = tempDir('merge-events-');
    const paths = runPaths(dir, 'key', 'run');
    const events = join(dir, 'events.ndjson');
    writeFileSync(events, '{"seq":0}\n');
    const mergePath = join(dir, 'merge-events.jsonl');

    openMergeEvents(mergePath).emit({ kind: 'merge.dirty_waiting', paths: ['x'], waited_ms: 0 });

    assert.equal(readFileSync(events, 'utf8'), '{"seq":0}\n');
    assert.ok(paths.events.endsWith('events.ndjson'));
  });
});
