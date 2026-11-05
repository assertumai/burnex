import { execFile, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';

import { BurnexError } from '../../kernel/errors.js';
import { heldModelDiscovery, type ModelDiscoveryResult } from '../pipeline/backend/models.js';
import { resolveAdapter } from '../pipeline/backend/registry.js';
import { enginePackageRoot } from '../pipeline/document/packagePaths.js';
import { buildStepEnv } from '../pipeline/run/exec/env.js';
import { isUnpricedCall, loadPriceCatalog, type PriceCatalog } from '../pipeline/run/budget/priceCatalog.js';
import { EventSchema } from '../pipeline/run/journal/schema.js';
import { listProjects, listRunsByKey, readUsageSoft } from '../pipeline/run/journal/reader.js';
import { runPaths } from '../pipeline/run/journal/paths.js';
import { resolveInstallMethod, type InferProbes } from '../install/infer.js';
import { installManifestPath, burnexHome, type InstallManifest } from '../install/manifest.js';
import { CHECK_TIMEOUT_MS, checkUpdate, type UpdateCheck, type UpdateProbeHost, type UpdateStep } from '../install/plan.js';
import { currentDaemonKernel } from './daemon/kernel.js';
import { agentState, systemHost, type AgentState, type LaunchdHost } from './daemon/launchd.js';
import type { KernelCache } from './pipelines.js';
import { readSettings } from './settings.js';

/**
 * Свёртка экрана «System» (`ui-system-health`): версия и способ установки,
 * сведения о демоне, автозапуск, бэкенды и модели без цены. Ничего из этого не
 * ходит в сеть и не запускает проб — только диск, `launchctl print` и память
 * демона; сеть — единственный маршрут `GET /api/system/update`.
 */

/** Предел новейших прогонов проекта, в которых ищется отказ бэкенда. */
export const REFUSAL_RUNS_PER_PROJECT = 20;

/** Сколько демон помнит исход проверки обновления, пока `?refresh=1` не потребует новой. */
export const UPDATE_HOLD_MS = 10 * 60_000;

/** Сведения демона о самом себе — от процесса, а не из `ui.pid` (design.md, Решение 1). */
export interface DaemonSelf {
  readonly pid: number;
  /** Момент старта сервера, мс с эпохи. */
  readonly startedAt: number;
  readonly port: number;
  readonly projectRoot: string | undefined;
  /** `process.argv[1]`: той же точкой входа порождаются `update` и `up`. */
  readonly entry: string;
}

/** Всё, что касается системы, внедряется: тест не трогает ни launchd, ни git, ни диск установки. */
export interface SystemHost {
  readonly now: () => number;
  readonly launchd: LaunchdHost;
  readonly engineRoot: string;
  /** Версия из `package.json` корня движка. */
  readonly engineVersion: () => string | undefined;
  readonly manifestPath: string;
  readonly readManifest: () => string | undefined;
  readonly installProbes: InferProbes;
  /** Имя релиза, на который указывает `current` каталога релизов. */
  readonly currentRelease: (releasesDir: string) => string | undefined;
  /** Полный путь команды, как её найдёт `spawn`; `undefined` — не найдена. */
  readonly findCommand: (command: string, pathEnv: string | undefined) => string | undefined;
  readonly heldProbe: (name: string, command: string) => ModelDiscoveryResult | undefined;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly priceCatalog: () => PriceCatalog | undefined;
  readonly capture: UpdateProbeHost['capture'];
}

function findExecutable(command: string, pathEnv: string | undefined): string | undefined {
  const isExecutable = (file: string): boolean => {
    try {
      if (!statSync(file).isFile()) return false;
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  // Путь со `/` `spawn` берёт как есть, без обхода `PATH`.
  if (command.includes('/')) return isExecutable(resolve(command)) ? resolve(command) : undefined;
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function systemSystemHost(): SystemHost {
  const home = homedir();
  const engineRoot = enginePackageRoot();
  const manifestPath = installManifestPath(process.env, home);
  // Местная и быстрая проба способа установки — синхронно, как в `burnex update`.
  const captureLocal = (step: UpdateStep): string | undefined => {
    const result = spawnSync(step.cmd, [...step.args], { cwd: step.cwd, encoding: 'utf8' });
    return result.status === 0 ? result.stdout : undefined;
  };
  // Проверка обновления ходит в сеть: только асинхронно, иначе на `git fetch` встаёт весь демон.
  const capture: SystemHost['capture'] = (step, timeoutMs) =>
    new Promise((settle) => {
      execFile(
        step.cmd,
        [...step.args],
        { cwd: step.cwd, encoding: 'utf8', ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) },
        (error, stdout) => settle(error === null ? stdout : undefined),
      );
    });

  return {
    now: Date.now,
    launchd: systemHost(),
    engineRoot,
    engineVersion: () => {
      try {
        const version: unknown = (JSON.parse(readFileSync(join(engineRoot, 'package.json'), 'utf8')) as { version?: unknown }).version;
        return typeof version === 'string' ? version : undefined;
      } catch {
        return undefined;
      }
    },
    manifestPath,
    readManifest: () => (existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : undefined),
    installProbes: {
      releasesDir: join(burnexHome(process.env, home), 'releases'),
      isGitTree: (dir) => captureLocal({ cmd: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd: dir })?.trim() === 'true',
      readPackageName: (dir) => {
        try {
          const name: unknown = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name;
          return typeof name === 'string' ? name : undefined;
        } catch {
          return undefined;
        }
      },
    },
    currentRelease: (releasesDir) => {
      try {
        return basename(readlinkSync(join(releasesDir, 'current')));
      } catch {
        return undefined;
      }
    },
    findCommand: findExecutable,
    heldProbe: heldModelDiscovery,
    processEnv: process.env,
    priceCatalog: () => {
      try {
        return loadPriceCatalog();
      } catch {
        return undefined;
      }
    },
    capture,
  };
}

// --- ответ GET /api/system ------------------------------------------------

export interface EngineView {
  readonly version: string | undefined;
  readonly root: string;
  /** Способ установки; нет — когда он не определился (см. `error`). */
  readonly method?: InstallManifest['method'];
  /** Откуда способ взят: паспорт установки или вывод по пути. */
  readonly source?: 'manifest' | 'inferred';
  readonly managed?: {
    readonly ref: string;
    readonly version: string;
    readonly installedAt?: string;
    /** Релиз, на который смотрит `current`. */
    readonly release?: string;
  };
  readonly checkoutDir?: string;
  readonly npmPackage?: string;
  /** Причина, по которой способ не определён: слова `resolveInstallMethod`. Кнопка «Обновить» неактивна. */
  readonly error?: string;
}

export interface DaemonView {
  readonly pid: number;
  readonly startedAt: string;
  readonly port: number;
  readonly projectRoot?: string;
  readonly entry: string;
  /** Запущен агентом launchd: pid совпал с pid, который launchd сообщает для метки агента. */
  readonly underLaunchd: boolean;
}

export type AutostartView = AgentState & { readonly thisDaemon?: boolean };

export type CommandState = { readonly status: 'found'; readonly path: string } | { readonly status: 'missing' };

export type ProbeView =
  | { readonly status: 'not-probed' }
  | {
      readonly status: ModelDiscoveryResult['status'];
      readonly modelCount?: number;
      readonly message?: string;
    };

export interface RefusalView {
  readonly class: 'rate_limit' | 'unauthenticated';
  readonly at: string;
  readonly project: string;
  readonly run: string;
  readonly job: string;
  readonly step: string;
  readonly statusCode?: number;
  readonly message: string;
  /** Бэкенд, названный сводкой расхода; у отказа без бэкенда поля нет. */
  readonly backend?: string;
}

export interface BackendHealth {
  readonly id: string;
  readonly command: string;
  readonly enabled: boolean;
  /** Адаптер есть в реестре: без него бэкенд назван, но не подключён. */
  readonly adapter: boolean;
  readonly commandState: CommandState;
  readonly probe: ProbeView;
  /** Последний отказ каждого класса. */
  readonly refusals: readonly RefusalView[];
}

export interface UnpricedModel {
  readonly backend: string;
  /** `null` — конфигурация модели не называет, вызов пойдёт на модели CLI по умолчанию. */
  readonly model: string | null;
  /** Ключ конфигурации, где модель названа. */
  readonly path: string | null;
}

export interface SystemView {
  readonly generatedAt: string;
  readonly engine: EngineView;
  readonly daemon: DaemonView;
  readonly autostart: AutostartView;
  readonly backends: readonly BackendHealth[];
  /** Причина, по которой состав бэкендов не прочитан (отказ сборки конфигурации). */
  readonly backendsError?: string;
  /** Отказы без бэкенда: сводка не назвала попытку, и приписывать их угаданному бэкенду нельзя. */
  readonly unattributedRefusals: readonly RefusalView[];
  readonly unpriced: { readonly asOf: string | undefined; readonly models: readonly UnpricedModel[] };
}

export interface SystemEnv {
  readonly runsRoot: string;
  readonly home: string | undefined;
  readonly kernelCache?: KernelCache | undefined;
  readonly self: DaemonSelf;
}

export function describeInstall(host: SystemHost): { manifest?: InstallManifest; source?: 'manifest' | 'inferred'; error?: string } {
  try {
    const { manifest, source } = resolveInstallMethod(host.readManifest(), host.engineRoot, host.installProbes, host.manifestPath);
    return { manifest, source };
  } catch (error) {
    if (!(error instanceof BurnexError)) throw error;
    return { error: error.hint === undefined ? error.message : `${error.message}. ${error.hint}` };
  }
}

function buildEngine(host: SystemHost): EngineView {
  const base = { version: host.engineVersion(), root: host.engineRoot };
  const { manifest, source, error } = describeInstall(host);
  if (manifest === undefined || source === undefined) return { ...base, ...(error === undefined ? {} : { error }) };

  switch (manifest.method) {
    case 'managed': {
      const release = host.currentRelease(manifest.releases_dir);
      return {
        ...base,
        method: 'managed',
        source,
        managed: {
          ref: manifest.ref,
          version: manifest.version,
          ...(manifest.installed_at === undefined ? {} : { installedAt: manifest.installed_at }),
          ...(release === undefined ? {} : { release }),
        },
      };
    }
    case 'checkout':
      return { ...base, method: 'checkout', source, checkoutDir: manifest.dir };
    case 'npm':
      return { ...base, method: 'npm', source, npmPackage: manifest.package };
  }
}

/** Разбор журнала: отказы бэкендов из 20 новейших прогонов каждого проекта. */
function collectRefusals(runsRoot: string): RefusalView[] {
  const found: RefusalView[] = [];
  for (const project of listProjects(runsRoot)) {
    for (const runId of listRunsByKey(runsRoot, project.key).slice(0, REFUSAL_RUNS_PER_PROJECT)) {
      const paths = runPaths(runsRoot, project.key, runId);
      let text: string;
      try {
        text = readFileSync(paths.events, 'utf8');
      } catch {
        continue;
      }
      // Подстрока отсекает дорогой разбор: отказ — редкая строка среди тысяч событий.
      if (!text.includes('backend.refused')) continue;

      let usage: ReturnType<typeof readUsageSoft>['summary'];
      let usageRead = false;
      for (const line of text.split('\n')) {
        if (!line.includes('backend.refused')) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = EventSchema.safeParse(raw);
        if (!parsed.success || parsed.data.kind !== 'backend.refused') continue;
        const event = parsed.data;

        if (!usageRead) {
          usage = readUsageSoft(paths).summary;
          usageRead = true;
        }
        // Событие бэкенда не называет (схема событий строгая — поле не добавить, не ослепив
        // старый движок): бэкенд берётся у попытки сводки с теми же job/step/attempt.
        const backend = usage?.jobs[event.job]?.steps[event.step]?.attempts.find((attempt) => attempt.attempt === event.attempt)?.backend;
        found.push({
          class: event.class,
          at: event.ts,
          project: project.path ?? project.key,
          run: runId,
          job: event.job,
          step: event.step,
          ...(event.status_code === undefined ? {} : { statusCode: event.status_code }),
          message: event.message,
          ...(backend === undefined ? {} : { backend }),
        });
      }
    }
  }
  return found;
}

function latestPerClass(refusals: readonly RefusalView[]): RefusalView[] {
  const latest = new Map<string, RefusalView>();
  for (const refusal of refusals) {
    const current = latest.get(refusal.class);
    if (current === undefined || Date.parse(refusal.at) > Date.parse(current.at)) latest.set(refusal.class, refusal);
  }
  return [...latest.values()];
}

function probeView(result: ModelDiscoveryResult | undefined): ProbeView {
  if (result === undefined) return { status: 'not-probed' };
  switch (result.status) {
    case 'ok':
      return { status: 'ok', modelCount: result.models.length };
    case 'failed':
    case 'probe_error':
      return { status: result.status, message: result.message };
    case 'not_installed':
      return { status: 'not_installed', message: result.command };
    default:
      return { status: result.status };
  }
}

export async function buildSystem(env: SystemEnv, host: SystemHost): Promise<SystemView> {
  const home = env.home ?? homedir();
  const { self } = env;

  const autostart = agentState(host.launchd);
  const thisDaemon = autostart.supported && autostart.loaded && autostart.pid === self.pid;

  const view = {
    generatedAt: new Date(host.now()).toISOString(),
    engine: buildEngine(host),
    daemon: {
      pid: self.pid,
      startedAt: new Date(self.startedAt).toISOString(),
      port: self.port,
      ...(self.projectRoot === undefined ? {} : { projectRoot: self.projectRoot }),
      entry: self.entry,
      underLaunchd: thisDaemon,
    },
    autostart: autostart.supported ? { ...autostart, thisDaemon } : autostart,
  };

  let settings: Awaited<ReturnType<typeof readSettings>>;
  let kernel: Awaited<ReturnType<typeof currentDaemonKernel>>;
  try {
    settings = await readSettings(home, env.kernelCache);
    kernel = await currentDaemonKernel(env.kernelCache, home);
  } catch (error) {
    return {
      ...view,
      backends: [],
      backendsError: error instanceof Error ? error.message : String(error),
      unattributedRefusals: [],
      unpriced: { asOf: undefined, models: [] },
    };
  }
  const config = kernel.resolved.config;

  const refusals = collectRefusals(env.runsRoot);
  const known = new Set(settings.backends.map((backend) => backend.name));
  const byBackend = new Map<string, RefusalView[]>();
  const unattributed: RefusalView[] = [];
  for (const refusal of refusals) {
    if (refusal.backend === undefined || !known.has(refusal.backend)) {
      unattributed.push(refusal);
      continue;
    }
    byBackend.set(refusal.backend, [...(byBackend.get(refusal.backend) ?? []), refusal]);
  }

  const backends: BackendHealth[] = settings.backends.map((backend) => {
    // PATH, который получит шаг: `backends.<id>.env` ложится поверх окружения демона.
    const stepEnv = buildStepEnv({
      base: host.processEnv,
      envFiles: [],
      pipeline: {},
      job: {},
      step: {},
      backend: config.backends[backend.name]?.env ?? {},
      injected: {},
      deny: config.envDeny,
      cwd: process.cwd(),
    }).env;
    const path = host.findCommand(backend.command, stepEnv.PATH);
    return {
      id: backend.name,
      command: backend.command,
      enabled: backend.enabled,
      adapter: backend.available,
      commandState: path === undefined ? { status: 'missing' } : { status: 'found', path },
      probe: probeView(host.heldProbe(backend.name, backend.command)),
      refusals: latestPerClass(byBackend.get(backend.name) ?? []),
    };
  });

  const catalog = host.priceCatalog();
  const models: UnpricedModel[] = [];
  for (const backend of settings.backends) {
    if (!backend.available) continue;
    let adapter;
    try {
      adapter = resolveAdapter(backend.name, config, kernel.registry);
    } catch {
      continue;
    }

    // Модели, которые конфигурация называет для бэкенда; пайплайны не перебираются —
    // это предупреждение прогона, и оно остаётся там.
    const named: Array<{ model: string; path: string }> = [];
    if (backend.defaultModel !== undefined) named.push({ model: backend.defaultModel, path: `backends.${backend.name}.default_model` });
    for (const [tier, selection] of Object.entries(backend.modelTiers)) {
      named.push({ model: selection.model, path: `backends.${backend.name}.model_tiers.${tier}` });
    }
    if (backend.name === config.defaults.agent && config.defaults.model !== undefined) {
      named.push({ model: config.defaults.model, path: 'defaults.model' });
    }

    if (named.length === 0) {
      if (isUnpricedCall(adapter, undefined, catalog)) models.push({ backend: backend.name, model: null, path: null });
      continue;
    }
    for (const { model, path } of named) {
      if (isUnpricedCall(adapter, model, catalog)) models.push({ backend: backend.name, model, path });
    }
  }

  return {
    ...view,
    backends,
    unattributedRefusals: latestPerClass(unattributed),
    unpriced: { asOf: catalog?.asOf, models },
  };
}

// --- ответ GET /api/system/update ------------------------------------------

export interface UpdateView {
  readonly checkedAt: string;
  /** Исход удержан с прошлой проверки, а не вычислен сейчас. */
  readonly held: boolean;
  /** Способ установки не определился — проверять нечем; слова `resolveInstallMethod`. */
  readonly error?: string;
  readonly check?: UpdateCheck;
}

/** Память демона об исходе проверки: на сервер, не на модуль — тесты поднимают несколько демонов. */
export interface UpdateHold {
  value: { readonly at: number; readonly view: UpdateView } | undefined;
  /** Идущая проверка: второй запрос ждёт её, а не порождает ещё один `git fetch`. */
  pending?: Promise<UpdateView> | undefined;
}

export function createUpdateHold(): UpdateHold {
  return { value: undefined };
}

/**
 * Проверка обновления тем же правилом, что и `burnex update` (`checkUpdate`).
 * Единственное место витрины, которое ходит в сеть, — по явному запросу,
 * асинхронно и с пределом `CHECK_TIMEOUT_MS` на всю проверку, а не на команду.
 */
export async function readUpdate(
  hold: UpdateHold,
  host: SystemHost,
  options: { refresh: boolean; timeoutMs?: number },
): Promise<UpdateView> {
  const now = host.now();
  if (!options.refresh && hold.value !== undefined && now - hold.value.at < UPDATE_HOLD_MS) {
    return { ...hold.value.view, held: true };
  }
  if (hold.pending !== undefined) return hold.pending;

  const { manifest, error } = describeInstall(host);
  const checkedAt = new Date(now).toISOString();
  if (manifest === undefined) return { checkedAt, held: false, ...(error === undefined ? {} : { error }) };

  const engineVersion = host.engineVersion();
  const pending = checkUpdate(manifest, host, {
    ...(engineVersion === undefined ? {} : { engineVersion }),
    timeoutMs: options.timeoutMs ?? CHECK_TIMEOUT_MS,
    now: host.now,
  }).then((check) => {
    const view: UpdateView = { checkedAt, held: false, check };
    hold.value = { at: now, view };
    return view;
  });
  hold.pending = pending;
  try {
    return await pending;
  } finally {
    hold.pending = undefined;
  }
}
