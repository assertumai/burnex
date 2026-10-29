import { StepcastError } from '../../../kernel/errors.js';
import { availableNames, type Registry } from '../../../kernel/registry.js';
import type { Pipeline, SecretDeclaration } from '../document/model.js';
import { describeSecretParamsIssue } from '../secrets/declaration.js';

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

function refusal(secret: SecretDeclaration, reason: string, hint?: string): StepcastError {
  return new StepcastError(`Секрет ${secret.name} не разрешён: ${reason}`, {
    at: `secrets.${secret.name}`,
    ...(hint === undefined ? {} : { hint }),
  });
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
    const provider = options.registry.secretProviders.get(secret.provider);
    if (provider === undefined) {
      const known = availableNames(options.registry, 'secretProviders');
      throw refusal(
        secret,
        `провайдер ${secret.provider} не зарегистрирован`,
        known.length === 0 ? undefined : `Доступны: ${known.join(', ')}`,
      );
    }

    const issue = describeSecretParamsIssue(provider, secret.params);
    if (issue !== undefined) {
      throw refusal(secret, `параметры не соответствуют схеме провайдера ${secret.provider}: ${issue}`);
    }

    let value: unknown;
    try {
      value = await provider.resolve({
        params: secret.params,
        secret: secret.name,
        env: secret.env,
        projectRoot: options.projectRoot,
        signal,
      });
    } catch (error) {
      throw new StepcastError(
        `Секрет ${secret.name} не разрешён: провайдер ${secret.provider} завершился ошибкой: ${error instanceof Error ? error.message : String(error)}`,
        { at: `secrets.${secret.name}`, cause: error },
      );
    }

    if (typeof value !== 'string') {
      throw refusal(secret, `провайдер ${secret.provider} вернул не строку`);
    }
    if (value === '') {
      throw refusal(secret, `провайдер ${secret.provider} вернул пустое значение`);
    }
    if (value.length < MIN_SECRET_LENGTH) {
      throw refusal(
        secret,
        `значение короче ${MIN_SECRET_LENGTH} символов`,
        'Короткое значение нельзя надёжно замаскировать в журнале: оно совпадало бы с обычным текстом',
      );
    }
    if (/[\r\n]/.test(value)) {
      throw refusal(
        secret,
        'значение содержит перевод строки',
        'Маскирование построчное; многострочный материал (например, PEM) передайте путём к файлу',
      );
    }

    values.set(secret.name, value);
  }

  return values;
}
