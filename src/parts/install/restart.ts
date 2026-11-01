import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { ExitCode, StepcastError } from '../../kernel/errors.js';
import {
  daemonPaths,
  isAlive,
  runningDaemon,
  stopDaemon,
  type DaemonRecord,
} from '../ui/daemon/daemon.js';
import { STABLE_ENTRY, agentPlistPath, agentTarget, systemHost, type LaunchdHost } from '../ui/daemon/launchd.js';

/**
 * Перезапуск демона витрины после успешного обновления.
 *
 * Всё, что касается системы, внедряется (как `launchctl` в `launchd.ts`):
 * тест не должен ни трогать настоящий launchd, ни порождать процессы.
 */
export interface RestartHost extends LaunchdHost {
  /** Живой отсоединённый демон из `ui.pid`. */
  readonly runningDaemon: () => DaemonRecord | undefined;
  /** Остановить его и дождаться выхода: порт нужен новому демону сразу. */
  readonly stopDaemon: () => Promise<void>;
  /** `stepcast up` по пути входа в каталоге `cwd`; `false` — не поднялся. */
  readonly spawnUp: (entry: string, cwd: string) => boolean;
  /** Текст plist агента, если он есть. */
  readonly readAgentPlist: () => string | undefined;
}

export interface RestartOptions {
  /** Путь входа новой версии: им поднимается отсоединённый демон. */
  readonly newEntry: string;
  /**
   * Установка managed: агенту launchd положено смотреть в `current`. У checkout и
   * npm пути через `current` нет, и подсказка про `up --install` там ложна.
   */
  readonly stableEntry: boolean;
  readonly noRestart: boolean;
  /** Обновление прошло успешно; иначе демон не трогается вовсе. */
  readonly updateOk: boolean;
}

export type RestartOutcome = 'skipped' | 'kickstarted' | 'restarted' | 'manual' | 'none';

export async function restartDaemon(
  host: RestartHost,
  options: RestartOptions,
  write: (line: string) => void,
): Promise<RestartOutcome> {
  if (!options.updateOk || options.noRestart) return 'skipped';

  const target = agentTarget(host);
  if (host.platform === 'darwin' && host.launchctl(['print', target]).status === 0) {
    const result = host.launchctl(['kickstart', '-k', target]);
    if (result.status !== 0) {
      throw new StepcastError('Обновление прошло, но launchctl не перезапустил агент витрины', {
        exitCode: ExitCode.jobFailed,
        hint: result.stderr.trim() === '' ? `код возврата ${result.status}` : result.stderr.trim(),
      });
    }
    write('демон витрины перезапущен через launchd');
    if (options.stableEntry && host.readAgentPlist()?.includes(STABLE_ENTRY) !== true) {
      write('агент смотрит в конкретный релиз, а не в current: stepcast up --install закрепит путь');
    }
    return 'kickstarted';
  }

  const daemon = host.runningDaemon();
  if (daemon === undefined) return 'none';

  if (daemon.cwd === undefined) {
    // Поднят прежней версией: каталога проекта в записи нет, а остановленный демон некуда вернуть.
    write('демон витрины поднят прежней версией и работает на старом коде');
    write('перезапустите витрину: stepcast down && stepcast up в каталоге проекта');
    return 'manual';
  }

  await host.stopDaemon();
  if (!host.spawnUp(options.newEntry, daemon.cwd)) {
    throw new StepcastError('Обновление прошло, но витрина не поднялась заново', {
      exitCode: ExitCode.jobFailed,
      hint: `Поднимите её сами: stepcast up в ${daemon.cwd}`,
    });
  }
  write(`демон витрины перезапущен в ${daemon.cwd}`);
  return 'restarted';
}

const EXIT_POLL_MS = 100;
const EXIT_WAIT_MS = 5000;

/** Настоящий хозяин: launchd, `ui.pid` и порождение `stepcast up`. */
export function systemRestartHost(): RestartHost {
  const base = systemHost();
  const paths = daemonPaths(base.home);
  return {
    ...base,
    runningDaemon: () => runningDaemon(paths),
    stopDaemon: async () => {
      const pid = runningDaemon(paths)?.pid;
      stopDaemon(paths);
      if (pid === undefined) return;
      const deadline = Date.now() + EXIT_WAIT_MS;
      while (isAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
      }
    },
    spawnUp: (entry, cwd) => spawnSync(process.execPath, [entry, 'up'], { cwd, stdio: 'inherit' }).status === 0,
    readAgentPlist: () => {
      const plist = agentPlistPath(base.home);
      return existsSync(plist) ? readFileSync(plist, 'utf8') : undefined;
    },
  };
}
