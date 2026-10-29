import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import type { SecretProviderContribution } from '../contract.js';
import { parseEnvFile } from '../run/exec/env.js';

/**
 * Встроенный провайдер секретов `env-file` (`secrets-named-providers`,
 * design.md, решение 7): значение — одна запись файла формата `.env`.
 *
 * Разбор — тот же `parseEnvFile`, что у `env_files`, чтобы два чтения одного
 * файла не разошлись. Но отсутствие файла здесь отказ: `env_files` молча
 * пропускает отсутствующий файл, а для секрета это значило бы шаг без токена,
 * о котором узнают только по ответу 401.
 */
export const ENV_FILE_PROVIDER: SecretProviderContribution = {
  name: 'env-file',
  schema: {
    type: 'object',
    properties: {
      file: { type: 'string', minLength: 1 },
      key: { type: 'string', minLength: 1 },
    },
    required: ['file'],
    additionalProperties: false,
  },
  async resolve({ params, secret, env, projectRoot }) {
    const file = params.file as string;
    const key = typeof params.key === 'string' ? params.key : env;
    const path = isAbsolute(file) ? file : resolvePath(projectRoot, file);

    if (!existsSync(path)) {
      throw new Error(`секрет ${secret}: файл ${file} не найден (искали ${path})`);
    }
    const value = parseEnvFile(path)[key];
    if (value === undefined) {
      throw new Error(`секрет ${secret}: в файле ${file} нет ключа ${key}`);
    }
    return value;
  },
};
