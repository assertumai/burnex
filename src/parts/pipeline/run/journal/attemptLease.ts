import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** Never steal a stale attempt lease: an orphan backend may still have side effects. */
export function acquireAttemptLease(dir: string): () => void {
  const path = join(dir, 'active-attempt.lock');
  const generation = randomUUID();
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(`Active attempt lease exists: ${path}. Inspect the owner and backend before recovery; automatic takeover is disabled.`);
  }
  try {
    writeFileSync(fd, JSON.stringify({ generation, pid: process.pid, host: hostname(), acquired_at: new Date().toISOString() }));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return () => {
    const owner = JSON.parse(readFileSync(path, 'utf8')) as { generation?: string };
    if (owner.generation !== generation) throw new Error(`Attempt ownership changed: ${path}`);
    unlinkSync(path);
  };
}
