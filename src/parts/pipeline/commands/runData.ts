import { BurnexError, ExitCode, type ExitCodeValue } from '../../../kernel/errors.js';
import { readEngineEnv } from '../../../kernel/env-names.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';
import { assertRunDataKey, publishRunData, readRunData, type RunData } from '../run/journal/runData.js';

/** Run-level publication is independent of job declarations and never rewrites runner-owned state. */
export function runRunDataCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  env: Readonly<Record<string, string | undefined>>,
): ExitCodeValue {
  const dir = readEngineEnv(env, 'RUN_DIR', { warn: false });
  if (dir === undefined || dir.trim() === '') {
    throw new BurnexError('Команда data --run работает только внутри шага прогона (BURNEX_RUN_DIR)');
  }
  const [action, key, value] = args.positional;
  if (action === 'get') {
    const data = readRunData(dir);
    if (key === undefined) write(JSON.stringify(data, null, 2));
    else {
      assertRunDataKey(key);
      const published = data[key];
      if (published === undefined) throw new BurnexError(`Прогон не публиковал поле «${key}»`);
      write(published);
    }
  } else if (action === 'set') {
    if (key === undefined || value === undefined) throw new BurnexError('set требует ключ и значение');
    assertRunDataKey(key);
    publishRunData(dir, { [key]: value });
    write(`${key}: ${value}`);
  } else if (action === 'merge') {
    const raw = args.flags['json'];
    if (typeof raw !== 'string') throw new BurnexError('merge требует --json с объектом значений');
    let patch: unknown;
    try { patch = JSON.parse(raw); } catch { throw new BurnexError('--json содержит невалидный JSON'); }
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new BurnexError('--json должен содержать объект строковых значений');
    }
    publishRunData(dir, patch as RunData);
    write(JSON.stringify(readRunData(dir), null, 2));
  } else {
    throw new BurnexError('data --run: ожидалось set, merge или get');
  }
  return ExitCode.ok;
}
