import type { ResumeFrom } from '../resumePlan.js';
import type { RunPaths } from './paths.js';
import { runOwnerState } from './runOwnership.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { attemptProcessState, readActiveAttempt, type ActiveAttempt } from './activeAttempt.js';

/** Scan journal step directories only, never user workspaces or symbolic links. */
export function listAttemptCheckpoints(jobsDir: string): Array<{ dir: string; active: ActiveAttempt }> {
  const result: Array<{ dir: string; active: ActiveAttempt }> = [];
  const entries = (dir: string) => {
    try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  };
  const visit = (dir: string, depth: number): void => {
    if (depth > 12) return;
    const active = readActiveAttempt(dir);
    if (active !== undefined) result.push({ dir, active });
    for (const entry of entries(dir)) if (entry.isDirectory()) visit(join(dir, entry.name), depth + 1);
  };
  for (const job of entries(jobsDir)) if (job.isDirectory()) visit(join(jobsDir, job.name, 'steps'), 0);
  return result;
}

export function attemptFingerprint(jobsDir: string): string {
  return listAttemptCheckpoints(jobsDir).map(({ dir, active }) =>
    `${dir}:${active.generation}:${active.checkpoint_seq}:${attemptProcessState(active)}`).join('|');
}

/** Explicit resume is required after loss; a live/ambiguous backend always blocks it. */
export function assertAttemptsSafeToResume(jobsDir: string, explicitFrom?: ResumeFrom): void {
  for (const { dir, active } of listAttemptCheckpoints(jobsDir)) {
    if (active.state !== 'running') continue;
    const state = attemptProcessState(active);
    if (state !== 'lost') throw new Error(`Cannot resume: backend process is ${state} (${dir}). Reconcile its owner and child before starting another attempt.`);
    if (explicitFrom === undefined) throw new Error(`Interrupted attempt requires explicit resume --from after checking workspace side effects (${dir}).`);
  }
}

/** Call under the source resume lease, before restoring or running anything. */
export function assertRunSafeToResume(paths: RunPaths, explicitFrom?: ResumeFrom): void {
  const owner = runOwnerState(paths.dir);
  if (owner === 'present' || owner === 'unknown') {
    throw new Error(`Cannot resume: source runner is ${owner} (${paths.dir}). Reconcile run ownership before replay.`);
  }
  assertAttemptsSafeToResume(paths.jobs, explicitFrom);
  if (owner === 'lost' && explicitFrom === undefined) {
    throw new Error(`Interrupted run requires explicit resume --from after checking workspace side effects (${paths.dir}).`);
  }
}
