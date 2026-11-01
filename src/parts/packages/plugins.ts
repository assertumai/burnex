import { join } from 'node:path';

import { listPluginDirNames, reservedNameFailure } from '../../kernel/tree/discover.js';
import { directoryOperations, type TreeOperation, type TreeRowFailure } from '../../kernel/tree/tree.js';
import { activePackages, type PackageIndex, type PackageLayer } from './index.js';

/**
 * Каталожные плагины пакетов слоя как операции дерева (`packages-directory-layer`,
 * design.md, Решения 4, 6). Ядро дерева пакетов не знает: оно получает обычные
 * операции с источником `{ layer, package }`, а конфликт слоя приходит одной
 * операцией с заведомым отказом.
 */

interface PackagePlugin {
  readonly id: string;
  readonly dir: string;
  readonly package: string;
}

/**
 * Заведомый отказ конфликта двух пакетов: явный признак `conflict` отличает его
 * от отказа имени встроенной строки не по тексту (`ui-packages-screen`, Решение 3).
 * Ядро несёт объект отказа в строку дерева как есть (`applyOperation`).
 */
interface PackagePluginConflictFailure extends TreeRowFailure {
  readonly conflict: readonly [string, string];
}

/** Пакеты конфликта, если заведомый отказ строки — конфликт пакетов одного слоя. */
export function packagePluginConflict(failure: TreeRowFailure | undefined): readonly [string, string] | undefined {
  return failure !== undefined && 'conflict' in failure ? (failure as PackagePluginConflictFailure).conflict : undefined;
}

/**
 * Операции плагинов действующих пакетов слоя, в порядке имён пакетов и
 * каталогов. Один `id` в двух пакетах слоя — одна операция-отказ, которая
 * заменяет строку нижнего слоя (`supersede`): ни один из двух пакетов не
 * выбран, и нижний слой молча не подставляется. Каталог с `id` встроенной
 * строки отказывает так же, как свободный каталог, и встроенную строку
 * оставляет действующей.
 */
export function packagePluginOperations(
  index: PackageIndex,
  layer: PackageLayer,
  reservedIds: readonly string[],
): readonly TreeOperation[] {
  const found: PackagePlugin[] = [];
  for (const pack of activePackages(index, layer)) {
    const pluginsDir = join(pack.dir, 'plugins');
    for (const id of listPluginDirNames(pluginsDir)) found.push({ id, dir: join(pluginsDir, id), package: pack.name });
  }

  const operations: TreeOperation[] = [];
  const handled = new Set<string>();
  for (const plugin of found) {
    if (handled.has(plugin.id)) continue;
    handled.add(plugin.id);

    const owners = found.filter((candidate) => candidate.id === plugin.id);
    if (reservedIds.includes(plugin.id)) {
      // Имя встроенной строки отказывает в каждом пакете само по себе, и
      // конфликт двух пакетов этого не меняет: отказ `supersede` занял бы место
      // встроенной строки и выключил бы её.
      for (const owner of owners) {
        operations.push(
          ...directoryOperations([{ id: owner.id, dir: owner.dir, failure: reservedNameFailure(owner.id) }], {
            layer,
            package: owner.package,
          }),
        );
      }
      continue;
    }

    const [first, second] = owners;
    if (first !== undefined && second !== undefined) {
      const failure: PackagePluginConflictFailure = {
        message: `Плагин ${plugin.id} приносят два пакета одного слоя — ${first.package} и ${second.package}`,
        hint: 'Переименуйте каталог плагина в одном из пакетов, уберите один из пакетов либо положите свой плагин в свободный каталог .stepcast/plugins',
        conflict: [first.package, second.package],
      };
      operations.push(
        ...directoryOperations(
          [
            {
              id: plugin.id,
              dir: first.dir,
              supersede: true,
              failure,
            },
          ],
          { layer, package: first.package },
        ),
      );
      continue;
    }

    operations.push(...directoryOperations([{ id: plugin.id, dir: plugin.dir }], { layer, package: plugin.package }));
  }
  return operations;
}
