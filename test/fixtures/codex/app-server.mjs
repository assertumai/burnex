#!/usr/bin/env node
// Synthetic offline CLI: no API, authentication, or user config access.
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('codex-cli synthetic'); process.exit(0); }
if (process.argv.includes('--help')) {
  console.log(process.env.FAKE_INCOMPATIBLE ? 'app-server' : 'app-server --ignore-user-config');
  process.exit(0);
}
if (process.argv.includes('generate-json-schema')) {
  const dir = join(process.argv[process.argv.indexOf('--out') + 1], 'v2');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ThreadTokenUsageUpdatedNotification.json'), JSON.stringify({
    properties: { inputTokens: {}, cachedInputTokens: {}, outputTokens: {}, threadId: {}, turnId: {} },
  }));
  writeFileSync(join(dir, '../ClientRequest.json'), JSON.stringify(['initialize', 'thread/start', 'thread/resume', 'thread/fork', 'thread/read', 'turn/start', 'turn/interrupt']));
  process.exit(0);
}
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const usage = (inputTokens) => send({ method: 'thread/tokenUsage/updated', params: {
  threadId: 'thread-synthetic', turnId: 'turn-synthetic',
  tokenUsage: { total: { inputTokens, cachedInputTokens: 0, outputTokens: 0 }, last: { inputTokens: 999999 } },
} });
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  const reply = (result) => send({ id: request.id, result });
  switch (request.method) {
    case 'initialize':
      if (process.env.FAKE_UNAUTHENTICATED) send({ id: request.id, error: {
        code: -32000, message: 'Sign in required', data: { codexErrorInfo: 'unauthorized' },
      } });
      else if (process.env.FAKE_INIT_ERROR) send({ id: request.id, error: { message: 'initialization failed' } });
      else reply({});
      break;
    case 'initialized': break;
    case 'thread/start': reply({ thread: { id: 'thread-synthetic' } }); break;
    case 'thread/resume':
    case 'thread/fork': usage(1000); reply({ thread: { id: 'thread-synthetic' } }); break;
    case 'thread/read': reply({ thread: { id: 'thread-synthetic' } }); break;
    case 'turn/start': {
      if (process.env.FAKE_STEP_DIR) {
        const checkpoint = JSON.parse(readFileSync(join(process.env.FAKE_STEP_DIR, 'active-attempt.json'), 'utf8'));
        if (checkpoint.session_id !== 'thread-synthetic') process.exit(9);
      }
      reply({ turn: { id: 'turn-synthetic' } });
      const base = process.env.FAKE_BASE ? Number(process.env.FAKE_BASE) : 0;
      usage(base + 100); usage(base + 170); usage(base + 170); usage(base + 240);
      if (process.env.FAKE_CRASH) { setTimeout(() => process.exit(7), 50); break; }
      if (process.env.FAKE_CLEAN_EOF) { setTimeout(() => process.exit(0), 50); break; }
      if (process.env.FAKE_LIMIT) {
        send({ method: 'turn/completed', params: { threadId: 'thread-synthetic',
          turn: { id: 'turn-synthetic', status: 'failed', error: {
            message: 'Subscription limit', codexErrorInfo: 'usageLimitExceeded',
            resets_at: process.env.FAKE_LIMIT === 'wait' ? Date.now() + 5000 : 2000000000,
          } } } });
        break;
      }
      if (process.env.FAKE_WAIT) break;
      setTimeout(() => {
        send({ method: 'item/completed', params: { threadId: 'thread-synthetic',
          item: { type: 'agentMessage', text: process.env.FAKE_JUDGE
            ? '{"pass":true,"reason":"verified by judge"}' : '{"answer":42}' } } });
        send({ method: 'turn/completed', params: { threadId: 'thread-synthetic', turn: { id: 'turn-synthetic', status: 'completed' } } });
      }, 80);
      break;
    }
    case 'turn/interrupt':
      if (process.env.FAKE_STEP_DIR) writeFileSync(join(process.env.FAKE_STEP_DIR, 'interrupt-received'), 'yes');
      reply({});
      send({ method: 'turn/completed', params: { threadId: 'thread-synthetic', turn: { id: 'turn-synthetic', status: 'interrupted' } } });
      break;
    default: send({ id: request.id, error: { code: -32601, message: 'unsupported' } });
  }
});
