import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { UsageSchema } from './schema.js';

export const ProcessOwnerSchema = z.object({
  pid: z.number().int().positive(), host: z.string(), started_at: z.string(), identity: z.string().optional(),
});
type ProcessOwner = z.infer<typeof ProcessOwnerSchema>;

export const ActiveAttemptSchema = z.object({
  version: z.literal(1), generation: z.string(), checkpoint_seq: z.number().int().nonnegative(),
  attempt: z.number().int().positive(), backend: z.string(), transport: z.string(),
  state: z.enum(['running', 'completed', 'interrupted']),
  owner: ProcessOwnerSchema,
  role: z.enum(['agent', 'judge']).optional(),
  spawn_pending: z.boolean().optional(),
  child: z.object({ pid: z.number().int().positive(), started_at: z.string(), identity: z.string().optional() }).optional(),
  session_id: z.string().optional(), turn_id: z.string().optional(), diagnostic: z.string().optional(),
  started_at: z.string(), updated_at: z.string(),
  last_stdout_at: z.string().optional(), last_stderr_at: z.string().optional(),
  last_backend_event_at: z.string().optional(), last_usage_at: z.string().optional(),
  usage_state: z.enum(['unavailable', 'observed', 'closed', 'incomplete']),
  billable_tokens: z.number().optional(),
  usage: UsageSchema.optional(), ledger: z.unknown().optional(),
  exit_code: z.number().nullable().optional(), signal: z.string().nullable().optional(),
});
export type ActiveAttempt = z.infer<typeof ActiveAttemptSchema>;

/** Critical transitions fsync the file and parent directory before returning. */
export function durableWrite(path: string, content: string): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    // Windows does not expose a directory handle suitable for fsync via Node.
    if (process.platform !== 'win32') {
      fd = openSync(join(path, '..'), 'r');
      fsyncSync(fd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export interface AttemptCheckpoint {
  update(patch: Partial<ActiveAttempt>, force?: boolean): boolean;
}

export function createAttemptCheckpoint(
  dir: string, attempt: number, backend: string, transport: string, role?: ActiveAttempt['role'],
): AttemptCheckpoint {
  const now = new Date().toISOString();
  let state: ActiveAttempt = { version: 1, generation: randomUUID(), checkpoint_seq: 0,
    attempt, backend, transport, state: 'running', usage_state: 'unavailable',
    owner: currentProcessOwner(),
    ...(role === undefined ? {} : { role }),
    started_at: now, updated_at: now };
  let lastWrite = 0;
  let timer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    clearTimeout(timer); timer = undefined;
    state.checkpoint_seq++;
    const content = `${JSON.stringify(state, null, 2)}\n`;
    // The active pointer is authoritative; archive each identity before proceeding.
    durableWrite(join(dir, 'active-attempt.json'), content);
    durableWrite(join(dir, `attempt-checkpoint.${attempt}.${state.generation}.json`), content);
    lastWrite = Date.now();
  };
  return { update(patch, force = false) {
    state = { ...state, ...patch,
      ...(patch.child === undefined ? {} : { child: { ...patch.child, ...identityField(patch.child.pid) } }),
      updated_at: new Date().toISOString() };
    const remaining = 1000 - (Date.now() - lastWrite);
    if (!force && remaining > 0) {
      // Persist the last sample even when the backend goes silent afterward.
      timer ??= setTimeout(flush, remaining);
      timer.unref();
      return false;
    }
    flush();
    return true;
  } };

}

export function readActiveAttempt(dir: string | undefined): ActiveAttempt | undefined {
  if (dir === undefined) return undefined;
  try {
    const parsed = ActiveAttemptSchema.safeParse(JSON.parse(readFileSync(join(dir, 'active-attempt.json'), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

/** Read-only diagnostics: existence alone never proves process identity. */
export function attemptProcessState(active: ActiveAttempt): 'running' | 'silent' | 'lost' | 'unknown' | 'exited' {
  if (active.state !== 'running') return 'exited';
  if (active.owner.host !== hostname()) return 'unknown';
  const owner = ownerProcessState(active.owner);
  const child = active.child === undefined ? 'missing' : identifiedProcessState(active.child);
  if (active.spawn_pending && owner !== 'present') return 'unknown';
  if (owner === 'missing' && child === 'missing') return 'lost';
  if (owner !== 'present' || (active.child !== undefined && child !== 'present')) return 'unknown';
  const lastOutput = Math.max(...[active.started_at, active.last_stdout_at, active.last_stderr_at]
    .filter((value): value is string => value !== undefined).map((value) => Date.parse(value)));
  return Date.now() - lastOutput > 60_000 ? 'silent' : 'running';
}

export function currentProcessOwner(): ProcessOwner {
  return { pid: process.pid, host: hostname(), started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    ...identityField(process.pid) };
}

export function ownerProcessState(owner: ProcessOwner): 'present' | 'missing' | 'unknown' {
  if (owner.host !== hostname()) return 'unknown';
  return identifiedProcessState(owner);
}

function identifiedProcessState(processRef: { pid: number; identity?: string | undefined }): 'present' | 'missing' | 'unknown' {
  try { process.kill(processRef.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'missing' : 'unknown'; }
  return processRef.identity !== undefined && processIdentity(processRef.pid) === processRef.identity ? 'present' : 'unknown';
}

/** Absolute process start time prevents treating a reused PID as the original child. */
function processIdentity(pid: number): string | undefined {
  try {
    const identity = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim();
    return identity === '' ? undefined : identity;
  } catch { return undefined; }
}
function identityField(pid: number): { identity?: string } {
  const identity = processIdentity(pid);
  return identity === undefined ? {} : { identity };
}
