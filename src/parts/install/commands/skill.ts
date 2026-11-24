import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commandRow } from '../../../kernel/cli/commandRow.js';
import { BurnexError, ExitCode } from '../../../kernel/errors.js';
import { enginePackageRoot } from '../../pipeline/document/packagePaths.js';

const agentDirs = { codex: '.agents', cursor: '.cursor', claude: '.claude' } as const;

export const row = commandRow({
  name: 'skill',
  spec: {
    description: 'install: установить skill Burnex в текущий проект',
    positional: ['action'],
    flags: { agent: { kind: 'string', description: 'для какого агента установить: codex, cursor или claude (обязательно)' } },
  },
  run(args, io) {
    const agent = args.flags.agent;
    if (args.positional[0] !== 'install' || (agent !== 'codex' && agent !== 'cursor' && agent !== 'claude')) {
      throw new BurnexError('Использование: burnex skill install --agent <codex|cursor|claude>');
    }
    const source = join(enginePackageRoot(), 'src/builtin/skills/burnex');
    const target = join(io.cwd, agentDirs[agent], 'skills/burnex');
    // Skill — каталог: SKILL.md и справочники, на которые он ссылается.
    const files = readdirSync(source, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(source.length + 1));
    // Сначала сверка, потом запись: отказ не оставляет skill установленным наполовину.
    const pending = files.filter((file) => {
      const existing = join(target, file);
      if (!existsSync(existing)) return true;
      if (!readFileSync(existing).equals(readFileSync(join(source, file)))) {
        throw new BurnexError(`Файл ${existing} уже существует и отличается от поставляемого skill`);
      }
      return false;
    });
    for (const file of pending) {
      mkdirSync(dirname(join(target, file)), { recursive: true });
      copyFileSync(join(source, file), join(target, file));
    }
    io.out(`Skill Burnex для ${agent}: ${target}`);
    return ExitCode.ok;
  },
}, { independent: true });
