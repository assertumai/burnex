/**
 * Проверка одной записи `triggers.schedule`.
 *
 * Живёт отдельно от линта, чтобы линт, `burnex run --scheduled` и экран
 * «Schedule» называли причину отказа одними и теми же словами: второй
 * валидатор расходился бы с первым.
 */

import { isKnownTimeZone, isSatisfiable, parseCron, type CronMask } from './cron.js';

export interface ScheduleEntryInput {
  readonly cron?: string | undefined;
  readonly timezone?: string | undefined;
}

export type ScheduleEntryCheck =
  | {
      readonly ok: true;
      readonly mask: CronMask;
      readonly timezone: string;
      /** Пояс не объявлен в записи — взят пояс машины. */
      readonly defaultTimezone: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Путь внутри записи: `cron`, `timezone` или пусто для записи целиком. */
      readonly at: string;
    };

/**
 * Выполнимость проверяется по календарю (`isSatisfiable`), а не перебором от
 * «сейчас»: вердикт не должен зависеть от дня, в который его позвали.
 */
export function checkScheduleEntry(entry: ScheduleEntryInput, index: number): ScheduleEntryCheck {
  if (entry.cron === undefined || entry.cron.trim() === '') {
    return { ok: false, reason: `Запись расписания ${index} не содержит обязательного поля cron`, at: 'cron' };
  }

  const parsed = parseCron(entry.cron);
  if (!parsed.ok) {
    return { ok: false, reason: `Запись расписания ${index}: ${parsed.reason}`, at: 'cron' };
  }

  if (entry.timezone !== undefined && !isKnownTimeZone(entry.timezone)) {
    return {
      ok: false,
      reason: `Запись расписания ${index}: неизвестный часовой пояс ${entry.timezone}`,
      at: 'timezone',
    };
  }

  if (!isSatisfiable(parsed.mask)) {
    return {
      ok: false,
      reason: `Запись расписания ${index}: расписание невыполнимо — такой день в этом месяце не наступает`,
      at: '',
    };
  }

  return {
    ok: true,
    mask: parsed.mask,
    timezone: entry.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    defaultTimezone: entry.timezone === undefined,
  };
}
