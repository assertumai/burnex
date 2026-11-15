import assert from 'node:assert/strict';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { CliIo } from '../src/kernel/cli/args.js';
import { run as runCli } from '../src/parts/cli/main.js';
import { ExitCode } from '../src/kernel/errors.js';
import { makeProject, withHome } from './helpers.js';

/**
 * `examples/home/` — пример с главной сайта документации (изменение
 * `docs-site`): сайт вставляет его `burnex.yml` как есть, поэтому пример
 * обязан проходить `burnex lint` в том виде, в каком читатель его скопирует —
 * с плагином Codex в глобальной конфигурации, как велит страница
 * «Подключить Codex и Cursor».
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXAMPLE = join(ROOT, 'examples', 'home');

describe('examples/home', () => {
  // burnex.yml — русская главная и README, burnex.en.yml — английская главная.
  for (const file of ['burnex.yml', 'burnex.en.yml']) {
    it(`${file}: burnex lint проходит без ошибок при подключённом плагине Codex`, async () => {
      const project = makeProject();
      cpSync(EXAMPLE, project.root, { recursive: true });
      writeFileSync(join(project.home, '.burnex', 'config.yml'), 'plugins:\n  - burnex/backends/codex\n');

      const stdout: string[] = [];
      const stderr: string[] = [];
      const io: CliIo = { out: (line) => stdout.push(line), err: (line) => stderr.push(line), cwd: project.root };
      const code = await withHome(project.home, () => runCli(['lint', file], io));

      assert.equal(code, ExitCode.ok, `${stdout.join('\n')}\n${stderr.join('\n')}`);
      assert.match(stdout.join('\n'), new RegExp(`^ok: ${file.replaceAll('.', '\\.')}`, 'm'));
    });
  }
});
