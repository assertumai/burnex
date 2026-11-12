import { existsSync } from 'node:fs';

import { createAnchorer, type Anchor, type AnchorKind, type TreeAnchorer } from '../domain/anchor/index.js';
import type { Graph } from '../domain/graph.js';
import { OWN_TREE, type Job, type Pipeline } from '../document/model.js';
import type { RunJournal } from './journal/writer.js';
import type { JobRecord } from './journal/schema.js';
import type { ResumePlan, SourceRun } from './resumePlan.js';
import {
  chosenSourceId,
  defaultTreeOf,
  jobTree,
  opensTree,
  resolveSeedSource,
  sharedTreeOf,
  treeHeads,
  treeKey,
  type CompletedJob,
} from './trees.js';
import {
  discardTreeDir,
  openTreeDir,
  treeDirPath,
  type PreparedWorkspace,
  type TreeDir,
  type TreeSeed,
} from './workspace.js';

/**
 * Деревья прогона в ходе исполнения (`named-workspace-trees`, решения 2–3, 9).
 *
 * Владеет картой «дерево → каталог»: какой каталог у дерева, кто и чем его
 * засеял, перенят ли он у исходного прогона. Решает, когда каталог заводится:
 * дерево по умолчанию — в начале прогона, голова именованного дерева и
 * личное дерево — в момент завершения источника (пока его дерево не получила
 * следующая работа) либо, если засеять тогда было нечем, при старте работы.
 *
 * Раскладку по документу считает `run/trees.ts`, механику одного каталога —
 * `run/workspace.ts`; здесь только их связка во времени прогона.
 */

type WorkspaceRecord = NonNullable<JobRecord['workspace']>;
type SeedRecord = NonNullable<WorkspaceRecord['seed']>;

interface OpenedTree {
  readonly mode: 'worktree' | 'copy';
  readonly dir: TreeDir;
  /** Работа, для которой каталог заведён; у дерева по умолчанию и перенятого — нет. */
  readonly opener?: string;
  readonly seed?: SeedRecord;
  /** Прогон, у которого каталог перенят возобновлением. */
  readonly adoptedFrom?: string;
}

type TreeSlot = OpenedTree | { readonly failed: string; readonly opener?: string };

export interface RunTreesOptions {
  readonly pipeline: Pipeline;
  readonly graph: Graph;
  /** Каталог запуска: репозиторий, чьей базой объектов заводятся деревья. */
  readonly cwd: string;
  readonly journal: RunJournal;
  readonly anchorKind: AnchorKind;
  readonly nestedRepos?: readonly string[];
  readonly sourceCommits: Readonly<Record<string, string>>;
  /** Каталог и последний якорь завершившихся работ — общий с прогоном (циклы его сбрасывают). */
  readonly completed: Map<string, Omit<CompletedJob, 'frozen'>>;
  readonly resume?: { readonly plan: ResumePlan; readonly source: SourceRun };
  readonly anchorerFor?: (options: {
    readonly dir: string;
    readonly stateDir: string;
    readonly kind: AnchorKind;
    readonly scope: string;
    readonly repoDir?: string;
    readonly nested?: readonly string[];
  }) => TreeAnchorer;
}

/** Размещение работы: рабочая директория и её запись в состоянии. */
export interface Placement {
  readonly prepared: PreparedWorkspace;
  readonly record: WorkspaceRecord;
}

export class RunTrees {
  private readonly slots = new Map<string, TreeSlot>();
  private readonly heads: ReadonlyMap<string, string>;
  private readonly started = new Set<string>();
  private readonly running = new Set<string>();
  /** Деревья, уже перенятые возобновлением: повторное заведение (проход цикла) идёт обычным засевом. */
  private readonly resumed = new Set<string>();

  constructor(private readonly options: RunTreesOptions) {
    this.heads = treeHeads(options.pipeline, options.graph);
  }

  /**
   * Дерево по умолчанию — до первой работы, от исходного состояния. Отказ не
   * роняет прогон: он становится отказом подготовки каждой работы дерева.
   */
  async openDefault(): Promise<void> {
    const name = defaultTreeOf(this.options.pipeline);
    if (name === undefined) return;
    const member = this.options.pipeline.jobs.find((job) => sharedTreeOf(job) === name);
    if (member === undefined) return;
    await this.open(member, { kind: 'none' }, undefined);
  }

  /** Работа начинает исполняться: её дерево больше не засевается заново. */
  begin(jobId: string): void {
    this.started.add(jobId);
    this.running.add(jobId);
  }

  end(jobId: string): void {
    this.running.delete(jobId);
  }

  /**
   * Каталог работы. `loopReseed` — источник точки входа цикла в проходе
   * N > 1: дерево выхода прошлого прохода.
   */
  async place(job: Job, loopReseed?: { readonly job: string; readonly dir: string }): Promise<Placement> {
    const tree = jobTree(job);
    if (tree.kind === 'cwd' || job.workspace.mode === 'cwd') {
      return { prepared: { mode: 'cwd', dir: this.options.cwd }, record: { mode: 'cwd', path: this.options.cwd } };
    }
    const key = treeKey(job);

    if (loopReseed !== undefined && opensTree(job, this.heads) && this.dirOf(key) !== loopReseed.dir) {
      await this.open(job, { kind: 'copy', from: { dir: loopReseed.dir } }, { from: loopReseed.job, by: 'copy' });
    }

    let slot = this.slots.get(key);
    if (slot === undefined) {
      // Каталог не заведён в момент завершения источника: источник пропущен,
      // исполнялся в `cwd` или дерево — по умолчанию без заведения на старте.
      const shared = sharedTreeOf(job);
      if (shared !== undefined && shared === defaultTreeOf(this.options.pipeline)) {
        await this.open(job, { kind: 'none' }, undefined);
      } else {
        const frozen = new Map(
          [...this.options.completed].map(([id, item]) => [id, { ...item, frozen: this.isFrozen(id) }] as const),
        );
        const source = resolveSeedSource(this.options.graph, job, frozen, existsSync);
        if (source.kind === 'copy') {
          await this.open(job, { kind: 'copy', from: { dir: source.dir } }, { from: source.job, by: 'copy' });
        } else if (source.kind === 'anchor') {
          await this.open(job, { kind: 'anchor', anchor: source.anchor }, {
            from: source.job,
            by: 'anchor',
            reason: source.reason,
          });
        } else {
          await this.open(job, { kind: 'none' }, { from: 'none' });
        }
      }
      slot = this.slots.get(key) as TreeSlot;
    }
    if ('failed' in slot) throw new Error(slot.failed);

    const own = slot.opener === job.id;
    return {
      prepared: { mode: slot.mode, dir: slot.dir.dir, ...(slot.dir.nested === undefined ? {} : { nested: slot.dir.nested }) },
      record: {
        mode: slot.mode,
        path: slot.dir.dir,
        tree: tree.kind === 'own' ? OWN_TREE : tree.name,
        ...(own && slot.seed !== undefined ? { seed: slot.seed } : { continued: true }),
        ...(slot.adoptedFrom === undefined ? {} : { adopted_from: slot.adoptedFrom }),
        // Пишется до первого шага: уборка обязана снять учётные записи частей
        // и после отказа, отмены и остановки по бюджету.
        ...(slot.dir.nested === undefined ? {} : { nested: slot.dir.nested.map((part) => ({ ...part })) }),
      },
    };
  }

  /**
   * Работа завершилась: каталоги голов, ждущих её как источник, заводятся
   * сейчас — до того, как её дерево получит следующая работа (решение 3).
   * Голова уже идущая не трогается; голова, исполнившаяся в прошлом проходе
   * цикла, засевается заново — проход строится на новом состоянии источника.
   */
  async completed(job: Job): Promise<void> {
    if (job.workspace.mode === 'cwd') return;
    const completion = this.options.completed.get(job.id);
    if (completion === undefined) return;
    for (const head of this.options.pipeline.jobs) {
      if (head.workspace.mode === 'cwd' || !opensTree(head, this.heads)) continue;
      if (chosenSourceId(this.options.graph, head) !== job.id) continue;
      if (this.running.has(head.id)) continue;
      if (this.dirOf(treeKey(head)) === completion.dir) continue;
      await this.open(head, { kind: 'copy', from: { dir: completion.dir } }, { from: job.id, by: 'copy' });
    }
  }

  /**
   * Работа отдала исход, не начавшись (пропущена условием, отменена): каталог,
   * заведённый для неё заранее, снимается — он никому не нужен.
   */
  settledWithoutRun(jobId: string): void {
    if (this.started.has(jobId)) return;
    for (const [key, slot] of this.slots) {
      if (slot.opener !== jobId) continue;
      if ('failed' in slot) this.slots.delete(key);
      else this.discard(key, slot);
    }
  }

  /** Конец прогона: снять каталоги, заведённые для работ, которые так и не начались. */
  disposeUnused(): void {
    for (const [key, slot] of this.slots) {
      if ('failed' in slot || slot.opener === undefined || this.started.has(slot.opener)) continue;
      this.discard(key, slot);
    }
  }

  private discard(key: string, slot: OpenedTree): void {
    this.slots.delete(key);
    // Перенятый каталог принадлежит исходному прогону — снимать его не нам.
    if (slot.adoptedFrom !== undefined) return;
    try {
      const failures = discardTreeDir({ mode: slot.mode, dir: slot.dir, cwd: this.options.cwd, runDir: this.options.journal.paths.dir });
      for (const detail of failures) {
        this.options.journal.event({ kind: 'bookkeeping.failed', operation: 'снятие неиспользованного каталога дерева', detail });
      }
    } catch (error) {
      this.options.journal.event({
        kind: 'bookkeeping.failed',
        operation: 'снятие неиспользованного каталога дерева',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private dirOf(key: string): string | undefined {
    const slot = this.slots.get(key);
    return slot === undefined || 'failed' in slot ? undefined : slot.dir.dir;
  }

  /** Личное дерево после завершения работы никто не продолжает: его каталог — состояние на момент завершения. */
  private isFrozen(jobId: string): boolean {
    const job = this.options.graph.byId.get(jobId);
    return job !== undefined && jobTree(job).kind === 'own';
  }

  /**
   * Завести каталог дерева работы `job` (для дерева по умолчанию — любой его
   * работы). Отказ запоминается в карте: работа дерева отказывает им при
   * старте отказом подготовки, ни один её шаг не исполняется.
   */
  private async open(job: Job, seed: TreeSeed, record: SeedRecord | undefined): Promise<void> {
    const { journal } = this.options;
    const key = treeKey(job);
    const mode = job.workspace.mode as 'worktree' | 'copy';
    const shared = sharedTreeOf(job);
    const opener = record === undefined ? undefined : job.id;
    const restore = this.resumeOf(key);

    try {
      // Возобновление перенимает каталог дерева у исходного прогона: в нём
      // лежат и установленные зависимости, и сборка (решение 9).
      if (restore?.adopt !== undefined && existsSync(restore.adopt.dir)) {
        this.slots.set(key, {
          mode,
          dir: restore.adopt,
          adoptedFrom: restore.runId,
          ...(opener === undefined ? {} : { opener }),
        });
      } else {
        const dir = await openTreeDir({
          mode,
          dir: treeDirPath({
            runDir: journal.paths.dir,
            path: job.workspace.path,
            ...(shared === undefined ? {} : { shared }),
            job: job.id,
          }),
          cwd: this.options.cwd,
          runDir: journal.paths.dir,
          bookkeeping: { journal, job: job.id },
          seed,
          ...(this.options.nestedRepos === undefined ? {} : { nestedRepos: this.options.nestedRepos }),
          sourceCommits: this.options.sourceCommits,
          anchorKind: this.options.anchorKind,
          anchorsDir: journal.paths.anchors,
          anchorScope: `seed:${key}`,
          ...(this.options.anchorerFor === undefined ? {} : { anchorerFor: this.options.anchorerFor }),
        });
        this.slots.set(key, {
          mode,
          dir,
          ...(opener === undefined ? {} : { opener }),
          ...(record === undefined ? {} : { seed: record }),
        });
        if (record !== undefined && record.from !== 'none') {
          journal.event({
            kind: 'workspace.seeded',
            job: job.id,
            tree: job.workspace.tree ?? OWN_TREE,
            source: record.from,
            ...(record.by === undefined ? {} : { by: record.by }),
            ...(record.reason === undefined ? {} : { reason: record.reason }),
          });
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.slots.set(key, { failed: detail, ...(opener === undefined ? {} : { opener }) });
      return;
    }

    if (restore?.anchor !== undefined) this.restore(key, restore.anchor);
  }

  /**
   * Что возобновление делает с деревом: перенять каталог исходного прогона и
   * привести его к якорю последнего переиспользованного шага дерева. Дерево
   * работы, продолжающей оборванную сессию, перенимается без восстановления:
   * оно и есть то состояние, которое диалог оставил.
   */
  private resumeOf(key: string):
    | { readonly runId: string; readonly adopt?: TreeDir; readonly anchor?: Anchor }
    | undefined {
    const resume = this.options.resume;
    if (resume === undefined || this.resumed.has(key)) return undefined;
    this.resumed.add(key);
    const members = new Set(this.options.pipeline.jobs.filter((job) => treeKey(job) === key).map((job) => job.id));
    const runId = resume.source.manifest.run_id;

    const continuing = resume.plan.adoptWorkspace.find((item) => members.has(item.job));
    if (continuing !== undefined) {
      return {
        runId,
        adopt: { dir: continuing.path, ...(continuing.nested === undefined ? {} : { nested: continuing.nested }) },
      };
    }

    const last = [...resume.plan.restoreWorkspace].reverse().find((item) => members.has(item.job));
    if (last === undefined) return undefined;
    const previous = resume.source.status.jobs.find((record) => record.id === last.job)?.workspace;
    return {
      runId,
      anchor: last.anchor,
      ...(previous === undefined || previous.mode === 'cwd'
        ? {}
        : { adopt: { dir: previous.path, ...(previous.nested === undefined ? {} : { nested: previous.nested }) } }),
    };
  }

  /**
   * Привести каталог дерева к якорю: отслеживаемое и новое приводится,
   * игнорируемое остаётся на месте (вариант «а» решения 9). Недоступный
   * якорь не отказ: переисполнить лишнее дороже, но это ровно то, что
   * пользователь получил бы без возобновления.
   */
  private restore(key: string, anchor: Anchor): void {
    const slot = this.slots.get(key);
    if (slot === undefined || 'failed' in slot) return;
    const { journal } = this.options;
    const nested = this.options.nestedRepos;
    const anchorer = (this.options.anchorerFor ?? createAnchorer)({
      dir: slot.dir.dir,
      stateDir: journal.paths.anchors,
      kind: this.options.anchorKind,
      scope: `resume:${key}`,
      repoDir: this.options.cwd,
      ...(nested === undefined || slot.mode !== 'worktree' ? {} : { nested }),
    });
    try {
      anchorer.restore(anchor);
      journal.event({ kind: 'tree.restored', anchor: anchor.id, path: slot.dir.dir });
    } catch (error) {
      journal.event({
        kind: 'bookkeeping.failed',
        operation: 'восстановление дерева по якорю',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      anchorer.dispose();
    }
  }
}
