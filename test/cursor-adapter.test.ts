import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  createCursorAdapter,
  cursorModelDiscovery,
  parseCursorModelList,
  SANDBOX_MODES,
} from '../src/parts/backends/cursor/index.js';
import type { BackendConfig } from '../src/parts/pipeline/surface.js';
import type { AgentInvocation, BackendAdapter, BackendEvent } from '../src/parts/pipeline/backend/types.js';
import { StepcastError } from '../src/kernel/errors.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { lintPipeline } from '../src/parts/pipeline/domain/lint.js';
import { runPipeline } from '../src/parts/pipeline/run/runner.js';
import { readEvents, readStatus } from '../src/parts/pipeline/run/journal/reader.js';
import { resolveWithPlugins } from '../src/parts/resolve.js';
import { makeProject } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Разбор проверяется на фикстурах `test/fixtures/cursor/`. Они составлены по
 * документации Cursor CLI, а не записаны с живого CLI (README фикстур) —
 * поэтому строка, сочинённая прямо в тесте, допустима там, где документация
 * молчит: расход, отказ аутентификации.
 */
const FIXTURES = fileURLToPath(new URL('../../test/fixtures/cursor/', import.meta.url));

function fixture(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((line) => line.trim() !== '');
}

const CONFIG: BackendConfig = {
  command: 'cursor-agent',
  enabled: true,
  defaultModel: undefined,
  concurrency: 2,
  cacheReadWeight: 0.1,
  sessions: true,
  structuredOutput: false,
  strictPermissions: false,
  mcp: false,
  permissions: undefined,
  env: {},
};

function invocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return { prompt: 'сделай', cwd: '/tmp/work', resumeSession: false, ...overrides };
}

function events(adapter: BackendAdapter, lines: readonly string[]): BackendEvent[] {
  return lines.map((line) => adapter.parseLine(line));
}

function ofKind<K extends BackendEvent['kind']>(list: readonly BackendEvent[], kind: K): Extract<BackendEvent, { kind: K }>[] {
  return list.filter((event): event is Extract<BackendEvent, { kind: K }> => event.kind === kind);
}

describe('cursor-backend: сборка запуска', () => {
  const adapter = createCursorAdapter(CONFIG);

  // Сценарий: «Новая сессия»
  it('новая сессия: -p, stream-json, --force, модель шага; промпт последним аргументом', () => {
    const launch = adapter.launch(invocation({ model: 'sonnet-4.5' }));

    assert.deepEqual(launch.command, [
      'cursor-agent', '-p', '--output-format', 'stream-json', '--force', '--model', 'sonnet-4.5', '--', 'сделай',
    ]);
    assert.equal(launch.stdin, '', 'форма передачи промпта — аргумент (README фикстур)');
    assert.ok(!launch.command.includes('--resume'));
    assert.ok(!launch.command.includes('--approve-mcps'));
  });

  it('промпт, начатый с «-», отделён концом флагов и флагом не становится', () => {
    for (const prompt of ['- пункт списка', '--help и дальше текст', '-p']) {
      const launch = adapter.launch(invocation({ prompt, sessionId: 'c-1', resumeSession: true }));
      assert.deepEqual(launch.command.slice(-2), ['--', prompt]);
      // Все флаги — до `--`: ничто после него CLI флагом не прочтёт.
      assert.equal(launch.command.indexOf('--'), launch.command.length - 2);
    }
  });

  it('модель шага побеждает умолчание бэкенда, а без обеих флага --model нет', () => {
    const configured = createCursorAdapter({ ...CONFIG, defaultModel: 'auto' });
    const step = configured.launch(invocation({ model: 'gpt-5' }));
    assert.equal(step.command[step.command.indexOf('--model') + 1], 'gpt-5');

    const fallback = configured.launch(invocation());
    assert.equal(fallback.command[fallback.command.indexOf('--model') + 1], 'auto');

    assert.ok(!adapter.launch(invocation()).command.includes('--model'));
  });

  // Сценарий: «Продолжение сессии»
  it('продолжение: --resume <id> при тех же прочих флагах', () => {
    const launch = adapter.launch(invocation({ sessionId: 'c-1', resumeSession: true }));

    assert.equal(launch.command[launch.command.indexOf('--resume') + 1], 'c-1');
    assert.ok(launch.command.includes('--force'));
    assert.ok(launch.command.includes('stream-json'));
    assert.equal(launch.command.at(-1), 'сделай');
  });

  it('без идентификатора, без resumeSession или при sessions: false --resume нет', () => {
    assert.ok(!adapter.launch(invocation({ resumeSession: true })).command.includes('--resume'));
    assert.ok(!adapter.launch(invocation({ sessionId: 'c-1' })).command.includes('--resume'));
    const off = createCursorAdapter({ ...CONFIG, sessions: false });
    assert.ok(!off.launch(invocation({ sessionId: 'c-1', resumeSession: true })).command.includes('--resume'));
  });

  // Сценарий: «Окружение бэкенда»
  it('env бэкенда доходит до спецификации запуска', () => {
    const launch = createCursorAdapter({ ...CONFIG, env: { CURSOR_API_KEY: 'k' } }).launch(invocation());
    assert.deepEqual(launch.env, { CURSOR_API_KEY: 'k' });
  });

  it('effort, переданный напрямую, флага не даёт, а MCP-серверы и схема не передаются', () => {
    const launch = adapter.launch(
      invocation({
        effort: 'high',
        outputSchemaPath: '/tmp/schema.json',
        mcpServers: { s: { command: ['node', 'a.js'] } },
      }),
    );
    assert.deepEqual(launch.command, ['cursor-agent', '-p', '--output-format', 'stream-json', '--force', '--', 'сделай']);
  });

  it('возможности объявлены честно', () => {
    assert.deepEqual(adapter.capabilities, {
      sessions: true,
      structuredOutput: false,
      strictPermissions: false,
      mcp: false,
      effort: false,
      reportsCost: false,
      sessionIdSource: 'backend',
    });
    assert.equal(createCursorAdapter({ ...CONFIG, sessions: false }).capabilities.sessions, false);
    assert.equal(adapter.name, 'cursor-agent');
  });
});

describe('cursor-backend: песочница', () => {
  const adapter = createCursorAdapter(CONFIG);
  const sandboxOf = (command: readonly string[]): string | undefined =>
    command.includes('--sandbox') ? command[command.indexOf('--sandbox') + 1] : undefined;

  // Сценарий: «Режим переводится»
  it('permissions.mode из словаря CLI уходит в --sandbox, а без режима флага нет', () => {
    for (const mode of SANDBOX_MODES) {
      assert.equal(sandboxOf(adapter.launch(invocation({ permissions: { mode } })).command), mode);
    }
    assert.deepEqual([...SANDBOX_MODES], ['enabled', 'disabled']);
    assert.equal(sandboxOf(adapter.launch(invocation()).command), undefined);
    assert.equal(sandboxOf(adapter.launch(invocation({ permissions: { enforce: 'inherit' } })).command), undefined);
  });

  // Сценарий: «Режим чужого бэкенда»
  it('режим вне словаря отказывает, называя бэкенд, значение и словарь', () => {
    assert.throws(
      () => adapter.launch(invocation({ permissions: { mode: 'workspace-write' } })),
      (error: unknown) =>
        error instanceof StepcastError &&
        /cursor-agent/.test(error.message) &&
        /workspace-write/.test(error.message) &&
        /enabled, disabled/.test(`${error.message} ${error.hint ?? ''}`),
    );
  });

  // Сценарий: «Пооперационный список»
  it('непустые allow и deny отказывают, пустые — нет', () => {
    for (const key of ['allow', 'deny'] as const) {
      assert.throws(
        () => adapter.launch(invocation({ permissions: { [key]: ['Bash(git *)'] } })),
        (error: unknown) =>
          error instanceof StepcastError && /cursor-agent/.test(error.message) && error.message.includes(key),
      );
    }
    assert.doesNotThrow(() => adapter.launch(invocation({ permissions: { allow: [], deny: [] } })));
  });

  it('enforce: strict отказывает: временного исключения, как у Codex, нет', () => {
    assert.throws(
      () => adapter.launch(invocation({ permissions: { enforce: 'strict' } })),
      (error: unknown) => error instanceof StepcastError && /cursor-agent/.test(error.message) && /strict/.test(error.message),
    );
  });

  // Сценарий: «База из конфигурации бэкенда»
  it('база из backends.cursor-agent.permissions действует, пока шаг политики не объявил', () => {
    const configured = createCursorAdapter({ ...CONFIG, permissions: { mode: 'enabled' } });
    assert.equal(sandboxOf(configured.launch(invocation()).command), 'enabled');
    assert.equal(sandboxOf(configured.launch(invocation({ permissions: { mode: 'disabled' } })).command), 'disabled');
  });
});

describe('cursor-backend: разбор потока', () => {
  const adapter = createCursorAdapter(CONFIG);

  // Сценарий: «Сессия из init»
  it('init называет сессию', () => {
    const list = events(adapter, fixture('new.jsonl'));
    const [init] = ofKind(list, 'init');

    assert.equal(init?.sessionId, 'c6b62c6f-7ead-4fd6-9922-e952131177ff');
    assert.equal(init?.data.type, 'system');
    assert.equal(ofKind(list, 'init').length, 1);
    assert.equal(init?.mcpServers, undefined, 'состав серверов поток не сообщает');
  });

  it('resume.jsonl несёт ту же сессию', () => {
    const sessions = [fixture('new.jsonl'), fixture('resume.jsonl')].map(
      (lines) => ofKind(events(adapter, lines), 'init')[0]?.sessionId,
    );
    assert.equal(sessions[0], sessions[1]);
  });

  // Сценарий: «Вызов инструмента учитывается один раз»
  it('tool_call: tool_use один раз, на завершённой записи, с именем вида и аргументами без результата', () => {
    const tools = ofKind(events(adapter, fixture('new.jsonl')), 'tool_use');

    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, 'shell');
    assert.deepEqual(tools[0]?.input, { command: 'ls', workingDirectory: '' });
  });

  it('assistant даёт текст, итог — итоговый текст без usage, пока расход не сообщён', () => {
    const list = events(adapter, fixture('new.jsonl'));
    const results = ofKind(list, 'result');

    assert.equal(results[0]?.text, 'Смотрю содержимое каталога.');
    const last = results.at(-1);
    assert.equal(last?.text, 'В каталоге два элемента: README.md и src.');
    assert.equal(last?.failed, undefined);
    // Сценарий: «Расход не сообщён»
    assert.equal(last?.usage, undefined);
    assert.equal(ofKind(list, 'usage').length, 0);
    assert.ok(results.every((result) => result.structured === undefined));
  });

  it('user и начатый tool_call пропускаются', () => {
    const list = events(adapter, fixture('new.jsonl'));
    assert.equal(list[1]?.kind, 'ignored', 'user');
    assert.equal(list[3]?.kind, 'ignored', 'tool_call started');
  });

  // Сценарий: «Текст похож на JSON»
  it('JSON-текст сообщения не становится структурой', () => {
    const event = adapter.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '{"pass": true}' }] },
      }),
    );
    assert.equal(event.kind, 'result');
    assert.equal(event.kind === 'result' && event.text, '{"pass": true}');
    assert.equal('structured' in event, false);

    const final = adapter.parseLine(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"pass": true}' }),
    );
    assert.equal('structured' in final, false);
  });

  it('части сообщения склеиваются, части без текста пропускаются', () => {
    const event = adapter.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'раз ' }, { type: 'image' }, { type: 'text', text: 'два' }] },
      }),
    );
    assert.equal(event.kind === 'result' && event.text, 'раз два');
  });

  // Сценарий: «Ошибка итога»
  it('result с is_error: true — отказ по лимиту', () => {
    const list = events(adapter, fixture('error.jsonl'));
    const [failed] = ofKind(list, 'result');

    assert.equal(failed?.failed, true);
    assert.equal(failed?.text, 'usage limit reached');
    assert.equal(failed?.refusal?.class, 'rate_limit');
  });

  it('отказ аутентификации классифицируется, неузнаваемый остаётся без класса', () => {
    const record = JSON.parse(fixture('error.jsonl')[1] as string) as Record<string, unknown>;
    const auth = adapter.parseLine(JSON.stringify({ ...record, result: 'Not logged in' }));
    assert.equal(auth.kind === 'result' && auth.refusal?.class, 'unauthenticated');

    const other = adapter.parseLine(JSON.stringify({ ...record, result: 'internal error' }));
    assert.equal(other.kind === 'result' && other.failed, true);
    assert.equal(other.kind === 'result' && other.refusal, undefined);
  });

  it('расход отдаётся только если запись его несёт', () => {
    const anthropic = adapter.parseLine(
      JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'ок',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
      }),
    );
    assert.deepEqual(anthropic.kind === 'result' && anthropic.usage, {
      tokens_in: 10,
      tokens_out: 5,
      cache_read: 4,
      cache_write: 2,
    });

    // У OpenAI input_tokens включает кешированные.
    const openai = adapter.parseLine(
      JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'ок',
        usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 4 },
      }),
    );
    assert.deepEqual(openai.kind === 'result' && openai.usage, { tokens_in: 6, tokens_out: 5, cache_read: 4 });

    const empty = adapter.parseLine(JSON.stringify({ type: 'result', is_error: false, result: 'ок', usage: {} }));
    assert.equal(empty.kind === 'result' && empty.usage, undefined, 'нули не подставляются');
  });

  it('пустая строка пропускается, не JSON и не объект — unparsed, незнакомая запись — ignored', () => {
    assert.deepEqual(adapter.parseLine('   '), { kind: 'ignored' });
    assert.deepEqual(adapter.parseLine('не json'), { kind: 'unparsed', line: 'не json' });
    assert.deepEqual(adapter.parseLine('42'), { kind: 'ignored' });
    assert.deepEqual(adapter.parseLine('null'), { kind: 'ignored' });
    assert.deepEqual(adapter.parseLine('{"type":"future"}'), { kind: 'ignored' });
    assert.deepEqual(adapter.parseLine('{"type":"system","subtype":"other"}'), { kind: 'ignored' });
  });
});

describe('cursor-backend: перечень моделей', () => {
  // Сценарий: «Каталог разобран»
  it('models.txt даёт модели с подписями, без effort и дубликатов', () => {
    const models = parseCursorModelList(readFileSync(join(FIXTURES, 'models.txt'), 'utf8'));

    assert.ok(models.every((model) => model.efforts === undefined && model.defaultEffort === undefined));
    assert.deepEqual(models, [
      { name: 'auto', label: 'Auto' },
      { name: 'sonnet-4.5', label: 'Claude 4.5 Sonnet' },
      { name: 'gpt-5', label: 'GPT-5' },
    ]);
  });

  // Сценарий: «Неразборный вывод»
  it('неразборный вывод даёт пустой список', () => {
    assert.deepEqual(parseCursorModelList('Error: not logged in\n'), []);
    assert.deepEqual(parseCursorModelList(''), []);
  });

  it('проба — <command> models, parse берёт stdout', () => {
    const probe = cursorModelDiscovery.probe(CONFIG);
    assert.deepEqual(probe.command, ['cursor-agent', 'models']);
    assert.equal(probe.stdin, '');
    assert.deepEqual(
      cursorModelDiscovery.parse({ stdout: 'auto - Auto\n', stderr: '', exitCode: 0 }),
      [{ name: 'auto', label: 'Auto' }],
    );
  });
});

describe('cursor-backend: исполнение шага на подменённом CLI', () => {
  const MODULE = fileURLToPath(new URL('../src/parts/backends/cursor/index.js', import.meta.url));

  /**
   * Проект с плагином `cursor` и исполняемым `cursor-agent`, который пишет argv
   * и stdin каждого запуска в `calls/<n>.json` и печатает фикстуру: `resume.jsonl`,
   * если пришёл `--resume`, иначе `new.jsonl`. Ни сети, ни настоящего CLI.
   * Шебанг — абсолютный путь к node: PATH шага не обязан его содержать.
   */
  function fakeCursorProject(pipeline: string) {
    const project = makeProject({ 'burnex.yml': pipeline });
    const bin = tempDir('cursor-bin-');
    const calls = join(bin, 'calls');
    const script = join(bin, 'cursor-agent');
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
const name = argv.includes('--resume') ? 'resume.jsonl' : 'new.jsonl';
process.stdout.write(fs.readFileSync(path.join(${JSON.stringify(FIXTURES)}, name), 'utf8'));
`,
    );
    chmodSync(script, 0o755);
    // `command` допустим только в глобальной конфигурации.
    writeFileSync(
      join(project.home, '.burnex', 'config.yml'),
      `plugins: [${JSON.stringify(MODULE)}]\nbackends:\n  cursor-agent:\n    command: ${JSON.stringify(script)}\n`,
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
    `      - id: ${id}\n        agent: cursor-agent\n        prompt: "Промпт ${id}"\n        expect: [{ exit_code: 0 }]\n${extra}`;

  // Сценарий: «Шаг на подменённом CLI»
  it('два шага в session: shared: второй запуск получает --resume с сессией первого', async () => {
    const { project, recorded } = fakeCursorProject(
      `name: p\njobs:\n  работа:\n    session: shared\n    steps:\n${step('первый')}${step('второй')}`,
    );

    const result = await run(project);

    assert.equal(result.status, 'success');
    const calls = recorded();
    assert.equal(calls.length, 2);
    assert.ok(!calls[0]?.argv.includes('--resume'), 'первый шаг не знает сессии заранее');
    const resume = calls[1]?.argv ?? [];
    assert.equal(resume[resume.indexOf('--resume') + 1], 'c6b62c6f-7ead-4fd6-9922-e952131177ff');
    // Промпт каждого шага дошёл до скрипта последним аргументом.
    assert.match(calls[0]?.argv.at(-1) ?? '', /Промпт первый/);
    assert.match(resume.at(-1) ?? '', /Промпт второй/);
    assert.deepEqual(
      (readStatus(result.journal.paths).jobs[0]?.steps ?? []).map((item) => item.session),
      ['c6b62c6f-7ead-4fd6-9922-e952131177ff', 'c6b62c6f-7ead-4fd6-9922-e952131177ff'],
    );
  });

  // Сценарий: «Effort из настроек»
  it('defaults.effort: прогон идёт, команда без effort, в журнале backend.degraded', async () => {
    const { project, recorded } = fakeCursorProject(
      `name: p\njobs:\n  работа:\n    steps:\n${step('один')}`,
    );
    project.write('.burnex/config.yml', 'defaults:\n  effort: high\n');

    const result = await run(project);

    assert.equal(result.status, 'success');
    const [call] = recorded();
    assert.ok(!call?.argv.some((arg) => /effort|^high$/.test(arg)), 'effort не передан ни в каком виде');
    const degraded = readEvents(result.journal.paths).flatMap((event) =>
      event.kind === 'backend.degraded' && event.capability === 'effort' ? [event] : [],
    );
    assert.equal(degraded.length, 1);
    assert.equal(degraded[0]?.backend, 'cursor-agent');
  });

  // Сценарии: «Схема вывода у шага», «MCP у шага», «Жёсткий режим»
  // Отказ должен прийти от предстартовой проверки движка, а не из `launch()`:
  // исключение песочницы тоже не дало бы скрипту запуститься, но назвало бы
  // не шаг и пришло бы уже после старта работы. Поэтому сверяется текст — он
  // называет и бэкенд, и `<job>/<step>`, чего ошибки `launch()` не делают. В
  // варианте strict нет `allow`: иначе отказ песочницы за allow подменял бы
  // проверяемый.
  it('output_schema, mcp, enforce: strict и судья отказывают предстартовой проверкой', async () => {
    const declarations: Record<string, { extra: string; message: RegExp }> = {
      output_schema: {
        extra: '        output_schema: ./schema.json\n',
        message: /^Бэкенд cursor-agent не поддерживает структурированный вывод, нужный для output_schema шага работа\/один$/,
      },
      mcp: {
        extra: '        mcp:\n          s: { command: [node, a.js] }\n',
        message: /^Бэкенд cursor-agent не объявляет возможность работать с MCP-серверами, объявленными у шага работа\/один$/,
      },
      'enforce: strict': {
        extra: '        permissions:\n          enforce: strict\n',
        message: /^Бэкенд cursor-agent не умеет применять enforce: strict, объявленный у шага работа\/один$/,
      },
      judge: {
        extra: '',
        message: /^Бэкенд судьи cursor-agent не поддерживает структурированный вывод, нужный для вердикта у шага работа\/один$/,
      },
    };
    for (const [name, { extra, message }] of Object.entries(declarations)) {
      const body =
        name === 'judge'
          ? step('один').replace('expect: [{ exit_code: 0 }]', 'expect: [{ judge: "всё хорошо", agent: cursor-agent }]')
          : step('один', extra);
      const { project, calls } = fakeCursorProject(`name: p\njobs:\n  работа:\n    steps:\n${body}`);
      project.write('schema.json', '{ "type": "object" }\n');

      await assert.rejects(
        run(project),
        (error: unknown) => error instanceof StepcastError && message.test(error.message),
        name,
      );
      assert.equal(existsSync(calls), false, `${name}: скрипт не должен был запуститься`);
    }
  });

  // Флаг конфигурации не включает возможность, которой у адаптера нет, —
  // и линт обязан сказать это раньше прогона, не советуя включить флаг.
  it('линт спрашивает возможность адаптера, а не флаг конфигурации', async () => {
    const { project } = fakeCursorProject(
      `name: p\njobs:\n  работа:\n    steps:\n` +
        step('один', '        output_schema: ./schema.json\n        mcp:\n          s: { command: [node, a.js] }\n') +
        step('два').replace('expect: [{ exit_code: 0 }]', 'expect: [{ judge: "всё хорошо", agent: cursor-agent }]'),
    );
    project.write('schema.json', '{ "type": "object" }\n');
    project.write('.burnex/config.yml', 'backends:\n  cursor-agent: { structured_output: true, mcp: true }\n');
    const { resolved, registry } = await resolveWithPlugins(
      {
        cwd: project.root,
        home: project.home,
        globalPath: join(project.home, '.burnex', 'config.yml'),
        projectPath: join(project.root, '.burnex', 'config.yml'),
      },
      {},
    );
    assert.equal(resolved.config.backends['cursor-agent']?.structuredOutput, true, 'флаг включён конфигурацией');

    const errors = lintPipeline(
      expandPipeline({ pipelinePath: project.path('burnex.yml'), config: resolved.config, registry }),
      { config: resolved.config, registry },
    ).filter((item) => item.severity === 'error');

    const schema = errors.find((item) => item.at === 'jobs.работа.steps.0.output_schema');
    assert.ok(schema, 'output_schema отклонён линтом');
    assert.match(schema.hint ?? '', /Адаптер бэкенда cursor-agent этой возможности не объявляет/);
    assert.doesNotMatch(schema.hint ?? '', /Включите/);
    const mcp = errors.find((item) => /MCP-серверами/.test(item.message));
    assert.ok(mcp, 'mcp отклонён линтом');
    assert.doesNotMatch(mcp.hint ?? '', /Включите/);
    const judge = errors.find((item) => /Бэкенд судьи cursor-agent не поддерживает/.test(item.message));
    assert.ok(judge, 'судья отклонён линтом');
    assert.match(judge.hint ?? '', /назначьте судье другой бэкенд/);
  });
});
