import { partRow } from '../services.js';
import { ENV_FILE_PROVIDER } from './envFile.js';

/**
 * Строка встроенного слоя: провайдер секретов `env-file`. Заведён строкой
 * реестра так же, как встроенные предикаты, — особого случая в движке нет, и
 * отключение строки патчем освобождает имя (`secrets-named-providers`,
 * design.md, решение 7).
 *
 * Строка-потребитель сервиса `secretProviders`: применяется собственной
 * областью с объявленным `inject`, владелец вклада остаётся «встроенным».
 */
export const row = partRow('secret-providers', ['secretProviders'], (ctx) => {
  ctx.secretProviders.register(ENV_FILE_PROVIDER.name, ENV_FILE_PROVIDER);
});
