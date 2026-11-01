import { existsSync, readFileSync } from 'node:fs';

import { agentState } from '../../daemon/launchd.js';
import { readBody, sendJson } from '../../daemon/http.js';
import type { MaintenanceKind } from '../../runLaunch.js';
import { buildSystem, describeInstall, readUpdate } from '../../system.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Экран «System» (`ui-system-health`): здоровье установки. Чтение — свёртка
 * без сети и без новых проб; действия («Обновить», автозапуск) демон сам не
 * исполняет, а порождает отсоединённой командой CLI: оба перезапускают самого
 * демона, и обработчик запроса не пережил бы собственного `kickstart -k`.
 */

/** Последних строк журнала действия, которые отдаёт `GET /api/system/log`. */
const LOG_TAIL_LINES = 200;

const handleSystem: ApiHandler = async (_req, res, env) => {
  try {
    sendJson(res, 200, await buildSystem(env, env.systemHost));
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
};

const handleUpdateCheck: ApiHandler = async (req, res, env) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    sendJson(res, 200, await readUpdate(env.updateHold, env.systemHost, { refresh: url.searchParams.get('refresh') === '1' }));
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
};

const handleUpdate: ApiHandler = (_req, res, env) => {
  const busy = env.launchMaintenance.busy();
  if (busy !== undefined) {
    sendJson(res, 409, { error: `Another maintenance action is still running: ${busy}` });
    return;
  }
  // Без способа установки `stepcast update` откажет сам, но в журнале, которого экран не ждёт.
  const { error } = describeInstall(env.systemHost);
  if (error !== undefined) {
    sendJson(res, 409, { error });
    return;
  }

  env.launchMaintenance.launch({
    kind: 'update',
    command: process.execPath,
    args: [env.self.entry, 'update'],
    cwd: env.self.projectRoot ?? process.cwd(),
  });
  sendJson(res, 202, { log: env.launchMaintenance.logPath('update') });
};

const handleAutostart: ApiHandler = async (req, res, env) => {
  let enabled: unknown;
  try {
    enabled = (JSON.parse(await readBody(req)) as { enabled?: unknown }).enabled;
  } catch {
    enabled = undefined;
  }
  if (typeof enabled !== 'boolean') {
    sendJson(res, 400, { error: 'Body must be {"enabled": true|false}' });
    return;
  }

  const state = agentState(env.systemHost.launchd);
  if (!state.supported) {
    sendJson(res, 409, { error: state.reason });
    return;
  }
  const busy = env.launchMaintenance.busy();
  if (busy !== undefined) {
    sendJson(res, 409, { error: `Another maintenance action is still running: ${busy}` });
    return;
  }

  const { entry } = env.self;
  env.launchMaintenance.launch({
    kind: 'autostart',
    cwd: env.self.projectRoot ?? process.cwd(),
    ...(enabled
      ? { command: process.execPath, args: [entry, 'up', '--install'] }
      : {
          // Выгрузка агента гасит демон, поэтому `up` идёт следом в том же процессе:
          // иначе витрина после выключения автозапуска не вернулась бы вовсе.
          command: 'sh',
          args: ['-c', '"$0" "$1" down --uninstall && "$0" "$1" up', process.execPath, entry],
        }),
  });
  sendJson(res, 202, { log: env.launchMaintenance.logPath('autostart') });
};

const handleLog: ApiHandler = (req, res, env) => {
  const kind = new URL(req.url ?? '/', 'http://localhost').searchParams.get('kind');
  if (kind !== 'update' && kind !== 'autostart') {
    sendJson(res, 400, { error: 'kind must be "update" or "autostart"' });
    return;
  }

  const path = env.launchMaintenance.logPath(kind satisfies MaintenanceKind);
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  // Хвост файла, оканчивающегося переводом строки, не несёт пустой последней строки.
  if (lines.at(-1) === '') lines.pop();
  // `run` — исход процесса, порождённого этим демоном: по нему экран узнаёт, что действие
  // кончилось без перезапуска, а не ждёт нового pid до таймаута.
  const run = env.launchMaintenance.last(kind);
  sendJson(res, 200, { kind, path, lines: lines.slice(-LOG_TAIL_LINES), ...(run === undefined ? {} : { run }) });
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/system', handleSystem);
  ctx.api.register('GET', '/api/system/update', handleUpdateCheck);
  ctx.api.register('POST', '/api/system/update', handleUpdate);
  ctx.api.register('POST', '/api/system/autostart', handleAutostart);
  ctx.api.register('GET', '/api/system/log', handleLog);
});
