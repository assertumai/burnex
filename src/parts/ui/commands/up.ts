import { fileURLToPath } from 'node:url';
import { hasLegacyCabinet, legacyCabinetDiagnostic, migrateHomeRoot } from '../../../kernel/dirs.js';

import { enginePackageRoot } from '../../pipeline/document/packagePaths.js';
import { daemonEntryPath, readManifestQuietly } from '../../install/entry.js';
import { installManifestPath } from '../../install/manifest.js';
import { resolveConfig } from '../../pipeline/config/resolve.js';
import { ExitCode, type ExitCodeValue } from '../../../kernel/errors.js';
import {
  daemonPaths,
  describeDaemon,
  isAddressInUse,
  portBusyError,
  runningDaemon,
  startDetached,
  stopDaemon,
  writeRecord,
} from '../daemon/daemon.js';
import { installAgent, requireMacos, systemHost, type LaunchdHost } from '../daemon/launchd.js';
import { createUiServer } from '../daemon/server.js';
import { commandRow } from '../../../kernel/cli/commandRow.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';

/** Точка входа CLI: её же демон запускает сам себя в фоне с --foreground. */
function binPath(): string {
  return fileURLToPath(new URL('../../../bin.js', import.meta.url));
}

/**
 * `burnex up` — поднять витрину.
 *
 * По умолчанию отсоединяется: смысл наблюдательного пункта в том, что он
 * поднят всегда, а команда, занимающая терминал, этому противоречит — её
 * закрывают вместе с окном.
 */
export async function runUpCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  host: LaunchdHost = systemHost(),
  engineRoot: string = enginePackageRoot(),
): Promise<ExitCodeValue> {
  // Отказ вне macOS раньше чтения конфигурации: причина не зависит от неё.
  if (args.flags.install === true) requireMacos(host, '--install');

  // Перенос ~/.stepcast → ~/.burnex делают команды, трогающие домашний каталог
  // намеренно (`up`, `update`, install.sh), а не каждое чтение путей.
  const migrated = migrateHomeRoot(host.home);
  if (migrated !== undefined) write(`домашний каталог ${migrated.from} переименован в ${migrated.to}; на прежнем месте оставлена ссылка для установленного релиза`);

  const { config } = resolveConfig({ cwd });
  if (hasLegacyCabinet(cwd)) {
    const warning = legacyCabinetDiagnostic(cwd);
    write(`предупреждение: ${warning.message} (${warning.file}). ${warning.hint}`);
  }
  const paths = daemonPaths(host.home);
  // Один путь и для агента, и для отсоединённого демона: иначе `update` поднимал бы разные версии.
  const entry = daemonEntryPath({
    engineRoot,
    manifest: readManifestQuietly(installManifestPath(process.env, host.home)),
    fallback: binPath(),
  });
  const port = config.ui.port;

  if (args.flags.foreground === true) {
    let server;
    try {
      // Конфигурация нужна витрине для разбора пайплайнов: раскрытие
      // опирается на умолчания так же, как их применяет прогон. `projectRoot`
      // — каталог, в котором поднята витрина: проектный слой таблицы
      // маршрутов ищется от него (`ui-daemon`, «Демон знает корень проекта»).
      server = await createUiServer({ runsRoot: config.runs.root, port, config, projectRoot: cwd });
    } catch (error) {
      if (isAddressInUse(error)) throw portBusyError(port, error);
      throw error;
    }

    write(`витрина: http://127.0.0.1:${server.port}`);
    write(`наблюдение за ${config.runs.root}`);
    // Процесс держится сервером и живёт до сигнала прерывания.
    return ExitCode.ok;
  }

  if (args.flags.install === true) {
    // Агент займёт порт сам: отсоединённый демон, поднятый обычным `up`, ему мешал бы.
    stopDaemon(paths);
    const plist = installAgent(host, {
      execPath: process.execPath,
      binPath: entry,
      workingDirectory: cwd,
      logFile: paths.logFile,
      env: process.env,
    });
    write(`автозапуск установлен: ${plist}`);
    write(`витрина: http://127.0.0.1:${port}`);
    write('убрать автозапуск: burnex down --uninstall');
    return ExitCode.ok;
  }

  // Повторный запуск — не ошибка: человек хочет открыть дашборд, а не узнать,
  // что он уже открыт. Печатаются те же сведения, что дала бы команда о
  // состоянии демона, — поэтому отдельной такой команды и нет.
  const running = runningDaemon(paths);
  if (running !== undefined) {
    for (const line of describeDaemon(running)) write(line);
    return ExitCode.ok;
  }

  const pid = startDetached({ paths, argv: [entry, 'up', '--foreground'] });
  writeRecord(paths, { pid, port, started_at: new Date().toISOString(), cwd });

  write(`витрина: http://127.0.0.1:${port}`);
  write(`процесс: ${pid}`);
  write('остановить: burnex down');
  return ExitCode.ok;
}

export const row = commandRow({
  name: 'up',
  spec: {
    description: 'поднять витрину: наблюдение за всеми прогонами в браузере',
    flags: {
      foreground: {
        kind: 'boolean',
        description: 'держать сервер в текущем терминале, не отсоединяя его',
      },
      install: {
        kind: 'boolean',
        description: 'поставить демон на автозапуск через launchd (только macOS)',
      },
    },
  },
  run: (args, io, env) => runUpCommand(args, io.out, env.cwd),
});
