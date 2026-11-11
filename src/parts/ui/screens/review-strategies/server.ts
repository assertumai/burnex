import { homedir } from 'node:os';
import { z } from 'zod';

import { isBurnexError } from '../../../../kernel/errors.js';
import { readBody, sendJson } from '../../daemon/http.js';
import { projectPipelines, type PipelineView } from '../../pipelines.js';
import { deleteReviewStrategy, readReviewStrategies, saveReviewStrategy, StrategyRejected } from '../../reviewStrategies.js';
import { readSettings } from '../../settings.js';
import { listProjects } from '../../../pipeline/run/journal/reader.js';
import { screenRow, type ApiHandler, type RequestEnv } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Серверная половина экрана «Review strategies» (`ui-review-strategies`):
 * `GET` — стратегии обоих слоёв проекта демона с разбором и использованием,
 * `PUT` — запись одной стратегии в файл её слоя, `DELETE` — удаление файла.
 * Проектный слой — проект, в котором поднят демон (`env.projectRoot`), тем
 * же правилом, каким его ищет файл маршрутов.
 */

async function backendNames(env: RequestEnv): Promise<readonly string[]> {
  return (await readSettings(env.home, env.kernelCache)).backends.map((backend) => backend.name);
}

/** Раскрытые пайплайны проекта демона — ими шаги `review:` разрешают стратегии. */
async function pipelinesOf(env: RequestEnv): Promise<readonly PipelineView[]> {
  if (env.projectRoot === undefined || env.config === undefined) return [];
  const projectRoot = env.projectRoot;
  const key = listProjects(env.runsRoot).find((project) => project.path === projectRoot)?.key ?? '';
  const found = await projectPipelines(key, projectRoot, env.config, {
    ...(env.home === undefined ? {} : { home: env.home }),
    kernelCache: env.kernelCache,
  });
  return found.pipelines;
}

function roots(env: RequestEnv): { projectRoot?: string; home: string } {
  return { home: env.home ?? homedir(), ...(env.projectRoot === undefined ? {} : { projectRoot: env.projectRoot }) };
}

const handleList: ApiHandler = async (_req, res, env) => {
  try {
    sendJson(res, 200, readReviewStrategies({ ...roots(env), backendNames: await backendNames(env), pipelines: await pipelinesOf(env) }));
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
};

const LayerSchema = z.union([z.literal('project'), z.literal('home')]);

const PutBodySchema = z
  .object({
    layer: LayerSchema,
    name: z.string(),
    document: z.record(z.string(), z.unknown()),
    create: z.boolean().optional(),
  })
  .strict();

function sendFailure(res: Parameters<ApiHandler>[1], error: unknown): void {
  if (!isBurnexError(error)) {
    sendJson(res, 500, { error: (error as Error).message });
    return;
  }
  sendJson(res, 400, {
    error: error.message,
    ...(error instanceof StrategyRejected ? { rejected: true } : {}),
    ...(error.at === undefined ? {} : { at: error.at }),
  });
}

const handleSave: ApiHandler = async (req, res, env) => {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Request body is too large' });
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body === '' ? '{}' : body) as unknown;
  } catch {
    sendJson(res, 400, { error: 'Request body is not valid JSON' });
    return;
  }
  const parsed = PutBodySchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'Request body must name a layer, a strategy name and its document' });
    return;
  }
  try {
    const path = saveReviewStrategy(parsed.data, { ...roots(env), backendNames: await backendNames(env) });
    sendJson(res, 200, { path });
  } catch (error) {
    sendFailure(res, error);
  }
};

const handleDelete: ApiHandler = (req, res, env) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const layer = LayerSchema.safeParse(url.searchParams.get('layer'));
  const name = url.searchParams.get('name');
  if (!layer.success || name === null) {
    sendJson(res, 400, { error: 'Name the layer and the strategy to delete' });
    return;
  }
  try {
    deleteReviewStrategy(layer.data, name, roots(env));
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendFailure(res, error);
  }
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/review-strategies', handleList);
  ctx.api.register('PUT', '/api/review-strategies', handleSave);
  ctx.api.register('DELETE', '/api/review-strategies', handleDelete);
});
