import { readFileSync } from 'node:fs';
import type { AgentInvocation, BackendChannel, BackendConnection, Usage } from '../../pipeline/surface.js';

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null ? value as RecordValue : {};
}
export function appServerUsage(value: unknown): Partial<Usage> {
  const raw = object(value);
  const number = (key: string): number | undefined =>
    typeof raw[key] === 'number' && Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0
      ? raw[key] as number : undefined;
  const input = number('inputTokens');
  const cached = number('cachedInputTokens');
  const written = number('cacheWriteInputTokens') ?? 0;
  const output = number('outputTokens');
  if (input === undefined || cached === undefined || output === undefined || cached + written > input) {
    throw new Error('Invalid Codex token usage breakdown');
  }
  return { tokens_in: input - cached - written, cache_read: cached, cache_write: written, tokens_out: output };
}

/** JSON-RPC over stdio, one connection per invocation. No retry after turn/start. */
export function connectAppServer(invocation: AgentInvocation, channel: BackendChannel): BackendConnection {
  let nextId = 1;
  const pending = new Map<number, (result: RecordValue) => void>();
  let threadId: string | undefined;
  let turnId: string | undefined;
  let started = false;
  let finished = false;
  let canceled = false;
  let replay: { threadId: string; usage: Partial<Usage> } | undefined;
  const fail = (message: string): void => {
    if (finished) return;
    finished = true;
    channel.emit({ kind: 'result', failed: true, text: message });
    channel.close();
  };
  const request = (method: string, params: unknown, done: (result: RecordValue) => void): void => {
    const id = nextId++;
    pending.set(id, done);
    channel.send({ id, method, params });
  };
  const startTurn = (): void => {
    if (canceled || finished) { channel.close(); return; }
    if (replay !== undefined && replay.threadId === threadId) channel.emit({ kind: 'usage_snapshot', scope: 'thread',
      sessionId: threadId!, usage: replay.usage, baseline: true });
    started = true;
    request('turn/start', { threadId, input: [{ type: 'text', text: invocation.prompt, text_elements: [] }],
      ...(invocation.effort === undefined ? {} : { effort: invocation.effort }),
      ...(invocation.outputSchemaPath === undefined ? {} :
        { outputSchema: JSON.parse(readFileSync(invocation.outputSchemaPath, 'utf8')) as unknown }) }, (result) => {
      turnId = String(object(result.turn).id ?? '');
      if (canceled && turnId !== '') request('turn/interrupt', { threadId, turnId }, () => {});
    });
  };
  request('initialize', { clientInfo: { name: 'burnex', version: '1' }, capabilities: {} }, () => {
    channel.send({ method: 'initialized', params: {} });
    const resume = invocation.resumeSession && invocation.sessionId !== undefined;
    const fork = !resume && invocation.forkFrom !== undefined;
    request(resume ? 'thread/resume' : fork ? 'thread/fork' : 'thread/start', {
      cwd: invocation.cwd, approvalPolicy: 'never',
      ...(invocation.model === undefined ? {} : { model: invocation.model }),
      ...(resume || fork ? { threadId: resume ? invocation.sessionId : invocation.forkFrom } : {}),
    }, (result) => {
      const id = object(result.thread).id;
      if (typeof id !== 'string' || id === '') { fail('Codex did not return thread.id'); return; }
      threadId = id;
      // emit is synchronous: journal persists session ID before any turn starts.
      channel.emit({ kind: 'session_started', sessionId: id });
      if (!resume && !fork) replay = { threadId: id,
        usage: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0 } };
      // A read request is also a protocol barrier for replay delivered during resume.
      request('thread/read', { threadId: id, includeTurns: false }, startTurn);
    });
  });
  return {
    receive(line) {
      if (finished || line.trim() === '') return;
      try {
        const message = object(JSON.parse(line));
        if (typeof message.id === 'number' && pending.has(message.id)) {
          const done = pending.get(message.id)!;
          pending.delete(message.id);
          if (message.error !== undefined) { fail(`Codex RPC error: ${String(object(message.error).message ?? 'unknown')}`); return; }
          done(object(message.result));
          return;
        }
        if (message.id !== undefined && typeof message.method === 'string') {
          // An unattended runner cannot grant approvals or invoke client-side tools.
          channel.send({ id: message.id, error: { code: -32601, message: 'Client requests disabled by Burnex approval policy' } });
          fail(`Unexpected Codex client request: ${message.method}`);
          return;
        }
        const params = object(message.params);
        if (message.method === 'thread/tokenUsage/updated') {
          const id = params.threadId;
          if (typeof id !== 'string') return;
          const usage = appServerUsage(object(params.tokenUsage).total);
          if (!started) { replay = { threadId: id, usage }; return; }
          if (id !== threadId) return;
          channel.emit({ kind: 'usage_snapshot', scope: 'thread', sessionId: id, usage,
            ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}) });
        } else if (message.method === 'item/completed' && params.threadId === threadId) {
          const item = object(params.item);
          if (item.type === 'agentMessage' && typeof item.text === 'string') {
            let structured: unknown;
            try { structured = JSON.parse(item.text) as unknown; } catch { /* Plain response. */ }
            channel.emit({ kind: 'result', text: item.text, ...(structured === undefined ? {} : { structured }) });
          } else if (typeof item.type === 'string') {
            channel.emit({ kind: 'tool_use', name: item.type, input: {} });
          }
        } else if (message.method === 'model/rerouted' && params.threadId === threadId) {
          // Cannot allocate cumulative usage between models using this notification.
          fail('Codex rerouted the model; cumulative cost attribution is unavailable');
        } else if (message.method === 'turn/completed' && params.threadId === threadId) {
          const turn = object(params.turn);
          if (turn.status !== 'completed') channel.emit({ kind: 'result', failed: true,
            text: `Codex turn ${String(turn.status)}: ${String(object(turn.error).message ?? '')}` });
          finished = true;
          channel.close();
        }
      } catch (error) { fail(`Invalid Codex app-server message: ${(error as Error).message}`); }
    },
    interrupt() {
      canceled = true;
      if (threadId !== undefined && turnId !== undefined) request('turn/interrupt', { threadId, turnId }, () => {});
      else if (!started) channel.close();
    },
  };
}
