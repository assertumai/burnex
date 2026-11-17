import { z } from 'zod';

import { isBurnexError } from '../../../../kernel/errors.js';
import { readBody, sendJson } from '../../daemon/http.js';
import { addProject, buildProjects, pickDirectory, removeProject } from '../../projects.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Реестр проектов витрины (`../../projects.ts`): список, добавление — выбором
 * папки в системном диалоге или по пути — и снятие. Остальные экраны показывают только добавленные сюда проекты.
 */
const handleGet: ApiHandler = (_req, res, env) => {
  sendJson(res, 200, buildProjects(env.runsRoot));
};

const AddSchema = z.object({ path: z.string().min(1) }).strict();
const RemoveSchema = z.object({ key: z.string().min(1) }).strict();

async function readJson(req: Parameters<ApiHandler>[0], res: Parameters<ApiHandler>[1]): Promise<unknown> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Request body is too large' });
    return undefined;
  }
  try {
    return JSON.parse(body === '' ? '{}' : body) as unknown;
  } catch {
    sendJson(res, 400, { error: 'Request body is not valid JSON' });
    return undefined;
  }
}

function change(res: Parameters<ApiHandler>[1], env: Parameters<ApiHandler>[2], apply: () => void): void {
  try {
    apply();
    // Состав проектов меняет все обзоры: наблюдатель должен перечитать их
    // сейчас, а не на следующем такте.
    env.watcher.poll();
    sendJson(res, 200, buildProjects(env.runsRoot));
  } catch (error) {
    sendJson(res, isBurnexError(error) ? 400 : 500, { error: (error as Error).message });
  }
}

const handleAdd: ApiHandler = async (req, res, env) => {
  const raw = await readJson(req, res);
  if (raw === undefined) return;
  const parsed = AddSchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'Request body does not match the format: path' });
    return;
  }
  change(res, env, () => void addProject(env.runsRoot, parsed.data.path));
};

/**
 * Добавление через системный диалог выбора папки: ответ приходит, когда
 * пользователь выбрал папку или закрыл диалог (`canceled`).
 */
const handlePick: ApiHandler = async (_req, res, env) => {
  let picked: string | undefined;
  try {
    picked = await pickDirectory();
  } catch (error) {
    sendJson(res, isBurnexError(error) ? 400 : 500, { error: (error as Error).message });
    return;
  }
  if (picked === undefined) {
    sendJson(res, 200, { ...buildProjects(env.runsRoot), canceled: true });
    return;
  }
  const path = picked;
  change(res, env, () => void addProject(env.runsRoot, path));
};

const handleRemove: ApiHandler = async (req, res, env) => {
  const raw = await readJson(req, res);
  if (raw === undefined) return;
  const parsed = RemoveSchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'Request body does not match the format: key' });
    return;
  }
  change(res, env, () => removeProject(env.runsRoot, parsed.data.key));
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/projects', handleGet);
  ctx.api.register('POST', '/api/projects', handleAdd);
  ctx.api.register('POST', '/api/projects/pick', handlePick);
  ctx.api.register('DELETE', '/api/projects', handleRemove);
});
