import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ExitCode, BurnexError } from '../src/kernel/errors.js';
import type { ParsedArgs } from '../src/kernel/cli/types.js';
import { resolveConfigWithAgent } from '../src/parts/pipeline/config/agentOverride.js';
import { runRunCommand } from '../src/parts/pipeline/commands/run.js';
import { runResumeCommand } from '../src/parts/pipeline/commands/resume.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { jobDir, projectKey, runPaths } from '../src/parts/pipeline/run/journal/paths.js';
import { listRuns, readManifest } from '../src/parts/pipeline/run/journal/reader.js';
import { RunManifestSchema } from '../src/parts/pipeline/run/journal/schema.js';
import { makeProject, withHome, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * `run --agent` (`pipeline-execution`, `run-journal`): слой флага над
 * `defaults.agent`. Тесты раскрывают пайплайн с конфигурацией помощника —
 * так видно, какому шагу достался агент, — а запись в манифесте и отказ до
 * каталога прогона проверяют через команды, как пользователь.
 */

const BACKENDS = `
backends:
  codex:
    default_model: gpt-5.6-terra
`;

const PIPELINE = `
version: 1
kind: pipeline
name: agent-override
jobs:
  work:
    steps:
      - { id: free, prompt: hi }
      - { id: pinned, prompt: hi, agent: claude }
      - { id: local, run: [sh, -c, 'echo done > done.txt'] }
`;

/** Шлюз падает без маркера — раньше агентских шагов, чтобы было что возобновлять. */
const GATED = `
version: 1
kind: pipeline
name: agent-override
jobs:
  work:
    steps:
      - { id: gate, run: [sh, -c, 'test -f marker.txt'] }
      - { id: free, prompt: hi }
      - { id: pinned, prompt: hi, agent: claude }
`;

/** Заведомо падающие бэкенды: тестам resume важно, какой агент выбран, а не его ответ. */
const FAILING_BACKENDS = 'backends:\n  claude: { command: "false" }\n  codex: { command: "false" }\n';

function bed(files: Record<string, string> = {}, global = '') {
  const project = makeProject({
    'burnex.yml': PIPELINE,
    '.burnex/config.yml': BACKENDS,
    ...files,
  });
  const runsRoot = tempDir('runs-');
  // `runs.root` и `backends.*.command` допустимы только в глобальной конфигурации.
  writeFileSync(join(project.home, '.burnex', 'config.yml'), `runs:\n  root: ${runsRoot}\n${global}`);
  const lines: string[] = [];
  return { project, runsRoot, lines, write: (line: string) => lines.push(line) };
}

type Bed = ReturnType<typeof bed>;

function agentsOf(project: Project, agent: string | undefined): Record<string, string> {
  const config =
    agent === undefined
      ? withHome(project.home, () => project.config)
      : withHome(project.home, () => resolveConfigWithAgent({ cwd: project.root, agent }));
  const expanded = expandPipeline({ pipelinePath: project.path('burnex.yml'), config });
  const result: Record<string, string> = {};
  for (const step of expanded.pipeline.jobs[0]!.steps) if (step.kind === 'agent') result[step.id] = step.agent;
  return result;
}

function args(command: string, positional: string[], flags: ParsedArgs['flags']): ParsedArgs {
  return { command, positional, flags };
}

function run(b: Bed, flags: ParsedArgs['flags']): Promise<number> {
  return withHome(b.project.home, () => runRunCommand(args('run', ['burnex.yml'], flags), b.write, b.project.root));
}

function manifestOf(b: Bed, runId: string) {
  return readManifest(runPaths(b.runsRoot, projectKey(b.project.root), runId));
}

describe('resolveConfigWithAgent: слой флага над defaults.agent', () => {
  it('известное имя заменяет defaults.agent, умолчания бэкендов сохранены', () => {
    const b = bed();
    const config = withHome(b.project.home, () => resolveConfigWithAgent({ cwd: b.project.root, agent: 'codex' }));
    assert.equal(config.defaults.agent, 'codex');
    assert.equal(config.backends.codex?.defaultModel, 'gpt-5.6-terra');
  });

  it('неизвестное имя — отказ с перечнем известных бэкендов', () => {
    const b = bed();
    assert.throws(
      () => withHome(b.project.home, () => resolveConfigWithAgent({ cwd: b.project.root, agent: 'nope' })),
      (error) => {
        assert.ok(error instanceof BurnexError);
        assert.match(error.message, /nope/);
        assert.match(error.hint ?? '', /claude/);
        assert.match(error.hint ?? '', /codex/);
        return true;
      },
    );
  });
});

describe('run --agent: кому достаётся выбранный агент', () => {
  it('шаг без агента получает выбранного, шаг с агентом документа — прежнего', () => {
    const b = bed();
    assert.deepEqual(agentsOf(b.project, undefined), { free: 'claude', pinned: 'claude' });
    assert.deepEqual(agentsOf(b.project, 'codex'), { free: 'codex', pinned: 'claude' });
  });

  it('запись pipeline_agents сильнее флага', () => {
    const b = bed({
      '.burnex/config.yml': `${BACKENDS}pipeline_agents:\n  agent-override: { agent: claude }\n`,
    });
    assert.deepEqual(agentsOf(b.project, 'codex'), { free: 'claude', pinned: 'claude' });
  });
});

describe('run --agent и agent_policy', () => {
  // Флаг — слой `config`, тот же, что `defaults.agent` из файла: где
  // `defaults.agent` сильнее документа, там сильнее и флаг. Под `fallback`
  // это агент корня документа; агент работы и шага сильнее при любой политике.
  const ROOTED = `
version: 1
kind: pipeline
name: agent-override
agent: claude
jobs:
  work:
    steps:
      - { id: root, prompt: hi }
      - { id: pinned, prompt: hi, agent: claude }
  own:
    agent: claude
    steps:
      - { id: job, prompt: hi }
`;

  function rootedAgents(policy: string, agent: string): Record<string, string> {
    const b = bed({ 'burnex.yml': ROOTED, '.burnex/config.yml': `${BACKENDS}agent_policy: ${policy}\n` });
    const config = withHome(b.project.home, () => resolveConfigWithAgent({ cwd: b.project.root, agent }));
    const expanded = expandPipeline({ pipelinePath: b.project.path('burnex.yml'), config });
    const result: Record<string, string> = {};
    for (const job of expanded.pipeline.jobs) for (const step of job.steps) if (step.kind === 'agent') result[step.id] = step.agent;
    return result;
  }

  it('force: агент корня документа сильнее флага', () => {
    assert.deepEqual(rootedAgents('force', 'codex'), { root: 'claude', pinned: 'claude', job: 'claude' });
  });

  it('fallback: агент корня документа уступает флагу, агент работы и шага — нет', () => {
    assert.deepEqual(rootedAgents('fallback', 'codex'), { root: 'codex', pinned: 'claude', job: 'claude' });
  });
});

describe('run --agent: отказ и журнал', () => {
  it('неизвестный агент — ошибка конфигурации без каталога прогона, и при --dry-run тоже', async () => {
    const b = bed();
    for (const flags of [{ agent: 'nope' }, { agent: 'nope', 'dry-run': true }]) {
      b.lines.length = 0;
      assert.equal(await run(b, flags), ExitCode.configError);
      assert.match(b.lines.join('\n'), /nope/);
      assert.match(b.lines.join('\n'), /codex/);
    }
    assert.deepEqual(listRuns(b.runsRoot, b.project.root), []);
  });

  it('run.json несёт agent_override при флаге и не несёт без него', async () => {
    const b = bed({ 'burnex.yml': PIPELINE.replace(/ {6}- \{ id: free.*\n.*pinned.*\n/, '') });
    // listRuns отдаёт новые первыми, а id двух запусков в одну секунду порядка не гарантируют:
    // прогон опознаётся по разности списков, а не по позиции.
    assert.equal(await run(b, { agent: 'codex' }), ExitCode.ok);
    const [flagged] = listRuns(b.runsRoot, b.project.root);
    assert.equal(await run(b, {}), ExitCode.ok);
    const plain = listRuns(b.runsRoot, b.project.root).find((id) => id !== flagged);
    assert.ok(flagged !== undefined && plain !== undefined);
    assert.equal(manifestOf(b, flagged).agent_override, 'codex');
    assert.equal('agent_override' in manifestOf(b, plain), false);
  });

  it('манифест прежней версии без agent_override читается', async () => {
    const b = bed({ 'burnex.yml': PIPELINE.replace(/ {6}- \{ id: free.*\n.*pinned.*\n/, '') });
    assert.equal(await run(b, {}), ExitCode.ok);
    const id = listRuns(b.runsRoot, b.project.root)[0] as string;
    const parsed = RunManifestSchema.safeParse(manifestOf(b, id));
    assert.equal(parsed.success, true);
  });
});

describe('resume наследует agent_override', () => {
  // Сценарий «Возобновление наследует выбор»: агент шагов — не только ключ
  // манифеста. Исходный прогон падает на шлюзе раньше агентского шага;
  // возобновление переисполняет работу, и её раскрытое определение
  // (`resolved.json`) называет агента, которым шаг пошёл в исполнение. Сам
  // бэкенд — заведомо падающая команда: важно, кого выбрали, а не ответ.
  function gatedBed(project = BACKENDS): Bed {
    return bed({ 'burnex.yml': GATED, '.burnex/config.yml': project }, FAILING_BACKENDS);
  }

  /** Агенты шагов работы `work` — из `resolved.json`, с которым она пошла в исполнение. */
  function agentsIn(b: Bed, runId: string): Record<string, string> {
    const path = join(jobDir(runPaths(b.runsRoot, projectKey(b.project.root), runId), 'work'), 'resolved.json');
    const job = JSON.parse(readFileSync(path, 'utf8')) as { steps: { id: string; kind: string; agent?: string }[] };
    const result: Record<string, string> = {};
    for (const step of job.steps) if (step.kind === 'agent' && step.agent !== undefined) result[step.id] = step.agent;
    return result;
  }

  /** Возобновить после того, как шлюз пропускает; вернуть id нового прогона. */
  async function resumePastGate(b: Bed, source: string): Promise<string> {
    b.project.write('marker.txt', 'есть');
    await withHome(b.project.home, () => runResumeCommand(args('resume', [source], {}), b.write, b.project.root));
    const resumed = listRuns(b.runsRoot, b.project.root).find((id) => id !== source);
    assert.ok(resumed !== undefined, `возобновление не создало прогона:\n${b.lines.join('\n')}`);
    return resumed;
  }

  // Адаптер `codex` без плагина не предоставлен, поэтому направление обратное:
  // файл называет `codex`, флаг — встроенного `claude`. Потеряй resume слой
  // флага, шаг `free` ушёл бы к `codex`.
  it('шаги возобновлённого прогона исполняются выбранным агентом', async () => {
    const b = gatedBed(`${BACKENDS}defaults:\n  agent: codex\n`);
    assert.notEqual(await run(b, { agent: 'claude' }), ExitCode.ok, 'без маркера шлюз падает');
    const [source] = listRuns(b.runsRoot, b.project.root);
    assert.ok(source !== undefined);

    const resumed = await resumePastGate(b, source);
    assert.deepEqual(agentsIn(b, resumed), { free: 'claude', pinned: 'claude' });
    assert.equal(manifestOf(b, resumed).agent_override, 'claude');
  });

  // Сценарий run-journal «Манифест прежней версии»: run.json, записанный
  // движком до `agent_override` (и до `mode`), читается и возобновляется
  // без переопределения — шаги получают агента по умолчанию.
  it('манифест прежней версии без ключей возобновляется без переопределения', async () => {
    const b = gatedBed();
    assert.notEqual(await run(b, {}), ExitCode.ok, 'без маркера шлюз падает');
    const [source] = listRuns(b.runsRoot, b.project.root);
    assert.ok(source !== undefined);
    const manifestPath = join(runPaths(b.runsRoot, projectKey(b.project.root), source).dir, 'run.json');
    const legacy = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    delete legacy.agent_override;
    delete legacy.mode;
    writeFileSync(manifestPath, JSON.stringify(legacy, null, 2));
    assert.equal(RunManifestSchema.safeParse(legacy).success, true);

    const resumed = await resumePastGate(b, source);
    assert.equal('agent_override' in manifestOf(b, resumed), false);
    assert.deepEqual(agentsIn(b, resumed), { free: 'claude', pinned: 'claude' });
  });

  it('возобновлённый прогон пишет тот же ключ; без ключа в источнике — без ключа', async () => {
    const b = bed({ 'burnex.yml': PIPELINE.replace(/ {6}- \{ id: free.*\n.*pinned.*\n/, '') });

    assert.equal(await run(b, { agent: 'codex' }), ExitCode.ok);
    const source = listRuns(b.runsRoot, b.project.root)[0] as string;
    const resume = (id: string) =>
      withHome(b.project.home, () => runResumeCommand(args('resume', [id], {}), b.write, b.project.root));
    assert.equal(await resume(source), ExitCode.ok);
    const resumed = listRuns(b.runsRoot, b.project.root).find((id) => id !== source) as string;
    assert.equal(manifestOf(b, resumed).agent_override, 'codex');

    assert.equal(await run(b, {}), ExitCode.ok);
    const plain = listRuns(b.runsRoot, b.project.root).find((id) => id !== source && id !== resumed) as string;
    assert.equal(await resume(plain), ExitCode.ok);
    const plainResumed = listRuns(b.runsRoot, b.project.root).find(
      (id) => ![source, resumed, plain].includes(id),
    ) as string;
    assert.equal('agent_override' in manifestOf(b, plainResumed), false);
  });
});
