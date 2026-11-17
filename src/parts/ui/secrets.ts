import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative } from 'node:path';

import { availableNames, BUILTIN_OWNER, contributionOwner, type Registry } from '../../kernel/registry.js';
import type { Config } from '../pipeline/config/resolve.js';
import { listPipelineEntries } from '../pipeline/domain/project/pipelines.js';
import { displayInputs } from '../pipeline/document/displayInputs.js';
import { expandPipeline } from '../pipeline/document/expand.js';
import { backendsInUse } from '../pipeline/secrets/declaration.js';
import type { SecretDeclaration } from '../pipeline/document/model.js';
import { shownProjects } from './projects.js';
import {
  probeBackendCredential,
  probePipelineSecret,
  type SecretProbe,
  type SecretProbeStatus,
} from '../pipeline/run/secrets.js';
import {
  projectSection,
  toFailure,
  withProjectSection,
  type Failure,
  type KernelCache,
} from './pipelines.js';
import { homeRoot } from '../../kernel/dirs.js';

/**
 * Секреты проектов для экрана «Secrets» (`ui-secrets-screen`, design.md).
 *
 * Статус записи — результат настоящей пробы тем же путём, что и запуск
 * (`probePipelineSecret`, `probeBackendCredential`): экран, отвечающий «упадёт
 * ли мой прогон на секрете», не вправе проверять что-то иное. Значение
 * проба отдаёт только вызывающему, и `settle` ниже читает от неё `ok`,
 * `status` и поля ошибки — больше ничего. Поэтому у `SecretView` нет поля
 * значения: ответ нельзя собрать так, чтобы оно в него попало.
 */

export type SecretStatus = 'resolved' | SecretProbeStatus;

/** Результат пробы без значения: то, что уходит в ответ. */
interface Outcome {
  readonly status: SecretStatus;
  /** Причина отказа теми же словами, какими отказал бы запуск. */
  readonly reason?: string;
  readonly reasonAt?: string;
  readonly reasonHint?: string;
}

export interface SecretUsage {
  /** Адрес пайплайна, как на «Pipelines». */
  readonly pipeline: string;
  /** Шаги, называющие секрет, как `job/step`. */
  readonly steps: readonly string[];
}

export interface SecretView extends Outcome {
  readonly name: string;
  readonly env: string;
  readonly provider: string;
  /** Параметры объявления — не значение, они лежат и в `pipeline.lock.yml`. */
  readonly params: Readonly<Record<string, unknown>>;
  readonly usedBy: readonly SecretUsage[];
  /** Объявлен, но ни один шаг его не называет. */
  readonly unused: boolean;
}

export interface CredentialView extends Outcome {
  readonly backend: string;
  readonly variable: string;
  readonly provider: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** `backends.<id>.credentials.<VAR>` — место записи в конфигурации. */
  readonly at: string;
  /** Бэкенд идёт хотя бы в одном пайплайне проекта — запуск разрешил бы запись. */
  readonly inUse: boolean;
}

export interface ProviderView {
  readonly name: string;
  /** Имя плагина либо `BUILTIN_OWNER` — так вклад называет реестр. */
  readonly owner: string;
}

/** Пайплайн, который не раскрылся: секретов у него нет, причина — как на «Pipelines». */
export interface PipelineFailureView extends Failure {
  readonly pipeline: string;
}

export interface ProjectSecretsView {
  readonly projectKey: string;
  readonly projectPath: string;
  /** Конфигурация или плагины проекта не загрузились: ни провайдеров, ни записей. */
  readonly error?: string;
  readonly errorFile?: string;
  readonly errorAt?: string;
  readonly errorHint?: string;
  readonly providers: readonly ProviderView[];
  readonly secrets: readonly SecretView[];
  readonly credentials: readonly CredentialView[];
  readonly pipelineErrors: readonly PipelineFailureView[];
}

export interface SecretsOverview {
  readonly projects: readonly ProjectSecretsView[];
  readonly generatedAt: string;
}

/**
 * Срок проб одного проекта. Встроенный `keychain` укладывается в свои 5 с;
 * плагинный провайдер без таймаута (сетевой vault) иначе держал бы
 * `GET /api/secrets` сколько угодно. Не уложившаяся проба —
 * `provider-unavailable`, остальные записи проекта ответ получают.
 */
export const PROBE_TIMEOUT_MS = 10_000;

export interface BuildSecretsOptions {
  readonly home?: string;
  readonly kernelCache?: KernelCache;
  readonly now?: Date;
  /** Отмена запроса: клиент закрыл соединение — пробы бросаются. */
  readonly signal?: AbortSignal;
  /** Срок проб одного проекта; по умолчанию `PROBE_TIMEOUT_MS`. */
  readonly probeTimeoutMs?: number;
}

/** Свёртка пробы: от неё читаются только `ok`, `status` и поля ошибки — значение отбрасывается здесь. */
function settle(probe: SecretProbe): Outcome {
  if (probe.ok) return { status: 'resolved' };
  const { message, at, hint } = probe.error;
  return {
    status: probe.status,
    reason: message,
    ...(at === undefined ? {} : { reasonAt: at }),
    ...(hint === undefined ? {} : { reasonHint: hint }),
  };
}

/** Секрет, собранный из объявлений нескольких пайплайнов: «имя + объявление» — одна запись. */
interface Declared {
  readonly secret: SecretDeclaration;
  readonly usedBy: SecretUsage[];
}

function declarationKey(secret: SecretDeclaration): string {
  return JSON.stringify([secret.name, secret.provider, secret.env, secret.params]);
}

async function projectView(
  project: { readonly key: string; readonly path: string },
  config: Config,
  options: BuildSecretsOptions,
): Promise<ProjectSecretsView> {
  const empty = { providers: [], secrets: [], credentials: [], pipelineErrors: [] };
  let forProject: Config;
  let registry: Registry;
  try {
    const overrides = await projectSection(project.path, options.home, options.kernelCache);
    forProject = withProjectSection(config, overrides);
    registry = overrides.registry;
  } catch (error) {
    // Реестра нет — нет и вопроса, каким провайдером что разрешается; проект
    // показан одной строкой с объяснением, как на «Pipelines».
    const failure = toFailure(error, project.path);
    return { projectKey: project.key, projectPath: project.path, ...failure, ...empty };
  }

  const entries = listPipelineEntries(project.path, {
    globalConfigDir: homeRoot(options.home ?? homedir()),
  });

  const declared = new Map<string, Declared>();
  const pipelineErrors: PipelineFailureView[] = [];
  const used = new Set<string>();
  for (const entry of entries) {
    const address = entry.address ?? relative(project.path, entry.path).replace(/\\/g, '/');
    try {
      const { pipeline } = expandPipeline({
        pipelinePath: entry.path,
        config: forProject,
        registry,
        inputs: displayInputs(entry.path),
        ...(entry.address === undefined ? {} : { projectRoot: project.path }),
      });
      for (const backend of backendsInUse(pipeline, forProject.defaults.agent)) used.add(backend);

      const stepsBySecret = new Map<string, string[]>();
      for (const job of pipeline.jobs) {
        for (const step of job.steps) {
          for (const name of step.secrets ?? []) {
            stepsBySecret.set(name, [...(stepsBySecret.get(name) ?? []), `${job.id}/${step.id}`]);
          }
        }
      }
      for (const secret of pipeline.secrets) {
        const key = declarationKey(secret);
        const entryFor = declared.get(key) ?? { secret, usedBy: [] };
        declared.set(key, entryFor);
        const steps = stepsBySecret.get(secret.name);
        if (steps !== undefined) entryFor.usedBy.push({ pipeline: address, steps });
      }
    } catch (error) {
      pipelineErrors.push({ pipeline: address, ...toFailure(error, project.path) });
    }
  }

  const deadline = AbortSignal.timeout(options.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
  const credentialEntries = Object.entries(forProject.backends).flatMap(([backend, settings]) =>
    Object.entries(settings.credentials ?? {}).map(([variable, credential]) => ({ backend, variable, credential })),
  );

  // Пробы одного проекта идут вместе: время ответа задаёт самый медленный
  // провайдер, а не сумма всех, и сверху его ограничивает срок `deadline`.
  const [secrets, credentials] = await Promise.all([
    Promise.all(
      [...declared.values()].map(async ({ secret, usedBy }): Promise<SecretView> => ({
        name: secret.name,
        env: secret.env,
        provider: secret.provider,
        params: secret.params,
        usedBy,
        unused: usedBy.length === 0,
        ...settle(await probePipelineSecret(secret, registry, project.path, signal)),
      })),
    ),
    Promise.all(
      credentialEntries.map(async ({ backend, variable, credential }): Promise<CredentialView> => ({
        backend,
        variable,
        provider: credential.provider,
        params: credential.params,
        at: `backends.${backend}.credentials.${variable}`,
        inUse: used.has(backend),
        ...settle(
          await probeBackendCredential(backend, variable, credential, registry, forProject.globalConfigDir, signal),
        ),
      })),
    ),
  ]);

  return {
    projectKey: project.key,
    projectPath: project.path,
    providers: availableNames(registry, 'secretProviders').map((name) => ({
      name,
      owner: contributionOwner(registry, 'secretProviders', name) ?? BUILTIN_OWNER,
    })),
    secrets,
    credentials,
    pipelineErrors,
  };
}

export async function buildSecrets(
  runsRoot: string,
  config: Config,
  options: BuildSecretsOptions = {},
): Promise<SecretsOverview> {
  const projects: ProjectSecretsView[] = [];

  // Последовательно, как в `buildPipelines`: параллельный импорт чужих
  // плагинов порядка не ускоряет, а карточки делает недетерминированными.
  for (const project of shownProjects(runsRoot)) {
    // Клиент ушёл — ответ уже некому отдавать, а следующий проект поднял бы плагины зря.
    if (options.signal?.aborted === true) break;
    if (project.path === undefined || !existsSync(project.path)) continue;
    projects.push(await projectView({ key: project.key, path: project.path }, config, options));
  }

  return { projects, generatedAt: (options.now ?? new Date()).toISOString() };
}
