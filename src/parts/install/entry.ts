import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { isInsideDir } from './infer.js';
import { parseInstallManifest, type InstallManifest } from './manifest.js';

/**
 * Путь входа демона витрины.
 *
 * Node разрешает симлинки главного модуля, поэтому `binPath()` указывает в
 * конкретный релиз (`releases/<v>/…`), а не в `current`: агент launchd,
 * запомнивший такой путь, после `kickstart -k` поднял бы прежнюю версию. При
 * `managed`-установке путь строится через `current` — тогда переключение
 * ссылки и есть обновление.
 */

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export interface DaemonEntryInput {
  /** Корень исполняемого движка (`enginePackageRoot()`). */
  readonly engineRoot: string;
  readonly manifest: InstallManifest | undefined;
  /** Прежний путь (`binPath()`), если устойчивый не применим. */
  readonly fallback: string;
  /** Внедряется ради теста; по умолчанию `realpath` с откатом на нормализацию. */
  readonly realpath?: (path: string) => string;
}

export function daemonEntryPath(input: DaemonEntryInput): string {
  const { manifest } = input;
  if (manifest === undefined || manifest.method !== 'managed') return input.fallback;

  const realpath = input.realpath ?? real;
  if (!isInsideDir(realpath(manifest.releases_dir), realpath(input.engineRoot))) return input.fallback;
  return join(manifest.releases_dir, 'current', 'dist', 'src', 'bin.js');
}

/**
 * Паспорт для выбора пути входа. Отсутствующий или битый паспорт даёт
 * `undefined`: `up` не должен ломаться из-за паспорта, он нужен только `update`.
 */
export function readManifestQuietly(path: string): InstallManifest | undefined {
  try {
    return parseInstallManifest(readFileSync(path, 'utf8'), path);
  } catch {
    return undefined;
  }
}
