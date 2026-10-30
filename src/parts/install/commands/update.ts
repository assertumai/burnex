import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { commandRow } from '../../../kernel/cli/commandRow.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../../kernel/errors.js';
import { enginePackageRoot } from '../../pipeline/document/packagePaths.js';
import { resolveInstallMethod, type InferProbes } from '../infer.js';
import { installManifestPath, stepcastHome, type InstallManifest } from '../manifest.js';
import { pickLatestTag, planUpdate, type UpdateStep } from '../plan.js';
import { restartDaemon, systemRestartHost, type RestartHost } from '../restart.js';

/** Всё, что касается системы, внедряется: тест не запускает ни git, ни npm, ни install.sh. */
export interface UpdateHost {
  readonly engineRoot: string;
  readonly manifestPath: string;
  readonly probes: InferProbes;
  readonly readManifest: () => string | undefined;
  /** Выполнить команду с выводом в терминал; возвращает код возврата. */
  readonly exec: (step: UpdateStep) => number;
  /** Выполнить команду и вернуть stdout (`git status`, `git ls-remote`); `undefined` — команда не удалась. */
  readonly capture: (step: UpdateStep) => string | undefined;
  readonly restart: RestartHost;
}

function stepLine(step: UpdateStep): string {
  return [step.cmd, ...step.args].join(' ') + (step.cwd === undefined ? '' : `   (в ${step.cwd})`);
}

/** Куда `up` нового кода входит после обновления. */
function newEntry(manifest: InstallManifest, engineRoot: string): string {
  if (manifest.method === 'managed') return join(manifest.releases_dir, 'current', 'dist', 'src', 'bin.js');
  return join(manifest.method === 'checkout' ? manifest.dir : engineRoot, 'dist', 'src', 'bin.js');
}

/**
 * `stepcast update` — обновить движок тем способом, каким он поставлен.
 *
 * Демон трогается только после успешного обновления: упавшая посреди сборка
 * не должна дополнительно оставлять человека без витрины.
 */
export async function runUpdateCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  host: UpdateHost,
): Promise<ExitCodeValue> {
  const ref = typeof args.flags.ref === 'string' ? args.flags.ref : undefined;
  const noRestart = args.flags['no-restart'] === true;

  const { manifest, source } = resolveInstallMethod(host.readManifest(), host.engineRoot, host.probes, host.manifestPath);
  write(
    source === 'manifest'
      ? `способ установки: ${manifest.method} (паспорт ${host.manifestPath})`
      : `способ установки: ${manifest.method} (выведен из пути ${host.engineRoot}, паспорта нет)`,
  );

  let latestTag: string | undefined;
  if (manifest.method === 'managed' && ref === undefined) {
    const listed = host.capture({ cmd: 'git', args: ['ls-remote', '--tags', '--refs', manifest.repo, 'v*'] });
    if (listed === undefined) {
      throw new StepcastError(`Не удалось получить список тегов ${manifest.repo}`, {
        exitCode: ExitCode.jobFailed,
        hint: 'Проверьте сеть и доступ к репозиторию либо назовите ссылку явно: stepcast update --ref <ссылка>',
      });
    }
    latestTag = pickLatestTag(listed);
  }

  let dirty = false;
  let detached = false;
  if (manifest.method === 'checkout') {
    const status = host.capture({ cmd: 'git', args: ['status', '--porcelain'], cwd: manifest.dir });
    if (status === undefined) {
      throw new StepcastError(`git status в ${manifest.dir} не удался`, {
        exitCode: ExitCode.jobFailed,
        hint: 'Каталог из паспорта должен быть git-деревом',
      });
    }
    dirty = status.trim() !== '';
    // Без --ref тянуть можно только ветку: отцеплённый HEAD план отвергнет с подсказкой.
    detached = ref === undefined && host.capture({ cmd: 'git', args: ['symbolic-ref', '-q', 'HEAD'], cwd: manifest.dir }) === undefined;
  }

  const plan = planUpdate(manifest, {
    ...(ref === undefined ? {} : { ref }),
    latestTag,
    dirty,
    detached,
  });

  if (plan.kind === 'up-to-date') {
    write(`уже установлена версия ${plan.version}, обновлять нечего`);
    return ExitCode.ok;
  }
  if (plan.kind === 'refuse') {
    throw new StepcastError(plan.reason, { exitCode: ExitCode.jobFailed, ...(plan.hint === undefined ? {} : { hint: plan.hint }) });
  }

  for (const step of plan.steps) {
    write(`$ ${stepLine(step)}`);
    const status = host.exec(step);
    if (status !== 0) {
      // Демон остаётся как был: обновление не закончено.
      write(`команда завершилась с кодом ${status}, обновление прервано, витрина не тронута`);
      return ExitCode.jobFailed;
    }
  }
  write('движок обновлён');

  await restartDaemon(
    host.restart,
    { newEntry: newEntry(manifest, host.engineRoot), stableEntry: manifest.method === 'managed', noRestart, updateOk: true },
    write,
  );
  return ExitCode.ok;
}

function systemUpdateHost(): UpdateHost {
  const home = homedir();
  const root = enginePackageRoot();
  const releasesDir = join(stepcastHome(process.env, home), 'releases');
  const manifestPath = installManifestPath(process.env, home);

  const capture = (step: UpdateStep): string | undefined => {
    const result = spawnSync(step.cmd, [...step.args], { cwd: step.cwd, encoding: 'utf8' });
    return result.status === 0 ? result.stdout : undefined;
  };

  return {
    engineRoot: root,
    manifestPath,
    probes: {
      releasesDir,
      isGitTree: (dir) => capture({ cmd: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd: dir })?.trim() === 'true',
      readPackageName: (dir) => {
        try {
          const name: unknown = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name;
          return typeof name === 'string' ? name : undefined;
        } catch {
          return undefined;
        }
      },
    },
    readManifest: () => (existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : undefined),
    exec: (step) =>
      spawnSync(step.cmd, [...step.args], {
        cwd: step.cwd,
        stdio: 'inherit',
        env: { ...process.env, ...step.env },
      }).status ?? 1,
    capture,
    restart: systemRestartHost(),
  };
}

/**
 * Независима от конфигурации (design.md этого изменения, Решение 6; design.md
 * `cli-commands-as-rows`, Решение 4): обновление движка — частый способ
 * починить сломанную конфигурацию, поэтому строка не читает ни её, ни реестра
 * вкладов.
 */
export const row = commandRow(
  {
    name: 'update',
    spec: {
      description: 'обновить движок тем способом, каким он поставлен (managed, checkout, npm)',
      flags: {
        ref: {
          kind: 'string',
          description: 'ссылка вместо последнего тега; для npm — версия или dist-tag',
        },
        'no-restart': {
          kind: 'boolean',
          description: 'не перезапускать демон витрины после обновления',
        },
      },
    },
    run: (args, io) => runUpdateCommand(args, io.out, systemUpdateHost()),
  },
  { independent: true },
);
