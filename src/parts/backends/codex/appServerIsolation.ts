import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Codex persists project trust when starting a local thread. */
function isProjectTrustConfig(content: string): boolean {
  const lines = content.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const project = /^\[projects\.(?:"(?:[^"\\]|\\.)+"|'[^']+')\]$/;
  const trust = /^trust_level\s*=\s*"(?:trusted|untrusted)"$/;
  return lines.length % 2 === 0
    && lines.every((line, index) => (index % 2 === 0 ? project : trust).test(line));
}

/** Explicit opt-in only. Burnex never copies credentials or changes the user's home. */
export function isolatedAppServerHome(env: Readonly<Record<string, string>> | undefined): string | undefined {
  const requested = env?.BURNEX_CODEX_ISOLATED_HOME;
  if (requested === undefined) return undefined;
  if (!isAbsolute(requested) || !existsSync(requested) || !statSync(requested).isDirectory()) {
    throw new Error('BURNEX_CODEX_ISOLATED_HOME must name an existing absolute directory');
  }
  const home = realpathSync(requested);
  const userHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  if (existsSync(userHome) && realpathSync(userHome) === home) {
    throw new Error('BURNEX_CODEX_ISOLATED_HOME must differ from the user Codex home');
  }
  for (const name of ['profiles', 'AGENTS.md', 'AGENTS.override.md']) {
    if (existsSync(join(home, name))) throw new Error(`Isolated Codex home must not contain ${name}`);
  }
  const config = join(home, 'config.toml');
  const stat = lstatSync(config, { throwIfNoEntry: false });
  if (stat !== undefined && (!stat.isFile() || !isProjectTrustConfig(readFileSync(config, 'utf8')))) {
    throw new Error('Isolated Codex home config.toml may only contain project trust metadata');
  }
  return home;
}
