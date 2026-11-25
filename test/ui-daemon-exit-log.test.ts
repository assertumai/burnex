import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { daemonPaths } from '../src/parts/ui/daemon/daemon.js';
import { installExitLog, noteOrphanDaemon, type ExitLogProcess } from '../src/parts/ui/daemon/exitLog.js';
import { tempDir } from './tmp.js';

const NOW = new Date('2026-11-25T19:00:00.000Z');
const STAMP = '2026-11-25T19:00:00.000Z';

/** Подставной процесс: настоящему нельзя ни вешать обработчики, ни слать сигналы. */
class FakeProcess extends EventEmitter {
  readonly pid = 4242;
  readonly killed: string[] = [];

  kill(pid: number, signal: string): void {
    assert.equal(pid, this.pid);
    this.killed.push(signal);
  }
}

function bed(): { proc: FakeProcess; lines: string[] } {
  const proc = new FakeProcess();
  const lines: string[] = [];
  installExitLog({ write: (line) => lines.push(line), proc: proc as unknown as ExitLogProcess, now: () => NOW });
  return { proc, lines };
}

describe('ui-daemon: запись причины завершения', () => {
  it('отмечает запуск со временем и номером процесса', () => {
    const { lines } = bed();
    assert.deepEqual(lines, [`${STAMP} демон запущен, процесс 4242`]);
  });

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    it(`записывает ${signal} и завершается им же`, () => {
      const { proc, lines } = bed();
      proc.emit(signal);

      assert.equal(lines.at(-1), `${STAMP} демон остановлен сигналом ${signal}`);
      assert.deepEqual(proc.killed, [signal], 'сигнал должен дойти до процесса повторно');
      assert.equal(proc.listenerCount(signal), 0, 'иначе повторный сигнал снова попал бы в обработчик');
    });
  }

  it('записывает необработанную ошибку со стеком и её происхождением', () => {
    const { proc, lines } = bed();
    proc.emit('uncaughtExceptionMonitor', new Error('диск полон'), 'unhandledRejection');

    assert.match(lines.at(-1) ?? '', new RegExp(`^${STAMP} демон упал \\(unhandledRejection\\): Error: диск полон\\n\\s+at `));
  });

  it('записывает код выхода, в том числе тихого', () => {
    const { proc, lines } = bed();
    proc.emit('exit', 0);

    assert.equal(lines.at(-1), `${STAMP} демон завершился с кодом 0`);
  });

  it('недоступный лог не мешает завершению по сигналу', () => {
    const proc = new FakeProcess();
    installExitLog({
      write: () => {
        throw new Error('ENOSPC');
      },
      proc: proc as unknown as ExitLogProcess,
    });

    proc.emit('SIGTERM');
    assert.deepEqual(proc.killed, ['SIGTERM']);
  });

  it('помечает в логе прежний демон, оставивший pid-файл', () => {
    const home = tempDir('daemon-exit-');
    mkdirSync(join(home, '.burnex'), { recursive: true });
    const paths = daemonPaths(home);

    noteOrphanDaemon(paths, { pid: 38843, port: 7717, started_at: '2026-11-25T00:04:10.053Z' }, NOW);

    assert.equal(
      readFileSync(paths.logFile, 'utf8'),
      `${STAMP} прежний демон (процесс 38843, запущен 2026-11-25T00:04:10.053Z) завершён не командой burnex down; ` +
        'если выше нет строки о причине — SIGKILL, нехватка памяти или перезагрузка\n',
    );
  });
});
