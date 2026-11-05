import { dirname, join } from 'node:path';

import { withLegacyNames } from '../../kernel/env-names.js';
import type { InstallManifest } from './manifest.js';

/** Одна команда плана; исполнитель внедряется, вывод идёт в терминал как есть. */
export interface UpdateStep {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export type UpdatePlan =
  | { readonly kind: 'up-to-date'; readonly version: string }
  | { readonly kind: 'refuse'; readonly reason: string; readonly hint?: string }
  | { readonly kind: 'run'; readonly steps: readonly UpdateStep[] };

export interface UpdateInputs {
  /** Значение `--ref`: для `npm` версия или dist-tag. */
  readonly ref?: string;
  /** Последний строгий тег репозитория (`pickLatestTag`); нужен только `managed`. */
  readonly latestTag?: string | undefined;
  /** Непусто ли `git status --porcelain`; нужен только `checkout`. */
  readonly dirty?: boolean;
  /** Отцеплен ли HEAD чекаута (после `--ref` тегом или sha); нужен только `checkout`. */
  readonly detached?: boolean;
}

const STRICT_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Последний тег из вывода `git ls-remote --tags --refs`: только строгие
 * `vX.Y.Z`, сравнение по числам (`v0.10.0` старше `v0.9.0`, пре-релизы
 * пропускаются, если их не назвали `--ref` явно).
 */
export function pickLatestTag(lsRemoteOutput: string): string | undefined {
  let best: { tag: string; parts: readonly number[] } | undefined;
  for (const line of lsRemoteOutput.split('\n')) {
    const name = line.trim().split(/\s+/)[1]?.replace(/^refs\/tags\//, '');
    const match = name === undefined ? null : STRICT_TAG.exec(name);
    if (name === undefined || match === null) continue;

    const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (best === undefined || compare(parts, best.parts) > 0) best = { tag: name, parts };
  }
  return best?.tag;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Знак разности версий semver: `> 0` — `a` новее. Пререлиз младше своего
 * выпуска, пререлизы между собой — по частям (semver.org, п. 11).
 * `undefined` — хоть одна строка не semver: сравнивать не по чему.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const ma = SEMVER.exec(a.trim());
  const mb = SEMVER.exec(b.trim());
  if (ma === null || mb === null) return undefined;
  const core = compare([Number(ma[1]), Number(ma[2]), Number(ma[3])], [Number(mb[1]), Number(mb[2]), Number(mb[3])]);
  if (core !== 0) return core;
  const pa = ma[4];
  const pb = mb[4];
  if (pa === undefined || pb === undefined) return pa === pb ? 0 : pa === undefined ? 1 : -1;
  const xa = pa.split('.');
  const xb = pb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i += 1) {
    const ia = xa[i];
    const ib = xb[i];
    if (ia === undefined || ib === undefined) return ia === undefined ? -1 : 1;
    if (ia === ib) continue;
    const na = /^\d+$/.test(ia);
    const nb = /^\d+$/.test(ib);
    if (na && nb) return Number(ia) - Number(ib);
    if (na !== nb) return na ? -1 : 1;
    return ia < ib ? -1 : 1;
  }
  return 0;
}

/** Чистый план обновления: ни диска, ни сети, ни процессов. */
export function planUpdate(method: InstallManifest, inputs: UpdateInputs): UpdatePlan {
  switch (method.method) {
    case 'managed': {
      const target = inputs.ref ?? inputs.latestTag;
      if (target === undefined) {
        return {
          kind: 'refuse',
          reason: `В ${method.repo} нет тегов vX.Y.Z, обновляться не до чего`,
          hint: 'Назовите ссылку явно: burnex update --ref main',
        };
      }
      // «Уже стоит» — только если стоит ровно этот тег: `version` у сборки ветки или sha
      // берётся из package.json и совпала бы с тегом, хотя код другой.
      if (STRICT_TAG.test(method.ref) && method.ref === target) return { kind: 'up-to-date', version: method.version };

      // install.sh берётся из `current` по паспорту, а не из корня запущенного движка:
      // `update` можно позвать и из чекаута, где скрипт лежит в scripts/.
      const release = join(method.releases_dir, 'current');
      return {
        kind: 'run',
        steps: [
          {
            cmd: 'bash',
            args: [join(release, 'install.sh'), '--repo', method.repo, '--ref', target],
            cwd: release,
            // install.sh берёт каталоги от BURNEX_HOME и BURNEX_BIN_DIR: установка могла
            // идти не в умолчаниях, и без них обновление поставило бы второй лаунчер.
            // Под прежними именами тоже: install.sh текущего релиза может быть
            // старше переименования и знать только их.
            env: withLegacyNames({
              BURNEX_HOME: dirname(method.releases_dir),
              ...(method.bin_dir === undefined ? {} : { BURNEX_BIN_DIR: method.bin_dir }),
            }),
          },
        ],
      };
    }
    case 'checkout': {
      if (inputs.dirty === true) {
        return {
          kind: 'refuse',
          reason: `В ${method.dir} есть незакоммиченные правки`,
          hint: 'Закоммитьте или отложите их: git pull поверх них упадёт посреди обновления',
        };
      }
      if (inputs.ref === undefined && inputs.detached === true) {
        return {
          kind: 'refuse',
          reason: `HEAD в ${method.dir} отцеплен (прежний --ref тегом или sha): git pull тянуть некуда`,
          hint: 'Назовите ссылку явно: burnex update --ref <ветка или тег>',
        };
      }
      const cwd = method.dir;
      const fetch: UpdateStep[] =
        inputs.ref === undefined
          ? [{ cmd: 'git', args: ['pull', '--ff-only'], cwd }]
          : [
              { cmd: 'git', args: ['fetch', '--tags'], cwd },
              { cmd: 'git', args: ['checkout', inputs.ref], cwd },
              // Существующая локальная ветка после checkout стоит на старом коммите: её
              // догоняет pull. Тег и sha отцепляют HEAD — тянуть там нечего.
              {
                cmd: 'sh',
                args: ['-c', 'if git symbolic-ref -q HEAD >/dev/null; then git pull --ff-only; fi'],
                cwd,
              },
            ];
      return {
        kind: 'run',
        steps: [...fetch, { cmd: 'npm', args: ['ci'], cwd }, { cmd: 'npm', args: ['run', 'build'], cwd }],
      };
    }
    case 'npm':
      return {
        kind: 'run',
        steps: [{ cmd: 'npm', args: ['install', '-g', `${method.package}@${inputs.ref ?? 'latest'}`] }],
      };
  }
}

/**
 * Предел времени всей проверки с экрана: экран ждёт ответа, а `git fetch` без
 * сети висит минутами. Делится между командами проверки, а не даётся каждой:
 * у `checkout` их четыре подряд.
 */
export const CHECK_TIMEOUT_MS = 20_000;

/**
 * Единственное, что проверке нужно от хозяина: выполнить команду и забрать stdout.
 * Ответ может быть обещанием: демон не вправе стоять на `spawnSync`, пока идёт сеть.
 */
export interface UpdateProbeHost {
  /** `undefined` — команда не удалась или не уложилась в `timeoutMs`. */
  readonly capture: (step: UpdateStep, timeoutMs?: number) => string | undefined | Promise<string | undefined>;
}

export interface UpdateCheckOptions {
  /** Значение `--ref`: проверять не «есть ли новее», а «стоит ли именно это». */
  readonly ref?: string;
  /**
   * Ходить ли за новостями (`git fetch`, `npm view`). `false` — только то, что
   * решает команда `update` до плана: тег для `managed`, чистота дерева для
   * `checkout`; для `checkout` и `npm` исход тогда `available` без сравнения.
   */
  readonly remote?: boolean;
  /** Версия запущенного движка; без неё `npm` не с чем сравнивать. */
  readonly engineVersion?: string;
  /**
   * Предел времени всей проверки; без него команды ждут сколько нужно — так
   * ведёт себя `burnex update` в терминале, где прервать может сам человек.
   */
  readonly timeoutMs?: number;
  /** Часы для предела; тесты подставляют свои. */
  readonly now?: () => number;
}

export type UpdateCheck =
  | { readonly status: 'available'; readonly current: string; readonly latest?: string; readonly commits?: number }
  | { readonly status: 'up-to-date'; readonly version: string }
  | { readonly status: 'blocked'; readonly reason: string; readonly hint?: string }
  | { readonly status: 'no-tags'; readonly reason: string; readonly hint?: string }
  | { readonly status: 'unknown'; readonly reason: string; readonly hint?: string };

/**
 * Есть ли что обновлять. Решение «уже стоит» и отказы грязного дерева и
 * отцеплённого HEAD берутся из `planUpdate` — экран и команда `update` не могут
 * разойтись, потому что решает одна функция.
 */
export async function checkUpdate(
  manifest: InstallManifest,
  host: UpdateProbeHost,
  options: UpdateCheckOptions = {},
): Promise<UpdateCheck> {
  const { ref, remote = true, engineVersion, timeoutMs, now = Date.now } = options;
  const deadline = timeoutMs === undefined ? undefined : now() + timeoutMs;
  const capture = async (step: UpdateStep): Promise<string | undefined> => {
    if (deadline === undefined) return host.capture(step);
    // Исчерпанный предел — та же неудача команды: следующая не запускается вовсе.
    const left = deadline - now();
    return left > 0 ? host.capture(step, left) : undefined;
  };
  const withRef = ref === undefined ? {} : { ref };

  switch (manifest.method) {
    case 'managed': {
      let latestTag: string | undefined;
      if (ref === undefined) {
        const listed = await capture({ cmd: 'git', args: ['ls-remote', '--tags', '--refs', manifest.repo, 'v*'] });
        if (listed === undefined) {
          return {
            status: 'unknown',
            reason: `Не удалось получить список тегов ${manifest.repo}`,
            hint: 'Проверьте сеть и доступ к репозиторию либо назовите ссылку явно: burnex update --ref <ссылка>',
          };
        }
        latestTag = pickLatestTag(listed);
      }
      const plan = planUpdate(manifest, { ...withRef, latestTag });
      if (plan.kind === 'up-to-date') return { status: 'up-to-date', version: plan.version };
      if (plan.kind === 'refuse') {
        return { status: 'no-tags', reason: plan.reason, ...(plan.hint === undefined ? {} : { hint: plan.hint }) };
      }
      return { status: 'available', current: manifest.ref, latest: ref ?? latestTag! };
    }
    case 'checkout': {
      const status = await capture({ cmd: 'git', args: ['status', '--porcelain'], cwd: manifest.dir });
      if (status === undefined) {
        return {
          status: 'unknown',
          reason: `git status в ${manifest.dir} не удался`,
          hint: 'Каталог из паспорта должен быть git-деревом',
        };
      }
      // Без --ref тянуть можно только ветку: отцеплённый HEAD план отвергнет с подсказкой.
      const detached =
        ref === undefined && (await capture({ cmd: 'git', args: ['symbolic-ref', '-q', 'HEAD'], cwd: manifest.dir })) === undefined;
      const plan = planUpdate(manifest, { ...withRef, dirty: status.trim() !== '', detached });
      if (plan.kind === 'refuse') {
        return { status: 'blocked', reason: plan.reason, ...(plan.hint === undefined ? {} : { hint: plan.hint }) };
      }
      const current = engineVersion ?? manifest.dir;
      if (!remote || ref !== undefined) return { status: 'available', current };

      // `fetch` не меняет рабочее дерево; без него `@{u}` сравнивался бы с вчерашним состоянием.
      if ((await capture({ cmd: 'git', args: ['fetch'], cwd: manifest.dir })) === undefined) {
        return {
          status: 'unknown',
          reason: `git fetch в ${manifest.dir} не удался`,
          hint: 'Проверьте сеть и доступ к удалённому репозиторию',
        };
      }
      const behind = await capture({ cmd: 'git', args: ['rev-list', '--count', 'HEAD..@{u}'], cwd: manifest.dir });
      const commits = behind === undefined ? Number.NaN : Number.parseInt(behind.trim(), 10);
      if (!Number.isInteger(commits)) {
        return {
          status: 'unknown',
          reason: `У текущей ветки в ${manifest.dir} нет вышестоящей: сравнивать не с чем`,
          hint: 'git branch --set-upstream-to=origin/<ветка>',
        };
      }
      return commits === 0 ? { status: 'up-to-date', version: current } : { status: 'available', current, commits };
    }
    case 'npm': {
      if (!remote || engineVersion === undefined) return { status: 'available', current: engineVersion ?? manifest.package };
      const viewed = await capture({ cmd: 'npm', args: ['view', ref === undefined ? manifest.package : `${manifest.package}@${ref}`, 'version'] });
      const latest = viewed?.trim();
      if (latest === undefined || latest === '') {
        return { status: 'unknown', reason: `npm view ${manifest.package} не ответил`, hint: 'Проверьте сеть и реестр npm' };
      }
      // С `--ref` человек называет, что поставить, — любое отличие и есть обновление. Без него
      // установленная версия новее `latest` (пререлиз, локальная сборка) — не повод предлагать
      // откат; несравнимые строки остаются прежним правилом «отличается — доступно».
      const ahead = ref === undefined ? compareVersions(engineVersion, latest) : undefined;
      return latest === engineVersion || (ahead !== undefined && ahead >= 0)
        ? { status: 'up-to-date', version: engineVersion }
        : { status: 'available', current: engineVersion, latest };
    }
  }
}
