import { sendJson } from '../../daemon/http.js';
import { buildSchedule } from '../../schedule.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Расписания пайплайнов проектов (`ui-schedule-view`). Только чтение: экран не
 * правит документ пайплайна, и других методов у маршрута нет.
 */
const handleSchedule: ApiHandler = async (_req, res, env) => {
  if (env.config === undefined) {
    sendJson(res, 200, { projects: [], service: { present: false }, generatedAt: new Date().toISOString() });
    return;
  }

  const abandoned = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abandoned.abort();
  });

  try {
    sendJson(
      res,
      200,
      await buildSchedule(env.runsRoot, env.config, {
        ...(env.home === undefined ? {} : { home: env.home }),
        kernelCache: env.kernelCache,
        signal: abandoned.signal,
      }),
    );
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/schedule', handleSchedule);
});
