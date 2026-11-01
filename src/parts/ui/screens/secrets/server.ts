import { sendJson } from '../../daemon/http.js';
import { buildSecrets } from '../../secrets.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Статусы секретов проектов (`ui-secrets-screen`). Каждый запрос — настоящая
 * проба провайдеров, без кеша статусов: разблокированная связка ключей должна
 * отразиться при следующем «Проверить снова», а не через час. Значения в ответ
 * не попадают по построению типа `SecretView`.
 */
const handleSecrets: ApiHandler = async (_req, res, env) => {
  if (env.config === undefined) {
    sendJson(res, 200, { projects: [], generatedAt: new Date().toISOString() });
    return;
  }

  // Закрытое до ответа соединение снимает пробы: висящий провайдер не держит
  // их после того, как клиент ушёл («Проверить снова» шлёт новый запрос).
  const abandoned = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abandoned.abort();
  });

  try {
    sendJson(
      res,
      200,
      await buildSecrets(env.runsRoot, env.config, {
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
  ctx.api.register('GET', '/api/secrets', handleSecrets);
});
