import { ExitCode, type ExitCodeValue } from '../../../kernel/errors.js';
import { daemonPaths, stopDaemon } from '../daemon/daemon.js';
import { removeAgent, requireMacos, systemHost, unloadAgent, type LaunchdHost } from '../daemon/launchd.js';
import { commandRow } from '../../../kernel/cli/commandRow.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';

/**
 * `stepcast down` — остановить витрину.
 *
 * Отсутствие демона не ошибка: человек хотел, чтобы витрина не работала, и
 * она не работает. Отказ здесь заставлял бы писать проверку перед вызовом.
 *
 * Агент launchd выгружается первым: пока он загружен, `KeepAlive` поднимал бы
 * убитый демон заново. Демон агента pid-файла не пишет, поэтому «остановлена»
 * говорит и выгрузка.
 */
export function runDownCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  _cwd: string,
  host: LaunchdHost = systemHost(),
): ExitCodeValue {
  const uninstall = args.flags.uninstall === true;
  if (uninstall) requireMacos(host, '--uninstall');

  const unloaded = uninstall ? false : unloadAgent(host);
  const removed = uninstall ? removeAgent(host) : false;
  const outcome = stopDaemon(daemonPaths(host.home));

  write(outcome === 'stopped' || unloaded || removed ? 'витрина остановлена' : 'витрина не запущена');
  if (uninstall) write(removed ? 'автозапуск удалён' : 'автозапуск не установлен');
  return ExitCode.ok;
}

/**
 * Независима от конфигурации (design.md изменения `cli-commands-as-rows`,
 * Решение 4): останавливает демон витрины, не читая ни конфигурации, ни
 * реестра вкладов. Метка и путь plist постоянны, поэтому это не нарушается.
 */
export const row = commandRow(
  {
    name: 'down',
    spec: {
      description: 'остановить витрину',
      flags: {
        uninstall: {
          kind: 'boolean',
          description: 'заодно убрать автозапуск через launchd (только macOS)',
        },
      },
    },
    run: (args, io, env) => runDownCommand(args, io.out, env.cwd),
  },
  { independent: true },
);
