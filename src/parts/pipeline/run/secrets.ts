import { StepcastError } from '../../../kernel/errors.js';
import { availableNames, type Registry } from '../../../kernel/registry.js';
import type { Config } from '../config/resolve.js';
import type { Pipeline, SecretDeclaration } from '../document/model.js';
import { backendsInUse, describeSecretParamsIssue } from '../secrets/declaration.js';

/**
 * Разрешение секретов до каталога прогона (`secrets-named-providers`,
 * design.md, решение 4).
 *
 * Результат — карта «имя секрета → значение» в памяти прогона. Она не
 * попадает ни в замок, ни в ключ шага, ни в манифест: единственные места,
 * куда значение доходит, — окружение процесса шага и маскировщик журнала.
 */

/**
 * Порог длины значения. Короткое значение вроде `true` или `1234` замаскировало
 * бы половину логов и, хуже, выдало бы себя тем, что именно скрыто.
 */
export const MIN_SECRET_LENGTH = 8;

export interface ResolveSecretsOptions {
  readonly pipeline: Pipeline;
  readonly registry: Registry;
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
}

/** Секреты, на которые ссылается хотя бы один шаг раскрытого пайплайна, в порядке объявления. */
export function namedSecrets(pipeline: Pipeline): SecretDeclaration[] {
  const named = new Set(pipeline.jobs.flatMap((job) => job.steps.flatMap((step) => step.secrets ?? [])));
  return pipeline.secrets.filter((secret) => named.has(secret.name));
}

/**
 * Что именно разрешается. Секрет пайплайна и учётные данные бэкенда проходят
 * один путь проверок (`secrets-keychain-provider`, design.md, решение 3):
 * линт и запуск обязаны отказывать теми же словами, и разные ветки кода
 * разошлись бы на первой правке.
 */
interface Target {
  /** Начало сообщения об отказе: «Секрет gh не разрешён», «Учётные данные … не разрешены». */
  readonly refused: string;
  readonly at: string;
  readonly provider: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** Поле `secret` входа провайдера — имя в сообщениях. */
  readonly secret: string;
  readonly env: string;
}

function refusal(target: Target, reason: string, hint?: string): StepcastError {
  return new StepcastError(`${target.refused}: ${reason}`, {
    at: target.at,
    ...(hint === undefined ? {} : { hint }),
  });
}

async function resolveTarget(
  target: Target,
  registry: Registry,
  projectRoot: string,
  signal: AbortSignal,
): Promise<string> {
  const provider = registry.secretProviders.get(target.provider);
  if (provider === undefined) {
    const known = availableNames(registry, 'secretProviders');
    throw refusal(
      target,
      `провайдер ${target.provider} не зарегистрирован`,
      known.length === 0 ? undefined : `Доступны: ${known.join(', ')}`,
    );
  }

  const issue = describeSecretParamsIssue(provider, target.params);
  if (issue !== undefined) {
    throw refusal(target, `параметры не соответствуют схеме провайдера ${target.provider}: ${issue}`);
  }

  let value: unknown;
  try {
    value = await provider.resolve({
      params: target.params,
      secret: target.secret,
      env: target.env,
      projectRoot,
      signal,
    });
  } catch (error) {
    throw new StepcastError(
      `${target.refused}: провайдер ${target.provider} завершился ошибкой: ${error instanceof Error ? error.message : String(error)}`,
      { at: target.at, cause: error },
    );
  }

  if (typeof value !== 'string') {
    throw refusal(target, `провайдер ${target.provider} вернул не строку`);
  }
  if (value === '') {
    throw refusal(target, `провайдер ${target.provider} вернул пустое значение`);
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw refusal(
      target,
      `значение короче ${MIN_SECRET_LENGTH} символов`,
      'Короткое значение нельзя надёжно замаскировать в журнале: оно совпадало бы с обычным текстом',
    );
  }
  if (/[\r\n]/.test(value)) {
    throw refusal(
      target,
      'значение содержит перевод строки',
      'Маскирование построчное; многострочный материал (например, PEM) передайте путём к файлу',
    );
  }
  return value;
}

/**
 * Значения всех названных шагами секретов. Любой сбой — отказ запуска: вызов
 * стоит до `RunJournal.create`, и прогон без секрета не оставляет за собой
 * каталога. Объявленный, но никем не названный секрет не разрешается: иначе
 * неиспользуемая запись роняла бы прогон на чужой машине.
 */
export async function resolveSecrets(options: ResolveSecretsOptions): Promise<ReadonlyMap<string, string>> {
  const values = new Map<string, string>();
  const signal = options.signal ?? new AbortController().signal;

  for (const secret of namedSecrets(options.pipeline)) {
    const value = await resolveTarget(
      {
        refused: `Секрет ${secret.name} не разрешён`,
        at: `secrets.${secret.name}`,
        provider: secret.provider,
        params: secret.params,
        secret: secret.name,
        env: secret.env,
      },
      options.registry,
      options.projectRoot,
      signal,
    );
    values.set(secret.name, value);
  }

  return values;
}

export interface ResolveBackendCredentialsOptions {
  readonly pipeline: Pipeline;
  readonly config: Config;
  readonly registry: Registry;
  readonly signal?: AbortSignal;
}

/**
 * Учётные данные бэкендов, которыми идёт хотя бы один агентский шаг или судья
 * (`secrets-keychain-provider`, design.md, решение 3): «бэкенд → { переменная →
 * значение }». Запись неиспользуемого бэкенда не разрешается — иначе ключ
 * `codex` ронял бы прогон чисто claude-пайплайна на машине с заблокированной
 * связкой ключей. `projectRoot` провайдера — каталог глобального конфига, от
 * которого разрешаются относительные пути параметров.
 */
export async function resolveBackendCredentials(
  options: ResolveBackendCredentialsOptions,
): Promise<ReadonlyMap<string, Readonly<Record<string, string>>>> {
  const { config } = options;
  const signal = options.signal ?? new AbortController().signal;
  const resolved = new Map<string, Readonly<Record<string, string>>>();

  for (const backend of backendsInUse(options.pipeline, config.defaults.agent)) {
    const credentials = Object.entries(config.backends[backend]?.credentials ?? {});
    if (credentials.length === 0) continue;

    const values: Record<string, string> = {};
    for (const [variable, credential] of credentials) {
      const at = `backends.${backend}.credentials.${variable}`;
      values[variable] = await resolveTarget(
        {
          refused: `Учётные данные ${at} не разрешены`,
          at,
          provider: credential.provider,
          params: credential.params,
          secret: at,
          env: variable,
        },
        options.registry,
        config.globalConfigDir,
        signal,
      );
    }
    resolved.set(backend, values);
  }

  return resolved;
}
