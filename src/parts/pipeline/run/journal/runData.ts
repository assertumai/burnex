import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BurnexError } from '../../../../kernel/errors.js';
import { atomicWrite } from './writer.js';

export const RUN_DATA_KEYS = ['description', 'result'] as const;
export type RunDataKey = (typeof RUN_DATA_KEYS)[number];
export type RunData = Partial<Record<RunDataKey, string>>;

export function assertRunDataKey(key: string): asserts key is RunDataKey {
  if (key !== 'description' && key !== 'result') {
    throw new BurnexError(`Недопустимое поле прогона «${key}»: ожидалось description или result`);
  }
}

export function runDataPath(runDir: string, key: RunDataKey): string {
  return join(runDir, `run-${key}.json`);
}

/** Each field has its own atomic file: concurrent jobs updating different fields cannot erase each other. */
export function readRunData(runDir: string): RunData {
  const data: RunData = {};
  for (const key of RUN_DATA_KEYS) {
    try {
      const value: unknown = JSON.parse(readFileSync(runDataPath(runDir, key), 'utf8'));
      if (typeof value === 'string') data[key] = value;
    } catch {
      // Optional publication: old runs and damaged fields remain readable.
    }
  }
  return data;
}

/** Last publication wins per field. Validate the entire patch before writing anything. */
export function publishRunData(runDir: string, patch: RunData): void {
  for (const [key, value] of Object.entries(patch)) {
    assertRunDataKey(key);
    if (typeof value !== 'string') throw new BurnexError(`Поле ${key} должно быть строкой`);
  }
  for (const [key, value] of Object.entries(patch)) {
    assertRunDataKey(key);
    atomicWrite(runDataPath(runDir, key), `${JSON.stringify(value)}\n`);
  }
}
