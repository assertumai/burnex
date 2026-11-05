import { join } from 'node:path';

import {
  buildPackageIndex,
  describeBrokenPackages,
  lookupInPackages,
  resourceLayers,
  type PackageIndex,
  type ResourceKind,
} from '../../packages/index.js';
import type { ScriptRoots } from './expand.js';
import { homeRoot } from '../../../kernel/dirs.js';

/**
 * Слои разрешения имени для шагов `uses` и скриптов `script`
 * (`packages-directory-layer`, design.md, Решения 1, 4): свободный проект →
 * пакеты проекта → свободный home → пакеты home → встроенное. Порядок и
 * правило конфликта живут в указателе пакетов; здесь они лишь применяются к
 * `ScriptRoots`, которым пользуются оба обхода.
 */

export interface LayerHit {
  readonly layer: 'project' | 'home' | 'builtin';
  /** Пакет, давший находку; у свободного и встроенного слоя нет. */
  readonly package?: string;
  readonly path: string;
}

export type LayerSearch =
  | { readonly hit: LayerHit }
  /** Два пакета одного слоя приносят имя: отказ, который не проваливается в нижний слой. */
  | { readonly conflict: readonly [string, string] }
  | { readonly searched: readonly string[]; readonly broken: readonly string[] };

/**
 * Указатель, построенный от корней вызова. Пакеты home лежат рядом с глобальным
 * конфигом `<home>/.burnex/`, как и свободные ресурсы того же корня: тест с
 * подставным `home` получает пустой слой пакетов, а не пакеты машины.
 */
export function packageIndexFor(roots: ScriptRoots): PackageIndex {
  return (
    roots.packages ??
    buildPackageIndex({ projectRoot: roots.project, globalPath: join(homeRoot(roots.home), 'config.yml') })
  );
}

/**
 * Найти ресурс по имени. `exists` получает кандидата — `<каталог слоя>/<имя>` —
 * и решает, находка ли это: для шага — каталог с `step.yml`, для скрипта —
 * файл. Слой, где совпало несколько пакетов, отказывает сразу, не уступая
 * нижнему слою (молчаливая подмена хуже явной ошибки).
 */
export function findInLayers(
  kind: Extract<ResourceKind, 'steps' | 'scripts'>,
  name: string,
  roots: ScriptRoots,
  exists: (candidate: string) => boolean,
): LayerSearch {
  const index = packageIndexFor(roots);
  const layers = resourceLayers(index, kind, { projectRoot: roots.project, homeBurnexDir: homeRoot(roots.home) });
  const searched: string[] = [];
  // Промах шага перечисляет каталоги кандидатов (`<слой>/steps/<имя>`), промах
  // скрипта — каталоги слоёв: так перечни выглядели до пакетов, и на них
  // держатся тексты отказов.
  const listed = (dir: string, candidate: string): string => (kind === 'steps' ? candidate : dir);

  for (const layer of layers) {
    switch (layer.source) {
      case 'project':
      case 'home': {
        const candidate = join(layer.path, name);
        searched.push(listed(layer.path, candidate));
        if (exists(candidate)) return { hit: { layer: layer.source, path: candidate } };
        break;
      }
      case 'builtin': {
        const candidate = join(roots.builtin, name);
        searched.push(listed(roots.builtin, candidate));
        if (exists(candidate)) return { hit: { layer: 'builtin', path: candidate } };
        break;
      }
      case 'project-packages':
      case 'home-packages': {
        for (const entry of layer.packages) searched.push(listed(entry.path, join(entry.path, name)));
        const found = lookupInPackages(layer.packages, (dir) => {
          const candidate = join(dir, name);
          return exists(candidate) ? candidate : undefined;
        });
        if (found.kind === 'conflict') return { conflict: found.packages };
        if (found.kind === 'found') {
          return {
            hit: { layer: layer.source === 'project-packages' ? 'project' : 'home', package: found.package, path: found.path },
          };
        }
        break;
      }
    }
  }
  return { searched, broken: describeBrokenPackages(index) };
}
