import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withOwnBlock } from '../src/parts/pipeline/domain/backlog/index.js';
import { parse } from '../src/parts/pipeline/domain/backlog/parse.js';

const PREAMBLE = '# Очередь\n\nВводный текст.\n\n';

function item(slug: string, extra = 'status: todo'): string {
  return `## ${slug}\n\n${extra}\ntitle: т\nwhy: з\ndone_when: к\n`;
}

function bed(...items: readonly string[]): string {
  return PREAMBLE + items.join('\n');
}

function statusOf(text: string, slug: string): string | undefined {
  return parse(text).find((entry) => entry.slug === slug)?.fields.get('status')?.value;
}

describe('withOwnBlock', () => {
  it('заменяет блок пункта, остальное берёт у вершины побайтово', () => {
    const tip = bed(item('one'), item('two'), item('three'));
    const live = bed(item('one', 'status: done'), item('two'), item('three'));

    const result = withOwnBlock(tip, live, 'one');

    assert.equal(result, bed(item('one', 'status: done'), item('two'), item('three')));
  });

  it('чужой in_progress и claimed_by живого файла не переносятся', () => {
    const tip = bed(item('mine'), item('theirs'));
    const live = bed(
      item('mine', 'status: done'),
      item('theirs', 'status: in_progress\nclaimed_by: run-b'),
    );

    const result = withOwnBlock(tip, live, 'mine');

    assert.equal(statusOf(result, 'mine'), 'done');
    assert.equal(statusOf(result, 'theirs'), 'todo');
    assert.ok(!result.includes('claimed_by'));
  });

  it('пункт, которого нет в вершине, дописывается в конец', () => {
    const tip = bed(item('one'));
    const live = bed(item('one'), item('fresh', 'status: done'));

    const result = withOwnBlock(tip, live, 'fresh');

    assert.deepEqual(
      parse(result).map((entry) => entry.slug),
      ['one', 'fresh'],
    );
    assert.equal(statusOf(result, 'fresh'), 'done');
    assert.ok(result.startsWith(tip.replace(/\n*$/u, '')));
  });

  it('заголовок пункта внутри огороженного блока кода преамбулы не считается границей', () => {
    const preamble = '# Очередь\n\n```\n## example\n\nstatus: todo\n```\n\n';
    const tip = `${preamble}${item('one')}`;
    const live = `${preamble}${item('one', 'status: done')}`;

    const result = withOwnBlock(tip, live, 'one');

    assert.equal(result, live);
  });

  it('блок последнего пункта в файле без завершающего перевода строки', () => {
    const tip = bed(item('one'), item('two')).replace(/\n$/u, '');
    const live = bed(item('one'), item('two', 'status: done')).replace(/\n$/u, '');

    const result = withOwnBlock(tip, live, 'two');

    assert.equal(result, live);
    assert.ok(!result.endsWith('\n'));
  });

  it('отсутствие пункта в живом файле — отказ с названием слага', () => {
    assert.throws(() => withOwnBlock(bed(item('one')), bed(item('one')), 'ghost'), /ghost/u);
  });
});
