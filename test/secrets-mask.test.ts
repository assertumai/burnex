import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createMasker, MASK, NO_MASK } from '../src/parts/pipeline/run/journal/mask.js';
import { RunJournal } from '../src/parts/pipeline/run/journal/writer.js';
import { runProcess } from '../src/parts/pipeline/run/exec/process.js';
import { makeJournalBed } from './helpers.js';
import { tempDir } from './tmp.js';

describe('маскировщик значений секретов', () => {
  it('заменяет все вхождения на ***', () => {
    const masker = createMasker(['секрет-один-1', 'секрет-два-22']);
    assert.equal(masker.mask('а секрет-один-1 и секрет-два-22, снова секрет-один-1'), `а ${MASK} и ${MASK}, снова ${MASK}`);
  });

  it('значение, содержащее другое, не оставляет хвоста: порядок — от длинного к короткому', () => {
    const masker = createMasker(['abcdefgh', 'abcdefgh-хвост']);
    assert.equal(masker.mask('x abcdefgh-хвост y'), `x ${MASK} y`);
  });

  it('пустое множество — проход без обработки', () => {
    assert.equal(createMasker([]).active, false);
    assert.equal(NO_MASK.mask('любой текст'), 'любой текст');
    const value = { a: ['б'] };
    assert.equal(NO_MASK.maskValue(value), value);
  });

  it('maskValue проходит строки вложенных структур и ключи', () => {
    const masker = createMasker(['секрет-12345']);
    assert.deepEqual(masker.maskValue({ 'ключ-секрет-12345': ['секрет-12345', 7, { x: 'a секрет-12345' }] }), {
      [`ключ-${MASK}`]: [MASK, 7, { x: `a ${MASK}` }],
    });
  });
});

describe('журнал: маскирование', () => {
  function journalWith(secrets: readonly string[]): RunJournal {
    const bed = makeJournalBed();
    return RunJournal.create({ runsRoot: bed.runsRoot, projectRoot: bed.projectRoot, secrets });
  }

  it('prompt.txt и прочие текстовые файлы шага пишутся замаскированными', () => {
    const journal = journalWith(['секрет-12345']);
    const dir = journal.prepareJob('build');
    const path = journal.writeStepFile(dir, 'prompt.txt', 'вот секрет-12345 в промпте');
    assert.equal(readFileSync(path, 'utf8'), `вот ${MASK} в промпте`);
  });

  it('данные шага (input.json, output.json, diff.patch) не маскируются', () => {
    const journal = journalWith(['секрет-12345']);
    const dir = journal.prepareJob('build');
    for (const name of ['input.json', 'output.json', 'diff.patch']) {
      assert.equal(readFileSync(journal.writeStepFile(dir, name, 'секрет-12345'), 'utf8'), 'секрет-12345');
    }
  });

  it('журнал без секретов пишет как есть', () => {
    const journal = journalWith([]);
    const dir = journal.prepareJob('build');
    assert.equal(readFileSync(journal.writeStepFile(dir, 'prompt.txt', 'секрет-12345'), 'utf8'), 'секрет-12345');
  });
});

describe('runProcess: маскирование потока', () => {
  const SECRET = 'длинное-значение-секрета';

  async function runWith(script: string, secrets: readonly string[]) {
    const dir = tempDir('mask-process-');
    const chunks: string[] = [];
    const result = await runProcess({
      command: [process.execPath, '-e', script],
      cwd: dir,
      env: {},
      timeoutMs: 10_000,
      stdoutPath: join(dir, 'stdout.log'),
      onStdout: (chunk) => chunks.push(chunk),
      masker: createMasker(secrets),
    });
    return { result, log: readFileSync(join(dir, 'stdout.log'), 'utf8'), chunks: chunks.join('') };
  }

  it('onStdout и накопленный текст видят то же, что файл', async () => {
    const { result, log, chunks } = await runWith(`console.log('до ${SECRET} после')`, [SECRET]);
    assert.equal(log, `до ${MASK} после\n`);
    assert.equal(chunks, log);
    assert.equal(result.stdout, log);
  });

  it('значение, разорванное паузой между двумя записями, не доходит ни целиком, ни частями', async () => {
    const half = Math.floor(SECRET.length / 2);
    const script = `process.stdout.write(${JSON.stringify(SECRET.slice(0, half))});
setTimeout(() => process.stdout.write(${JSON.stringify(`${SECRET.slice(half)}\n`)}), 300);`;
    const { log, chunks } = await runWith(script, [SECRET]);
    assert.equal(log, `${MASK}\n`);
    assert.equal(chunks, log);
  });

  it('очень длинная строка без перевода не копится бесконечно, а значение на границе сброса не рвётся', async () => {
    const filler = 'x'.repeat(70_000);
    const { log } = await runWith(`process.stdout.write(${JSON.stringify(`${filler}${SECRET}${filler}`)})`, [SECRET]);
    assert.equal(log, `${filler}${MASK}${filler}`);
  });

  it('значение, кончающееся ровно на конце переполненного хвоста, маскируется до сброса', async () => {
    const filler = 'x'.repeat(70_000);
    // Пауза гарантирует, что к моменту сброса хвост кончается именно значением:
    // точка среза приходится внутрь него, а продолжение ещё не пришло.
    const script = `process.stdout.write(${JSON.stringify(`${filler}${SECRET}`)});
setTimeout(() => process.stdout.write('хвост\\n'), 300);`;
    const { log, chunks } = await runWith(script, [SECRET]);
    assert.equal(log, `${filler}${MASK}хвост\n`);
    assert.equal(chunks, log);
  });

  it('граница куска посреди многобайтового символа значения не ломает маскирование', async () => {
    // Первый байт «д» уходит отдельно: раздельное декодирование дало бы U+FFFD.
    const bytes = JSON.stringify([...Buffer.from(`${SECRET}\n`)]);
    const script = `const b = Buffer.from(${bytes});
process.stdout.write(b.subarray(0, 1));
setTimeout(() => process.stdout.write(b.subarray(1)), 300);`;
    const { log, chunks } = await runWith(script, [SECRET]);
    assert.equal(log, `${MASK}\n`);
    assert.equal(chunks, log);
  });

  it('без маскировщика поток идёт как есть', async () => {
    const { log } = await runWith(`console.log('${SECRET}')`, []);
    assert.equal(log, `${SECRET}\n`);
  });
});
