import { dirname, join } from 'node:path';

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

/** Чистый план обновления: ни диска, ни сети, ни процессов. */
export function planUpdate(method: InstallManifest, inputs: UpdateInputs): UpdatePlan {
  switch (method.method) {
    case 'managed': {
      const target = inputs.ref ?? inputs.latestTag;
      if (target === undefined) {
        return {
          kind: 'refuse',
          reason: `В ${method.repo} нет тегов vX.Y.Z, обновляться не до чего`,
          hint: 'Назовите ссылку явно: stepcast update --ref main',
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
            // install.sh берёт каталоги от STEPCAST_HOME и STEPCAST_BIN_DIR: установка могла
            // идти не в умолчаниях, и без них обновление поставило бы второй лаунчер.
            env: {
              STEPCAST_HOME: dirname(method.releases_dir),
              ...(method.bin_dir === undefined ? {} : { STEPCAST_BIN_DIR: method.bin_dir }),
            },
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
          hint: 'Назовите ссылку явно: stepcast update --ref <ветка или тег>',
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
