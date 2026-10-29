import { Ajv2020 } from 'ajv/dist/2020.js';

import type { SecretProviderContribution } from '../contract.js';
import type { SecretDeclaration } from '../document/model.js';

/**
 * Объявления секретов в модели документа и проверка их параметров схемой
 * провайдера. Общее место для разбора, линта и разрешения до прогона
 * (`secrets-named-providers`, design.md, решения 1 и 4): три потребителя
 * обязаны отказывать одними и теми же словами, иначе линт пропустит то, на
 * чём упадёт запуск.
 */

const ajv = new Ajv2020({ allErrors: true, strict: false });

/** Переменная окружения по умолчанию: имя секрета в верхнем регистре, `-` → `_`. */
export function defaultSecretEnv(name: string): string {
  return name.toUpperCase().replaceAll('-', '_');
}

/** Ключи объявления, которые провайдеру не достаются: `provider` и `env` зарезервированы. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['provider', 'env']);

/** Объявление из сырого документа в модель: умолчание `env` применено, параметры отделены. */
export function toSecretDeclarations(raw: Readonly<Record<string, unknown>> | undefined): SecretDeclaration[] {
  return Object.entries(raw ?? {}).map(([name, entry]) => {
    const record = entry as Record<string, unknown>;
    const params = Object.fromEntries(Object.entries(record).filter(([key]) => !RESERVED_KEYS.has(key)));
    return {
      name,
      provider: record.provider as string,
      env: typeof record.env === 'string' ? record.env : defaultSecretEnv(name),
      params,
    };
  });
}

/**
 * Параметры объявления против JSON-схемы вклада провайдера. Возвращает
 * причину отказа либо `undefined`, если параметры подошли.
 */
export function describeSecretParamsIssue(
  provider: SecretProviderContribution,
  params: Readonly<Record<string, unknown>>,
): string | undefined {
  const validate = ajv.compile(provider.schema as object);
  if (validate(params)) return undefined;
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath === '' ? 'параметры' : error.instancePath} ${error.message ?? ''}`.trim())
    .join('; ');
}
