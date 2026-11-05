import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { commandRow } from '../../../kernel/cli/commandRow.js';
import type { CliIo, ParsedArgs } from '../../../kernel/cli/args.js';
import { formatColumns } from '../../../kernel/cli/output.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../../kernel/errors.js';
import type { PipelineCommandEnv } from '../../pipeline/contract.js';
import { findProjectRoot } from '../../pipeline/run/journal/paths.js';
import { buildPackageIndex, homePackagesDir, projectPackagesDir } from '../index.js';
import { PACKAGE_MANIFEST_FILE, checkPackageName } from '../manifest.js';
import { summarizePackages, type NeedsContext, type PackageSummary } from '../summary.js';
import { homeRoot } from '../../../kernel/dirs.js';

/**
 * `burnex package list|new` (`packages-directory-layer`, design.md, Решение 9).
 *
 * Строка команды ядерная, без `inject`: она обязана работать, когда пакет или
 * плагин сломал состав, — `list` для того и нужен, чтобы увидеть, какой пакет
 * сломан. Поэтому диспетчер (`src/parts/cli/main.ts`) пускает её и после отказа
 * загрузки, как `plugins`, а реестр она читает, только если он есть.
 */

const ACTIONS = ['list', 'new'] as const;

export interface PackageCommandOptions {
  readonly cwd: string;
  /** Каталог глобального конфига: пакеты home лежат рядом. По умолчанию `~/.burnex`. */
  readonly globalConfigDir?: string;
  /** Имена зарегистрированных бэкендов, если состав собран; без них `needs.backends` не сверяется. */
  readonly backends?: ReadonlySet<string>;
}

const LAYER_TITLE = { project: 'проект', home: 'home' } as const;

function statusText(summary: PackageSummary): string {
  switch (summary.status) {
    case 'ok':
      return 'действует';
    case 'broken':
      return `сломан: ${summary.reason ?? 'причина не названа'}`;
    case 'shadowed':
      return `затенён пакетом ${summary.shadowedBy === 'project' ? 'проекта' : 'home'}`;
  }
}

/** Незакрытые `needs` строкой: `packages: tools; mcp: github (не проверяется)`. */
function needsText(summary: PackageSummary): string | undefined {
  if (summary.unmetNeeds === undefined) return undefined;
  const parts: string[] = [];
  const { packages, backends, mcp, secrets } = summary.unmetNeeds;
  if (packages !== undefined) parts.push(`packages: ${packages.join(', ')} (не найдены)`);
  if (backends !== undefined) parts.push(`backends: ${backends.join(', ')} (не зарегистрированы)`);
  if (mcp !== undefined) parts.push(`mcp: ${mcp.join(', ')} (объявлены, не проверяются)`);
  if (secrets !== undefined) parts.push(`secrets: ${secrets.join(', ')} (объявлены, не проверяются)`);
  return parts.join('; ');
}

function runList(args: ParsedArgs, io: CliIo, options: PackageCommandOptions): ExitCodeValue {
  const globalConfigDir = options.globalConfigDir ?? homeRoot(homedir());
  const index = buildPackageIndex({
    projectRoot: findProjectRoot(options.cwd),
    globalPath: join(globalConfigDir, 'config.yml'),
  });
  const context: NeedsContext = options.backends === undefined ? {} : { backends: options.backends };
  const summaries = summarizePackages(index, context);

  if (args.flags.json === true) {
    io.out(JSON.stringify({ packages: summaries }, null, 2));
    return ExitCode.ok;
  }
  if (summaries.length === 0) {
    io.out('пакетов нет');
    return ExitCode.ok;
  }

  // Причина поломки и затенение идут последней колонкой строки: она длинная и
  // ломает выравнивание только у себя.
  const columns = formatColumns(
    summaries.map((summary) => [
      summary.name,
      LAYER_TITLE[summary.layer],
      summary.version ?? '-',
      summary.dir,
      summary.provides.length === 0 ? '-' : summary.provides.join(','),
      statusText(summary),
    ]),
  );
  summaries.forEach((summary, position) => {
    io.out(columns[position] ?? '');
    const needs = needsText(summary);
    if (needs !== undefined) io.out(`    нужно: ${needs}`);
  });
  return ExitCode.ok;
}

function manifestTemplate(name: string): string {
  return `version: 1
kind: package
name: ${name}
description: Пакет ${name} — опишите, что он приносит
package_version: 0.1.0
`;
}

/**
 * Пустые подкаталоги не создаются: пустой каталог в git не живёт, а раскладка
 * описана в `docs/packages.md`.
 */
function runNew(args: ParsedArgs, io: CliIo, options: PackageCommandOptions): ExitCodeValue {
  const name = args.positional[1];
  if (name === undefined) {
    throw new StepcastError('Не назван пакет: burnex package new <имя> [--home]', { exitCode: ExitCode.configError });
  }
  const problem = checkPackageName(name);
  if (problem !== undefined) {
    throw new StepcastError(problem, {
      exitCode: ExitCode.configError,
      hint: 'Имя пакета — kebab-slug; stepcast и builtin зарезервированы',
    });
  }

  const home = args.flags.home === true;
  const globalConfigDir = options.globalConfigDir ?? homeRoot(homedir());
  const packagesDir = home
    ? homePackagesDir(join(globalConfigDir, 'config.yml'))
    : projectPackagesDir(findProjectRoot(options.cwd));
  const dir = join(packagesDir, name);
  if (existsSync(dir)) {
    throw new StepcastError(`Каталог пакета ${dir} уже существует`, {
      exitCode: ExitCode.configError,
      file: dir,
      hint: 'Существующий пакет не перезаписывается — выберите другое имя или уберите каталог руками',
    });
  }

  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, PACKAGE_MANIFEST_FILE);
  writeFileSync(manifest, manifestTemplate(name));
  io.out(`создан ${manifest}`);
  return ExitCode.ok;
}

export function runPackageCommand(args: ParsedArgs, io: CliIo, options: PackageCommandOptions): ExitCodeValue {
  const action = args.positional[0];
  if (action === 'list') return runList(args, io, options);
  if (action === 'new') return runNew(args, io, options);
  throw new StepcastError(
    action === undefined ? 'Не указано действие: burnex package list|new' : `Неизвестное действие пакета: ${action}`,
    { exitCode: ExitCode.configError, hint: `Действия: ${ACTIONS.join(', ')}` },
  );
}

export const PACKAGE_COMMAND_SPEC = {
  description: 'пакеты пользователя: list — перечень со статусом, new <имя> — заготовка пакета, см. docs/packages.md',
  positional: ['action', 'name'],
  flags: {
    json: { kind: 'boolean', description: 'list: печатать перечень машинным JSON' },
    home: { kind: 'boolean', description: 'new: завести пакет в слое home, а не проекта' },
  },
} as const;

export const row = commandRow<PipelineCommandEnv>({
  name: 'package',
  spec: PACKAGE_COMMAND_SPEC,
  run: (args, io, env) =>
    runPackageCommand(args, io, {
      cwd: env.cwd,
      globalConfigDir: env.config.globalConfigDir,
      backends: new Set(env.registry.backends.keys()),
    }),
});
