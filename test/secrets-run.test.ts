import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/kernel/errors.js';
import { applyDeclarativePlugin } from '../src/kernel/load.js';
import { registryFromKernel, type Registry } from '../src/kernel/registry.js';
import { createBuiltinKernel } from '../src/parts/builtin.js';
import { createFakeBackend, initLine, resultLine } from '../src/parts/pipeline/backend/fake.js';
import type { BackendAdapter } from '../src/parts/pipeline/backend/types.js';
import {
  DECLARATIVE_CONTRIBUTION_FIELDS,
  type PipelinePlugin,
  type StepKindInput,
} from '../src/parts/pipeline/contract.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { readEvents, readManifest } from '../src/parts/pipeline/run/journal/reader.js';
import { planResume, readSourceRun } from '../src/parts/pipeline/run/resumePlan.js';
import { runPipeline, type RunResult } from '../src/parts/pipeline/run/runner.js';
import { createKeychainProvider } from '../src/parts/pipeline/secrets/keychain.js';
import { gitCommit, gitInit, makeProject, testBaseEnv, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

const SECRET = 'токен-секрета-12345';

interface Started {
  readonly result: RunResult;
  readonly runsRoot: string;
}

function registryWith(plugin?: PipelinePlugin): Promise<Registry> {
  const kernel = createBuiltinKernel();
  if (plugin === undefined) return Promise.resolve(registryFromKernel(kernel));
  return applyDeclarativePlugin(kernel, plugin, '/модуль/p.js', DECLARATIVE_CONTRIBUTION_FIELDS).then(() =>
    registryFromKernel(kernel),
  );
}

function configIn(project: Project, runsRoot: string) {
  return { ...project.config, runs: { ...project.config.runs, root: runsRoot } };
}

async function start(
  project: Project,
  options: {
    readonly registry?: Registry;
    readonly baseEnv?: Record<string, string | undefined>;
    readonly adapterFor?: (name: string) => BackendAdapter;
    readonly runsRoot?: string;
  } = {},
): Promise<Started> {
  const runsRoot = options.runsRoot ?? tempDir('runs-');
  const config = configIn(project, runsRoot);
  const result = await runPipeline({
    expanded: expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config,
      ...(options.registry === undefined ? {} : { registry: options.registry }),
    }),
    config,
    projectRoot: project.root,
    cwd: project.root,
    baseEnv: options.baseEnv ?? testBaseEnv(),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.adapterFor === undefined ? {} : { adapterFor: options.adapterFor }),
  });
  return { result, runsRoot };
}

const read = (result: RunResult, relative: string): string =>
  readFileSync(join(result.journal.paths.dir, relative), 'utf8');

/** Пайплайн: один секрет из `.env.local`, одна работа, шаги вызывающего. */
function pipeline(steps: string, options: { header?: string; secret?: string; env?: string } = {}): string {
  return `
kind: pipeline
name: p
${options.header ?? ''}secrets:
  svc:
    provider: env-file
    file: .env.local
    env: ${options.env ?? 'SVC_CRED'}
${options.secret ?? ''}jobs:
  build:
    steps:
${steps}
`;
}

const ENV_FILE = { '.env.local': `SVC_CRED=${SECRET}\n` };

describe('secrets: разрешение до каталога прогона', () => {
  async function refused(files: Record<string, string>, registry?: Registry): Promise<StepcastError> {
    const project = makeProject(files);
    const runsRoot = tempDir('runs-');
    try {
      await start(project, { runsRoot, ...(registry === undefined ? {} : { registry }) });
    } catch (error) {
      assert.ok(error instanceof StepcastError, `ожидался StepcastError, пришло ${String(error)}`);
      assert.deepEqual(readdirSync(runsRoot), [], 'отказ не оставляет каталога прогона');
      return error;
    }
    return assert.fail('ожидался отказ запуска');
  }

  const USING = '      - { id: a, run: [echo, ok], secrets: [svc] }\n';

  it('короткое значение: отказ называет секрет и порог в 8 символов', async () => {
    const error = await refused({ '.env.local': 'SVC_CRED=short\n', 'stepcast.yml': pipeline(USING) });
    assert.match(error.message, /svc/);
    assert.match(error.message, /короче 8 символов/);
  });

  it('значение ровно в 8 символов принимается', async () => {
    const project = makeProject({ '.env.local': 'SVC_CRED=12345678\n', 'stepcast.yml': pipeline(USING) });
    assert.equal((await start(project)).result.status, 'success');
  });

  it('отсутствующий файл и отсутствующий ключ env-file', async () => {
    const noFile = await refused({ 'stepcast.yml': pipeline(USING) });
    assert.match(noFile.message, /\.env\.local/);
    const noKey = await refused({ '.env.local': 'OTHER=значение-значение\n', 'stepcast.yml': pipeline(USING) });
    assert.match(noKey.message, /SVC_CRED/);
  });

  it('неизвестный провайдер', async () => {
    const error = await refused({
      'stepcast.yml': `
kind: pipeline
secrets:
  svc: { provider: vault }
jobs:
  build:
    steps:
${USING}`,
    });
    assert.match(error.message, /провайдер vault не зарегистрирован/);
  });

  it('параметры против схемы провайдера', async () => {
    const error = await refused({
      'stepcast.yml': `
kind: pipeline
secrets:
  svc: { provider: env-file, extra: 1 }
jobs:
  build:
    steps:
${USING}`,
    });
    assert.match(error.message, /не соответствуют схеме провайдера env-file/);
  });

  describe('провайдер плагина', () => {
    const decl = `
kind: pipeline
secrets:
  svc: { provider: vault }
jobs:
  build:
    steps:
      - { id: a, run: [sh, -c, 'echo "$SVC"'], secrets: [svc], env: {} }
`;
    const withResolve = (resolve: () => Promise<unknown>): PipelinePlugin => ({
      name: 'vault-plugin',
      secretProviders: [{ name: 'vault', schema: { type: 'object' }, resolve: resolve as () => Promise<string> }],
    });

    it('значение берётся из resolve плагина', async () => {
      const registry = await registryWith(withResolve(async () => 'значение-из-vault'));
      const project = makeProject({ 'stepcast.yml': decl.replace('$SVC', '$SVC').replace('svc: { provider: vault }', 'svc: { provider: vault, env: SVC }') });
      const { result } = await start(project, { registry });
      assert.equal(result.status, 'success');
      assert.equal(read(result, 'jobs/build/steps/01-a/stdout.log'), '***\n');
    });

    for (const [title, resolve, expected] of [
      ['resolve бросил', async () => Promise.reject(new Error('сеть недоступна')), /сеть недоступна/],
      ['resolve вернул не строку', async () => 42, /вернул не строку/],
      ['resolve вернул пустое значение', async () => '', /пустое значение/],
      ['значение с переводом строки', async () => 'первая-строка\nвторая', /перевод строки/],
    ] as const) {
      it(`${title}: отказ запуска без каталога прогона`, async () => {
        const registry = await registryWith(withResolve(resolve));
        const error = await refused({ 'stepcast.yml': decl }, registry);
        assert.match(error.message, /svc/);
        assert.match(error.message, expected);
      });
    }
  });

  it('секрет, который никто не называет, не разрешается: отсутствующий файл не мешает старту', async () => {
    const project = makeProject({ 'stepcast.yml': pipeline('      - { id: a, run: [echo, ok] }\n') });
    assert.equal((await start(project)).result.status, 'success');
  });

  it('значения не попадают ни в манифест, ни в замок прогона', async () => {
    const project = makeProject({ ...ENV_FILE, 'stepcast.yml': pipeline(USING) });
    const { result } = await start(project);
    const dir = result.journal.paths.dir;
    assert.doesNotMatch(readFileSync(join(dir, 'pipeline.lock.yml'), 'utf8'), new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(readManifest(result.journal.paths)), new RegExp(SECRET));
    assert.match(readFileSync(join(dir, 'pipeline.lock.yml'), 'utf8'), /secrets:\n {2}svc:/);
  });
});

describe('secrets: возобновление', () => {
  const PIPELINE = pipeline('      - { id: a, run: [echo, ok], secrets: [svc] }\n');

  it('ротация значения не меняет ключ шага: шаг переиспользуется', async () => {
    const project = makeProject({ ...ENV_FILE, 'stepcast.yml': PIPELINE, '.gitignore': '.env.local\n' });
    gitInit(project.root);
    gitCommit(project.root, 'init');
    const runsRoot = tempDir('runs-');
    const first = await start(project, { runsRoot });
    assert.equal(first.result.status, 'success');

    project.write('.env.local', 'SVC_CRED=другое-значение-67890\n');
    const { plan } = planResume({
      cwd: project.root,
      config: configIn(project, runsRoot),
      source: readSourceRun(first.result.journal.paths),
    });
    assert.ok(plan.steps.length > 0);
    assert.ok(plan.steps.every((item) => item.decision.kind === 'reuse'));
  });

  it('возобновление разрешает секреты заново; пропавший файл — отказ без нового каталога', async () => {
    const project = makeProject({ ...ENV_FILE, 'stepcast.yml': PIPELINE, '.gitignore': '.env.local\n' });
    gitInit(project.root);
    gitCommit(project.root, 'init');
    const runsRoot = tempDir('runs-');
    const first = await start(project, { runsRoot });
    const projectDir = readdirSync(runsRoot).filter((name) => name !== 'projects.json');
    const before = readdirSync(join(runsRoot, projectDir[0]!)).sort();

    project.write('.env.local', 'SVC_CRED=коротко\n');
    const config = configIn(project, runsRoot);
    const source = readSourceRun(first.result.journal.paths);
    const { expanded, plan } = planResume({ cwd: project.root, config, source });

    await assert.rejects(
      () =>
        runPipeline({
          expanded,
          config,
          projectRoot: project.root,
          cwd: project.root,
          baseEnv: testBaseEnv(),
          resume: { plan, source },
        }),
      (error: unknown) => error instanceof StepcastError && /короче 8 символов/.test(error.message),
    );
    assert.deepEqual(readdirSync(join(runsRoot, projectDir[0]!)).sort(), before, 'нового каталога прогона нет');
  });
});

describe('secrets: окружение шага', () => {
  /** Шаг печатает значение переменной в файл рабочего дерева: stdout журнала маскируется. */
  // Без фигурных скобок: `${…}` в документе — подстановка stepcast, а не оболочки.
  const dump = (id: string, extra = ''): string =>
    `      - { id: ${id}, run: [sh, -c, 'if [ -n "$SVC_CRED" ]; then printf "%s" "$SVC_CRED"; else printf ABSENT; fi > ${id}.seen'], expect: [{ exit_code: 0 }]${extra} }\n`;
  const seen = (project: Project, id: string): string => readFileSync(project.path(`${id}.seen`), 'utf8');

  it('объявивший шаг получает значение, соседний шаг — нет, хотя переменная есть в окружении процесса', async () => {
    const project = makeProject({
      ...ENV_FILE,
      'stepcast.yml': pipeline(dump('named', ', secrets: [svc]') + dump('neighbour')),
    });
    const { result } = await start(project, {
      baseEnv: { ...testBaseEnv(), SVC_CRED: 'из-окружения-процесса' },
    });
    assert.equal(result.status, 'success');
    assert.equal(seen(project, 'named'), SECRET);
    assert.equal(seen(project, 'neighbour'), 'ABSENT');
  });

  it('секрет с env, подпадающим под env_deny, доходит и не порождает env.denied', async () => {
    const project = makeProject({
      '.env.local': `GITHUB_TOKEN=${SECRET}\n`,
      'stepcast.yml': `
kind: pipeline
secrets:
  gh: { provider: env-file, file: .env.local, env: GITHUB_TOKEN }
jobs:
  build:
    steps:
      - { id: a, run: [sh, -c, 'if [ -n "$GITHUB_TOKEN" ]; then printf "%s" "$GITHUB_TOKEN"; else printf ABSENT; fi > a.seen'], secrets: [gh] }
`,
    });
    const { result } = await start(project);
    assert.equal(result.status, 'success');
    assert.equal(seen(project, 'a'), SECRET);
    assert.deepEqual(
      readEvents(result.journal.paths).filter((event) => event.kind === 'env.denied' && event.name === 'GITHUB_TOKEN'),
      [],
    );
  });

  it('env.withheld: пишется один раз на пару «переменная, шаг», только если переменная была', async () => {
    const project = makeProject({
      ...ENV_FILE,
      'stepcast.yml': pipeline(
        dump('named', ', secrets: [svc]') + dump('neighbour') + dump('neighbour-again'),
        { header: 'env_files: [.from-file.env]\n' },
      ),
      '.from-file.env': 'SVC_CRED=из-env-files-12345\n',
    });
    const { result } = await start(project);
    assert.equal(result.status, 'success');
    assert.equal(seen(project, 'neighbour'), 'ABSENT');

    const withheld = readEvents(result.journal.paths).filter((event) => event.kind === 'env.withheld');
    assert.deepEqual(
      withheld.map((event) => (event.kind === 'env.withheld' ? [event.name, event.secret, event.scope] : [])),
      [
        ['SVC_CRED', 'svc', 'jobs.build.steps.neighbour'],
        ['SVC_CRED', 'svc', 'jobs.build.steps.neighbour-again'],
      ],
    );
  });

  it('переменной не было в окружении — события env.withheld нет', async () => {
    const project = makeProject({
      ...ENV_FILE,
      'stepcast.yml': pipeline(dump('named', ', secrets: [svc]') + dump('neighbour')),
    });
    const base = testBaseEnv();
    delete base.SVC_CRED;
    const { result } = await start(project, { baseEnv: base });
    assert.equal(result.status, 'success');
    assert.deepEqual(readEvents(result.journal.paths).filter((event) => event.kind === 'env.withheld'), []);
  });

  it('проверка expect шага секрета не получает: cmd видит окружение без значения', async () => {
    const project = makeProject({
      ...ENV_FILE,
      'stepcast.yml': pipeline(
        `      - id: a\n        run: [sh, -c, 'test -n "$SVC_CRED"']\n        secrets: [svc]\n        expect: [{ exit_code: 0 }, { cmd: 'test -z "$SVC_CRED"' }]\n`,
      ),
    });
    assert.equal((await start(project)).result.status, 'success');
  });

  it('проверка цикла until идёт с вычеркнутыми переменными секретов', async () => {
    const project = makeProject({
      ...ENV_FILE,
      'stepcast.yml': `
kind: pipeline
secrets:
  svc: { provider: env-file, file: .env.local, env: SVC_CRED }
jobs:
  build:
    until:
      max_iterations: 1
      check: [{ cmd: 'test -z "$SVC_CRED"' }]
    steps:
      - { id: a, run: [echo, ok], secrets: [svc] }
`,
    });
    const { result } = await start(project, { baseEnv: { ...testBaseEnv(), SVC_CRED: 'из-окружения-12345' } });
    assert.equal(result.status, 'success');
  });

  describe('агентский шаг', () => {
    /** Агент, чей процесс записывает полученную переменную в файл рабочего дерева. */
    function envDumpingAgent(): BackendAdapter {
      const base = createFakeBackend({ lines: [initLine(), resultLine({ text: 'готово' })] });
      return {
        ...base.adapter,
        launch(invocation) {
          const spec = base.adapter.launch(invocation);
          const [node, flag, script] = spec.command as [string, string, string];
          const dump = `require('fs').writeFileSync('agent.seen', process.env.SVC_CRED ?? 'ABSENT');`;
          return { ...spec, command: [node, flag, dump + script] };
        },
      };
    }

    it('получает пустой набор секретов: переменная из окружения процесса вычеркнута', async () => {
      const project = makeProject({
        ...ENV_FILE,
        'stepcast.yml': pipeline('      - { id: think, agent: fake, prompt: подумай }\n'),
      });
      const { result } = await start(project, {
        baseEnv: { ...testBaseEnv(), SVC_CRED: 'из-окружения-процесса' },
        adapterFor: () => envDumpingAgent(),
      });
      assert.equal(result.status, 'success');
      assert.equal(readFileSync(project.path('agent.seen'), 'utf8'), 'ABSENT');
      const withheld = readEvents(result.journal.paths).filter((event) => event.kind === 'env.withheld');
      assert.equal(withheld.length, 1);
    });
  });

  describe('шаг плагинного вида', () => {
    it('получает значения полем env входа исполнителя', async () => {
      let received: Readonly<Record<string, string>> | undefined;
      const registry = await registryWith({
        name: 'notify-plugin',
        steps: [
          {
            name: 'notify',
            title: 'Уведомление',
            fields: { type: 'string' },
            execute: (input: StepKindInput) => {
              received = input.env;
              return { text: 'ok' };
            },
          },
        ],
      });
      const project = makeProject({
        ...ENV_FILE,
        'stepcast.yml': pipeline('      - { id: n, notify: hello, secrets: [svc] }\n'),
      });
      const { result } = await start(project, { registry });
      assert.equal(result.status, 'success');
      assert.equal(received?.SVC_CRED, SECRET);
    });
  });
});

describe('secrets: подстановка ${env.*}', () => {
  const job = (env: string, step: string): string => `
kind: pipeline
secrets:
  svc: { provider: env-file, file: .env.local, env: SVC_CRED }
jobs:
  build:
${env}    steps:
${step}`;

  it('${env.<env секрета>}: работа отказывает до первого шага, называя секрет', async () => {
    const project = makeProject({
      ...ENV_FILE,
      'stepcast.yml': job('', '      - { id: a, run: [echo, "${env.SVC_CRED}"], secrets: [svc] }\n'),
    });
    const { result } = await start(project);
    assert.equal(result.status, 'failed');
    const reason = readEvents(result.journal.paths).find((event) => event.kind === 'job.finished');
    assert.ok(reason?.kind === 'job.finished');
    assert.match(reason.reason ?? '', /секрет svc/);
    assert.match(reason.reason ?? '', /secrets: командного шага/);
    assert.equal(readEvents(result.journal.paths).some((event) => event.kind === 'step.started'), false);
    assert.equal(existsSync(join(result.journal.paths.dir, 'jobs/build/resolved.json')), false);
  });

  it('переменная со встроенным значением секрета: отказ с объяснением', async () => {
    const project = makeProject({
      ...ENV_FILE,
      'stepcast.yml': job(
        `    env: { DATABASE_URL: "postgres://user:${SECRET}@db/app" }\n`,
        // Секрет назван шагом, поэтому разрешён и его значение известно движку.
        '      - { id: a, run: [echo, "${env.DATABASE_URL}"], secrets: [svc] }\n',
      ),
    });
    const { result } = await start(project);
    assert.equal(result.status, 'failed');
    const reason = readEvents(result.journal.paths).find((event) => event.kind === 'job.finished');
    assert.ok(reason?.kind === 'job.finished');
    assert.match(reason.reason ?? '', /DATABASE_URL/);
    assert.match(reason.reason ?? '', /содержит секрет svc/);
    // Значения нет нигде в журнале: ни в событии, ни в раскрытом определении.
    assert.doesNotMatch(readFileSync(result.journal.paths.events, 'utf8'), new RegExp(SECRET));
    assert.equal(existsSync(join(result.journal.paths.dir, 'jobs/build/resolved.json')), false);
  });

  it('обычная объявленная переменная без секрета подставляется как прежде', async () => {
    const project = makeProject({
      ...ENV_FILE,
      'stepcast.yml': job('    env: { GREETING: hello }\n', '      - { id: a, run: [echo, "${env.GREETING}"] }\n'),
    });
    const { result } = await start(project);
    assert.equal(result.status, 'success');
    assert.equal(read(result, 'jobs/build/steps/01-a/stdout.log'), 'hello\n');
  });
});

describe('secrets: маскирование в журнале', () => {
  const NAMED = (command: string): string =>
    pipeline(`      - { id: a, run: [sh, -c, '${command}'], secrets: [svc], expect: [{ exit_code: 0 }] }\n`);

  it('секрет в stdout.log и stderr.log заменён на ***', async () => {
    const project = makeProject({ ...ENV_FILE, 'stepcast.yml': NAMED('echo "токен $SVC_CRED"; echo "err $SVC_CRED" >&2') });
    const { result } = await start(project);
    assert.equal(result.status, 'success');
    assert.equal(read(result, 'jobs/build/steps/01-a/stdout.log'), 'токен ***\n');
    assert.equal(read(result, 'jobs/build/steps/01-a/stderr.log'), 'err ***\n');
  });

  it('значение на стыке двух кусков вывода без перевода строки между ними', async () => {
    const half = Math.floor(SECRET.length / 2);
    const project = makeProject({
      ...ENV_FILE,
      'stepcast.yml': NAMED(
        `printf "%s" "${SECRET.slice(0, half)}"; sleep 0.4; printf "%s\\n" "${SECRET.slice(half)}"`,
      ),
    });
    const { result } = await start(project);
    const log = read(result, 'jobs/build/steps/01-a/stdout.log');
    assert.equal(log, '***\n');
    assert.ok(!log.includes(SECRET.slice(0, half)) && !log.includes(SECRET.slice(half)));
  });

  it('хвост без перевода строки сбрасывается на конце потока замаскированным', async () => {
    const project = makeProject({ ...ENV_FILE, 'stepcast.yml': NAMED('printf "%s" "$SVC_CRED"') });
    const { result } = await start(project);
    assert.equal(read(result, 'jobs/build/steps/01-a/stdout.log'), '***');
  });

  it('значение из выхода прошлой работы в промпте агентского шага: prompt.txt несёт ***', async () => {
    const project = makeProject({
      ...ENV_FILE,
      'stepcast.yml': `
kind: pipeline
secrets:
  svc: { provider: env-file, file: .env.local, env: SVC_CRED }
jobs:
  build:
    context: [{ text: "в выходе прошлой работы оказалось ${SECRET}" }]
    steps:
      - { id: use, run: [echo, ok], secrets: [svc] }
      - { id: think, agent: fake, prompt: подумай }
`,
    });
    const fake = createFakeBackend({ lines: [initLine(), resultLine({ text: 'готово' })] });
    const { result } = await start(project, { adapterFor: () => fake.adapter });
    assert.equal(result.status, 'success');
    const prompt = read(result, 'jobs/build/steps/02-think/prompt.txt');
    assert.match(prompt, /оказалось \*\*\*/);
    assert.doesNotMatch(prompt, new RegExp(SECRET));
  });

  it('событие со значением в тексте пишется маскированным и в файл, и наблюдателю', async () => {
    const project = makeProject({ ...ENV_FILE, 'stepcast.yml': NAMED('echo ok') });
    const delivered: string[] = [];
    const config = configIn(project, tempDir('runs-'));
    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config }),
      config,
      projectRoot: project.root,
      cwd: project.root,
      baseEnv: testBaseEnv(),
      onEvent: (event) => delivered.push(JSON.stringify(event)),
    });
    result.journal.event({ kind: 'bookkeeping.failed', operation: 'проба', detail: `упало с ${SECRET}` });
    const raw = readFileSync(result.journal.paths.events, 'utf8');
    assert.doesNotMatch(raw, new RegExp(SECRET));
    assert.match(raw, /упало с \*\*\*/);
    assert.ok(delivered.every((line) => !line.includes(SECRET)));
    assert.ok(delivered.some((line) => line.includes('упало с ***')));
  });

  it('без секретов вывод идёт как есть', async () => {
    const project = makeProject({
      'stepcast.yml': 'kind: pipeline\njobs:\n  b:\n    steps:\n      - { id: a, run: [sh, -c, "echo токен-12345678"] }\n',
    });
    const { result } = await start(project);
    assert.equal(read(result, 'jobs/b/steps/01-a/stdout.log'), 'токен-12345678\n');
  });
});

describe('secrets: провайдер keychain не на macOS', () => {
  it('запуск отклонён до каталога прогона с объяснением про macOS, а не про команду', async () => {
    // Настоящее имя `keychain` занято встроенной строкой, а на macOS она
    // вызвала бы настоящий `security`; поэтому платформа подменяется у
    // провайдера под другим именем, с той же схемой и той же фабрикой. Команда
    // несуществующая: запусти её провайдер — отказ был бы про отсутствие файла.
    const linux = createKeychainProvider({ command: '/нет/такой/security', platform: 'linux' });
    const registry = await registryWith({
      name: 'keychain-linux-plugin',
      secretProviders: [{ ...linux, name: 'keychain-linux' }],
    });
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
secrets:
  gh-token: { provider: keychain-linux, service: github.com, account: alice, env: GH_TOKEN }
jobs:
  build:
    steps:
      - { id: a, run: [echo, ok], secrets: [gh-token] }
`,
    });
    const runsRoot = tempDir('runs-');

    await assert.rejects(start(project, { registry, runsRoot }), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.equal(error.at, 'secrets.gh-token');
      assert.match(error.message, /только на macOS/);
      assert.doesNotMatch(error.message, /не найдена/);
      return true;
    });
    assert.deepEqual(readdirSync(runsRoot), [], 'отказ не оставляет каталога прогона');
  });
});
