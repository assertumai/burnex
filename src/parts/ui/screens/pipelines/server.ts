import { isStepcastError } from '../../../../kernel/errors.js';
import { readBody, sendJson } from '../../daemon/http.js';
import { writePipelineAgent } from '../../pipelineAgents.js';
import { buildPipelines } from '../../pipelines.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Пайплайны проектов: реестр каждого проекта собирается импортом чужого кода
 * (`buildPipelines` асинхронна). Перенесена без изменений из прежнего
 * `src/parts/ui/daemon/server.ts` (`ui-screens`, «Переведённые экраны не меняют поведения»).
 */
const handlePipelines: ApiHandler = async (_req, res, env) => {
  if (env.config === undefined) {
    sendJson(res, 200, { pipelines: [], generatedAt: new Date().toISOString() });
    return;
  }

  try {
    // `home` доезжает сюда, потому что секцию `project` витрина читает у
    // каждого проекта своей: команда проверки объявлена в репозитории.
    const overview = await buildPipelines(env.runsRoot, env.config, {
      ...(env.home === undefined ? {} : { home: env.home }),
      kernelCache: env.kernelCache,
    });
    sendJson(res, 200, overview);
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
};

/**
 * Выбор пользователя для пайплайна или шага (`pipeline_agents`, `step_agents`):
 * пишется в глобальный файл, ответ — заново раскрытые пайплайны, чтобы карточка
 * сразу показала итог, а не догадку о нём.
 */
const handleAgents: ApiHandler = async (req, res, env) => {
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
    await writePipelineAgent(patch, env.home, env.kernelCache);
  } catch (error) {
    const message = (error as Error).message;
    sendJson(res, isStepcastError(error) ? 400 : 500, { error: message });
    return;
  }
  await handlePipelines(req, res, env);
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/pipelines', handlePipelines);
  ctx.api.register('PUT', '/api/pipelines/agents', handleAgents);
});
