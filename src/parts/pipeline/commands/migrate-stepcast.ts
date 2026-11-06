import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve as resolvePath } from 'node:path';

import { commandRow } from '../../../kernel/cli/commandRow.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';
import { CABINET_DIR_NAME, LEGACY_CABINET_DIR_NAME, DEFAULT_PIPELINE_FILE, LEGACY_DEFAULT_PIPELINE_FILE } from '../../../kernel/dirs.js';
import { ExitCode, type ExitCodeValue } from '../../../kernel/errors.js';
import { installManifestPath } from '../../install/manifest.js';

/**
 * `burnex migrate-stepcast [path]` — отсылки проекта на прежнее имя движка и
 * что с каждой сделать. Команда только находит и называет: правит файлы
 * владелец проекта (или агент по скиллу переноса), а движок один выпуск
 * читает прежние имена и так (`docs/release.md`, «Переход со stepcast»).
 *
 * Независима от конфигурации: проект посреди переноса — ровно тот, чей
 * конфиг может не разобраться, и проверка обязана работать именно тогда.
 * Не читаются `.git`, `.claude` (чужие рабочие деревья), зависимости, сборки
 * и очередь предложений: там либо не правят, либо правят не руками.
 *
 * Что проверяется:
 * - каталог кабинета `.stepcast/` и файл `stepcast.yml` в корне;
 * - текст файлов проекта: переменные `STEPCAST_*`, адреса `stepcast:<имя>`,
 *   подпути `stepcast/<…>`, модули `@stepcast/*`, вызовы `stepcast <команда>`,
 *   права `Bash(stepcast …)`, пути `.stepcast/`, `stepcast.yml`,
 *   `node_modules/stepcast`, метка `ai.stepcast.daemon`;
 * - домашний каталог: `~/.stepcast` без `~/.burnex`, паспорт установки
 *   способом npm с пакетом `stepcast`.
 */

export interface MigrationFinding {
  /** Файл или каталог относительно корня проекта; `~` — домашний каталог. */
  readonly where: string;
  readonly line?: number;
  /** Что найдено — текст как есть. */
  readonly found: string;
  /** Что сделать. */
  readonly fix: string;
}

interface Rule {
  readonly pattern: RegExp;
  readonly fix: (match: RegExpExecArray) => string;
}

const CLI_COMMANDS =
  'run|resume|diff|decide|propose|widgets|apply|lint|status|logs|config|schema|plugins|package|gc|init|context|up|down|update|usage|backlog|knowledge|data|merge-lanes|assert-clean|project|migrate-stepcast';

/**
 * Порядок правил — порядок перебора по строке: каждое совпадение
 * засчитывается один раз, и более узкие образцы стоят раньше широких
 * (`.stepcast/` раньше голого `stepcast`, которого здесь и нет вовсе: слово
 * само по себе — не отсылка, а, например, название в прозе).
 */
const RULES: readonly Rule[] = [
  { pattern: /\bSTEPCAST_([A-Z0-9_]+)/g, fix: (m) => `BURNEX_${m[1]}` },
  { pattern: /ai\.stepcast\.daemon/g, fix: () => 'ai.burnex.daemon' },
  { pattern: /node_modules\/stepcast\b/g, fix: () => 'node_modules/burnex' },
  { pattern: /@stepcast\/(slots|ui)\b/g, fix: (m) => `@burnex/${m[1]}` },
  { pattern: /(?<![\w@./-])stepcast\/(plugin|pipeline|step|backends)\b/g, fix: (m) => `burnex/${m[1]}` },
  { pattern: /\bstepcast:([a-z][a-z0-9-]*)/g, fix: (m) => `burnex:${m[1]}` },
  { pattern: /Bash\(stepcast\b/g, fix: () => 'Bash(burnex' },
  { pattern: new RegExp(String.raw`(?<![\w./-])stepcast (?=(?:${CLI_COMMANDS})\b)`, 'g'), fix: () => 'burnex ' },
  { pattern: /(?<![\w-])\.stepcast(?=[/\\'"`\s)]|$)/g, fix: () => CABINET_DIR_NAME },
  { pattern: /(?<![\w./-])stepcast\.yml\b/g, fix: () => DEFAULT_PIPELINE_FILE },
];

const TEXT_EXTENSIONS = new Set([
  '.yml', '.yaml', '.md', '.txt', '.json', '.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx', '.sh', '.bash', '.zsh',
  '.env', '.toml', '.ini', '.cfg', '.py', '.rb', '.gitignore', '.plist', '.xml',
]);
const TEXT_BASENAMES = new Set(['.gitignore', '.env', 'Makefile', 'Dockerfile', 'README']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'proposals']);
/** Скрытые каталоги, которые всё же читаются: кабинет движка и правила агентов. Остальные (.git, .claude, .runtime, .idea…) — чужие или служебные. */
const READ_HIDDEN_DIRS = new Set([CABINET_DIR_NAME, LEGACY_CABINET_DIR_NAME, '.agents', '.github', '.cursor']);

/** Вложенный репозиторий git — другой проект со своим переносом; архив openspec — история, которую не правят. */
function isForeignDir(dir: string, name: string): boolean {
  if (name.startsWith('.') && !READ_HIDDEN_DIRS.has(name)) return true;
  if (SKIPPED_DIRS.has(name)) return true;
  if (name === 'archive' && dir.endsWith(join('openspec', 'changes'))) return true;
  return existsSync(join(dir, name, '.git'));
}
const MAX_FILE_BYTES = 1_000_000;

function isTextFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (TEXT_BASENAMES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  return dot !== -1 && TEXT_EXTENSIONS.has(name.slice(dot));
}

/** Файлы проекта, которые стоит читать: без служебных и скрытых каталогов, вложенных репозиториев, зависимостей, сборок, архива openspec, очереди предложений и бинарников. */
function* walk(root: string): Generator<string> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!isForeignDir(dir, entry.name)) stack.push(path);
        continue;
      }
      if (!entry.isFile() || !isTextFile(path)) continue;
      yield path;
    }
  }
}

function scanText(root: string, path: string, out: MigrationFinding[]): void {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size > MAX_FILE_BYTES) return;
  const text = readFileSync(path, 'utf8');
  if (!text.includes('stepcast') && !text.includes('STEPCAST')) return;
  const where = relative(root, path) || path;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(line)) !== null) {
        out.push({ where, line: index + 1, found: match[0], fix: `→ ${rule.fix(match)}` });
      }
    }
  });
}

function layoutFindings(root: string, out: MigrationFinding[]): void {
  const legacyCabinet = join(root, LEGACY_CABINET_DIR_NAME);
  if (existsSync(legacyCabinet)) {
    out.push({
      where: `${LEGACY_CABINET_DIR_NAME}/`,
      found: 'кабинет проекта под прежним именем',
      fix: existsSync(join(root, CABINET_DIR_NAME))
        ? `рядом уже есть ${CABINET_DIR_NAME}/ — перенесите содержимое в него и удалите ${LEGACY_CABINET_DIR_NAME}/`
        : `git mv ${LEGACY_CABINET_DIR_NAME} ${CABINET_DIR_NAME}`,
    });
  }
  if (existsSync(join(root, LEGACY_DEFAULT_PIPELINE_FILE))) {
    out.push({
      where: LEGACY_DEFAULT_PIPELINE_FILE,
      found: 'пайплайн по умолчанию под прежним именем',
      fix: existsSync(join(root, DEFAULT_PIPELINE_FILE))
        ? `рядом уже есть ${DEFAULT_PIPELINE_FILE} — объедините и удалите ${LEGACY_DEFAULT_PIPELINE_FILE}`
        : `git mv ${LEGACY_DEFAULT_PIPELINE_FILE} ${DEFAULT_PIPELINE_FILE}`,
    });
  }
}

export function homeFindings(home: string, env: Readonly<Record<string, string | undefined>> = process.env): MigrationFinding[] {
  const out: MigrationFinding[] = [];
  const legacy = join(home, LEGACY_CABINET_DIR_NAME);
  let legacyIsDir = false;
  try {
    const stat = lstatSync(legacy);
    legacyIsDir = stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    legacyIsDir = false;
  }
  if (legacyIsDir && !existsSync(join(home, CABINET_DIR_NAME))) {
    out.push({
      where: `~/${LEGACY_CABINET_DIR_NAME}`,
      found: 'домашний каталог под прежним именем',
      fix: `перенесёт сам install.sh, burnex up или burnex update (переименование + ссылка на прежнем месте)`,
    });
  }
  const manifestPath = installManifestPath(env, home);
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { method?: unknown; package?: unknown };
      if (manifest.method === 'npm' && manifest.package === 'stepcast') {
        out.push({
          where: relative(home, manifestPath).startsWith('..') ? manifestPath : `~/${relative(home, manifestPath)}`,
          found: '"package": "stepcast"',
          fix: '→ "package": "burnex" — иначе burnex update поставит пакет под прежним именем',
        });
      }
    } catch {
      // Нечитаемый паспорт — забота `burnex update`, не этой проверки.
    }
  }
  return out;
}

export function collectMigrationFindings(root: string): MigrationFinding[] {
  const out: MigrationFinding[] = [];
  layoutFindings(root, out);
  for (const path of walk(root)) scanText(root, path, out);
  return out;
}

function formatFinding(finding: MigrationFinding): string {
  const place = finding.line === undefined ? finding.where : `${finding.where}:${finding.line}`;
  return `${place}: ${finding.found} ${finding.fix}`;
}

export function runMigrateStepcastCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  home: string = homedir(),
): ExitCodeValue {
  const root = resolvePath(cwd, args.positional[0] ?? '.');
  const project = collectMigrationFindings(root);
  const homeItems = homeFindings(home);
  const all = [...project, ...homeItems];

  if (args.flags.json === true) {
    write(JSON.stringify({ root, findings: all }, null, 2));
    return all.length === 0 ? ExitCode.ok : ExitCode.configError;
  }

  if (all.length === 0) {
    write(`ok: отсылок на stepcast в ${root} нет`);
    return ExitCode.ok;
  }
  if (args.flags.files === true) {
    // Сводка по файлам: с чего начинать в большом проекте, где построчный
    // перечень — тысячи строк. Каталоги и домашний каталог — как есть.
    const counts = new Map<string, number>();
    for (const finding of all) counts.set(finding.where, (counts.get(finding.where) ?? 0) + 1);
    for (const [where, count] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      write(`${where}: ${count}`);
    }
  } else {
    for (const finding of all) write(formatFinding(finding));
  }
  write(`${root}: отсылок на stepcast ${project.length}${homeItems.length === 0 ? '' : `, домашний каталог ${homeItems.length}`}`);
  write('Прежние имена движок читает ещё один выпуск; правьте по подсказкам выше, порядок — docs/release.md, «Переход со stepcast».');
  return ExitCode.configError;
}

export const row = commandRow(
  {
    name: 'migrate-stepcast',
    spec: {
      description: 'найти в проекте отсылки на прежнее имя движка stepcast и сказать, что исправить',
      positional: ['path'],
      flags: {
        files: { kind: 'boolean', description: 'сводка по файлам: сколько отсылок в каждом, без строк' },
        json: { kind: 'boolean', description: 'печатать находки машинным JSON' },
      },
    },
    run: (args, io, env) => runMigrateStepcastCommand(args, io.out, env.cwd),
  },
  { independent: true },
);
