import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

/**
 * Поток событий `merge-lanes --onto`: `<run_dir>/merge-events.jsonl`.
 *
 * Формат — как у событий журнала (`ts`, `seq`, `kind`, поля), но `seq` свой:
 * `merge-lanes` исполняется отдельным процессом, пока журнал прогона открыт,
 * и счётчик `events.ndjson` живёт в памяти того процесса.
 */

const eventBase = { ts: z.string(), seq: z.number().int().nonnegative() };

export const MergeEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...eventBase,
    kind: z.literal('merge.dirty_waiting'),
    paths: z.array(z.string()),
    waited_ms: z.number().int().nonnegative(),
  }),
  z.object({
    ...eventBase,
    kind: z.literal('merge.dirty_resolved'),
    waited_ms: z.number().int().nonnegative(),
  }),
]);

export type MergeEvent = z.infer<typeof MergeEventSchema>;
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type MergeEventInput = DistributiveOmit<MergeEvent, 'ts' | 'seq'>;

export interface MergeEventWriter {
  emit(input: MergeEventInput): void;
}

/** Последний `seq` уже записанного файла; нечитаемые строки пропускаются, как в читателе журнала. */
function lastSeq(path: string): number {
  if (!existsSync(path)) return -1;
  let last = -1;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue;
    try {
      const parsed = MergeEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) last = Math.max(last, parsed.data.seq);
    } catch {
      // Оборванная строка упавшего процесса.
    }
  }
  return last;
}

/**
 * Писатель потока. `seq` продолжает записанное: повторный `merge-lanes` того
 * же прогона открывает тот же файл. `write` получает строку для вывода команды.
 */
export function openMergeEvents(
  path: string,
  write: (line: string) => void = () => undefined,
): MergeEventWriter {
  let sequence = lastSeq(path) + 1;
  return {
    emit(input) {
      const event = MergeEventSchema.parse({ ts: new Date().toISOString(), seq: sequence++, ...input });
      appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      write(describeMergeEvent(event));
    },
  };
}

export function describeMergeEvent(event: MergeEvent): string {
  const seconds = Math.round(event.waited_ms / 1000);
  switch (event.kind) {
    case 'merge.dirty_waiting':
      return `ждём чистую копию ветки уже ${seconds} с: изменены ${event.paths.join(', ')}`;
    case 'merge.dirty_resolved':
      return `копия ветки чиста, ждали ${seconds} с`;
  }
}
