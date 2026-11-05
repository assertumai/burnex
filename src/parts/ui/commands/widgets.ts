import { readFileSync } from 'node:fs';

import { ExitCode, type ExitCodeValue } from '../../../kernel/errors.js';
import { findProjectRoot } from '../../pipeline/run/journal/paths.js';
import { SHARED_MODULE_TABLE_VERSION } from '../daemon/sharedModules.js';
import { listProjectWidgetIds, locateWidget, type WidgetSource, type WidgetSourceOptions } from '../widgets.js';
import { parseWidgetImports, unresolvedSharedNames } from '../widgetImports.js';
import { commandRow } from '../../../kernel/cli/commandRow.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';

/**
 * `burnex widgets [--json]` — состав виджетов проекта: имя, файл, голые
 * спецификаторы и то, какие имена среди них действующая таблица не несёт
 * (`widget-migration`, «Команда печатает состав виджетов проекта и их
 * разрешимость»). Тот же разбор, что видит демон (`src/parts/ui/widgets.ts`,
 * `src/parts/ui/widgetImports.ts`) — расхождение между командой и витриной здесь
 * невозможно, они зовут один и тот же код.
 */

interface UnresolvedNameView {
  /** `specifier` — таблица не несёт самого голого спецификатора; `name` — специфик остался, а имя из него ушло. */
  readonly kind: 'specifier' | 'name';
  readonly specifier: string;
  readonly name: string;
  readonly noteText?: string;
}

interface WidgetSummary {
  readonly id: string;
  /** Нет у виджета в конфликте: файл не выбран ни один. */
  readonly file?: string;
  /** Слой и, если виджет из пакета, пакет (`packages-directory-layer`). */
  readonly source: WidgetSource;
  readonly imports: readonly string[];
  readonly unresolved: readonly UnresolvedNameView[];
  /** Причина, по которой виджет не действует: `id` в двух пакетах одного слоя. */
  readonly error?: string;
}

function sourceLabel(source: WidgetSource): string {
  return source.package === undefined ? source.layer : `package ${source.package} (${source.layer})`;
}

function summarize(projectRoot: string, options: WidgetSourceOptions): readonly WidgetSummary[] {
  const summaries: WidgetSummary[] = [];
  for (const id of listProjectWidgetIds(projectRoot, options)) {
    const located = locateWidget(projectRoot, id, options);
    if (located.kind === 'conflict') {
      // Виджет в конфликте витрина не отдаёт; здесь он назван с причиной, а не
      // пропадает из состава молча.
      summaries.push({
        id,
        source: { layer: located.source.layer },
        imports: [],
        unresolved: [],
        error: `declared by two packages of one layer: ${located.packages.join(' and ')}`,
      });
      continue;
    }
    if (located.kind === 'missing') continue;
    const file = located.file;
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const imports = parseWidgetImports(source);
    const unresolved = unresolvedSharedNames(imports).map(
      (item): UnresolvedNameView => ({
        kind: item.kind,
        specifier: item.specifier,
        name: item.name,
        ...(item.noteText === undefined ? {} : { noteText: item.noteText }),
      }),
    );
    summaries.push({ id, file, source: located.source, imports: imports.map((item) => item.specifier), unresolved });
  }
  return summaries;
}

export function runWidgetsCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  options: WidgetSourceOptions = {},
): ExitCodeValue {
  const projectRoot = findProjectRoot(cwd);
  const widgets = summarize(projectRoot, options);
  const payload = { widgets, tableVersion: SHARED_MODULE_TABLE_VERSION };

  if (args.flags.json === true) {
    write(JSON.stringify(payload, null, 2));
    return ExitCode.ok;
  }

  if (widgets.length === 0) {
    write('виджетов нет');
    return ExitCode.ok;
  }

  for (const widget of widgets) {
    if (widget.error !== undefined) {
      write(`${widget.id} [${widget.source.layer} packages] — ошибка: ${widget.error}`);
      continue;
    }
    const importsLabel = widget.imports.length === 0 ? '—' : widget.imports.join(', ');
    const status =
      widget.unresolved.length === 0
        ? 'ok'
        : `устарел: ${widget.unresolved
            .map((item) => (item.kind === 'specifier' ? item.name : `${item.name} (из ${item.specifier})`))
            .join(', ')}`;
    write(`${widget.id} (${widget.file ?? ''}) [${sourceLabel(widget.source)}] — импорт: ${importsLabel} — ${status}`);
  }
  write(`версия таблицы общих модулей: ${SHARED_MODULE_TABLE_VERSION}`);
  return ExitCode.ok;
}

export const row = commandRow(
  {
    name: 'widgets',
    spec: {
      description: 'печатать состав виджетов проекта: имя, файл, голые импорты и неразрешимые по действующей таблице',
      flags: {
        json: { kind: 'boolean', description: 'печатать тот же состав машинным JSON' },
      },
    },
    run: (args, io, env) => runWidgetsCommand(args, io.out, env.cwd),
  },
);
