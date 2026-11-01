import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildRouteTable } from '../../src/parts/ui/routesFile.ts';
import { NAV_GROUP_ORDER } from '../src/plugins/shell.tsx';
import { tempDir } from '../../test/tmp.ts';

/** Экраны группы встроенной таблицы по `nav.order`, как их раскладывает меню каркаса. */
function screensOf(group: string): string[] {
  const { entries } = buildRouteTable({ home: tempDir('nav-groups-home-') });
  return entries
    .filter((entry) => entry.definition.nav?.group === group)
    .sort((a, b) => (a.definition.nav?.order ?? 0) - (b.definition.nav?.order ?? 0))
    .map((entry) => entry.id);
}

describe('ui-dashboard: группы бокового меню поставки', () => {
  it('заголовки групп идут в порядке work, extend, config, system', () => {
    assert.deepEqual(NAV_GROUP_ORDER, ['work', 'extend', 'config', 'system']);
  });

  it('в config пять экранов настройки, в system остались Usage и Cleanup', () => {
    assert.deepEqual(screensOf('config'), [
      'screen-packages',
      'screen-agents',
      'screen-secrets',
      'screen-schedule',
      'screen-system',
    ]);
    assert.deepEqual(screensOf('system'), ['screen-usage', 'screen-cleanup']);
  });
});
