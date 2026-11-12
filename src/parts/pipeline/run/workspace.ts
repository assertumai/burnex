import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';

import { createAnchorer } from '../domain/anchor/index.js';
import type { Anchor, AnchorKind, TreeAnchorer } from '../domain/anchor/index.js';
import { loadIgnoreRules } from '../domain/anchor/ignore.js';
import { isGitWorktree } from '../domain/anchor/git.js';
import { BurnexError } from '../../../kernel/errors.js';
import { buildGraph } from '../domain/graph.js';
import type { Pipeline, Workspace } from '../document/model.js';
import type { BookkeepingScope } from './bookkeeping.js';
import { treeDiagnostics } from './trees.js';
import { createScope } from './scope.js';
import { addWorktree, removeWorktree } from './worktrees.js';

/**
 * Рабочие каталоги прогона (`named-workspace-trees`).
 *
 * Каталог принадлежит дереву, а не работе: дерево по умолчанию заводится в
 * начале прогона, именованное — его голове, личное — своей работе. Здесь —
 * механика заведения и снятия одного каталога; что и когда заводить, решает
 * прогон (`runner.ts`) по раскладке из `run/trees.ts`.
 *
 * Журнал прогона в любом режиме лежит вне рабочего дерева. Рабочий каталог
 * передаётся дочерним процессам явным параметром: `process.chdir` в движке с
 * несколькими работами — источник трудноуловимых ошибок.
 */
export interface TreeDir {
  readonly dir: string;
  /**
   * Материализованные части дерева — объявленный каталог и репозиторий,
   * которому он принадлежит, в каноническом порядке состава. Только в режиме
   * `worktree`: уборка снимает учётную запись каждой части адресно.
   */
  readonly nested?: readonly { readonly dir: string; readonly repo: string }[];
}

/** Рабочая директория работы, как её видит исполнение. */
export interface PreparedWorkspace extends TreeDir {
  readonly mode: Workspace['mode'];
}

function git(dir: string, args: readonly string[]): string {
  // `core.quotePath=false`: иначе git экранирует не-ASCII пути в выводе
  // C-последовательностями, и предикат границ, объяснение инвалидации и
  // сравнение прогонов начинают показывать «\321\201...» вместо имени файла.
  return execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Есть ли в репозитории хотя бы один коммит: `HEAD` разрешается в объект. */
export function hasCommit(dir: string): boolean {
  try {
    git(dir, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** Игнорирует ли репозиторий `root` путь `relDir` своими правилами. */
function ignoredByRoot(root: string, relDir: string): boolean {
  try {
    git(root, ['check-ignore', '-q', '--', relDir]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Отслеживает ли репозиторий `root` обычные файлы внутри каталога `relDir` —
 * не сам каталог гитлинком: пathspec `relDir/` совпадает и с записью
 * гитлинка (git считает её каталогоподобной), поэтому запись фильтруется по
 * режиму — `160000` исключается, остальное считается файлом, зашедшим в
 * индекс раньше, чем каталог стал репозиторием. Выкладка корня в режиме
 * `worktree` заняла бы такой каталог, и `worktree add` части отказал бы
 * посреди подготовки (design.md, решение 3).
 */
export function rootTracksPart(root: string, relDir: string): boolean {
  try {
    return git(root, ['ls-files', '-s', '--', `${relDir}/`])
      .split('\n')
      .filter((line) => line !== '')
      .some((line) => !line.startsWith('160000 '));
  } catch {
    return false;
  }
}

interface WorkspaceDiagnosticText {
  readonly message: string;
  readonly hint: string;
}

/**
 * Формулировки трёх отказов состава, действующих только при объявленной
 * работе в режиме `worktree` (плюс безусловный отказ `copy`) — общие для
 * предстартовой проверки прогона (`checkWorkspaceAvailability`) и `stepcast
 * lint`: диагностика, минующая один путь, обязана звучать так же, как та,
 * что минует другой.
 */
export function describeCopyRejection(jobId: string): WorkspaceDiagnosticText {
  return {
    message: `Работа ${jobId} объявляет режим copy, а вложенные репозитории объявлены составом дерева (project.nested_repos)`,
    hint: 'Копия не содержит .git, и объявленная часть в ней была бы каталогом без репозитория. Уберите nested_repos или переведите работу в режим cwd либо worktree',
  };
}

export function describeNoCommitForWorktree(relDir: string): WorkspaceDiagnosticText {
  return {
    message: `Объявленный вложенный репозиторий ${relDir} не имеет ни одного коммита, а режим worktree заводит его дерево из HEAD`,
    hint: `git worktree add … HEAD невозможен в репозитории без коммита. Сделайте в ${relDir} первый коммит либо переведите работы в режим cwd`,
  };
}

export function describeTrackedByRoot(relDir: string): WorkspaceDiagnosticText {
  return {
    message: `Корневой репозиторий отслеживает файлы по пути объявленного вложенного репозитория ${relDir}`,
    hint: 'Выкладка корня в режиме worktree займёт этот каталог, и git worktree add части откажет посреди подготовки. Уберите файлы части из индекса корня либо переведите работы в режим cwd',
  };
}

/**
 * Файлы, которые считаются содержимым дерева: отслеживаемые и новые, но не
 * игнорируемые. Под git список берётся у самого git — он единственный
 * толкует правила игнорирования полностью.
 */
function visibleFiles(root: string): string[] {
  if (isGitWorktree(root)) {
    return git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      .split('\0')
      .filter((path) => path !== '');
  }

  const rules = loadIgnoreRules(root);
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split('\\').join('/');
      if (rules.ignores(rel, entry.isDirectory())) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(rel);
    }
  };
  visit(root);
  return found;
}

/**
 * Каталог дерева в раскладке (решение 7): `<base>/trees/<дерево>/` у общего,
 * `<base>/jobs/<работа>/` у личного. `<base>` — объявленный `workspace.path`
 * либо `<run_dir>/workspace`.
 */
export function treeDirPath(options: {
  readonly runDir: string;
  readonly path: string | undefined;
  readonly shared?: string;
  readonly job: string;
}): string {
  const base = options.path ?? join(options.runDir, 'workspace');
  return options.shared === undefined ? join(base, 'jobs', options.job) : join(base, 'trees', options.shared);
}

/** Откуда наполняется заводимый каталог. */
export type TreeSeed =
  /** Исходное состояние проекта: `HEAD` начала прогона либо копия каталога запуска. */
  | { readonly kind: 'none' }
  /** Полный перенос каталога источника — отслеживаемое, неотслеживаемое и игнорируемое. */
  | { readonly kind: 'copy'; readonly from: TreeDir }
  /** Отступление: исходное состояние, приведённое к якорю источника. */
  | { readonly kind: 'anchor'; readonly anchor: Anchor };

export interface OpenTreeOptions {
  readonly mode: Exclude<Workspace['mode'], 'cwd'>;
  /** Путь заводимого каталога (`treeDirPath`). Существующий каталог по нему снимается и заводится заново. */
  readonly dir: string;
  /** Каталог запуска: репозиторий, чьей базой объектов заводятся деревья. */
  readonly cwd: string;
  /** Директория прогона: инвариант снятия рабочих деревьев. */
  readonly runDir: string;
  /**
   * Куда писать отказ уборки за неудавшейся подготовкой. Обязателен: откат
   * снимает чужие рабочие деревья и учётные записи репозиториев, и отказ
   * такого снятия обязан быть виден.
   */
  readonly bookkeeping: BookkeepingScope;
  readonly seed: TreeSeed;
  /** Объявленный состав вложенных репозиториев (`project.nested_repos`). */
  readonly nestedRepos?: readonly string[];
  /** Коммиты начала прогона: `.` для корня и относительный путь для каждой части. */
  readonly sourceCommits?: Readonly<Record<string, string>>;
  /** Способ фиксации якорей прогона и каталог их служебных файлов — для засева якорем. */
  readonly anchorKind?: AnchorKind;
  readonly anchorsDir?: string;
  /** Область служебных файлов якоря засева. */
  readonly anchorScope?: string;
  /** Подмена якоря: тесты подставляют поддельный, как и в `runner.ts`. */
  readonly anchorerFor?: (options: {
    readonly dir: string;
    readonly stateDir: string;
    readonly kind: AnchorKind;
    readonly scope: string;
    readonly repoDir?: string;
    readonly nested?: readonly string[];
  }) => TreeAnchorer;
}

/**
 * Завести каталог дерева. Отказ на любом шаге снимает всё заведённое и уходит
 * наверх как есть: работа отказывает прежним `spawn_failed`, и ни один её
 * шаг не исполняется.
 */
export async function openTreeDir(options: OpenTreeOptions): Promise<TreeDir> {
  const { mode, dir, cwd, runDir, seed } = options;
  // Канонический порядок состава — отсортированный, тот же, что у составного
  // якоря (`anchor/composite.ts`): для вложенных друг в друга объявленных
  // каталогов `worktree add` объемлющего (`a`) отказал бы «not an empty
  // directory», заведись раньше вложенный (`a/b`).
  const nestedRepos = mode === 'worktree' ? [...(options.nestedRepos ?? [])].sort() : [];
  const nested = nestedRepos.map((relDir) => ({ dir: relDir, repo: join(cwd, relDir) }));

  // Каталог прошлого прохода цикла (или брошенный прежней попыткой)
  // заводится заново: засев переносит состояние источника целиком.
  if (existsSync(dir)) {
    const failures = discardTreeDir({ mode, dir: { dir, nested }, cwd, runDir });
    if (failures.length > 0) throw new BurnexError(`Прежний каталог дерева снять не удалось: ${failures.join('; ')}`);
  }

  /**
   * Область подготовки: каждый заведённый каталог регистрирует своё снятие
   * сразу после заведения. Обратный порядок сам даёт правило «части в
   * обратном порядке, затем корень». При успехе область отпускается: дерево
   * обязано пережить прогон, и снять его вправе только `burnex gc`.
   */
  const preparation = createScope(options.bookkeeping);
  try {
    if (mode === 'worktree') {
      const from = seed.kind === 'copy' ? seed.from.dir : undefined;
      addWorktree({
        repoDir: cwd,
        path: dir,
        ref: headOf(from) ?? options.sourceCommits?.['.'] ?? 'HEAD',
        noCheckout: from !== undefined,
      });
      preparation.defer('снятие рабочего дерева', () => {
        removeWorktree({ repoDir: cwd, path: dir, runDir });
      });
      for (const part of nested) {
        // Часть выкладывается из HEAD своего репозитория — не гитлинка корня
        // и не рабочего дерева части: gitlink говорит о том, что корень помнит
        // о части, а не о том, где она сейчас.
        const fromPart = from === undefined ? undefined : join(from, part.dir);
        addWorktree({
          repoDir: part.repo,
          path: join(dir, part.dir),
          ref: headOf(fromPart) ?? options.sourceCommits?.[part.dir] ?? 'HEAD',
          noCheckout: from !== undefined,
        });
        preparation.defer(`снятие части ${part.dir} рабочего дерева`, () => {
          removeWorktree({ repoDir: part.repo, path: join(dir, part.dir), runDir });
        });
      }
      if (from !== undefined) {
        transferContent(from, dir, nestedRepos);
        for (const relDir of ['.', ...nestedRepos]) {
          transferIndex(join(from, relDir), join(dir, relDir));
        }
      }
    } else {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      preparation.defer('снятие рабочей копии', () => {
        rmSync(dir, { recursive: true, force: true });
      });
      if (seed.kind === 'copy') {
        transferContent(seed.from.dir, dir, []);
      } else {
        for (const relativePath of visibleFiles(cwd)) {
          const to = join(dir, relativePath);
          mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
          cpSync(join(cwd, relativePath), to, { preserveTimestamps: true, mode: constants.COPYFILE_FICLONE });
        }
      }
    }

    // Отступление к якорю: каталог заведён от исходного состояния и приведён
    // к якорю источника тем же `restore`, что и возобновление — без
    // наполовину приведённого дерева.
    if (seed.kind === 'anchor') await restoreToAnchor(options, nestedRepos, seed.anchor);
  } catch (error) {
    // Исходная причина уходит наружу как есть; отказ самой уборки не
    // подменяет её, а уходит в журнал событием `bookkeeping.failed`.
    await preparation.dispose();
    throw error;
  }
  preparation.release();
  return nested.length === 0 ? { dir } : { dir, nested };
}

/** Коммит, на котором стоит рабочее дерево `dir`, — если это рабочее дерево git. */
function headOf(dir: string | undefined): string | undefined {
  if (dir === undefined || !existsSync(join(dir, '.git'))) return undefined;
  try {
    return git(dir, ['rev-parse', 'HEAD']).trim();
  } catch {
    return undefined;
  }
}

/**
 * Перенести всё содержимое каталога источника — отслеживаемое,
 * неотслеживаемое и игнорируемое, — кроме служебного `.git` корня и частей:
 * он принадлежит рабочему дереву источника, а у заводимого свой. Фильтр
 * игнорирования к засеву не применяется (решение 3). Файлы клонируются там,
 * где файловая система умеет (`COPYFILE_FICLONE`: APFS, reflink), иначе
 * копируются; символические ссылки переносятся как есть.
 */
function transferContent(from: string, to: string, nestedRepos: readonly string[]): void {
  const skipped = new Set(['.', ...nestedRepos].map((relDir) => resolvePath(from, relDir, '.git')));
  cpSync(from, to, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (source) => !skipped.has(resolvePath(source)),
  });
}

/**
 * Индекс заводимого дерева — индекс источника, если источник — рабочее
 * дерево git, иначе дерево коммита, от которого заведено: файлы уже лежат,
 * и выкладка не нужна. Индексы лежат в общей базе объектов репозитория,
 * поэтому копия индекса годна как есть; сведения о файлах git обновит сам.
 */
function transferIndex(from: string, to: string): void {
  const index = (dir: string): string => git(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
  if (existsSync(join(from, '.git')) && existsSync(index(from))) {
    copyFileSync(index(from), index(to));
    return;
  }
  git(to, ['read-tree', 'HEAD']);
}

/** Привести каталог к якорю источника засева. */
async function restoreToAnchor(options: OpenTreeOptions, nestedRepos: readonly string[], anchor: Anchor): Promise<void> {
  if (options.anchorKind === undefined || options.anchorsDir === undefined) {
    throw new BurnexError('Внутренняя ошибка: для засева якорем не передан способ фиксации якорей');
  }
  const anchorer = (options.anchorerFor ?? createAnchorer)({
    dir: options.dir,
    stateDir: options.anchorsDir,
    kind: options.anchorKind,
    scope: options.anchorScope ?? 'seed',
    repoDir: options.cwd,
    ...(nestedRepos.length === 0 ? {} : { nested: nestedRepos }),
  });
  // Своя область, а не область подготовки: служебные файлы якоря живут ровно
  // на время засева и снимаются при любом его исходе.
  const seeding = createScope(options.bookkeeping);
  seeding.defer('снятие служебных файлов якоря засева', () => {
    anchorer.dispose();
  });
  try {
    anchorer.restore(anchor);
  } finally {
    await seeding.dispose();
  }
}

/**
 * Снять каталог дерева: части в обратном каноническом порядке, затем корень.
 * Возвращает отказы снятия учётных записей — вызывающий решает, отказ это
 * подготовки или учётная запись в журнал.
 */
export function discardTreeDir(options: {
  readonly mode: Workspace['mode'];
  readonly dir: TreeDir;
  readonly cwd: string;
  readonly runDir: string;
}): string[] {
  const { mode, dir, cwd, runDir } = options;
  if (mode === 'cwd') return [];
  if (mode === 'copy') {
    rmSync(dir.dir, { recursive: true, force: true });
    return [];
  }
  const failures: string[] = [];
  for (const part of [...(dir.nested ?? [])].reverse()) {
    const outcome = removeWorktree({ repoDir: part.repo, path: join(dir.dir, part.dir), runDir });
    if (outcome.kind === 'record_kept') failures.push(outcome.reason);
  }
  const outcome = removeWorktree({ repoDir: cwd, path: dir.dir, runDir });
  if (outcome.kind === 'record_kept') failures.push(outcome.reason);
  return failures;
}

/**
 * Пригодность режима в этом окружении. Проверяется один раз до запуска первой
 * работы: отказ на пятой работе из семи после сорока минут работы агента
 * недопустим, если то же самое было видно на нулевой секунде.
 */
/** Путь размещения копии, объявленный при режиме, для которого он бессмыслен. */
export function workspacePathNeedsCopy(workspace: Workspace): boolean {
  return workspace.path !== undefined && workspace.mode !== 'copy';
}

export function checkWorkspaceAvailability(options: {
  readonly pipeline: Pipeline;
  readonly cwd: string;
  /** Объявленный состав вложенных репозиториев (`project.nested_repos`). */
  readonly nestedRepos?: readonly string[];
}): void {
  const { pipeline, cwd, nestedRepos } = options;
  const workspaces = pipeline.jobs.map((job) => job.workspace);

  // Те же отказы раскладки, что и `burnex lint`: пайплайн, минующий линт,
  // обязан отказать до первой работы, а не посреди прогона.
  const { graph } = buildGraph(pipeline);
  const treeProblem = treeDiagnostics(pipeline, graph).find((diagnostic) => diagnostic.severity === 'error');
  if (treeProblem !== undefined) {
    throw new BurnexError(treeProblem.message, {
      file: treeProblem.file ?? pipeline.file,
      ...(treeProblem.at === undefined ? {} : { at: treeProblem.at }),
      ...(treeProblem.hint === undefined ? {} : { hint: treeProblem.hint }),
    });
  }

  if (workspaces.some((workspace) => workspace.mode === 'worktree') && !isGitWorktree(cwd)) {
    throw new BurnexError('Режим worktree требует репозитория git', {
      file: pipeline.file,
      at: 'workspace.mode',
      hint: 'Вне репозитория доступен режим copy — он работает с незакоммиченными изменениями и без git',
    });
  }

  for (const workspace of workspaces) {
    if (workspace.path === undefined) continue;
    if (workspacePathNeedsCopy(workspace)) {
      throw new BurnexError('Путь размещения рабочей копии допустим только при режиме copy', {
        file: pipeline.file,
        at: 'workspace.path',
      });
    }
    try {
      mkdirSync(workspace.path, { recursive: true, mode: 0o700 });
      statSync(workspace.path);
    } catch (error) {
      throw new BurnexError(`Место размещения рабочих копий недоступно: ${workspace.path}`, {
        file: pipeline.file,
        at: 'workspace.path',
        cause: error,
      });
    }
  }

  if (nestedRepos === undefined || nestedRepos.length === 0) return;

  // Копия `.git` не содержит, и объявленная часть в ней была бы каталогом
  // без репозитория — снимать с неё составное состояние нечем (design.md,
  // Non-Goals «Поддержка режима copy»). `worktree` при пригодном составе
  // ниже уже не отказывает: часть материализуется собственным рабочим
  // деревом, и якорь остаётся составным.
  const copyJob = pipeline.jobs.find((job) => job.workspace.mode === 'copy');
  if (copyJob !== undefined) {
    const { message, hint } = describeCopyRejection(copyJob.id);
    throw new BurnexError(message, { file: copyJob.source, at: `jobs.${copyJob.id}.workspace.mode`, hint });
  }

  if (!isGitWorktree(cwd)) {
    throw new BurnexError(
      'Корень рабочего дерева не является репозиторием git, а вложенные репозитории объявлены составом (project.nested_repos)',
      { file: pipeline.file, at: 'project.nested_repos' },
    );
  }

  // Обе следующие проверки — только для работ в режиме worktree: в cwd (и
  // при отклонённом выше copy) до `git worktree add` части дело не доходит.
  const usesWorktree = pipeline.jobs.some((job) => job.workspace.mode === 'worktree');

  for (const relDir of nestedRepos) {
    const full = join(cwd, relDir);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch (error) {
      throw new BurnexError(`Объявленный вложенный репозиторий не существует: ${relDir}`, {
        file: pipeline.file,
        at: 'project.nested_repos',
        hint: 'Проверьте путь в project.nested_repos — опечатку или несклонированный подмодуль',
        cause: error,
      });
    }
    if (!isDirectory || !isGitWorktree(full)) {
      throw new BurnexError(`Объявленный вложенный репозиторий не является рабочим деревом git: ${relDir}`, {
        file: pipeline.file,
        at: 'project.nested_repos',
        hint: 'project.nested_repos называет каталог, который сам является отдельным git-репозиторием',
      });
    }

    // Вложенный репозиторий без единого коммита корневой `add -A` встроить
    // не умеет: он отказывает целиком («does not have a commit checked out»),
    // и снятие первого же якоря провалилось бы отказом бухгалтерии посреди
    // прогона — тихим, после которого границы правок просто не оцениваются.
    // Отказ здесь узкий: часть, которую корень игнорирует, в его `add -A` не
    // попадает вовсе и своим репозиторием снимается без коммита прекрасно.
    if (!hasCommit(full) && !ignoredByRoot(cwd, relDir)) {
      throw new BurnexError(
        `Объявленный вложенный репозиторий ${relDir} не имеет ни одного коммита, а корневой репозиторий его не игнорирует`,
        {
          file: pipeline.file,
          at: 'project.nested_repos',
          hint: `Корневой git не умеет встроить такой каталог ссылкой на коммит и отказывает целиком. Сделайте в ${relDir} первый коммит или добавьте его в .gitignore корня`,
        },
      );
    }

    const toplevel = git(full, ['rev-parse', '--show-toplevel']).trim();
    if (realpathSync(toplevel) !== realpathSync(full)) {
      throw new BurnexError(
        `Объявленный вложенный репозиторий ${relDir} принадлежит репозиторию ${toplevel}, а не собственному`,
        {
          file: pipeline.file,
          at: 'project.nested_repos',
          hint: 'project.nested_repos называет каталог собственного репозитория, а не подкаталог корневого',
        },
      );
    }

    if (!usesWorktree) continue;

    // `git worktree add … HEAD` в репозитории без коммитов невозможен —
    // сегодняшнее послабление `!ignoredByRoot` выше относится к корневому
    // `add -A` и части, которую корень игнорирует, а не к выкладке части
    // собственным `worktree add` (design.md, решение 11).
    if (!hasCommit(full)) {
      const { message, hint } = describeNoCommitForWorktree(relDir);
      throw new BurnexError(message, { file: pipeline.file, at: 'project.nested_repos', hint });
    }

    if (rootTracksPart(cwd, relDir)) {
      const { message, hint } = describeTrackedByRoot(relDir);
      throw new BurnexError(message, { file: pipeline.file, at: 'project.nested_repos', hint });
    }
  }
}
