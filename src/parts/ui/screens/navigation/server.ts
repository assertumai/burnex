import { homedir } from 'node:os';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';

import { isBurnexError } from '../../../../kernel/errors.js';
import { readBody, sendJson } from '../../daemon/http.js';
import { NavPatchSchema, resetNav, writeNavPatch, type RouteBuildOptions } from '../../routesFile.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Серверная половина экрана «Navigation»: меню остаётся содержимым
 * `routes.yml` (docs/routes.md), а экран пишет в файл слоя только листья
 * `nav` и секцию `nav_groups`. Читает экран ту же таблицу, что и каркас, —
 * событие потока `routes`; своего `GET` у него нет.
 *
 * `POST /api/nav` — правка названных листьев, `POST /api/nav/reset` — снять
 * из слоя все настройки меню.
 */

const LayerSchema = z.union([z.literal('home'), z.literal('project')]);
const PatchBodySchema = z.object({ layer: LayerSchema, patch: NavPatchSchema }).strict();
const ResetBodySchema = z.object({ layer: LayerSchema }).strict();

async function readJson(req: IncomingMessage): Promise<{ value: unknown } | { status: number; error: string }> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    return { status: 413, error: 'Request body is too large' };
  }
  try {
    return { value: JSON.parse(body === '' ? '{}' : body) as unknown };
  } catch {
    return { status: 400, error: 'Request body is not valid JSON' };
  }
}

function handler<T>(schema: z.ZodType<T>, write: (body: T, options: RouteBuildOptions) => void): ApiHandler {
  return async (req, res, env) => {
    const read = await readJson(req);
    if ('error' in read) {
      sendJson(res, read.status, { error: read.error });
      return;
    }
    const parsed = schema.safeParse(read.value);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Request body does not match the format of a menu edit' });
      return;
    }
    try {
      write(parsed.data, {
        home: env.home ?? homedir(),
        ...(env.projectRoot === undefined ? {} : { projectRoot: env.projectRoot }),
      });
      // Своя запись видна сразу, а не со следующим тактом наблюдателя — как у `POST /api/routes`.
      env.watcher.poll();
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, isBurnexError(error) ? 400 : 500, { error: (error as Error).message });
    }
  };
}

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('POST', '/api/nav', handler(PatchBodySchema, (body, options) => writeNavPatch(body.layer, body.patch, options)));
  ctx.api.register('POST', '/api/nav/reset', handler(ResetBodySchema, (body, options) => resetNav(body.layer, options)));
});
