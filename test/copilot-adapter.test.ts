import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { createCopilotAdapter, MAX_ARG_BYTES } from '../src/parts/backends/copilot/index.js';
import type { BackendConfig } from '../src/parts/pipeline/surface.js';
import type { AgentInvocation } from '../src/parts/pipeline/backend/types.js';
import { StepcastError } from '../src/kernel/errors.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { discoverModels, resetModelDiscoveryCache } from '../src/parts/pipeline/backend/models.js';
import { lintPipeline } from '../src/parts/pipeline/domain/lint.js';
import { runPipeline } from '../src/parts/pipeline/run/runner.js';
import { readEvents, readStatus } from '../src/parts/pipeline/run/journal/reader.js';
import { resolveWithPlugins } from '../src/parts/resolve.js';
import { makeProject } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Фикстура `test/fixtures/copilot/answer.txt` составлена по документации, а не
 * записана с живого CLI (README фикстур): строка, сочинённая прямо в тесте,
 * допустима там, где документация молчит, — отказ, JSON в ответе.
 */
const FIXTURES = fileURLToPath(new URL('../../test/fixtures/copilot/', import.meta.url));
const ANSWER = readFileSync(join(FIXTURES, 'answer.txt'), 'utf8');

const CONFIG: BackendConfig = {
  command: 'copilot',
  enabled: true,
  defaultModel: undefined,
  concurrency: 2,
  cacheReadWeight: 0.1,
  sessions: false,
  structuredOutput: false,
  strictPermissions: false,
  mcp: false,
  permissions: undefined,
  env: {},
};

function invocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return { prompt: 'сделай', cwd: '/tmp/work', resumeSession: false, ...overrides };
}

describe('copilot-backend: сборка запуска', () => {
  const adapter = createCopilotAdapter(CONFIG);

  it('--allow-all, --no-color, -s; промпт слитным --prompt=, stdin пуст', () => {
    const launch = adapter.launch(invocation());

    assert.deepEqual(launch.command, ['copilot', '--allow-all', '--no-color', '-s', '--prompt=сделай']);
    assert.equal(launch.stdin, '', 'форма передачи промпта — аргумент (README фикстур)');
  });

  it('промпт, начатый с «-», остаётся частью одного аргумента --prompt=', () => {
    for (const prompt of ['- пункт', '--help и дальше текст', '-p']) {
      const { command } = adapter.launch(invocation({ prompt }));
      assert.equal(command.at(-1), `--prompt=${prompt}`);
      assert.ok(!command.includes(prompt), 'отдельного аргумента, равного промпту, нет');
      assert.ok(!command.some((arg) => arg === prompt && arg.startsWith('-')));
    }
  });

  it('промпт сверх 128 KiB отказывает, называя бэкенд и предел', () => {
    assert.throws(
      () => adapter.launch(invocation({ prompt: 'я'.repeat(70 * 1024) })),
      (error: unknown) =>
        error instanceof StepcastError && /copilot/.test(error.message) && /128 KiB/.test(error.message),
    );
    assert.doesNotThrow(() => adapter.launch(invocation({ prompt: 'a'.repeat(100 * 1024) })));
  });

  it('предел считает весь аргумент: префикс --prompt= и завершающий NUL', () => {
    // Аргумент `--prompt=<промпт>` плюс NUL должен уложиться в MAX_ARG_STRLEN.
    const fits = MAX_ARG_BYTES - '--prompt='.length - 1;
    const { command } = adapter.launch(invocation({ prompt: 'a'.repeat(fits) }));
    assert.equal(Buffer.byteLength(command.at(-1)!, 'utf8') + 1, MAX_ARG_BYTES);

    // Промпт сам по себе короче предела, но аргумент с префиксом — уже нет.
    for (const length of [fits + 1, MAX_ARG_BYTES - 1, MAX_ARG_BYTES]) {
      assert.throws(
        () => adapter.launch(invocation({ prompt: 'a'.repeat(length) })),
        (error: unknown) => error instanceof StepcastError && /copilot/.test(error.message),
        `промпт ${length} байт`,
      );
    }
  });

  it('модель шага побеждает умолчание бэкенда, а без обеих флага --model нет', () => {
    const withDefault = createCopilotAdapter({ ...CONFIG, defaultModel: 'gpt-5' });
    const modelOf = (command: readonly string[]): string | undefined =>
      command.includes('--model') ? command[command.indexOf('--model') + 1] : undefined;

    assert.equal(modelOf(withDefault.launch(invocation({ model: 'claude-sonnet-4.5' })).command), 'claude-sonnet-4.5');
    assert.equal(modelOf(withDefault.launch(invocation()).command), 'gpt-5');
    assert.equal(modelOf(adapter.launch(invocation()).command), undefined);
  });

  it('--resume и --continue нет даже при resumeSession и sessionId', () => {
    const { command } = adapter.launch(invocation({ sessionId: 'c-1', resumeSession: true }));
    assert.ok(!command.includes('--resume'));
    assert.ok(!command.includes('--continue'));
    assert.ok(!command.some((arg) => arg.includes('c-1')));
  });

  it('env бэкенда доходит до спецификации запуска', () => {
    const launch = createCopilotAdapter({ ...CONFIG, env: { COPILOT_GITHUB_TOKEN: 't' } }).launch(invocation());
    assert.deepEqual(launch.env, { COPILOT_GITHUB_TOKEN: 't' });
  });

  it('effort, схема и MCP-серверы флагов не дают', () => {
    const launch = adapter.launch(
      invocation({
        effort: 'high',
        outputSchemaPath: '/tmp/schema.json',
        mcpServers: { s: { command: ['node', 'a.js'] } },
      }),
    );
    assert.deepEqual(launch.command, ['copilot', '--allow-all', '--no-color', '-s', '--prompt=сделай']);
  });

  it('возможности объявлены честно и не зависят от флагов конфигурации', () => {
    const expected = {
      sessions: false,
      structuredOutput: false,
      strictPermissions: false,
      mcp: false,
      effort: false,
      reportsCost: false,
      sessionIdSource: 'backend',
    };
    assert.deepEqual(adapter.capabilities, expected);
    const enabled = createCopilotAdapter({
      ...CONFIG,
      sessions: true,
      structuredOutput: true,
      strictPermissions: true,
      mcp: true,
    });
    assert.deepEqual(enabled.capabilities, expected);
    assert.equal(adapter.name, 'copilot');
  });
});

describe('copilot-backend: доступ', () => {
  const adapter = createCopilotAdapter(CONFIG);

  it('любое permissions.mode отказывает, называя бэкенд и ключ', () => {
    for (const mode of ['enabled', 'workspace-write', 'plan']) {
      assert.throws(
        () => adapter.launch(invocation({ permissions: { mode } })),
        (error: unknown) =>
          error instanceof StepcastError && /copilot/.test(error.message) && /permissions\.mode/.test(error.message),
        mode,
      );
    }
  });

  it('непустые allow и deny отказывают, пустые — нет', () => {
    for (const key of ['allow', 'deny'] as const) {
      assert.throws(
        () => adapter.launch(invocation({ permissions: { [key]: ['Bash(git *)'] } })),
        (error: unknown) =>
          error instanceof StepcastError && /copilot/.test(error.message) && error.message.includes(`permissions.${key}`),
      );
    }
    assert.doesNotThrow(() => adapter.launch(invocation({ permissions: { allow: [], deny: [] } })));
  });

  it('база из backends.copilot.permissions действует, пока шаг политики не объявил', () => {
    const configured = createCopilotAdapter({ ...CONFIG, permissions: { mode: 'enabled' } });
    assert.throws(
      () => configured.launch(invocation()),
      (error: unknown) => error instanceof StepcastError && /permissions\.mode/.test(error.message),
    );
    assert.throws(
      () => createCopilotAdapter({ ...CONFIG, permissions: { deny: ['shell(rm)'] } }).launch(invocation()),
      (error: unknown) => error instanceof StepcastError && /permissions\.deny/.test(error.message),
    );
  });

  it('enforce: strict отказывает', () => {
    assert.throws(
      () => adapter.launch(invocation({ permissions: { enforce: 'strict' } })),
      (error: unknown) => error instanceof StepcastError && /copilot/.test(error.message) && /strict/.test(error.message),
    );
  });

  it('без объявления или с enforce: inherit запуск собирается', () => {
    assert.doesNotThrow(() => adapter.launch(invocation()));
    assert.doesNotThrow(() => adapter.launch(invocation({ permissions: { enforce: 'inherit' } })));
  });
});

describe('copilot-backend: разбор строк', () => {
  const adapter = createCopilotAdapter(CONFIG);

  it('каждая строка answer.txt — text, пустая — text с пустой строкой', () => {
    const lines = ANSWER.split('\n').slice(0, -1);
    assert.ok(lines.includes(''), 'в фикстуре есть пустая строка между абзацами');
    for (const line of lines) assert.deepEqual(adapter.parseLine(line), { kind: 'text', text: line });
  });

  it('хвостовой возврат каретки снимается', () => {
    assert.deepEqual(adapter.parseLine('готово\r'), { kind: 'text', text: 'готово' });
    assert.deepEqual(adapter.parseLine('\r'), { kind: 'text', text: '' });
  });

  it('JSON в ответе остаётся текстом, а не структурой', () => {
    assert.deepEqual(adapter.parseLine('{"pass": true}'), { kind: 'text', text: '{"pass": true}' });
  });

  it('слова об ограничении в ответе не дают отказа', () => {
    assert.deepEqual(adapter.parseLine('rate limit reached'), { kind: 'text', text: 'rate limit reached' });
  });
});

describe('copilot-backend: исполнение шага на подменённом CLI', () => {
  const MODULE = fileURLToPath(new URL('../src/parts/backends/copilot/index.js', import.meta.url));

  /**
   * Проект с плагином `copilot` и исполняемым `copilot`, который пишет argv и
   * stdin каждого запуска в `calls/<n>.json` и печатает `answer.txt`. Ни сети,
   * ни настоящего CLI. Шебанг — абсолютный путь к node: PATH шага не обязан
   * его содержать.
   */
  function fakeCopilotProject(pipeline: string) {
    const project = makeProject({ 'burnex.yml': pipeline });
    const bin = tempDir('copilot-bin-');
    const calls = join(bin, 'calls');
    const script = join(bin, 'copilot');
    writeFileSync(
      script,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const calls = ${JSON.stringify(calls)};
fs.mkdirSync(calls, { recursive: true });
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
const n = fs.readdirSync(calls).length;
fs.writeFileSync(path.join(calls, n + '.json'), JSON.stringify({ argv, stdin }));
process.stdout.write(fs.readFileSync(path.join(${JSON.stringify(FIXTURES)}, 'answer.txt'), 'utf8'));
`,
    );
    chmodSync(script, 0o755);
    // `command` допустим только в глобальной конфигурации.
    writeFileSync(
      join(project.home, '.burnex', 'config.yml'),
      `plugins: [${JSON.stringify(MODULE)}]\nbackends:\n  copilot:\n    command: ${JSON.stringify(script)}\n`,
    );
    const recorded = (): Array<{ argv: string[]; stdin: string }> =>
      existsSync(calls)
        ? readdirSync(calls)
            .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
            .map((file) => JSON.parse(readFileSync(join(calls, file), 'utf8')) as { argv: string[]; stdin: string })
        : [];
    return { project, calls, recorded };
  }

  async function run(project: ReturnType<typeof makeProject>) {
    const { resolved, registry } = await resolveWithPlugins(
      {
        cwd: project.root,
        home: project.home,
        globalPath: join(project.home, '.burnex', 'config.yml'),
        projectPath: join(project.root, '.burnex', 'config.yml'),
      },
      {},
    );
    const config = { ...resolved.config, runs: { ...resolved.config.runs, root: tempDir('runs-') } };
    return runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('burnex.yml'), config, registry }),
      config,
      registry,
      projectRoot: project.root,
      cwd: project.root,
    });
  }

  const step = (id: string, extra = ''): string =>
    `      - id: ${id}\n        agent: copilot\n        prompt: "Промпт ${id}"\n        expect: [{ exit_code: 0 }]\n${extra}`;

  it('шаг проходит, текст шага равен answer.txt, промпт и флаги дошли до скрипта', async () => {
    const { project, recorded } = fakeCopilotProject(`name: p\njobs:\n  работа:\n    steps:\n${step('один')}`);

    const result = await run(project);

    assert.equal(result.status, 'success');
    const [call] = recorded();
    assert.deepEqual(call?.argv.slice(0, 3), ['--allow-all', '--no-color', '-s']);
    assert.match(call?.argv.at(-1) ?? '', /^--prompt=[\s\S]*Промпт один/);
    assert.equal(call?.stdin, '');

    const files = readdirSync(result.journal.paths.dir, { recursive: true, encoding: 'utf8' });
    const read = (name: string): string => {
      const found = files.find((file) => file.endsWith(name));
      assert.ok(found, name + ' записан');
      return readFileSync(join(result.journal.paths.dir, found), 'utf8');
    };
    // Ответ CLI целиком, с пустой строкой между абзацами, лежит в журнале шага.
    assert.equal(read('stdout.log'), ANSWER);
    const record = JSON.parse(read('step.json')) as {
      session?: string;
      attempts?: Array<{ usage?: { tokens_in: number | null; reported_cost_usd?: number } }>;
    };
    assert.equal(record.session, undefined, 'сессии у CLI нет, и движок её не заводит');
    assert.equal(record.attempts?.[0]?.usage?.tokens_in, null, 'расход не сообщён');
    assert.equal(record.attempts?.[0]?.usage?.reported_cost_usd, undefined);
  });

  it('два шага в session: shared: предупреждение о деградации, оба без --resume, сессии нет', async () => {
    const { project, recorded } = fakeCopilotProject(
      `name: p\njobs:\n  работа:\n    session: shared\n    steps:\n${step('первый')}${step('второй')}`,
    );

    const result = await run(project);

    assert.equal(result.status, 'success');
    const calls = recorded();
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.ok(!call.argv.includes('--resume') && !call.argv.includes('--continue'));
    }
    const degraded = readEvents(result.journal.paths).flatMap((event) =>
      event.kind === 'backend.degraded' && event.capability === 'sessions' ? [event] : [],
    );
    assert.equal(degraded.length, 1);
    assert.equal(degraded[0]?.backend, 'copilot');
    assert.deepEqual(
      (readStatus(result.journal.paths).jobs[0]?.steps ?? []).map((item) => item.session),
      [undefined, undefined],
    );
  });

  it('defaults.effort: прогон идёт, команда без effort, в журнале backend.degraded', async () => {
    const { project, recorded } = fakeCopilotProject(`name: p\njobs:\n  работа:\n    steps:\n${step('один')}`);
    project.write('.burnex/config.yml', 'defaults:\n  effort: high\n');

    const result = await run(project);

    assert.equal(result.status, 'success');
    const [call] = recorded();
    assert.ok(!call?.argv.some((arg) => /effort|^high$/.test(arg)), 'effort не передан ни в каком виде');
    const degraded = readEvents(result.journal.paths).flatMap((event) =>
      event.kind === 'backend.degraded' && event.capability === 'effort' ? [event] : [],
    );
    assert.equal(degraded.length, 1);
    assert.equal(degraded[0]?.backend, 'copilot');
  });

  // Отказ приходит от предстартовой проверки движка, а не из `launch()`: текст
  // называет `<job>/<step>`, чего ошибки `launch()` не делают.
  it('effort шага, output_schema, mcp, enforce: strict и судья отказывают до запуска', async () => {
    const declarations: Record<string, { extra: string; message: RegExp }> = {
      effort: { extra: '        effort: high\n', message: /copilot.*работа\/один/s },
      output_schema: {
        extra: '        output_schema: ./schema.json\n',
        message: /^Бэкенд copilot не поддерживает структурированный вывод, нужный для output_schema шага работа\/один$/,
      },
      mcp: {
        extra: '        mcp:\n          s: { command: [node, a.js] }\n',
        message: /^Бэкенд copilot не объявляет возможность работать с MCP-серверами, объявленными у шага работа\/один$/,
      },
      'enforce: strict': {
        extra: '        permissions:\n          enforce: strict\n',
        message: /^Бэкенд copilot не умеет применять enforce: strict, объявленный у шага работа\/один$/,
      },
      judge: {
        extra: '',
        message: /^Бэкенд судьи copilot не поддерживает структурированный вывод, нужный для вердикта у шага работа\/один$/,
      },
    };
    for (const [name, { extra, message }] of Object.entries(declarations)) {
      const body =
        name === 'judge'
          ? step('один').replace('expect: [{ exit_code: 0 }]', 'expect: [{ judge: "всё хорошо", agent: copilot }]')
          : step('один', extra);
      const { project, calls } = fakeCopilotProject(`name: p\njobs:\n  работа:\n    steps:\n${body}`);
      project.write('schema.json', '{ "type": "object" }\n');

      await assert.rejects(
        run(project),
        (error: unknown) => error instanceof StepcastError && message.test(error.message),
        name,
      );
      assert.equal(existsSync(calls), false, `${name}: скрипт не должен был запуститься`);
    }
  });

  // Тот же отказ обязан прийти от `burnex lint`, раньше прогона, — и даже
  // при флагах конфигурации, включённых вопреки адаптеру.
  it('линт отклоняет output_schema, mcp, enforce: strict и судью на copilot', async () => {
    const { project, calls } = fakeCopilotProject(
      `name: p\njobs:\n  работа:\n    steps:\n` +
        step(
          'один',
          '        output_schema: ./schema.json\n        mcp:\n          s: { command: [node, a.js] }\n' +
            '        permissions:\n          enforce: strict\n',
        ) +
        step('два').replace('expect: [{ exit_code: 0 }]', 'expect: [{ judge: "всё хорошо", agent: copilot }]'),
    );
    project.write('schema.json', '{ "type": "object" }\n');
    project.write(
      '.burnex/config.yml',
      'backends:\n  copilot: { structured_output: true, mcp: true, strict_permissions: true }\n',
    );
    const { resolved, registry } = await resolveWithPlugins(
      {
        cwd: project.root,
        home: project.home,
        globalPath: join(project.home, '.burnex', 'config.yml'),
        projectPath: join(project.root, '.burnex', 'config.yml'),
      },
      {},
    );
    assert.equal(resolved.config.backends.copilot?.structuredOutput, true, 'флаг включён конфигурацией');

    const errors = lintPipeline(
      expandPipeline({ pipelinePath: project.path('burnex.yml'), config: resolved.config, registry }),
      { config: resolved.config, registry },
    ).filter((item) => item.severity === 'error');

    const schema = errors.find((item) => item.at === 'jobs.работа.steps.0.output_schema');
    assert.ok(schema, 'output_schema отклонён линтом');
    assert.match(schema.hint ?? '', /Адаптер бэкенда copilot этой возможности не объявляет/);
    assert.ok(errors.some((item) => /copilot/.test(item.message) && /MCP-серверами/.test(item.message)), 'mcp отклонён линтом');
    assert.ok(errors.some((item) => /copilot/.test(item.message) && /enforce: strict/.test(item.message)), 'enforce: strict отклонён линтом');
    assert.ok(errors.some((item) => /Бэкенд судьи copilot не поддерживает/.test(item.message)), 'судья отклонён линтом');
    assert.equal(existsSync(calls), false, 'линт CLI не запускает');
  });

  // Страница «Агенты» берёт ответ из `discoverModels`: без `models` у вклада
  // он — `unsupported`, и проба CLI не запускается вовсе.
  it('список моделей: unsupported без запуска пробы', async () => {
    const { project, calls } = fakeCopilotProject(`name: p\njobs:\n  работа:\n    steps:\n${step('один')}`);
    const { resolved, registry } = await resolveWithPlugins(
      {
        cwd: project.root,
        home: project.home,
        globalPath: join(project.home, '.burnex', 'config.yml'),
        projectPath: join(project.root, '.burnex', 'config.yml'),
      },
      {},
    );
    resetModelDiscoveryCache();

    assert.deepEqual(await discoverModels('copilot', resolved.config, registry), { status: 'unsupported' });
    assert.equal(existsSync(calls), false, 'проба CLI не запускалась');
  });
});
