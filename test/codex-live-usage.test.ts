import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexAdapter } from '../src/parts/backends/codex/adapter.js';
import { appServerUsage, connectAppServer } from '../src/parts/backends/codex/appServerProtocol.js';
import { probeAppServer } from '../src/parts/backends/codex/appServerCapabilities.js';
import { UsageNormalizer } from '../src/parts/pipeline/run/exec/usageNormalizer.js';
import { createSessionRegistry, executeAgentStep } from '../src/parts/pipeline/run/exec/agentStep.js';
import { createAttemptCheckpoint, readActiveAttempt, attemptProcessState, durableWrite } from '../src/parts/pipeline/run/journal/activeAttempt.js';
import { acquireAttemptLease } from '../src/parts/pipeline/run/journal/attemptLease.js';
import { assertAttemptsSafeToResume, attemptFingerprint, listAttemptCheckpoints } from '../src/parts/pipeline/run/journal/attemptRecovery.js';
import type { AgentStep } from '../src/parts/pipeline/document/model.js';
import type { BackendConfig, BackendEvent, Usage } from '../src/parts/pipeline/surface.js';
import { buildSnapshot } from '../src/parts/ui/snapshot.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { serializeLock } from '../src/parts/pipeline/document/lock.js';
import { readStatus, readUsage } from '../src/parts/pipeline/run/journal/reader.js';
import { ExitCode } from '../src/kernel/errors.js';
import { projectKey, runPaths, type RunPaths } from '../src/parts/pipeline/run/journal/paths.js';
import { runOwnerPath, runOwnerState } from '../src/parts/pipeline/run/journal/runOwnership.js';
import { planResume, readSourceRun } from '../src/parts/pipeline/run/resumePlan.js';
import { runPipeline, type RunOptions } from '../src/parts/pipeline/run/runner.js';
import { makeJournalBed, makeProject, seedRun } from './helpers.js';
import { tempDir } from './tmp.js';

const cli = fileURLToPath(new URL('../../test/fixtures/codex/app-server.mjs', import.meta.url));
const config: BackendConfig = { command: cli, enabled: true, defaultModel: undefined, concurrency: 2,
  cacheReadWeight: 0.1, sessions: true, structuredOutput: true, strictPermissions: false,
  mcp: true, permissions: undefined, env: { BURNEX_CODEX_TRANSPORT: 'app-server' } };
const snapshot = (tokens: number, baseline = false, sessionId = 's') => ({ kind: 'usage_snapshot' as const,
  scope: 'thread' as const, sessionId, baseline, usage: { tokens_in: tokens, tokens_out: 0, cache_read: 0, cache_write: 0 } });
const step: AgentStep = { kind: 'agent', id: 'code', index: 1, env: {}, context: [], contextInherit: true,
  contextExclude: [], timeoutMs: 3000, expect: [], attempts: { max: 1, escalation: [] },
  agent: 'codex', session: 'default', prompt: 'test', model: 'test-model' } as AgentStep;
function options(dir: string, env: Record<string, string> = {}) {
  return { step, cwd: dir, stepDir: dir, sessions: createSessionRegistry(),
    adapter: createCodexAdapter({ ...config, env: { ...config.env, ...env } }),
    buildPrompt: () => 'test', env: () => ({ PATH: process.env.PATH ?? '', FAKE_STEP_DIR: dir, ...env }),
    priceCatalog: { asOf: '2026-11-14', find: () => ({ backend: 'codex', model: 'test-model', aliases: [],
      input: 1, output: 1, cache_read: 0.1, cache_write: 1 }) } };
}

const judgeSteps = `      - id: check
        run: [echo, sample]
        expect:
          - judge: sample
            hard: true
            agent: codex`;

function appServerPipeline(steps: string, env: Record<string, string>, extra?: Partial<RunOptions>) {
  const project = makeProject({ 'burnex.yml': `
version: 1
kind: pipeline
name: codex-app-server
jobs:
  work:
    steps:
${steps}
` });
  const adapter = createCodexAdapter({ ...config, defaultModel: 'gpt-6.1-sol', env: { ...config.env, ...env } });
  return {
    expanded: expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config }),
    config: { ...project.config, runs: { ...project.config.runs, root: tempDir('app-server-runs-') } },
    projectRoot: project.root,
    cwd: project.root,
    adapterFor: () => adapter,
    ...extra,
  } satisfies RunOptions;
}

function runAppServerPipeline(steps: string, env: Record<string, string>) {
  return runPipeline(appServerPipeline(steps, env));
}

describe('cumulative usage ledger', () => {
  it('replaces 100 → 170 → 240, deduplicates replay and never rolls back', () => {
    const ledger = new UsageNormalizer();
    ledger.accept(snapshot(0, true));
    assert.equal(ledger.accept(snapshot(100))?.tokens_in, 100);
    assert.equal(ledger.accept(snapshot(170))?.tokens_in, 170);
    assert.equal(ledger.accept(snapshot(170)), undefined);
    assert.equal(ledger.accept(snapshot(240))?.tokens_in, 240);
    assert.equal(ledger.accept(snapshot(170)), undefined);
    assert.equal(ledger.uncertain, true);
    assert.equal(ledger.state().latest?.tokens_in, 240);
  });
  it('resume/fork baseline excludes inherited usage', () => {
    const ledger = new UsageNormalizer();
    ledger.accept(snapshot(1000, true));
    assert.equal(ledger.accept(snapshot(1450))?.tokens_in, 450);
  });
  it('unknown baseline, session changes and resets never invent usage', () => {
    const ledger = new UsageNormalizer();
    assert.equal(ledger.accept(snapshot(100)), undefined);
    assert.equal(ledger.uncertain, true);
    const changed = new UsageNormalizer(); changed.accept(snapshot(1000, true));
    assert.equal(changed.accept(snapshot(1450, false, 'different')), undefined);
    assert.equal(changed.accept(snapshot(1)), undefined);
    assert.equal(changed.state().latest?.tokens_in, 1000);
  });
  it('rejects invalid counters and duplicate baselines', () => {
    const ledger = new UsageNormalizer(); ledger.accept(snapshot(0, true));
    assert.equal(ledger.accept(snapshot(-1)), undefined);
    assert.equal(ledger.accept(snapshot(Number.NaN)), undefined);
    ledger.accept(snapshot(50, true));
    assert.equal(ledger.state().baseline?.tokens_in, 0);
  });
  it('missing categories cannot erase the regression watermark', () => {
    const ledger = new UsageNormalizer(); ledger.accept(snapshot(1000, true));
    ledger.accept(snapshot(1450));
    ledger.accept({ ...snapshot(0), usage: { tokens_out: 0 } });
    assert.equal(ledger.accept(snapshot(700)), undefined);
    assert.equal(ledger.state().latest?.tokens_in, 1450);
    assert.equal(ledger.uncertain, true);
  });
  it('handles 30,000 snapshots without additive accounting', () => {
    const ledger = new UsageNormalizer(); ledger.accept(snapshot(0, true));
    for (let i = 1; i <= 30_000; i++) assert.equal(ledger.accept(snapshot(i))?.tokens_in, i);
    assert.equal(ledger.accept(snapshot(30_000)), undefined);
  });
  it('cache write/read are disjoint; reasoning stays inside output', () => {
    assert.deepEqual(appServerUsage({ inputTokens: 12000, cachedInputTokens: 4000,
      cacheWriteInputTokens: 7000, outputTokens: 900, reasoningOutputTokens: 200, totalTokens: 999999 }),
    { tokens_in: 1000, cache_read: 4000, cache_write: 7000, tokens_out: 900 });
    assert.deepEqual(appServerUsage({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 3 }),
      { tokens_in: 80, cache_read: 20, cache_write: 0, tokens_out: 3 });
    assert.throws(() => appServerUsage({ inputTokens: 10, cachedInputTokens: 20, outputTokens: 0 }));
    const usage = createCodexAdapter(config).parseLine(JSON.stringify({ type: 'turn.completed', usage: {
      input_tokens: 12000, cached_input_tokens: 4000, cache_write_input_tokens: 7000, output_tokens: 900 } }));
    assert.equal(usage.kind === 'usage' ? usage.usage.tokens_in : undefined, 1000);
  });
});

describe('offline app-server compatibility and lifecycle', () => {
  it('probes schema and config isolation, with controlled fallback', () => {
    assert.equal(probeAppServer(cli).supported, true);
    assert.equal(probeAppServer(cli, { FAKE_INCOMPATIBLE: '1' }).supported, false);
    const invocation = { cwd: '/unused', prompt: 'test', resumeSession: false };
    const fallback = createCodexAdapter({ ...config, env: { BURNEX_CODEX_TRANSPORT: 'auto', FAKE_INCOMPATIBLE: '1' } }).launch(invocation);
    assert.equal(fallback.transport, 'exec');
    assert.match(fallback.diagnostic!, /fallback/);
    assert.throws(() => createCodexAdapter({ ...config, env: { BURNEX_CODEX_TRANSPORT: 'app-server', FAKE_INCOMPATIBLE: '1' } }).launch(invocation), /unavailable/);
    assert.equal(createCodexAdapter({ ...config, env: {} }).launch(invocation).connect, undefined);
  });
  it('supports a verified explicit isolated home without inventing a CLI flag', () => {
    const home = tempDir('codex-isolated-home-');
    const env = { BURNEX_CODEX_TRANSPORT: 'app-server', BURNEX_CODEX_ISOLATED_HOME: home, FAKE_INCOMPATIBLE: '1' };
    const invocation = { cwd: '/unused', prompt: 'test', resumeSession: false };
    const capability = probeAppServer(cli, env);
    assert.equal(capability.supported, true);
    assert.equal(capability.isolation, 'isolated-home');
    const launch = createCodexAdapter({ ...config, env }).launch(invocation);
    assert.equal(launch.command.includes('--ignore-user-config'), false);
    assert.equal(launch.env?.CODEX_HOME, realpathSync(home));
    const exec = createCodexAdapter({ ...config, env: { BURNEX_CODEX_ISOLATED_HOME: home } }).launch(invocation);
    assert.equal(exec.connect, undefined);
    assert.equal(exec.env?.CODEX_HOME, realpathSync(home));
    const trustConfig = '[projects."/private/tmp/smoke/project"]\ntrust_level = "trusted"\n';
    writeFileSync(join(home, 'config.toml'), trustConfig);
    assert.equal(probeAppServer(cli, env).supported, true);
    assert.ok(createCodexAdapter({ ...config, env }).launch(invocation).connect);
    writeFileSync(join(home, 'config.toml'), trustConfig + '\n[mcp_servers.personal]\ncommand="never-start"\n');
    assert.throws(() => probeAppServer(cli, env), /only contain project trust metadata/);
  });
  it('retains sandbox, mandatory MCP, model, effort and output schema routing', () => {
    const launch = createCodexAdapter(config).launch({ cwd: '/unused', prompt: 'test', resumeSession: false,
      model: 'test-model', effort: 'high', outputSchemaPath: '/unused/schema',
      permissions: { mode: 'read-only' }, mcpServers: { tools: { command: ['node', 'server'] } } });
    assert.ok(launch.command.includes('--ignore-user-config'));
    assert.ok(launch.command.includes('approval_policy="never"'));
    assert.ok(launch.command.includes('sandbox_mode="read-only"'));
    assert.ok(launch.command.includes('mcp_servers.tools.required=true'));
    assert.equal(launch.command.includes('--output-schema'), false);
  });
  it('saves thread ID before turn/start and publishes priced usage before completion', async () => {
    const dir = tempDir('app-server-');
    const updates: Usage[] = [];
    const result = await executeAgentStep({ ...options(dir), onUsage: (usage) => {
      updates.push(usage);
      if (usage.tokens_in === 100) {
        assert.equal(readActiveAttempt(dir)?.state, 'running');
        assert.equal(usage.cost_usd, 0.0001);
      }
    } });
    assert.equal(result.status, 'success');
    assert.deepEqual(updates.filter((u) => u.wallclock_ms === 0).map((u) => u.tokens_in), [100, 170, 240]);
    assert.equal(result.last?.usage.tokens_in, 240);
    assert.equal(result.last?.usage.cost_usd, 0.00024);
    assert.deepEqual(result.last?.structured, { answer: 42 });
    const checkpoint = readActiveAttempt(dir)!;
    assert.equal(checkpoint.session_id, 'thread-synthetic');
    assert.equal(checkpoint.usage_state, 'closed');
    assert.equal(checkpoint.usage?.tokens_in, 240);
    assert.equal(checkpoint.state, 'completed');
    assert.equal(existsSync(join(dir, 'active-attempt.lock')), false);
  });
  for (const mode of ['resume', 'fork'] as const) it(`${mode} excludes replayed history`, async () => {
    const dir = tempDir('app-server-resume-');
    const opts = options(dir, { FAKE_BASE: '1000' });
    if (mode === 'resume') opts.sessions.seed('default', 'old-thread');
    const result = await executeAgentStep({ ...opts, step: { ...step, ...(mode === 'fork' ? { forkFrom: 'old-thread' } : {}) } });
    assert.equal(result.last?.usage.tokens_in, 240);
  });
  it('uses turn/interrupt before process signals and preserves incomplete usage', async () => {
    const dir = tempDir('app-server-interrupt-');
    const controller = new AbortController();
    const result = await executeAgentStep({ ...options(dir, { FAKE_WAIT: '1' }), signal: controller.signal,
      graceMs: 200, onUsage: (usage) => { if (usage.tokens_in === 240) controller.abort(); } });
    assert.equal(result.status, 'canceled');
    assert.equal(readActiveAttempt(dir)?.usage_state, 'incomplete');
    assert.equal(readActiveAttempt(dir)?.usage?.tokens_in, 240);
    assert.equal(readFileSync(join(dir, 'interrupt-received'), 'utf8'), 'yes');
  });
  it('keeps last usage after unexpected child exit; never relaunches it', async () => {
    const dir = tempDir('app-server-crash-');
    const result = await executeAgentStep(options(dir, { FAKE_CRASH: '1' }));
    assert.equal(result.status, 'failed');
    assert.equal(result.attempts.length, 1);
    assert.equal(readActiveAttempt(dir)?.usage_state, 'incomplete');
    assert.equal(readActiveAttempt(dir)?.usage?.tokens_in, 240);
  });
  it('fails closed on initialize errors and server approval requests', () => {
    for (const response of [{ id: 1, error: { message: 'incompatible' } },
      { id: 99, method: 'item/commandExecution/requestApproval', params: {} }]) {
      const emitted: BackendEvent[] = []; let closed = false; const sent: unknown[] = [];
      const connection = connectAppServer({ cwd: '/unused', prompt: 'test', resumeSession: false },
        { send: (m) => sent.push(m), emit: (e) => emitted.push(e), close: () => { closed = true; } });
      connection.receive(JSON.stringify(response));
      assert.equal(closed, true);
      assert.ok(emitted.some((e) => e.kind === 'result' && e.failed));
      assert.equal(sent.some((m) => (m as { method?: string }).method === 'turn/start'), false);
    }
  });

  for (const [env, diagnostic] of [
    ['FAKE_INIT_ERROR', /initialization failed/],
    ['FAKE_CLEAN_EOF', /exited before turn\/completed/],
  ] as const) {
    it(`rejects an incomplete turn despite a clean process exit (${env})`, async () => {
      const run = await runAppServerPipeline(`      - id: code
        agent: codex
        prompt: test
        expect: [{ exit_code: 0 }]`, { [env]: '1' });
      assert.equal(run.status, 'failed');
      assert.match(readStatus(run.journal.paths).jobs[0]?.steps[0]?.reason ?? '', diagnostic);
    });
  }

  for (const [tier, cost] of [['standard', 0.00048], ['fast', 0.00096], ['flex', 0.00024]] as const) {
    it(`prices agent and judge snapshots at the requested ${tier} tier`, async () => {
      const env = { BURNEX_CODEX_SERVICE_TIER: tier };
      const agent = await runAppServerPipeline(`      - id: code
        agent: codex
        model: gpt-6.1-sol
        prompt: test`, env);
      const judge = await runAppServerPipeline(judgeSteps, { ...env, FAKE_JUDGE: '1' });
      for (const run of [agent, judge]) {
        assert.equal(run.status, 'success');
        const checkpoint = listAttemptCheckpoints(run.journal.paths.jobs)[0]?.active;
        assert.equal(checkpoint?.usage?.pricing?.requested_service_tier, tier);
        assert.equal(checkpoint?.usage?.cost_usd, cost);
        assert.equal(readUsage(run.journal.paths).total.billable_tokens, 240);
      }
    });
  }

  it('applies the live Fast cost ceiling before a waiting turn can complete', async () => {
    const run = await runAppServerPipeline(`      - id: code
        agent: codex
        model: gpt-6.1-sol
        prompt: test
        timeout: 3s
        budget:
          cost: 0.0006`, { BURNEX_CODEX_SERVICE_TIER: 'fast', FAKE_WAIT: '1' });
    assert.equal(run.status, 'budget_exceeded');
    assert.equal(listAttemptCheckpoints(run.journal.paths.jobs)[0]?.active.usage?.cost_usd, 0.00096);
  });

  it('routes typed app-server failures through runner refusal handling', async () => {
    const agent = `      - id: code
        agent: codex
        prompt: test`;
    const auth = await runAppServerPipeline(agent, { FAKE_UNAUTHENTICATED: '1' });
    assert.equal(auth.exitCode, ExitCode.backendUnavailable);
    const limit = await runAppServerPipeline(agent, { FAKE_LIMIT: '1' });
    assert.equal(limit.exitCode, ExitCode.budgetExceeded);
    const events = readFileSync(limit.journal.paths.events, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
    const refusal = events.find((event) => event.kind === 'backend.refused');
    assert.equal(refusal?.class, 'rate_limit');
    assert.equal(refusal?.resets_at, 2000000000000);

    const controller = new AbortController();
    let waited = false;
    const waiting = await runPipeline(appServerPipeline(agent + `
        budget:
          rate_limit_pct: 80
          on_exceed: wait`, { FAKE_LIMIT: 'wait' }, {
      signal: controller.signal,
      onEvent(event) {
        if (event.kind === 'budget.waiting') {
          waited = true;
          controller.abort();
        }
      },
    }));
    assert.equal(waited, true);
    assert.equal(waiting.status, 'canceled');
  });
});

describe('attempt durability, ownership and read-only recovery', () => {
  it('fences a live judge and requires explicit intent for library recovery after owner loss', async () => {
    const controller = new AbortController();
    let paths: RunPaths | undefined;
    const execution = appServerPipeline(judgeSteps, { FAKE_WAIT: '1' }, {
      signal: controller.signal,
      onEvent(event) {
        if (event.kind === 'run.started') {
          paths = runPaths(execution.config.runs.root, projectKey(execution.projectRoot), event.run_id);
        }
      },
    });
    const running = runPipeline(execution);
    try {
      for (let i = 0; i < 200 && !pathsHaveJudge(); i++) await delay(20);
      assert.ok(paths !== undefined && pathsHaveJudge());
      const sourcePaths = paths;
      const source = readSourceRun(sourcePaths);
      const build = (from?: string, snapshot = source) => planResume({
        config: execution.config, cwd: execution.cwd, source: snapshot,
        ...(from === undefined ? {} : { from }),
      });
      const explicit = build('work');
      await assert.rejects(runPipeline({ ...execution, ...explicit, resume: { source, plan: explicit.plan } }),
        /source runner is present/);

      // A surviving judge keeps the recovery unsafe even after the runner is lost.
      const judge = listAttemptCheckpoints(sourcePaths.jobs).find(({ active }) => active.role === 'judge')!;
      const originalCheckpoint = readFileSync(join(judge.dir, 'active-attempt.json'), 'utf8');
      const originalOwner = readFileSync(runOwnerPath(sourcePaths.dir), 'utf8');
      try {
        const missingPid = 2147483647;
        durableWrite(runOwnerPath(sourcePaths.dir), JSON.stringify({
          version: 1, state: 'active', owner: { ...judge.active.owner, pid: missingPid },
        }));
        durableWrite(join(judge.dir, 'active-attempt.json'), JSON.stringify({
          ...judge.active, owner: { ...judge.active.owner, pid: missingPid },
        }));
        await assert.rejects(runPipeline({ ...execution, ...explicit, resume: { source, plan: explicit.plan } }),
          /backend process is unknown/);
      } finally {
        durableWrite(runOwnerPath(sourcePaths.dir), originalOwner);
        durableWrite(join(judge.dir, 'active-attempt.json'), originalCheckpoint);
      }

      controller.abort();
      await running;
      assert.equal(runOwnerState(sourcePaths.dir), 'finished');
      durableWrite(runOwnerPath(sourcePaths.dir), JSON.stringify({
        version: 1, state: 'active', owner: { ...judge.active.owner, pid: 2147483647 },
      }));
      const automatic = build();
      assert.ok(automatic.plan.steps.some(({ decision }) => decision.kind === 'rerun'));
      await assert.rejects(runPipeline({ ...execution, ...automatic, resume: { source, plan: automatic.plan } }),
        /Interrupted run requires explicit resume --from/);
      const release = acquireAttemptLease(sourcePaths.dir);
      try {
        await assert.rejects(runPipeline({ ...execution, ...explicit, resume: { source, plan: explicit.plan } }),
          /lease exists/);
      } finally { release(); }
      await assert.rejects(runPipeline({ ...execution, ...explicit, resume: { source, plan: explicit.plan } }),
        /source run changed while planning resume/);
      const settled = readSourceRun(sourcePaths);
      const recovery = build('work', settled);
      const result = await runPipeline({
        ...execution, expanded: recovery.expanded,
        signal: new AbortController().signal,
        adapterFor: () => createCodexAdapter({ ...config, env: { ...config.env, FAKE_JUDGE: '1' } }),
        resume: { source: settled, plan: recovery.plan },
      });
      assert.equal(result.status, 'success');
      assert.notEqual(result.journal.paths.runId, sourcePaths.runId);
      assert.equal(runOwnerState(sourcePaths.dir), 'lost');
      assert.equal(runOwnerState(result.journal.paths.dir), 'finished');
    } finally {
      controller.abort();
      await running;
    }

    function pathsHaveJudge(): boolean {
      return paths !== undefined && listAttemptCheckpoints(paths.jobs).some(({ active }) =>
        active.role === 'judge' && active.child !== undefined);
    }
  });

  it('retains generations, throttles measurements, and flushes critical transitions', () => {
    const dir = tempDir('checkpoint-');
    const checkpoint = createAttemptCheckpoint(dir, 1, 'codex', 'exec');
    assert.equal(checkpoint.update({ session_id: 's' }, true), true);
    const first = readActiveAttempt(dir)!;
    assert.equal(checkpoint.update({ last_usage_at: 'later' }), false);
    checkpoint.update({ state: 'interrupted' }, true);
    assert.equal(readActiveAttempt(dir)?.checkpoint_seq, first.checkpoint_seq + 1);
    assert.equal(readActiveAttempt(dir)?.last_usage_at, 'later');
    createAttemptCheckpoint(dir, 1, 'codex', 'exec').update({}, true);
    assert.equal(readdirSync(dir).filter((name) => name.startsWith('attempt-checkpoint.')).length, 2);
  });
  it('flushes a trailing measurement even when no more output arrives', async () => {
    const dir = tempDir('checkpoint-trailing-');
    const checkpoint = createAttemptCheckpoint(dir, 1, 'codex', 'exec');
    checkpoint.update({}, true);
    checkpoint.update({ billable_tokens: 240 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(readActiveAttempt(dir)?.billable_tokens, 240);
    assert.equal(readActiveAttempt(dir)?.checkpoint_seq, 2);
  });
  it('exclusive lease rejects another writer and verifies generation on release', () => {
    const dir = tempDir('lease-'); const release = acquireAttemptLease(dir);
    assert.throws(() => acquireAttemptLease(dir), /lease exists/);
    const path = join(dir, 'active-attempt.lock');
    const owner = readFileSync(path, 'utf8');
    writeFileSync(path, '{"generation":"another"}');
    assert.throws(release, /ownership changed/);
    assert.equal(existsSync(path), true);
    writeFileSync(path, owner); release();
    const next = acquireAttemptLease(dir); next();
  });
  it('distinguishes silence, loss, foreign hosts and PID reuse without writing', () => {
    const dir = tempDir('recovery-');
    createAttemptCheckpoint(dir, 1, 'codex', 'exec').update({}, true);
    const active = readActiveAttempt(dir)!;
    assert.equal(attemptProcessState(active), 'running');
    assert.equal(attemptProcessState({ ...active, started_at: '2000-01-01' }), 'silent');
    assert.equal(attemptProcessState({ ...active, owner: { ...active.owner, identity: 'reused-pid' } }), 'unknown');
    assert.equal(attemptProcessState({ ...active, owner: { ...active.owner, host: 'other-host' } }), 'unknown');
    const orphan = { ...active, owner: { ...active.owner, pid: 2147483647 } };
    assert.equal(attemptProcessState(orphan), 'lost');
    assert.equal(attemptProcessState({ ...orphan, spawn_pending: true }), 'unknown');
  });
  it('read-only fingerprint detects runner loss; explicit from never bypasses live children', () => {
    const root = tempDir('recovery-tree-'); const dir = join(root, 'job', 'steps', '01-code');
    mkdirSync(dir, { recursive: true });
    createAttemptCheckpoint(dir, 1, 'codex', 'exec').update({}, true);
    const active = readActiveAttempt(dir)!;
    const path = join(dir, 'active-attempt.json');
    const before = readFileSync(path, 'utf8');
    assert.ok(attemptFingerprint(root).includes(active.generation));
    assert.throws(() => assertAttemptsSafeToResume(root, { job: 'job' }), /Cannot resume/);
    assert.equal(readFileSync(path, 'utf8'), before);
    durableWrite(path, JSON.stringify({ ...active, owner: { ...active.owner, pid: 2147483647, host: hostname() } }));
    assert.throws(() => assertAttemptsSafeToResume(root), /explicit resume/);
    assert.doesNotThrow(() => assertAttemptsSafeToResume(root, { job: 'job' }));
  });
});


describe('durable usage UI and exec fallback baselines', () => {
  it('shows an active step without a StepRecord, including checkpoint after projection loss', () => {
    const project = makeProject({ 'burnex.yml': `version: 1
kind: pipeline
name: live
jobs:
  work:
    steps:
      - id: code
        agent: claude
        prompt: test
` });
    const lock = serializeLock(expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config }).pipeline);
    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, { status: 'running', lock,
      jobs: [{ id: 'work', status: 'running', steps: [] }] });
    const dir = join(journal.paths.jobs, 'work', 'steps', '01-code');
    mkdirSync(dir, { recursive: true });
    createAttemptCheckpoint(dir, 1, 'codex', 'exec').update({ session_id: 'durable-thread',
      billable_tokens: 240, usage_state: 'observed', usage: { backend: 'codex', tokens_in: 240,
        tokens_out: 0, cache_read: 0, cache_write: 0, wallclock_ms: 0, cost_usd: 0.00024, cost_source: 'catalog' } }, true);
    // Deliberately leave status/usage projections unchanged.
    const before = readFileSync(journal.paths.status, 'utf8');
    const snapshot = buildSnapshot(journal.paths, 'test-project');
    const active = snapshot.jobs[0]?.steps[0];
    assert.equal(active?.status, 'running');
    assert.equal(active?.attempts, 1);
    assert.equal(active?.activeAttempt?.session_id, 'durable-thread');
    assert.equal(active?.activeAttempt?.billable_tokens, 240);
    assert.equal(active?.activeAttempt?.usage?.cost_usd, 0.00024);
    const path = join(dir, 'active-attempt.json');
    const checkpoint = readActiveAttempt(dir)!;
    durableWrite(path, JSON.stringify({ ...checkpoint, owner: { ...checkpoint.owner, pid: 2147483647 } }));
    const recovered = buildSnapshot(journal.paths, 'test-project');
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.jobs[0]?.steps[0]?.activeAttempt?.usage_state, 'incomplete');
    assert.equal(recovered.jobs[0]?.steps[0]?.activeAttempt?.usage?.tokens_in, 240);
    assert.equal(readFileSync(journal.paths.status, 'utf8'), before);
  });
  it('preserves recorded Codex exec usage when the resumed turn reports lower counters', async () => {
    const sessions = createSessionRegistry();
    const real = createCodexAdapter({ ...config, env: {} });
    const run = (fixture: string, expectedResume: boolean, sessionsForRun = sessions) => {
      const path = fileURLToPath(new URL(`../../test/fixtures/codex/${fixture}.jsonl`, import.meta.url));
      const adapter: typeof real = { ...real, launch: (invocation) => {
        assert.equal(invocation.resumeSession, expectedResume);
        return {
          command: [process.execPath, '-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', path],
          stdin: '',
        };
      } };
      const dir = tempDir('exec-turn-usage-');
      return executeAgentStep({ ...options(dir), adapter, sessions: sessionsForRun });
    };
    const first = await run('run1', false);
    assert.ok(first.sessionId);
    assert.equal(first.last?.usage.tokens_in, 18600);
    assert.equal((await run('run2', true)).last?.usage.tokens_in, 6416);

    const seeded = createSessionRegistry();
    seeded.seed('default', first.sessionId);
    assert.equal((await run('run2', true, seeded)).last?.usage.tokens_in, 6416);
  });
});


it('SIGKILL runner preserves the durable ledger and leaves ownership fenced', async () => {
  const dir = tempDir('killed-runner-');
  const checkpointModule = new URL('../src/parts/pipeline/run/journal/activeAttempt.js', import.meta.url).href;
  const leaseModule = new URL('../src/parts/pipeline/run/journal/attemptLease.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createAttemptCheckpoint } from ${JSON.stringify(checkpointModule)};
    import { acquireAttemptLease } from ${JSON.stringify(leaseModule)};
    const dir = ${JSON.stringify(dir)};
    acquireAttemptLease(dir);
    createAttemptCheckpoint(dir, 1, 'codex', 'app-server-stdio').update({
      session_id: 'durable-before-kill', usage_state: 'observed', billable_tokens: 240,
      usage: {backend:'codex',tokens_in:240,tokens_out:0,cache_read:0,cache_write:0,wallclock_ms:0}
    }, true);
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Runner exited before checkpoint'); })]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const checkpoint = readActiveAttempt(dir)!;
    assert.equal(checkpoint.session_id, 'durable-before-kill');
    assert.equal(checkpoint.usage?.tokens_in, 240);
    assert.equal(attemptProcessState(checkpoint), 'lost');
    assert.throws(() => acquireAttemptLease(dir), /lease exists/);
  } finally { child.kill('SIGKILL'); }
});


it('normalizes sanitized snapshots captured from real Codex 0.169.0', () => {
  const fixturePath = fileURLToPath(new URL('../../test/fixtures/codex/app-server-0.169.0-smoke.json', import.meta.url));
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { scenarios: Array<{
    mode: string; baseline: Partial<Usage>; snapshots: Array<Partial<Usage>>; expectedAttempt: Partial<Usage>;
  }> };
  for (const scenario of fixture.scenarios) {
    const ledger = new UsageNormalizer();
    ledger.accept({ kind: 'usage_snapshot', scope: 'thread', sessionId: scenario.mode, baseline: true, usage: scenario.baseline });
    let actual: Partial<Usage> | undefined;
    for (const usage of scenario.snapshots) actual = ledger.accept({ kind: 'usage_snapshot', scope: 'thread', sessionId: scenario.mode, usage }) ?? actual;
    assert.deepEqual(actual, scenario.expectedAttempt, scenario.mode);
    assert.equal(ledger.uncertain, false, scenario.mode);
  }
});
