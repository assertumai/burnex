import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  PriceCatalogError,
  backendsKnowingModel,
  estimateCostUsd,
  isUnpricedCall,
  loadPriceCatalog,
  priceCatalogPath,
  priceUsage,
  type PriceEntry,
} from '../src/parts/pipeline/run/budget/priceCatalog.js';
import { emptyUsage } from '../src/parts/pipeline/backend/types.js';
import { tempDir } from './tmp.js';

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backend: 'codex',
    model: 'm1',
    aliases: [],
    input: 10,
    output: 20,
    cache_read: 1,
    cache_write: 5,
    ...overrides,
  };
}

function writeCatalog(models: readonly unknown[]): string {
  const path = join(tempDir('prices-'), 'model-prices.json');
  writeFileSync(
    path,
    JSON.stringify({
      format: 1,
      as_of: '2026-01-02',
      currency: 'USD',
      unit: 'per_million_tokens',
      sources: ['https://example.test/prices'],
      models,
    }),
  );
  return path;
}

describe('price-catalog: поставляемый каталог', () => {
  it('проходит проверку и называет дату прейскуранта', () => {
    const catalog = loadPriceCatalog();
    assert.match(catalog.asOf, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(priceCatalogPath().endsWith(join('src', 'builtin', 'prices', 'model-prices.json')));
  });

  it('содержит модели обоих бэкендов', () => {
    const catalog = loadPriceCatalog();
    assert.ok(catalog.find('claude', 'claude-sonnet-4-5') !== undefined);
    assert.ok(catalog.find('codex', 'gpt-5-codex') !== undefined);
  });
});

describe('price-catalog: загрузчик отказывает названной ошибкой', () => {
  it('на пропущенной цене называет файл и запись', () => {
    const { cache_write: _omitted, ...incomplete } = entry({ model: 'broken' });
    const path = writeCatalog([entry(), incomplete]);
    assert.throws(
      () => loadPriceCatalog(path),
      (error: unknown) =>
        error instanceof PriceCatalogError &&
        error.message.includes(path) &&
        error.message.includes('запись 2 (broken)') &&
        error.message.includes('cache_write'),
    );
  });

  it('на отрицательной цене', () => {
    const path = writeCatalog([entry({ output: -1 })]);
    assert.throws(
      () => loadPriceCatalog(path),
      (error: unknown) =>
        error instanceof PriceCatalogError && error.message.includes(path) && error.message.includes('output'),
    );
  });

  it('на повторе имени или псевдонима в пределах бэкенда', () => {
    const path = writeCatalog([entry({ aliases: ['fast'] }), entry({ model: 'm2', aliases: ['fast'] })]);
    assert.throws(
      () => loadPriceCatalog(path),
      (error: unknown) =>
        error instanceof PriceCatalogError && error.message.includes('«fast»') && error.message.includes('codex'),
    );
  });

  it('на нечитаемом файле называет путь', () => {
    const path = join(tempDir('prices-'), 'нет.json');
    assert.throws(() => loadPriceCatalog(path), (error: unknown) => error instanceof PriceCatalogError && error.message.includes(path));
  });
});

describe('price-catalog: поиск цены', () => {
  it('находит по точному имени и по псевдониму', () => {
    const catalog = loadPriceCatalog(writeCatalog([entry({ aliases: ['fast'] })]));
    assert.equal(catalog.find('codex', 'm1')?.input, 10);
    assert.equal(catalog.find('codex', 'fast')?.input, 10);
  });

  it('не находит псевдоним чужого бэкенда и не нормализует регистр', () => {
    const catalog = loadPriceCatalog(writeCatalog([entry({ aliases: ['fast'] })]));
    assert.equal(catalog.find('claude', 'fast'), undefined);
    assert.equal(catalog.find('claude', 'm1'), undefined);
    assert.equal(catalog.find('codex', 'M1'), undefined);
  });

  it('одно имя у двух бэкендов не конфликтует', () => {
    const catalog = loadPriceCatalog(
      writeCatalog([entry({ backend: 'claude', input: 3 }), entry({ backend: 'codex', input: 7 })]),
    );
    assert.equal(catalog.find('claude', 'm1')?.input, 3);
    assert.equal(catalog.find('codex', 'm1')?.input, 7);
  });
});

describe('price-catalog: оценка', () => {
  const price = entry() as unknown as PriceEntry;

  it('считает сумму по четырём измерениям', () => {
    const usd = estimateCostUsd(price, {
      tokens_in: 100_000,
      tokens_out: 50_000,
      cache_read: 1_000_000,
      cache_write: 200_000,
    });
    // 1.0 + 1.0 + 1.0 + 1.0
    assert.equal(usd, 4);
  });

  it('округляет вверх до микродоллара один раз', () => {
    // 1 токен × 10 = 10 мкд, плюс 1 токен × 0.1 = 0.1 мкд → 11 мкд, не 10.
    const cheap = { ...price, input: 10, output: 0.1 } as PriceEntry;
    assert.equal(estimateCostUsd(cheap, { tokens_in: 1, tokens_out: 1, cache_read: null, cache_write: null }), 11 / 1e6);
  });

  it('не прибавляет микродоллар к точной сумме из-за шума плавающей точки', () => {
    const odd = { ...price, input: 0.1, output: 0 } as PriceEntry;
    assert.equal(estimateCostUsd(odd, { tokens_in: 3_000_000, tokens_out: 0, cache_read: null, cache_write: null }), 0.3);
  });

  it('несообщённое измерение не входит в оценку', () => {
    const usd = estimateCostUsd(price, { tokens_in: 100_000, tokens_out: 50_000, cache_read: null, cache_write: null });
    assert.equal(usd, 2);
  });
});

describe('price-catalog: действующая цена вызова', () => {
  const catalog = loadPriceCatalog(writeCatalog([entry()]));
  const base = { ...emptyUsage('codex', 'm1', 5), tokens_in: 100_000, tokens_out: 50_000 };

  it('сообщённая цена главнее каталога', () => {
    const priced = priceUsage({ ...base, reported_cost_usd: 0.01 }, catalog);
    assert.equal(priced.cost_usd, 0.01);
    assert.equal(priced.cost_source, 'reported');
    assert.equal(priced.reported_cost_usd, 0.01);
  });

  it('без сообщённой цены оценивает по каталогу и не трогает сырое поле', () => {
    const priced = priceUsage(base, catalog);
    assert.equal(priced.cost_usd, 2);
    assert.equal(priced.cost_source, 'catalog');
    assert.equal(priced.reported_cost_usd, undefined);
  });

  it('модель вне каталога, необъявленная модель и несообщённые токены остаются без цены', () => {
    assert.equal(priceUsage({ ...base, model: 'other' }, catalog).cost_usd, undefined);
    const { model: _model, ...undeclared } = base;
    assert.equal(priceUsage(undeclared, catalog).cost_usd, undefined);
    assert.equal(priceUsage({ ...base, tokens_out: null }, catalog).cost_usd, undefined);
    assert.equal(priceUsage(base, undefined).cost_usd, undefined);
  });

  it('бэкенд из чужой записи не получает цену', () => {
    assert.equal(priceUsage({ ...base, backend: 'claude' }, catalog).cost_usd, undefined);
  });
});

describe('price-catalog: бэкенды, знающие модель', () => {
  it('поставляемый каталог называет бэкенд по точному имени', () => {
    assert.deepEqual([...backendsKnowingModel('claude-opus-4-6')], ['claude']);
    assert.deepEqual([...backendsKnowingModel('gpt-5-codex')], ['codex']);
  });

  it('неизвестное имя даёт пустой набор', () => {
    assert.equal(backendsKnowingModel('no-such-model').size, 0);
  });

  it('находит модель и по псевдониму, и в нескольких бэкендах', () => {
    const path = writeCatalog([
      entry({ backend: 'claude', model: 'big', aliases: ['b'] }),
      entry({ backend: 'codex', model: 'b', aliases: [] }),
    ]);
    assert.deepEqual([...backendsKnowingModel('big', path)], ['claude']);
    assert.deepEqual([...backendsKnowingModel('b', path)].sort(), ['claude', 'codex']);
  });
});

describe('price-catalog: isUnpricedCall', () => {
  const catalog = loadPriceCatalog(writeCatalog([entry({ backend: 'codex', model: 'm1', aliases: ['mini'] })]));
  const adapter = (name: string, reportsCost: boolean): Parameters<typeof isUnpricedCall>[0] => ({
    name,
    capabilities: { reportsCost } as Parameters<typeof isUnpricedCall>[0]['capabilities'],
  });

  it('бэкенд, сообщающий цену, неучтённым не бывает — даже без модели', () => {
    assert.equal(isUnpricedCall(adapter('claude', true), undefined, catalog), false);
  });

  it('модель в каталоге по имени и псевдониму — цена есть', () => {
    assert.equal(isUnpricedCall(adapter('codex', false), 'm1', catalog), false);
    assert.equal(isUnpricedCall(adapter('codex', false), 'mini', catalog), false);
  });

  it('модель не названа — без цены', () => {
    assert.equal(isUnpricedCall(adapter('codex', false), undefined, catalog), true);
  });

  it('модели нет в каталоге этого бэкенда или самого каталога нет — без цены', () => {
    assert.equal(isUnpricedCall(adapter('codex', false), 'unknown', catalog), true);
    assert.equal(isUnpricedCall(adapter('other', false), 'm1', catalog), true);
    assert.equal(isUnpricedCall(adapter('codex', false), 'm1', undefined), true);
  });
});
