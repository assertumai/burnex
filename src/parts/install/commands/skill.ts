import { constants, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
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
    const source = join(enginePackageRoot(), 'src/builtin/skills/burnex/SKILL.md');
    const target = join(io.cwd, agentDirs[agent], 'skills/burnex/SKILL.md');
    mkdirSync(dirname(target), { recursive: true });
    try {
      copyFileSync(source, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!readFileSync(target).equals(readFileSync(source))) {
        throw new BurnexError(`Файл ${target} уже существует и отличается от поставляемого skill`);
      }
    }
    io.out(`Skill Burnex для ${agent}: ${target}`);
    return ExitCode.ok;
  },
}, { independent: true });
