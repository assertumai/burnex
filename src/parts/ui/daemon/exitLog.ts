import { appendFileSync } from 'node:fs';

import type { DaemonPaths, DaemonRecord } from './daemon.js';

/**
 * Запись о том, почему демон завершился.
 *
 * Демон отвязан от терминала, и единственный свидетель его смерти — `ui.log`.
 * Без этих строк штатная остановка, падение на исключении и убийство снаружи
 * выглядят одинаково: лог просто обрывается. Каждая строка несёт время —
 * иначе по журналу нельзя сказать, когда это случилось.
 */

/** Сигналы, которыми демон останавливают извне. `SIGKILL` перехватить нельзя. */
const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

/** Та часть `process`, на которую опирается запись: тест подставляет свою. */
export interface ExitLogProcess {
  readonly pid: number;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeAllListeners(event: string): unknown;
  kill(pid: number, signal: string): unknown;
}

export interface ExitLogOptions {
  readonly write: (line: string) => void;
  readonly proc?: ExitLogProcess;
  readonly now?: () => Date;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

export function installExitLog(options: ExitLogOptions): void {
  const proc = options.proc ?? (process as unknown as ExitLogProcess);
  const now = options.now ?? (() => new Date());
  const note = (text: string): void => {
    try {
      options.write(`${now().toISOString()} ${text}`);
    } catch {
      // Лог недоступен (например, кончилось место): запись причины не должна
      // сама менять то, как процесс завершается.
    }
  };

  note(`демон запущен, процесс ${proc.pid}`);

  for (const signal of STOP_SIGNALS) {
    proc.on(signal, () => {
      note(`демон остановлен сигналом ${signal}`);
      // Сигнал посылается себе повторно уже без обработчика: процесс
      // завершается так же, как завершился бы без этой записи.
      proc.removeAllListeners(signal);
      proc.kill(proc.pid, signal);
    });
  }

  // Монитор не отменяет умолчательное поведение: стек напечатает и процесс
  // завершит сам Node, здесь добавляется только строка со временем.
  proc.on('uncaughtExceptionMonitor', ((error: unknown, origin: string) => {
    note(`демон упал (${origin}): ${describeError(error)}`);
  }) as (...args: never[]) => void);

  // Сюда попадает и тихий выход, когда процесс больше ничто не держит.
  proc.on('exit', ((code: number) => {
    note(`демон завершился с кодом ${code}`);
  }) as (...args: never[]) => void);
}

/**
 * Отметить в логе демона, что прежний процесс исчез, не убрав pid-файл.
 *
 * `burnex down` и `burnex update` запись стирают, поэтому осиротевший файл
 * значит, что демон завершён иначе. Если выше в логе нет строки о причине —
 * это `SIGKILL`, нехватка памяти или перезагрузка: то, чего сам процесс
 * записать не может.
 */
export function noteOrphanDaemon(paths: DaemonPaths, record: DaemonRecord, now: Date = new Date()): void {
  const started = record.started_at === '' ? '' : `, запущен ${record.started_at}`;
  const line =
    `${now.toISOString()} прежний демон (процесс ${record.pid}${started}) завершён не командой burnex down; ` +
    'если выше нет строки о причине — SIGKILL, нехватка памяти или перезагрузка';
  try {
    appendFileSync(paths.logFile, `${line}\n`, { mode: 0o600 });
  } catch {
    // Пометка справочная: её отсутствие не должно мешать поднять новый демон.
  }
}
