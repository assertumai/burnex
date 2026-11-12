import { restorable, type Anchor } from '../domain/anchor/index.js';
import type { Graph } from '../domain/graph.js';
import type { Diagnostic } from '../domain/lint.js';
import { DEFAULT_TREE, OWN_TREE, type ExpandedPipeline, type Job, type Pipeline } from '../document/model.js';

/**
 * Раскладка рабочих деревьев прогона (`named-workspace-trees`).
 *
 * Чистый модуль: без файловой системы и процессов, как планировщик работ
 * (`scheduler.ts`). Отвечает на три вопроса по одному документу и графу —
 * в каком дереве идёт работа, заводит ли она каталог и откуда он засевается,
 * — и на один по исходам: какой источник есть у каталога сейчас.
 *
 * Форма графа каталога не выбирает: дерево — объявление (`workspace.tree`,
 * `scope`), а граф лишь называет голову дерева и источник её засева.
 *
 * Статические правила (`treeDiagnostics`) живут здесь же, а не в `lint.ts`:
 * их применяют и `burnex lint`, и предстартовая проверка прогона
 * (`run/workspace.ts`), и держать общее правило в модуле, который импортирует
 * один из потребителей, значило бы замкнуть импорты в кольцо.
 */

/** Дерево работы: checkout (`cwd`), общее именованное либо личное. */
export type JobTree =
  | { readonly kind: 'cwd' }
  | { readonly kind: 'shared'; readonly name: string }
  | { readonly kind: 'own' };

export function jobTree(job: Job): JobTree {
  const tree = job.workspace.tree;
  if (job.workspace.mode === 'cwd' || tree === undefined) return { kind: 'cwd' };
  return tree === OWN_TREE ? { kind: 'own' } : { kind: 'shared', name: tree };
}

/**
 * Ключ дерева, по которому работы сравниваются между собой: одинаковый ключ —
 * один каталог. Личное дерево у каждой работы своё.
 */
export function treeKey(job: Job): string {
  const tree = jobTree(job);
  if (tree.kind === 'cwd') return 'cwd';
  return tree.kind === 'own' ? `own:${job.id}` : `tree:${tree.name}`;
}

/** Имя общего дерева работы — ресурс планировщика; у личного и `cwd` отсутствует. */
export function sharedTreeOf(job: Job): string | undefined {
  const tree = jobTree(job);
  return tree.kind === 'shared' ? tree.name : undefined;
}

/** Дерево по умолчанию: заводится в начале прогона от исходного состояния, головы у него нет. */
export function defaultTreeOf(pipeline: Pipeline): string | undefined {
  if (pipeline.workspace.mode === 'cwd' || pipeline.workspace.scope === 'job') return undefined;
  return pipeline.workspace.trees?.[0] ?? DEFAULT_TREE;
}

/** Состав общих деревьев в порядке объявления работ. */
export function treeMembers(pipeline: Pipeline): ReadonlyMap<string, readonly Job[]> {
  const members = new Map<string, Job[]>();
  for (const job of pipeline.jobs) {
    const name = sharedTreeOf(job);
    if (name === undefined) continue;
    members.set(name, [...(members.get(name) ?? []), job]);
  }
  return members;
}

/**
 * Головы именованных деревьев (кроме дерева по умолчанию): единственная
 * работа дерева, от которой транзитивно зависят все остальные его работы.
 * Дерево без единственной головы в карту не попадает — это ошибка линта.
 */
export function treeHeads(pipeline: Pipeline, graph: Graph): ReadonlyMap<string, string> {
  const heads = new Map<string, string>();
  const fallback = defaultTreeOf(pipeline);
  for (const [name, members] of treeMembers(pipeline)) {
    if (name === fallback) continue;
    const candidates = headCandidates(members, graph);
    if (candidates.length === 1) heads.set(name, (candidates[0] as Job).id);
  }
  return heads;
}

function headCandidates(members: readonly Job[], graph: Graph): Job[] {
  return members.filter((candidate) =>
    members.every((other) => other.id === candidate.id || graph.upstream.get(other.id)?.has(candidate.id) === true),
  );
}

/**
 * Заводит ли работа каталог: личное дерево (и всякая работа при `scope: job`)
 * либо голова именованного дерева. Работы дерева по умолчанию и продолжения
 * именованного дерева каталог не заводят — он уже есть.
 */
export function opensTree(job: Job, heads: ReadonlyMap<string, string>): boolean {
  const tree = jobTree(job);
  if (tree.kind === 'own') return true;
  return tree.kind === 'shared' && heads.get(tree.name) === job.id;
}

/** Источник, выбранный работой: объявленный `inherit`, единственная зависимость, либо ничего. */
export function chosenSourceId(graph: Graph, job: Job): string | undefined {
  const inherit = job.workspace.inherit;
  if (inherit === 'none') return undefined;
  if (inherit !== undefined) return inherit;

  const dependencies = graph.dependencies.get(job.id) ?? [];
  return dependencies.length === 1 ? dependencies[0] : undefined;
}

/** Итог завершившейся работы, нужный засеву. */
export interface CompletedJob {
  /** Рабочая директория, в которой работа исполнялась. */
  readonly dir: string;
  /** Последний зафиксированный якорь. Отсутствует, если работа не дошла до первого шага. */
  readonly anchor?: Anchor;
  /**
   * Каталог после завершения работы больше никто не меняет: личное дерево.
   * Каталог общего дерева продолжают другие работы, и состояние источника
   * снимается с него только в момент завершения — позже он засевается якорем.
   */
  readonly frozen: boolean;
}

export type SeedSource =
  /** Каталог источника переносится целиком: его состояние на момент завершения ещё на месте. */
  | { readonly kind: 'copy'; readonly job: string; readonly dir: string }
  /** Каталог источника уже продолжен другими или недоступен: засев якорем. */
  | { readonly kind: 'anchor'; readonly job: string; readonly anchor: Anchor; readonly reason: string }
  /** Источника нет: исходное состояние проекта. */
  | { readonly kind: 'none' };

/**
 * Источник каталога, заводимого не в момент завершения источника (тот
 * засевается сразу, `runner.ts`): источник пропущен, исполнялся в `cwd` или
 * каталог заводится позже. Пропущенная, не дошедшая до каталога и
 * исполнявшаяся в `cwd` работа поиск не останавливает: засев переходит к её
 * собственному источнику, и так до исходного состояния проекта.
 */
export function resolveSeedSource(
  graph: Graph,
  job: Job,
  completed: ReadonlyMap<string, CompletedJob>,
  dirExists: (dir: string) => boolean,
): SeedSource {
  const seen = new Set<string>();
  const first = chosenSourceId(graph, job);
  let current = first;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const currentJob = graph.byId.get(current);
    const completion = currentJob?.workspace.mode === 'cwd' ? undefined : completed.get(current);
    if (completion !== undefined) {
      if (completion.frozen && dirExists(completion.dir)) return { kind: 'copy', job: current, dir: completion.dir };
      const anchor = completion.anchor;
      if (anchor !== undefined && restorable(anchor)) {
        const reason = !dirExists(completion.dir)
          ? `каталога ${current} нет`
          : current === first
            ? `дерево ${current} уже продолжено другими работами`
            : `источник ${first} не исполнялся, а дерево ${current} уже продолжено другими работами`;
        return { kind: 'anchor', job: current, anchor, reason };
      }
    }
    current = currentJob === undefined ? undefined : chosenSourceId(graph, currentJob);
  }
  return { kind: 'none' };
}

/**
 * Проверки деревьев и источников засева (`named-workspace-trees`, решения
 * 1–4). Отказы, видные по одному блоку `workspace`, отклоняет раскрытие
 * (`document/expand.ts`); здесь — требующие графа.
 */
export function treeDiagnostics(pipeline: ExpandedPipeline['pipeline'], graph: Graph): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const push = (diagnostic: Diagnostic): void => {
    diagnostics.push(diagnostic);
  };
  const heads = treeHeads(pipeline, graph);
  const fallback = defaultTreeOf(pipeline);

  for (const [name, members] of treeMembers(pipeline)) {
    if (name === fallback) continue;
    if (heads.has(name)) continue;
    const candidates = headCandidates(members, graph);
    const named = (candidates.length === 0 ? members : candidates).map((job) => job.id);
    push({
      severity: 'error',
      message: `Дерево ${name} не имеет единственной головы: ${named.join(', ')}`,
      file: (members[0] as Job).source,
      at: `jobs.${(members[1] ?? members[0] as Job).id}.workspace.tree`,
      hint: 'Голова дерева — его работа, от которой зависят все остальные: от неё дерево отпочковывается. Свяжите работы needs либо разведите по разным деревьям',
    });
  }

  for (const job of pipeline.jobs) {
    const at = `jobs.${job.id}.workspace.inherit`;
    const inherit = job.workspace.inherit;
    const dependencies = graph.dependencies.get(job.id) ?? [];

    if (inherit !== undefined && job.workspace.mode === 'cwd') {
      push({
        severity: 'error',
        message: `Работа ${job.id} объявляет workspace.inherit при режиме cwd`,
        file: job.source,
        at,
        hint: 'В режиме cwd рабочее дерево одно на прогон — наследовать нечего',
      });
      continue;
    }
    if (job.workspace.mode === 'cwd') continue;

    const opens = opensTree(job, heads);
    if (inherit !== undefined && !opens) {
      push({
        severity: 'error',
        message: `Работа ${job.id} объявляет workspace.inherit, а продолжает уже заведённое дерево ${job.workspace.tree ?? ''}`,
        file: job.source,
        at,
        hint: 'Источник выбирает только работа, которой заводится каталог: голова именованного дерева, tree: own или любая работа при scope: job. Уберите inherit',
      });
      continue;
    }

    if (inherit !== undefined && inherit !== 'none') {
      if (!graph.byId.has(inherit)) {
        push({
          severity: 'error',
          message: `Работа ${job.id} наследует дерево несуществующей работы ${inherit}`,
          file: job.source,
          at,
          hint: `Известны: ${[...graph.byId.keys()].sort().join(', ')}`,
        });
      } else if (!dependencies.includes(inherit)) {
        push({
          severity: 'error',
          message: `Работа ${job.id} наследует дерево работы ${inherit}, не входящей в её зависимости`,
          file: job.source,
          at,
          hint: dependencies.length === 0 ? 'У работы нет зависимостей' : `Допустимы: ${dependencies.join(', ')}`,
        });
      }
    }

    if (inherit === undefined && opens && dependencies.length > 1) {
      push({
        severity: 'error',
        message: `Работа ${job.id} зависит от нескольких работ и не объявляет workspace.inherit`,
        file: job.source,
        at,
        hint: `Работе заводится свой каталог: выберите источник или none: ${dependencies.join(', ')}`,
      });
    }
  }

  // Порядок не задан графом: что каждая увидит в общем дереве, решает порядок
  // объявления. Ошибкой это не делается (решение 4) — две проверки в общем
  // дереве обычны, и требовать для них needs значило бы заставлять писать
  // ложные зависимости.
  for (const [name, members] of treeMembers(pipeline)) {
    for (const [index, job] of members.entries()) {
      for (const other of members.slice(index + 1)) {
        const ordered =
          graph.upstream.get(job.id)?.has(other.id) === true || graph.upstream.get(other.id)?.has(job.id) === true;
        if (ordered) continue;
        push({
          severity: 'warning',
          message: `Работы ${job.id} и ${other.id} делят дерево ${name}, но не связаны зависимостями: исполняются по очереди, ${job.id} раньше ${other.id} по порядку объявления`,
          file: other.source,
          at: `jobs.${other.id}.needs`,
          hint: `${other.id} увидит в дереве правки ${job.id}. Если работам нужна изоляция, разведите их по деревьям (workspace.trees, tree: own) или объявите scope: job`,
        });
      }
    }
  }

  return diagnostics;
}
