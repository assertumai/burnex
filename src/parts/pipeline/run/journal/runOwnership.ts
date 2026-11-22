import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { currentProcessOwner, durableWrite, ownerProcessState, ProcessOwnerSchema } from './activeAttempt.js';

const RunOwnerSchema = z.object({
  version: z.literal(1),
  owner: ProcessOwnerSchema,
  state: z.enum(['active', 'finished', 'interrupted']),
});

export function runOwnerPath(dir: string): string {
  return join(dir, 'run-owner.json');
}

/** A run directory has one runner for its lifetime. Resumes create a new run. */
export function beginRunOwnership(dir: string): (finished: boolean) => void {
  const path = runOwnerPath(dir);
  const owner = currentProcessOwner();
  const write = (state: z.infer<typeof RunOwnerSchema>['state']): void =>
    durableWrite(path, `${JSON.stringify({ version: 1, owner, state })}\n`);
  write('active');
  return (finished) => write(finished ? 'finished' : 'interrupted');
}

export function runOwnerState(dir: string): 'legacy' | 'finished' | 'present' | 'lost' | 'unknown' {
  try {
    const record = RunOwnerSchema.parse(JSON.parse(readFileSync(runOwnerPath(dir), 'utf8')));
    switch (record.state) {
      case 'finished': return 'finished';
      case 'interrupted': return 'lost';
      case 'active': {
        const state = ownerProcessState(record.owner);
        return state === 'missing' ? 'lost' : state;
      }
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'legacy' : 'unknown';
  }
}
