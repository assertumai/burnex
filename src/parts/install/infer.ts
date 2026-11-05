import { relative, isAbsolute, sep } from 'node:path';

import { BurnexError } from '../../kernel/errors.js';
import { PACKAGE_NAME } from '../../kernel/package-name.js';
import { parseInstallManifest, type InstallManifest } from './manifest.js';

/**
 * Способ установки без паспорта выводится из места, где лежит движок. Проверки
 * диска внедряются: тест не должен зависеть от того, где стоит чекаут.
 */
export interface InferProbes {
  /** Лежит ли каталог внутри git-дерева. */
  readonly isGitTree: (dir: string) => boolean;
  /** `name` из `package.json` корня; `undefined`, если прочесть нельзя. */
  readonly readPackageName: (dir: string) => string | undefined;
  /** Каталог релизов `install.sh`: `$BURNEX_HOME/releases` или `~/.burnex/releases`. */
  readonly releasesDir: string;
}

/** Внутри ли `path` каталога `dir` (сам `dir` не считается). Чистое сравнение путей. */
export function isInsideDir(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function noManifestError(root: string): BurnexError {
  return new BurnexError(`Не удалось определить, как поставлен stepcast (${root}): паспорта установки нет`, {
    hint: 'Поставьте движок через install.sh (curl -fsSL …/scripts/install.sh | bash) или заведите install.json вручную',
  });
}

/**
 * Вывод способа по корню движка. Каталог релизов проверяется раньше git:
 * `~/.burnex` вполне может оказаться внутри чьего-то git-дерева, а релиз без
 * паспорта обновлять нечем — источник утерян.
 */
export function inferInstallMethod(root: string, probes: InferProbes): InstallManifest {
  if (root.split(sep).includes('node_modules')) {
    return { method: 'npm', package: probes.readPackageName(root) ?? PACKAGE_NAME };
  }
  if (isInsideDir(probes.releasesDir, root)) throw noManifestError(root);
  if (probes.isGitTree(root)) return { method: 'checkout', dir: root };
  throw noManifestError(root);
}

export interface ResolvedInstall {
  readonly manifest: InstallManifest;
  /** Откуда взят способ — печатается, чтобы человек видел, что сейчас будет. */
  readonly source: 'manifest' | 'inferred';
}

/** Паспорт, если он есть; иначе вывод по пути. Битый паспорт — отказ, а не молчаливый вывод. */
export function resolveInstallMethod(
  manifestText: string | undefined,
  root: string,
  probes: InferProbes,
  manifestFile?: string,
): ResolvedInstall {
  if (manifestText !== undefined) {
    return { manifest: parseInstallManifest(manifestText, manifestFile), source: 'manifest' };
  }
  return { manifest: inferInstallMethod(root, probes), source: 'inferred' };
}
