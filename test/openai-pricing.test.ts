import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyUsage, messagePrefix, sumUsage } from '../src/parts/pipeline/backend/types.js';
import { UsageSchema } from '../src/parts/pipeline/run/journal/schema.js';
import { estimateCostUsd, loadPriceCatalog, priceUsage } from '../src/parts/pipeline/run/budget/priceCatalog.js';

const catalog = loadPriceCatalog();
const sol = catalog.find('codex', 'gpt-6.1-sol')!;
const usage = { ...emptyUsage('codex', 'gpt-6.1-sol', 0), tokens_in: 100_000,
  tokens_out: 10_000, cache_read: 100_000, cache_write: 20_000 };

describe('OpenAI pricing', () => {
  it('prices current CLI models including separate cache write/read', () => {
    assert.equal(priceUsage(usage, catalog).cost_usd, 0.36);
    assert.equal(priceUsage(usage, catalog).cost_source, 'catalog');
    for (const name of ['gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-sol',
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      assert.ok(catalog.find('codex', name), name);
    }
  });
  it('keeps exactly 272K short; charges long output at 1.5x, not 2x', () => {
    assert.equal(estimateCostUsd(sol, { ...usage, pricing: { context_tokens: 272_000 } }), 0.36);
    assert.equal(estimateCostUsd(sol, { ...usage, pricing: { context_tokens: 272_001 } }), 0.67);
  });
  it('uses a conservative long estimate when only aggregate tokens are available', () => {
    const aggregate = { ...usage, cache_read: 300_000 };
    assert.equal(estimateCostUsd(sol, aggregate), 0.71);
    assert.equal(estimateCostUsd(sol, { ...aggregate, pricing: { context_tokens: 100_000 } }), 0.38);
  });
  it('applies fast/flex/batch and 12-hour cache writes', () => {
    assert.equal(estimateCostUsd(sol, { ...usage, pricing: { service_tier: 'fast' } }), 0.72);
    assert.equal(estimateCostUsd(sol, { ...usage, pricing: { service_tier: 'flex' } }), 0.18);
    assert.equal(estimateCostUsd(sol, { ...usage, pricing: { service_tier: 'batch' } }), 0.18);
    assert.equal(estimateCostUsd(sol, { ...usage, pricing: { cache_ttl: '12h' } }), 0.41);
    assert.equal(estimateCostUsd(sol, { ...usage, pricing: { service_tier: 'fast', context_tokens: 300_000 } }), 1.34);
  });
  it('does not silently substitute a tariff missing from the catalog', () => {
    const terra = { ...usage, model: 'gpt-6.1-terra', pricing: { service_tier: 'ultrafast' as const } };
    assert.equal(priceUsage(terra, catalog).cost_usd, undefined);
  });
  it('preserves backend-reported cost and unknown models', () => {
    assert.equal(priceUsage({ ...usage, reported_cost_usd: 0.012 }, catalog).cost_usd, 0.012);
    assert.equal(priceUsage({ ...usage, model: 'future-model' }, catalog).cost_usd, undefined);
  });
  it('does not label a Codex turn total as one request context', () => {
    const total = { ...usage, pricing: { input_scope: 'turn' as const } };
    assert.equal(messagePrefix(total), undefined);
    assert.equal(messagePrefix(usage), 220_000);
    const merged = sumUsage(emptyUsage('codex', usage.model, 0), total);
    assert.equal(merged.pricing?.input_scope, 'turn');
    assert.deepEqual(UsageSchema.parse(merged).pricing, { input_scope: 'turn' });
  });
  it('a real-sized Sol call no longer remains unpriced', () => {
    const call = { ...usage, tokens_in: 114_765, tokens_out: 49_667, cache_read: 8_646_144, cache_write: 0 };
    const priced = priceUsage(call, catalog);
    assert.equal(priced.cost_usd, 2.933294);
  });
});
