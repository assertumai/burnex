import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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
  for (const name of ['config.toml', 'profiles', 'AGENTS.md', 'AGENTS.override.md']) {
    if (existsSync(join(home, name))) throw new Error(`Isolated Codex home must not contain ${name}`);
  }
  return home;
}
