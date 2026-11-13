import { join } from 'node:path';

/**
 * Раскладка журнала шага `review`, какой её читает витрина (`review-defend`,
 * design.md, решение 7). Витрина знает её сама, а не берёт у исполнителя
 * шага: ей нужно открывать и журналы прежних режимов, которых движок больше
 * не пишет.
 */

/** Журнал защиты в каталоге шага — режим `defend`. */
export const DEFENSE_FILE = 'defense.ndjson';

/** Журнал прежнего режима `discussion`: витрина узнаёт его, но не разбирает. */
export const DISCUSSION_FILE = 'discussion.ndjson';

/**
 * Участник-защитник: его ходы лежат в `participants/defender/rounds/<r>/`,
 * а в журналах прежнего формата — по веткам ревьюеров.
 */
export const DEFENDER_ID = 'defender';

/** Каталог участника внутри каталога шага. */
export function participantDir(stepDir: string, participant: string): string {
  return join(stepDir, 'participants', participant);
}

/** Каталог хода ревьюера или защитника в раунде `round` ≥ 1. */
export function replyDir(stepDir: string, participant: string, round: number): string {
  return join(participantDir(stepDir, participant), 'rounds', String(round));
}

/**
 * Каталог хода участника в ветке `thread`, раунд `round` ≥ 1, — журнал
 * прежнего формата: ветки были только у защитника,
 * `participants/defender/<ревьюер>/rounds/<r>/`.
 */
export function threadTurnDir(stepDir: string, participant: string, thread: string, round: number): string {
  return join(participantDir(stepDir, participant), thread, 'rounds', String(round));
}
