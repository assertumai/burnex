import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { run, type CliIo } from '../src/parts/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/kernel/errors.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { lintPipeline, type Diagnostic } from '../src/parts/pipeline/domain/lint.js';
import { makeProject, withHome, type Project } from './helpers.js';

function lint(project: Project): Diagnostic[] {
  const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
  return lintPipeline(expanded, { config: project.config });
}

async function cli(project: Project, argv: readonly string[]): Promise<{ code: ExitCodeValue; out: string }> {
  const lines: string[] = [];
  const io: CliIo = { out: (line) => lines.push(line), err: (line) => lines.push(line), cwd: project.root };
  const code = await withHome(project.home, () => run(argv, io));
  return { code, out: lines.join('\n') };
}

const TOKEN = '  gh-token:\n    provider: env-file\n    file: .env.local\n';

/** Пайплайн с бюджетом (чтобы не шуметь предупреждением) и заданными секретами и шагами. */
function pipeline(options: { secrets?: string; header?: string; steps: string }): string {
  return `
kind: pipeline
name: p
budget: { tokens: 100k }
${options.header ?? ''}${options.secrets === undefined ? '' : `secrets:\n${options.secrets}`}jobs:
  build:
    steps:
${options.steps}
`;
}

const USING = '      - { id: a, run: [echo, ok], secrets: [gh-token] }\n';

const messages = (diagnostics: readonly Diagnostic[], severity: 'error' | 'warning'): string[] =>
  diagnostics.filter((item) => item.severity === severity).map((item) => item.message);

describe('lint: секреты', () => {
  it('чистое объявление и использование не дают ни ошибок, ни предупреждений о секретах', () => {
    const project = makeProject({ 'stepcast.yml': pipeline({ secrets: TOKEN, steps: USING }) });
    assert.deepEqual(
      lint(project).filter((item) => /секрет/i.test(item.message)),
      [],
    );
  });

  it('необъявленный секрет на шаге: имя и адрес шага — отказом разбора, который линт показывает как ошибку', async () => {
    const project = makeProject({
      'stepcast.yml': pipeline({ secrets: TOKEN, steps: '      - { id: deploy, run: [echo, ok], secrets: [missing] }\n' }),
    });
    const { code, out } = await cli(project, ['lint']);
    assert.equal(code, ExitCode.configError);
    assert.match(out, /missing/);
    assert.match(out, /deploy/);
    assert.match(out, /jobs\.build\.steps\.0\.secrets/);
  });

  it('secrets на агентском шаге: «агенту секрет не передаётся»', async () => {
    const project = makeProject({
      'stepcast.yml': pipeline({ secrets: TOKEN, steps: '      - { id: a, prompt: сделай, secrets: [gh-token] }\n' }),
    });
    const { code, out } = await cli(project, ['lint']);
    assert.equal(code, ExitCode.configError);
    assert.match(out, /Агенту секрет не передаётся/);
  });

  it('secrets на судье judge: тот же текст', async () => {
    const project = makeProject({
      'stepcast.yml': pipeline({
        secrets: TOKEN,
        steps: '      - id: a\n        run: [echo, ok]\n        expect: [{ judge: хорошо, secrets: [gh-token] }]\n',
      }),
    });
    const { code, out } = await cli(project, ['lint']);
    assert.equal(code, ExitCode.configError);
    assert.match(out, /Агенту секрет не передаётся/);
  });

  it('неизвестный провайдер: ошибка с именем провайдера и перечнем доступных', () => {
    const project = makeProject({
      'stepcast.yml': pipeline({ secrets: '  gh-token:\n    provider: vault\n    path: x\n', steps: USING }),
    });
    const errors = lint(project).filter((item) => item.severity === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /vault/);
    assert.equal(errors[0]!.at, 'secrets.gh-token.provider');
    assert.match(errors[0]!.hint ?? '', /env-file/);
  });

  it('параметры против схемы провайдера: файл обязателен, лишний ключ отклоняется', () => {
    const project = makeProject({
      'stepcast.yml': pipeline({
        secrets: '  gh-token:\n    provider: env-file\n  other:\n    provider: env-file\n    file: .env\n    extra: 1\n',
        steps: USING + '      - { id: b, run: [echo, ok], secrets: [other] }\n',
      }),
    });
    const errors = messages(lint(project), 'error');
    assert.equal(errors.length, 2);
    assert.match(errors[0]!, /gh-token.*env-file/);
    assert.match(errors[1]!, /other.*env-file/);
  });

  it('два секрета с одним env', () => {
    const project = makeProject({
      'stepcast.yml': pipeline({
        secrets: `${TOKEN}  other:\n    provider: env-file\n    file: .env\n    env: GH_TOKEN\n`,
        steps: USING + '      - { id: b, run: [echo, ok], secrets: [other] }\n',
      }),
    });
    const errors = messages(lint(project), 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /gh-token и other.*GH_TOKEN/);
  });

  it('явный env пайплайна, работы и шага с именем env секрета', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: p
budget: { tokens: 100k }
env: { SVC_CRED: из-пайплайна }
secrets:
  gh-token:
    provider: env-file
    file: .env.local
    env: SVC_CRED
jobs:
  build:
    env: { SVC_CRED: из-работы }
    steps:
      - { id: a, run: [echo, ok], secrets: [gh-token], env: { SVC_CRED: из-шага } }
`,
    });
    // Имя без суффикса `_TOKEN`: под встроенный `env_deny` оно не попадает, и
    // отказы здесь — только правило секретов.
    const found = lint(project).filter((item) => item.severity === 'error');
    assert.deepEqual(
      found.map((item) => item.at),
      ['env.SVC_CRED', 'jobs.build.env.SVC_CRED', 'jobs.build.steps.0.env.SVC_CRED'],
    );
    assert.match(found[0]!.message, /gh-token/);
  });

  it('${env.<env секрета>} в промпте агентского шага и в аргументе команды', () => {
    const project = makeProject({
      'stepcast.yml': pipeline({
        secrets: TOKEN,
        steps:
          '      - { id: a, run: [echo, "${env.GH_TOKEN}"], secrets: [gh-token] }\n' +
          '      - { id: b, prompt: "токен ${env.GH_TOKEN}" }\n' +
          '      - { id: c, run: [echo, "${env.HOME}"] }\n',
      }),
    });
    const errors = lint(project).filter((item) => item.severity === 'error');
    assert.deepEqual(
      errors.map((item) => item.at),
      ['jobs.build.steps.0.run.1', 'jobs.build.steps.1.prompt'],
    );
    assert.match(errors[0]!.message, /gh-token/);
    assert.match(errors[0]!.hint ?? '', /secrets:/);
  });

  it('неиспользуемый секрет — предупреждение, не ошибка', () => {
    const project = makeProject({
      'stepcast.yml': pipeline({ secrets: TOKEN, steps: '      - { id: a, run: [echo, ok] }\n' }),
    });
    const diagnostics = lint(project);
    assert.deepEqual(messages(diagnostics, 'error'), []);
    assert.match(messages(diagnostics, 'warning').join('\n'), /Секрет gh-token объявлен, но ни один шаг его не называет/);
  });

  it('stepcast lint завершается успехом на чистом документе с секретом', async () => {
    const project = makeProject({ 'stepcast.yml': pipeline({ secrets: TOKEN, steps: USING }) });
    const { code, out } = await cli(project, ['lint']);
    assert.equal(code, ExitCode.ok, out);
  });
});

describe('lint: keychain и учётные данные бэкендов', () => {
  const KEYCHAIN_SECRET = '  gh-token:\n    provider: keychain\n    service: github.com\n    account: alice\n';

  /** Конфигурация с записью `credentials` у бэкенда — как после разбора глобального конфига. */
  function withCredentials(
    project: Project,
    backend: string,
    credentials: Record<string, { provider: string; params: Record<string, unknown> }>,
  ): Project['config'] {
    return {
      ...project.config,
      backends: {
        ...project.config.backends,
        [backend]: { ...project.config.backends[backend]!, credentials },
      },
    };
  }

  function lintWith(project: Project, config: Project['config']): Diagnostic[] {
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config });
    return lintPipeline(expanded, { config });
  }

  const AGENT = '      - { id: think, agent: claude, prompt: подумай }\n';

  it('секрет keychain с валидными параметрами: линт не сообщает об ошибке, в том числе не на macOS', () => {
    const project = makeProject({ 'stepcast.yml': pipeline({ secrets: KEYCHAIN_SECRET, steps: USING }) });
    assert.deepEqual(messages(lint(project), 'error'), []);
  });

  it('секрет keychain без account: ошибка с указанием параметра', () => {
    const project = makeProject({
      'stepcast.yml': pipeline({
        secrets: '  gh-token:\n    provider: keychain\n    service: github.com\n',
        steps: USING,
      }),
    });
    const errors = messages(lint(project), 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /gh-token.*keychain/);
    assert.match(errors[0]!, /account/);
  });

  it('credentials с незарегистрированным провайдером: путь записи и имя провайдера', () => {
    const project = makeProject({ 'stepcast.yml': pipeline({ steps: AGENT }) });
    const config = withCredentials(project, 'claude', {
      ANTHROPIC_API_KEY: { provider: 'vault', params: { path: 'x' } },
    });
    const errors = lintWith(project, config).filter((item) => item.severity === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /vault/);
    assert.equal(errors[0]!.at, 'backends.claude.credentials.ANTHROPIC_API_KEY.provider');
    // Запись лежит в глобальном конфиге, а не в документе пайплайна.
    assert.equal(errors[0]!.file, config.globalConfigFile);
    assert.notEqual(errors[0]!.file, project.path('stepcast.yml'));
    assert.match(errors[0]!.hint ?? '', /keychain/);
  });

  it('credentials keychain без account: диагностика называет параметр и путь записи', () => {
    const project = makeProject({ 'stepcast.yml': pipeline({ steps: AGENT }) });
    const config = withCredentials(project, 'claude', {
      ANTHROPIC_API_KEY: { provider: 'keychain', params: { service: 'api.anthropic.com' } },
    });
    const errors = lintWith(project, config).filter((item) => item.severity === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /account/);
    assert.equal(errors[0]!.at, 'backends.claude.credentials.ANTHROPIC_API_KEY');
  });

  it('credentials бэкенда, которым пайплайн не идёт, не проверяются', () => {
    const project = makeProject({ 'stepcast.yml': pipeline({ steps: AGENT }) });
    const config = withCredentials(project, 'codex', {
      OPENAI_API_KEY: { provider: 'vault', params: {} },
    });
    assert.deepEqual(messages(lintWith(project, config), 'error'), []);
  });

  it('credentials с валидным keychain: диагностик нет', () => {
    const project = makeProject({ 'stepcast.yml': pipeline({ steps: AGENT }) });
    const config = withCredentials(project, 'claude', {
      ANTHROPIC_API_KEY: { provider: 'keychain', params: { service: 'api.anthropic.com', account: 'alice' } },
    });
    assert.deepEqual(messages(lintWith(project, config), 'error'), []);
  });
});
