import { isolatedAppServerHome } from './appServerIsolation.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { withTempDir } from '../../../plugin/index.js';
import { join } from 'node:path';

export interface AppServerCapability { supported: boolean; version: string; reason: string; isolation?: 'native-flag' | 'isolated-home' }
const cache = new Map<string, AppServerCapability>();
/** Offline probe only: never starts a thread or reads credentials. */
export function probeAppServer(command: string, env?: Readonly<Record<string, string>>): AppServerCapability {
  // Revalidate filesystem isolation even when protocol capabilities are cached.
  const isolatedHome = isolatedAppServerHome(env);
  const key = JSON.stringify([command, env]);
  const previous = cache.get(key);
  if (previous !== undefined) return previous;
  const run = (args: string[]) => spawnSync(command, args, { encoding: 'utf8', timeout: 10_000,
    maxBuffer: 2_000_000, env: { ...process.env, ...env, ...(isolatedHome === undefined ? {} : { CODEX_HOME: isolatedHome }) } });
  const versionResult = run(['--version']);
  const version = versionResult.status === 0 ? versionResult.stdout.trim() : 'unknown';
  const help = run(['app-server', '--help']);
  let result: AppServerCapability = { supported: false, version, reason: 'app-server configuration isolation is not supported' };
  const isolation = isolatedHome !== undefined ? 'isolated-home' : help.stdout?.includes('--ignore-user-config') ? 'native-flag' : undefined;
  if (help.status === 0 && isolation !== undefined) {
    result = withTempDir('burnex-codex-capabilities-', (dir): AppServerCapability => {
      try {
        const generated = run(['app-server', ...(isolation === 'native-flag' ? ['--ignore-user-config'] : []), 'generate-json-schema', '--out', dir]);
        const schema = generated.status === 0
          ? JSON.parse(readFileSync(join(dir, 'v2/ThreadTokenUsageUpdatedNotification.json'), 'utf8')) as Record<string, unknown> : {};
        const text = JSON.stringify(schema);
        const requests = JSON.parse(readFileSync(join(dir, 'ClientRequest.json'), 'utf8')) as unknown;
        const methods = JSON.stringify(requests);
        const supported = ['initialize', 'thread/start', 'thread/resume', 'thread/fork', 'thread/read', 'turn/start', 'turn/interrupt']
          .every((method) => methods.includes(`"${method}"`)) && ['inputTokens', 'cachedInputTokens', 'outputTokens', 'threadId', 'turnId'].every((field) => text.includes(`"${field}"`));
        return { supported, version, isolation, reason: supported ? `${isolation}: app-server with cumulative usage schema` : 'incompatible app-server usage schema' };
      } catch { return { supported: false, version, reason: 'unable to verify app-server schema' }; }
    });
  }
  cache.set(key, result);
  return result;
}
