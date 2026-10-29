import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { Cost } from '../src/components/Cost';

/**
 * Метка источника цены в витрине (`model-price-catalog`): оценка по каталогу
 * и смесь с ней несут `≈` и подсказку с источником и датой прейскуранта;
 * сообщённая цена и цена прогона прежней формы — без метки.
 */
describe('Cost: метка источника цены', () => {
  it('оценка по каталогу: ≈ и подсказка с датой', () => {
    const html = renderToStaticMarkup(<Cost usd={1.5} source="catalog" asOf="2026-10-01" />);
    assert.match(html, />≈\$1\.50</);
    assert.match(html, /title="оценка по каталогу цен от 2026-10-01"/);
  });

  it('смешанная цена: ≈ и подсказка про смесь', () => {
    const html = renderToStaticMarkup(<Cost usd={0.25} source="mixed" asOf="2026-10-01" />);
    assert.match(html, />≈\$0\.2500</);
    assert.match(html, /title="смешанная: сообщённая цена и оценка по каталогу от 2026-10-01"/);
  });

  it('сообщённая цена и прежняя форма: без метки и подсказки', () => {
    for (const source of ['reported', undefined] as const) {
      const html = renderToStaticMarkup(<Cost usd={1.5} source={source} asOf="2026-10-01" />);
      assert.match(html, />\$1\.50</);
      assert.equal(html.includes('≈'), false);
      assert.equal(html.includes('title='), false);
    }
  });

  it('неизвестная цена — прочерк без метки', () => {
    const html = renderToStaticMarkup(<Cost usd={null} source="catalog" asOf="2026-10-01" />);
    assert.match(html, />—</);
    assert.equal(html.includes('≈'), false);
    assert.equal(html.includes('title='), false);
  });
});
