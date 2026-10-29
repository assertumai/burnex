import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { missingRefs, parse } from '../src/parts/pipeline/domain/backlog/index.js';
import { tempDir } from './tmp.js';

function entryWith(fields: string) {
  const [entry] = parse(`## an-item\n\nstatus: todo\ntitle: т\nwhy: з\ndone_when: к\n${fields}\n`);
  assert.ok(entry !== undefined);
  return entry;
}

describe('backlog: missingRefs', () => {
  const dir = tempDir('backlog-refs-');
  mkdirSync(join(dir, 'backlog', 'an-item'), { recursive: true });
  writeFileSync(join(dir, 'backlog', 'an-item', 'goal.md'), 'цель\n');
  writeFileSync(join(dir, 'backlog', 'an-item', 'a.md'), 'а\n');

  it('полей нет — пусто', () => {
    assert.deepEqual(missingRefs(entryWith(''), dir), []);
  });

  it('все файлы на месте — пусто', () => {
    const entry = entryWith('goal: backlog/an-item/goal.md\ndetails: backlog/an-item/a.md');
    assert.deepEqual(missingRefs(entry, dir), []);
  });

  it('один отсутствует — назван, порядок goal → details', () => {
    const entry = entryWith('goal: backlog/an-item/nope.md\ndetails: backlog/an-item/a.md, backlog/an-item/b.md');
    assert.deepEqual(missingRefs(entry, dir), ['backlog/an-item/nope.md', 'backlog/an-item/b.md']);
  });

  it('путь называет каталог — это отсутствие', () => {
    assert.deepEqual(missingRefs(entryWith('goal: backlog/an-item'), dir), ['backlog/an-item']);
  });
});
