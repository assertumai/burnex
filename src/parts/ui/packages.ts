import { packagePluginConflict } from '../packages/plugins.js';
import { packageConflicts, type PackageProblem, type PackageSummary } from '../packages/summary.js';
import { currentDaemonKernel, daemonBuiltinRowIds } from './daemon/kernel.js';
import type { Watcher } from './daemon/watcher.js';
import type { KernelCache } from './pipelines.js';

/**
 * Отказы ресурсов пакетов для экрана «Packages» (`ui-packages-screen`, design.md,
 * Решения 2, 3): сведение того, что составы демона уже вычислили, а не вторая
 * проверка своими правилами. Исключение одно — конфликт имени: его даёт
 * `packageConflicts` над сводкой, потому что у шагов и скриптов иного источника
 * нет, а у виджетов, дашбордов, маршрутов и плагинов составы называют только
 * одного из двух пакетов и показали бы конфликт дважды в разной форме.
 */

export interface PackageProblems {
  readonly problems: readonly PackageProblem[];
  /** Причина, по которой дерево плагинов не собралось: отказов плагинов в `problems` тогда нет. */
  readonly pluginsError?: string;
}

function key(layer: string, kind: string, id: string | undefined): string {
  return `${layer}\0${kind}\0${id ?? ''}`;
}

/** Порядок: слой проекта, затем home; внутри — пакет, вид, `id`. */
function compareProblems(a: PackageProblem, b: PackageProblem): number {
  if (a.layer !== b.layer) return a.layer === 'project' ? -1 : 1;
  return (
    (a.packages[0] ?? '').localeCompare(b.packages[0] ?? '') ||
    a.kind.localeCompare(b.kind) ||
    (a.id ?? '').localeCompare(b.id ?? '')
  );
}

export async function buildPackageProblems(
  watcher: Watcher,
  kernelCache: KernelCache | undefined,
  home: string | undefined,
): Promise<PackageProblems> {
  const summaries: readonly PackageSummary[] = watcher.currentPackages();
  const conflicts = packageConflicts(summaries, { reservedPluginIds: daemonBuiltinRowIds() });
  const conflicted = new Set(conflicts.map((conflict) => key(conflict.layer, conflict.kind, conflict.id)));
  const layerOf = (name: string): PackageSummary['layer'] | undefined =>
    (summaries.find((summary) => summary.name === name && summary.status === 'ok') ??
      summaries.find((summary) => summary.name === name))?.layer;

  const problems: PackageProblem[] = [];

  // Виджет с `error` бывает только при конфликте имени (`widgets.ts`), и его
  // уже называет `packageConflicts`; отдельного отказа файла у виджета в
  // составе нет — ошибка компиляции приходит в браузер, а не в состав.

  // Отказ дашборда по `id`, который в слое пакетов конфликтует, — это и есть
  // запись конфликта: `buildDashboards` на конфликте останавливает поиск и
  // файлы обоих пакетов не разбирает вовсе, так что иной причины для этого
  // `id` в составе нет (проверять файл второй раз своими правилами здесь
  // нельзя — Решение 3). Отказ свободного дашборда (без пакета) сюда не идёт.
  for (const failure of watcher.currentDashboards().failures) {
    if (failure.package === undefined) continue;
    const layer = layerOf(failure.package) ?? failure.layer;
    if (conflicted.has(key(layer, 'dashboards', failure.id))) continue;
    problems.push({
      layer,
      packages: [failure.package],
      kind: 'dashboards',
      id: failure.id,
      file: failure.file,
      message: failure.reason,
    });
  }

  // Конфликт `id` маршрута называет два пакета и приходит из `packageConflicts`;
  // здесь остаётся отказ файла целиком — он называет один.
  for (const failure of watcher.currentRoutes().failures) {
    if (failure.packages.length !== 1) continue;
    problems.push({
      layer: failure.layer,
      packages: failure.packages,
      kind: 'routes',
      file: failure.file,
      message: failure.message,
    });
  }

  const kernel = await currentDaemonKernel(kernelCache, home);
  if (kernel.buildError === undefined) {
    for (const outcome of kernel.outcomes) {
      const { source } = outcome.row;
      if (outcome.status !== 'failed' || source.kind !== 'directory' || source.package === undefined) continue;
      // Конфликт двух пакетов приходит отказом `supersede`, подписанным только
      // первым из них, — его называет `packageConflicts`. Узнаётся он по явному
      // признаку отказа, а не по ключу: любой другой отказ (имя встроенной
      // строки, загрузка) остаётся своей записью.
      if (packagePluginConflict(outcome.row.failure) !== undefined) continue;
      const message = outcome.error?.message ?? 'plugin failed';
      const id = outcome.row.id;
      problems.push({ layer: source.layer, packages: [source.package], kind: 'plugins', id, file: source.dir, message });
    }
  }

  problems.push(...conflicts);
  problems.sort(compareProblems);
  return { problems, ...(kernel.buildError === undefined ? {} : { pluginsError: kernel.buildError }) };
}
