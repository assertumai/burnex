import { useEffect, useState, type JSX } from 'react';
import { Button } from '@burnex/ui';

export const RUN_COLUMNS = [
  ['project', 'Project'], ['name', 'Name'], ['status', 'Status'],
  ['description', 'Description'], ['result', 'Result'], ['startedAt', 'Started'],
  ['duration', 'Duration'], ['cost', 'Cost'], ['tokens', 'Tokens'],
] as const;
export type RunColumn = (typeof RUN_COLUMNS)[number][0];
export const RUN_COLUMNS_STORAGE_KEY = 'burnex.runs.hiddenColumns.v1';

export function parseHiddenColumns(raw: string | null): RunColumn[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const hidden = RUN_COLUMNS.map(([key]) => key).filter((key) => parsed.includes(key));
    return hidden.length === RUN_COLUMNS.length ? hidden.filter((key) => key !== 'name') : hidden;
  } catch { return []; }
}

export function useRunColumns(): {
  hidden: readonly RunColumn[];
  setHidden: (columns: readonly RunColumn[]) => void;
  visible: (column: RunColumn) => boolean;
} {
  const [hidden, setHidden] = useState<readonly RunColumn[]>(() => {
    try { return parseHiddenColumns(window.localStorage.getItem(RUN_COLUMNS_STORAGE_KEY)); } catch { return []; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(RUN_COLUMNS_STORAGE_KEY, JSON.stringify(hidden)); } catch { /* Storage may be disabled. */ }
  }, [hidden]);
  return { hidden, setHidden, visible: (column) => !hidden.includes(column) };
}

export function RunColumns({ hidden, setHidden }: {
  readonly hidden: readonly RunColumn[];
  readonly setHidden: (columns: readonly RunColumn[]) => void;
}): JSX.Element {
  return (
    <details className="run-columns">
      <summary>Columns</summary>
      <fieldset className="run-columns-menu">
        <legend>Visible columns</legend>
        {RUN_COLUMNS.map(([key, label]) => (
          <label key={key}>
            <input type="checkbox" checked={!hidden.includes(key)}
              disabled={!hidden.includes(key) && hidden.length === RUN_COLUMNS.length - 1}
              onChange={(event) => setHidden(event.target.checked ? hidden.filter((item) => item !== key) : [...hidden, key])} />
            {label}
          </label>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setHidden([])}>Show all</Button>
      </fieldset>
    </details>
  );
}
