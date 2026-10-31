import { isStepcastError } from '../../../../kernel/errors.js';
import { readBody, sendJson } from '../../daemon/http.js';
import { readModels } from '../../models.js';
import { readSettings, writeSettings } from '../../settings.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Строка экрана агентов владеет всеми маршрутами настроек агентов
 * (`ui-agents-settings-merge`, design.md Решение 3): `GET`/`PUT /api/settings`
 * — чтение и запись глобального файла (`../../settings.js`), `/api/models` —
 * перечисление моделей агентов. Прежняя строка `screen-settings` упразднена
 * вместе с экраном; маршрут принадлежит одной строке (`ui-screens`), и
 * отключение этой строки патчем снимает и правку настроек — экран «Pipelines»
 * без ответа `/api/settings` остаётся читающим, как и при любом отказе запроса.
 */
const handleRead: ApiHandler = async (_req, res, env) => {
  try {
    sendJson(res, 200, await readSettings(env.home, env.kernelCache));
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
};

const handleWrite: ApiHandler = async (req, res, env) => {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Request body is too large' });
    return;
  }

  let patch: unknown;
  try {
    patch = JSON.parse(body === '' ? '{}' : body) as unknown;
  } catch {
    sendJson(res, 400, { error: 'Request body is not valid JSON' });
    return;
  }

  try {
    sendJson(res, 200, await writeSettings(patch, env.home, env.kernelCache));
  } catch (error) {
    const message = isStepcastError(error) ? error.message : (error as Error).message;
    sendJson(res, isStepcastError(error) ? 400 : 500, { error: message });
  }
};

/**
 * Списки моделей агентов — отдельный проход от `/api/settings` (design.md
 * изменения `ui-dashboard`, решение 5): пробы поднимают дочерние процессы и
 * могут занять секунды на агента, а настройки обязаны отвечать сразу. Состав
 * агентов `readModels` (`../../models.js`) берёт тем же `readSettings`, что и
 * `handleRead`, — общая функция, а не запрос через HTTP. `?refresh=1` обходит
 * удержанное демоном и перечисляет заново.
 */
const handleModels: ApiHandler = async (req, res, env) => {
  try {
    const url = new URL(req.url ?? '/', 'http://internal');
    const refresh = url.searchParams.get('refresh') === '1';
    sendJson(res, 200, await readModels(env.home, { refresh }, env.kernelCache));
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/settings', handleRead);
  ctx.api.register('PUT', '/api/settings', handleWrite);
  ctx.api.register('GET', '/api/models', handleModels);
});
