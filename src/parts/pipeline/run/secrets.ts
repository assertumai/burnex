import { StepcastError } from '../../../kernel/errors.js';
import { availableNames, type Registry } from '../../../kernel/registry.js';
import type { BackendCredential, Config } from '../config/resolve.js';
import { SecretProviderUnavailableError } from '../contract.js';
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

/**
 * Исход пробы. `provider-unavailable` — провайдера нет в реестре либо он сам
 * сказал, что здесь работать не может (`SecretProviderUnavailableError`);
 * `not-found` — провайдер работал, годного значения нет. Витрина показывает
 * статус, запуск — `error`: тексты отказов один и тот же `StepcastError`.
 */
export type SecretProbeStatus = 'not-found' | 'provider-unavailable';

export type SecretProbe =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly status: SecretProbeStatus; readonly error: StepcastError };

async function probeTarget(
  target: Target,
  registry: Registry,
  projectRoot: string,
  signal: AbortSignal,
): Promise<SecretProbe> {
  const fail = (status: SecretProbeStatus, error: StepcastError): SecretProbe => ({ ok: false, status, error });

  const provider = registry.secretProviders.get(target.provider);
  if (provider === undefined) {
    const known = availableNames(registry, 'secretProviders');
    return fail(
      'provider-unavailable',
      refusal(
        target,
        `провайдер ${target.provider} не зарегистрирован`,
        known.length === 0 ? undefined : `Доступны: ${known.join(', ')}`,
      ),
    );
  }

  const issue = describeSecretParamsIssue(provider, target.params);
  if (issue !== undefined) {
    return fail(
      'not-found',
      refusal(target, `параметры не соответствуют схеме провайдера ${target.provider}: ${issue}`),
    );
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
    return fail(
      error instanceof SecretProviderUnavailableError ? 'provider-unavailable' : 'not-found',
      new StepcastError(
        `${target.refused}: провайдер ${target.provider} завершился ошибкой: ${error instanceof Error ? error.message : String(error)}`,
        { at: target.at, cause: error },
      ),
    );
  }

  if (typeof value !== 'string') {
    return fail('not-found', refusal(target, `провайдер ${target.provider} вернул не строку`));
  }
  if (value === '') {
    return fail('not-found', refusal(target, `провайдер ${target.provider} вернул пустое значение`));
  }
  if (value.length < MIN_SECRET_LENGTH) {
    return fail(
      'not-found',
      refusal(
        target,
        `значение короче ${MIN_SECRET_LENGTH} символов`,
        'Короткое значение нельзя надёжно замаскировать в журнале: оно совпадало бы с обычным текстом',
      ),
    );
  }
  if (/[\r\n]/.test(value)) {
    return fail(
      'not-found',
      refusal(
        target,
        'значение содержит перевод строки',
        'Маскирование построчное; многострочный материал (например, PEM) передайте путём к файлу',
      ),
    );
  }
  return { ok: true, value };
}

async function resolveTarget(
  target: Target,
  registry: Registry,
  projectRoot: string,
  signal: AbortSignal,
): Promise<string> {
  const probe = await probeTarget(target, registry, projectRoot, signal);
  if (!probe.ok) throw probe.error;
  return probe.value;
}

function secretTarget(secret: SecretDeclaration): Target {
  return {
    refused: `Секрет ${secret.name} не разрешён`,
    at: `secrets.${secret.name}`,
    provider: secret.provider,
    params: secret.params,
    secret: secret.name,
    env: secret.env,
  };
}

function credentialTarget(backend: string, variable: string, credential: BackendCredential): Target {
  const at = `backends.${backend}.credentials.${variable}`;
  return {
    refused: `Учётные данные ${at} не разрешены`,
    at,
    provider: credential.provider,
    params: credential.params,
    secret: at,
    env: variable,
  };
}

/**
 * Проба, которая не ждёт провайдера дольше сигнала. Плагинный провайдер вправе
 * сигнал не слушать (сетевой vault без своего таймаута), и тогда срок пробы
 * и отмена запроса витрины ничего бы не ограничивали. Сработавший сигнал —
 * `provider-unavailable`: провайдер не дал ответа здесь и сейчас, о наличии
 * значения ничего не известно. Запуск этой обёрткой не пользуется: его
 * отмена — дело самого прогона.
 */
function probeUntilAborted(
  target: Target,
  registry: Registry,
  projectRoot: string,
  signal: AbortSignal,
): Promise<SecretProbe> {
  const abandoned = (): SecretProbe => ({
    ok: false,
    status: 'provider-unavailable',
    error: refusal(
      target,
      `провайдер ${target.provider} не ответил до истечения срока пробы или отмены запроса`,
    ),
  });
  if (signal.aborted) return Promise.resolve(abandoned());

  return new Promise<SecretProbe>((resolve, reject) => {
    const onAbort = (): void => resolve(abandoned());
    signal.addEventListener('abort', onAbort, { once: true });
    probeTarget(target, registry, projectRoot, signal).then(
      (probe) => {
        signal.removeEventListener('abort', onAbort);
        resolve(probe);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Пробы для экрана «Secrets» (`ui-secrets-screen`, design.md, Решение 1): те
 * же Target и проверки, что у запуска, но исход — статус, а не исключение.
 * Значение достаётся только вызывающему; витрина читает от пробы `ok`.
 * Сработавший `signal` завершает пробу сразу, даже если провайдер его не слушает.
 */
export function probePipelineSecret(
  secret: SecretDeclaration,
  registry: Registry,
  projectRoot: string,
  signal: AbortSignal,
): Promise<SecretProbe> {
  return probeUntilAborted(secretTarget(secret), registry, projectRoot, signal);
}

export function probeBackendCredential(
  backend: string,
  variable: string,
  credential: BackendCredential,
  registry: Registry,
  globalConfigDir: string,
  signal: AbortSignal,
): Promise<SecretProbe> {
  return probeUntilAborted(credentialTarget(backend, variable, credential), registry, globalConfigDir, signal);
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
      secretTarget(secret),
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
      values[variable] = await resolveTarget(
        credentialTarget(backend, variable, credential),
        options.registry,
        config.globalConfigDir,
        signal,
      );
    }
    resolved.set(backend, values);
  }

  return resolved;
}
