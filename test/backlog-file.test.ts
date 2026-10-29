import assert from 'node:assert/strict';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/kernel/errors.js';
import { finishItem, oneLine, readBacklogFile, tailLine, REASON_LIMIT } from '../src/parts/pipeline/domain/backlog/file.js';
import { tempDir } from './tmp.js';

/**
 * Файловая сторона очереди (`src/parts/pipeline/domain/backlog/file.ts`): её пользуются и
 * `stepcast backlog`, и сведение дорожек, поэтому проверяется она здесь один
 * раз — временными файлами, в отличие от чистого ядра в `test/backlog.test.ts`.
 */

function backlog(status: string): string {
  return `## some-item\n\nstatus: ${status}\ntitle: Улучшение\nwhy: з\ndone_when: к\n`;
}

function makeFile(text: string): string {
  const dir = tempDir('backlog-file-');
  const path = join(dir, 'backlog.md');
  writeFileSync(path, text);
  return path;
}

function fieldOf(text: string, name: string): string | undefined {
  return new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(text)?.[1];
}

describe('backlog file: finishItem', () => {
  it('проставляет исход пункту без исхода', () => {
    const path = makeFile(backlog('in_progress'));
    assert.equal(finishItem(path, 'test', 'some-item', 'done'), 'set');
    assert.equal(fieldOf(readFileSync(path, 'utf8'), 'status'), 'done');
  });

  it('уже проставленный исход не переписывается — ни другим статусом, ни причиной', () => {
    const path = makeFile(backlog('done'));
    const before = readFileSync(path, 'utf8');
    assert.equal(finishItem(path, 'test', 'some-item', 'failed', 'поздняя причина'), 'already-final');
    assert.equal(readFileSync(path, 'utf8'), before, 'файл обязан остаться байт в байт прежним');
  });

  it('многострочная причина сводится в одну строку и урезается', () => {
    const path = makeFile(backlog('in_progress'));
    finishItem(path, 'test', 'some-item', 'failed', `начало\n${'ы'.repeat(REASON_LIMIT * 2)}\nконец`);

    const reason = fieldOf(readFileSync(path, 'utf8'), 'reason') ?? '';
    assert.ok(!reason.includes('\n'));
    assert.ok(reason.length <= REASON_LIMIT, `причина длиной ${reason.length}`);
    assert.ok(reason.startsWith('начало'));
  });

  it('режим файла сохраняется', () => {
    const path = makeFile(backlog('in_progress'));
    chmodSync(path, 0o664);
    finishItem(path, 'test', 'some-item', 'done');
    assert.equal(statSync(path).mode & 0o777, 0o664);
  });

  describe('с владельцем', () => {
    const owned = (status: string, owner?: string): string =>
      owner === undefined ? backlog(status) : `${backlog(status)}claimed_by: ${owner}\n`;
    const as = (own: readonly string[], seen: string[] = []) => ({
      isOwn: (claimedBy: string) => own.includes(claimedBy),
      onForeign: (claimedBy: string, slug: string) => seen.push(`${slug}:${claimedBy}`),
    });

    it('свой пункт получает исход', () => {
      const path = makeFile(owned('in_progress', 'run:R1'));
      assert.equal(finishItem(path, 'test', 'some-item', 'done', undefined, as(['run:R1'])), 'set');
      assert.equal(fieldOf(readFileSync(path, 'utf8'), 'status'), 'done');
    });

    it('пункт предка по resume (по предикату) получает исход', () => {
      const path = makeFile(owned('in_progress', 'run:R0'));
      assert.equal(finishItem(path, 'test', 'some-item', 'done', undefined, as(['run:R0', 'run:R1'])), 'set');
    });

    it('пункт без claimed_by правится', () => {
      const path = makeFile(owned('in_progress'));
      assert.equal(finishItem(path, 'test', 'some-item', 'failed', 'п', as([])), 'set');
      assert.equal(fieldOf(readFileSync(path, 'utf8'), 'status'), 'failed');
    });

    it('чужой пункт остаётся нетронутым, владелец называется', () => {
      const path = makeFile(owned('in_progress', 'run:R2'));
      const before = readFileSync(path, 'utf8');
      const seen: string[] = [];
      assert.equal(finishItem(path, 'test', 'some-item', 'done', undefined, as(['run:R1'], seen)), 'foreign-owner');
      assert.equal(readFileSync(path, 'utf8'), before, 'файл обязан остаться байт в байт прежним');
      assert.deepEqual(seen, ['some-item:run:R2']);
    });

    it('already-final проверяется раньше владельца', () => {
      const path = makeFile(owned('done', 'run:R2'));
      assert.equal(finishItem(path, 'test', 'some-item', 'failed', 'п', as(['run:R1'])), 'already-final');
    });
  });

  it('отсутствующий пункт — отказ, называющий слаг и файл', () => {
    const path = makeFile(backlog('in_progress'));
    assert.throws(() => finishItem(path, 'test', 'нет-такого', 'done'), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /нет-такого/);
      assert.equal(error.file, path);
      return true;
    });
  });
});

describe('backlog file: сведение причины', () => {
  it('oneLine оставляет начало, tailLine — конец', () => {
    const long = `начало ${'ы'.repeat(REASON_LIMIT * 2)} конец`;
    assert.ok(oneLine(long).startsWith('начало'));
    assert.ok(tailLine(long, REASON_LIMIT).endsWith('конец'));
    assert.ok(tailLine(long, REASON_LIMIT).length <= REASON_LIMIT);
  });

  it('короткий текст проходит обе целиком, лишь сплющив пробелы', () => {
    assert.equal(oneLine(' две\nстроки '), 'две строки');
    assert.equal(tailLine(' две\nстроки ', REASON_LIMIT), 'две строки');
  });
});

describe('backlog file: readBacklogFile', () => {
  it('отсутствующий файл — отказ, называющий путь', () => {
    const path = join(tempDir('backlog-file-'), 'нет-такой-очереди.md');
    assert.throws(() => readBacklogFile(path), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.equal(error.file, path);
      return true;
    });
  });
});
