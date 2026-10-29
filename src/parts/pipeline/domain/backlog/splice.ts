import { StepcastError } from '../../../../kernel/errors.js';
import { parse, type BacklogEntry } from './parse.js';

/**
 * Файл очереди для коммита сведения: версия вершины ветки, в которой заменён
 * только блок одного пункта — без ввода-вывода.
 *
 * Живой файл очереди несёт незакоммиченные отметки соседних прогонов
 * (`in_progress`, `claimed_by`); коммит, уносящий их, закрепил бы чужую заявку
 * в истории. Поэтому берётся не живой файл целиком, а версия вершины плюс блок
 * пункта дорожки.
 */

/** Строки блока пункта: от заголовка до последнего поля, пустые строки-разделители не входят. */
function blockRange(entry: BacklogEntry): readonly [number, number] {
  return [entry.headingLine, entry.lastFieldLine + 1];
}

export function withOwnBlock(tipText: string, liveText: string, slug: string): string {
  const live = parse(liveText).find((entry) => entry.slug === slug);
  if (live === undefined) {
    throw new StepcastError(`пункт «${slug}» в живом файле очереди не найден`, { at: slug });
  }
  const [liveFrom, liveTo] = blockRange(live);
  const block = liveText.split('\n').slice(liveFrom, liveTo);

  const tip = parse(tipText).find((entry) => entry.slug === slug);
  if (tip === undefined) {
    // Пункта нет в вершине (удалён или ещё не попал в ветку) — блок дописывается
    // в конец; порядок пунктов в коммите может отличаться от живого файла.
    return `${tipText.replace(/\n*$/u, '')}\n\n${block.join('\n')}\n`;
  }

  const [tipFrom, tipTo] = blockRange(tip);
  const lines = tipText.split('\n');
  lines.splice(tipFrom, tipTo - tipFrom, ...block);
  return lines.join('\n');
}
