import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BurnexError } from '../src/kernel/errors.js';
import {
  archivedPathFor,
  checkNeeds,
  needsMet,
  parse,
  readArchivedEntries,
  statusResolver,
  unmetNeeds,
  MISSING_STATUS,
  type BacklogEntry,
} from '../src/parts/pipeline/domain/backlog/index.js';
import { tempDir } from './tmp.js';

/** Граф зависимостей пунктов: статус слага, проверка связей, выполненность. */

function item(slug: string, status: string, needs?: string): string {
  const extra = needs === undefined ? '' : `\nneeds: ${needs}`;
  return `## ${slug}\n\nstatus: ${status}\ntitle: т\nwhy: з\ndone_when: к${extra}\n`;
}

function entries(...items: readonly string[]): readonly BacklogEntry[] {
  return parse(`# Очередь\n\n${items.join('\n')}`);
}

function entryOf(list: readonly BacklogEntry[], slug: string): BacklogEntry {
  const found = list.find((entry) => entry.slug === slug);
  assert.ok(found !== undefined);
  return found;
}

describe('backlog needs: чтение архива', () => {
  it('archivedPathFor кладёт archived.md в каталог очереди', () => {
    assert.equal(archivedPathFor('/srv/project/backlog.md'), '/srv/project/archived.md');
  });

  it('отсутствующий архив — пустой перечень', () => {
    const dir = tempDir('backlog-needs-');
    assert.deepEqual(readArchivedEntries(join(dir, 'backlog.md')), []);
  });

  it('читает пункты архива', () => {
    const dir = tempDir('backlog-needs-');
    writeFileSync(join(dir, 'archived.md'), `# Архив\n\n${item('old', 'done')}`);
    assert.deepEqual(
      readArchivedEntries(join(dir, 'backlog.md')).map((entry) => entry.slug),
      ['old'],
    );
  });

  it('неразбираемый архив — отказ с путём архива', () => {
    const dir = tempDir('backlog-needs-');
    writeFileSync(join(dir, 'archived.md'), '## old\n\nне поле\n');
    assert.throws(
      () => readArchivedEntries(join(dir, 'backlog.md')),
      (error: unknown) => {
        assert.ok(error instanceof BurnexError);
        assert.equal(error.file, join(dir, 'archived.md'));
        return true;
      },
    );
  });
});

describe('backlog needs: статус слага', () => {
  it('очередь приоритетнее архива, неизвестный слаг — undefined', () => {
    const statusOf = statusResolver(entries(item('both', 'todo')), entries(item('both', 'done'), item('old', 'done')));
    assert.equal(statusOf('both'), 'todo');
    assert.equal(statusOf('old'), 'done');
    assert.equal(statusOf('nope'), undefined);
  });
});

describe('backlog needs: проверка связей', () => {
  function refusal(list: readonly BacklogEntry[], archived: readonly BacklogEntry[] = []): BurnexError {
    try {
      checkNeeds(list, archived);
    } catch (error) {
      assert.ok(error instanceof BurnexError);
      return error;
    }
    return assert.fail('checkNeeds не отказал');
  }

  it('граф без зависимостей и корректный граф проходят', () => {
    checkNeeds(entries(item('a', 'todo'), item('b', 'todo', 'a'), item('c', 'todo', 'a, b')), []);
  });

  it('неизвестный слаг: at — пункт, в сообщении пункт и слаг', () => {
    const error = refusal(entries(item('b', 'todo', 'nope')));
    assert.equal(error.at, 'b');
    assert.match(error.message, /«b»/);
    assert.match(error.message, /«nope»/);
  });

  it('цикл из двух называет путь', () => {
    const error = refusal(entries(item('a', 'todo', 'b'), item('b', 'todo', 'a')));
    assert.match(error.message, /a → b → a/);
  });

  it('самоссылка — цикл', () => {
    const error = refusal(entries(item('a', 'todo', 'a')));
    assert.match(error.message, /a → a/);
  });

  it('зависимость в архиве допустима, её собственные needs не проверяются', () => {
    checkNeeds(entries(item('b', 'todo', 'old')), entries(item('old', 'done', 'ghost')));
  });

  it('слаг в обоих файлах побеждает очередь: цикл через него виден', () => {
    const error = refusal(
      entries(item('a', 'todo', 'b'), item('b', 'todo', 'a')),
      entries(item('b', 'done')),
    );
    assert.match(error.message, /→/);
  });
});

describe('backlog needs: выполненность', () => {
  const statusOf = statusResolver(
    entries(item('t', 'todo'), item('p', 'postponed'), item('f', 'failed'), item('w', 'in_progress'), item('d', 'done')),
    [],
  );

  it('выполняет зависимость только done', () => {
    const list = entries(item('x', 'todo', 'd'), item('y', 'todo', 'd, t'));
    assert.equal(needsMet(entryOf(list, 'x'), statusOf), true);
    assert.equal(needsMet(entryOf(list, 'y'), statusOf), false);
  });

  for (const status of ['t', 'p', 'f', 'w']) {
    it(`зависимость «${status}» не выполнена`, () => {
      assert.equal(needsMet(entryOf(entries(item('x', 'todo', status)), 'x'), statusOf), false);
    });
  }

  it('unmetNeeds называет слаги со статусами, отсутствующий — отметкой', () => {
    const entry = entryOf(entries(item('x', 'todo', 'd, p, ghost')), 'x');
    assert.deepEqual(unmetNeeds(entry, statusOf), [
      { slug: 'p', status: 'postponed' },
      { slug: 'ghost', status: MISSING_STATUS },
    ]);
  });
});
