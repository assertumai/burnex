import { sendJson } from '../daemon/http.js';
import { screenRow, type ApiHandler } from '../screens/registry.js';

/**
 * Строка состава без экрана: `GET /api/packages` (`packages-directory-layer`,
 * design.md, Решение 8). Отдаёт ту же сводку, что и `stepcast package list
 * --json`: имя, слой, версия, каталог, приносимые виды ресурсов и статус
 * (действует, сломан с причиной, затенён). Только чтение — витрина в каталог
 * пакета не пишет.
 */

const handleGet: ApiHandler = (_req, res, env) => {
  sendJson(res, 200, { packages: env.watcher.currentPackages() });
};

export const row = screenRow('ui-packages', ['api'], (ctx) => {
  ctx.api.register('GET', '/api/packages', handleGet);
});
