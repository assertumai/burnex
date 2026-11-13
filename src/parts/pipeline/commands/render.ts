import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { commandRow } from '../../../kernel/cli/commandRow.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';
import { BurnexError, ExitCode, type ExitCodeValue } from '../../../kernel/errors.js';
import { atomicWrite } from '../run/journal/writer.js';
import { DESIGN_FORMATS, isDesignFormat, readDesignDocument, renderDesign } from '../render/designDoc.js';

/** Виды рендера команды `burnex render`. */
const KINDS = ['design'] as const;

/**
 * `burnex render design <файл> --format html|openspec [--out <путь>]`
 * (`render-design`, design.md, решение 1): документ `burnex:design-doc` по
 * явному пути — в офлайн-HTML или OpenSpec `design.md`. Без `--out` — в
 * stdout, с `--out` — в файл, а stdout получает путь записанного файла.
 */
export function runRenderCommand(args: ParsedArgs, write: (line: string) => void, cwd: string = process.cwd()): ExitCodeValue {
  const [kind, file] = args.positional;
  if (kind === undefined || !(KINDS as readonly string[]).includes(kind)) {
    throw new BurnexError(`неизвестный вид рендера «${kind ?? ''}», ожидался один из: ${KINDS.join(', ')}`);
  }
  if (file === undefined) {
    throw new BurnexError('не указан файл документа', { hint: 'burnex render design <файл> --format html|openspec' });
  }
  const format = args.flags['format'];
  if (typeof format !== 'string' || !isDesignFormat(format)) {
    throw new BurnexError(
      typeof format === 'string' ? `неизвестный формат «${format}»` : 'не указан --format',
      { hint: `--format принимает: ${DESIGN_FORMATS.join(', ')}` },
    );
  }

  const text = renderDesign(readDesignDocument(resolve(cwd, file)), format);
  const out = args.flags['out'];
  if (typeof out === 'string' && out !== '') {
    const target = resolve(cwd, out);
    mkdirSync(dirname(target), { recursive: true });
    atomicWrite(target, text);
    write(target);
  } else {
    write(text.replace(/\n$/, ''));
  }
  return ExitCode.ok;
}

/** Независима от конфигурации: вход — явный путь, ни прогон, ни состав не нужны. */
export const row = commandRow(
  {
    name: 'render',
    spec: {
      description: 'отрисовать проектный документ burnex:design-doc в офлайн-HTML или OpenSpec design.md: design',
      positional: ['what', 'file'],
      flags: {
        format: { kind: 'string', description: 'формат: html | openspec, обязателен' },
        out: { kind: 'string', description: 'путь файла результата; без него — в stdout' },
      },
    },
    run: (args, io) => runRenderCommand(args, io.out, io.cwd),
  },
  { independent: true },
);
