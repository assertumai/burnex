import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkScheduleEntry } from '../src/parts/pipeline/domain/trigger/entry.js';

/**
 * Проверка одной записи `triggers.schedule`: её тексты делят линт, `run
 * --scheduled` и экран «Schedule», поэтому они проверены здесь дословно.
 */
describe('checkScheduleEntry', () => {
  it('принимает запись с явным поясом', () => {
    const checked = checkScheduleEntry({ cron: '0 3 * * *', timezone: 'Europe/Berlin' }, 0);
    assert.equal(checked.ok, true);
    if (!checked.ok) return;
    assert.equal(checked.timezone, 'Europe/Berlin');
    assert.equal(checked.defaultTimezone, false);
    assert.ok(checked.mask.hour.has(3));
  });

  it('без пояса берёт пояс машины и помечает его умолчательным', () => {
    const checked = checkScheduleEntry({ cron: '*/5 * * * *' }, 2);
    assert.equal(checked.ok, true);
    if (!checked.ok) return;
    assert.equal(checked.defaultTimezone, true);
    assert.equal(checked.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('отказывает записи без cron', () => {
    for (const entry of [{}, { cron: '   ' }]) {
      assert.deepEqual(checkScheduleEntry(entry, 1), {
        ok: false,
        reason: 'Запись расписания 1 не содержит обязательного поля cron',
        at: 'cron',
      });
    }
  });

  it('отказывает неразборчивому cron, называя номер записи', () => {
    const checked = checkScheduleEntry({ cron: 'каждый час' }, 3);
    assert.equal(checked.ok, false);
    if (checked.ok) return;
    assert.match(checked.reason, /^Запись расписания 3: /);
    assert.equal(checked.at, 'cron');
  });

  it('отказывает неизвестному часовому поясу', () => {
    assert.deepEqual(checkScheduleEntry({ cron: '0 3 * * *', timezone: 'Mars/Olympus' }, 0), {
      ok: false,
      reason: 'Запись расписания 0: неизвестный часовой пояс Mars/Olympus',
      at: 'timezone',
    });
  });

  it('отказывает невыполнимому выражению', () => {
    assert.deepEqual(checkScheduleEntry({ cron: '0 0 30 2 *' }, 0), {
      ok: false,
      reason: 'Запись расписания 0: расписание невыполнимо — такой день в этом месяце не наступает',
      at: '',
    });
  });
});
