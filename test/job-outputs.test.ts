import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { lintPipeline } from '../src/parts/pipeline/domain/lint.js';
import {
  JOB_OUTPUT_KEY,
  keyRejection,
  needsVarName,
  parseJobOutputs,
  type OutputPolicy,
} from '../src/parts/pipeline/run/jobOutputs.js';
import { jobOutputsPath } from '../src/parts/pipeline/run/journal/paths.js';
import { readStatus } from '../src/parts/pipeline/run/journal/reader.js';
import { JobRecordSchema } from '../src/parts/pipeline/run/journal/schema.js';
import { buildResumePlan, parseFrom, readSourceRun } from '../src/parts/pipeline/run/resumePlan.js';
import { runPipeline, type RunResult } from '../src/parts/pipeline/run/runner.js';
import { makeProject, testBaseEnv, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

const POLICY: OutputPolicy = { envDeny: ['*_TOKEN', '*_SECRET'], secretEnvs: ['DEPLOY_PASS'] };

function expand(project: Project) {
  return expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
}

async function runProject(project: Project): Promise<RunResult> {
  const runsRoot = tempDir('runs-');
  return runPipeline({
    expanded: expand(project),
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
}

function initRepo(project: Project): void {
  execFileSync('git', ['-C', project.root, 'init', '--quiet', '--initial-branch=main']);
  execFileSync('git', ['-C', project.root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', project.root, 'config', 'user.name', 'Тест']);
  execFileSync('git', ['-C', project.root, 'add', '-A']);
  execFileSync('git', ['-C', project.root, 'commit', '--quiet', '-m', 'первый']);
}

/** Шаг `run`, дописывающий в файл выходов переданный `printf`-текст. */
function publish(id: string, text: string): string {
  return `
      - id: ${id}
        run: [sh, -c, 'printf "${text}" >> "$STEPCAST_JOB_OUTPUTS"']
        expect: [{ exit_code: 0 }]`;
}

function jobStatus(result: RunResult, id: string) {
  return readStatus(result.journal.paths).jobs.find((job) => job.id === id);
}

describe('job-outputs: разбор объявления', () => {
  const doc = (outputs: string): string => `
version: 1
kind: pipeline
name: выходы
jobs:
  build:
${outputs}
    steps:
      - id: one
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`;

  it('принимает допустимые имена', () => {
    const project = makeProject({ 'stepcast.yml': doc('    outputs: [sha, branch_name]') });
    assert.deepEqual(expand(project).pipeline.jobs[0]?.outputs, ['sha', 'branch_name']);
  });

  it('работа без объявления получает пустой набор', () => {
    const project = makeProject({ 'stepcast.yml': doc('') });
    assert.deepEqual(expand(project).pipeline.jobs[0]?.outputs, []);
  });

  for (const bad of ['1sha', 'git-sha']) {
    it(`отклоняет «${bad}», называя работу и имя`, () => {
      const project = makeProject({ 'stepcast.yml': doc(`    outputs: [${bad}]`) });
      assert.throws(() => expand(project), (error: Error) => {
        assert.match(error.message, /Работа build/);
        assert.ok(error.message.includes(`«${bad}»`));
        return true;
      });
    });
  }

  it('ключ недопустим в обвязке uses', () => {
    const project = makeProject({
      'job.yml': `
version: 1
kind: job
name: работа
steps:
  - id: one
    run: [echo, ok]
    expect: [{ exit_code: 0 }]
`,
      'stepcast.yml': `
version: 1
kind: pipeline
name: обвязка
jobs:
  build:
    uses: ./job.yml
    outputs: [sha]
`,
    });
    assert.throws(() => expand(project), /outputs/);
  });
});

describe('job-outputs: имя переменной и разбор файла', () => {
  it('нормализует работу и сохраняет ключ как записан', () => {
    assert.equal(needsVarName('implement-a', 'sha'), 'NEEDS_IMPLEMENT_A_sha');
    assert.equal(needsVarName('build', 'SHA'), 'NEEDS_BUILD_SHA');
  });

  it('разбирает ключ до первого «=», значение буквально, срезает \\r, пропускает пустые строки', () => {
    const parsed = parseJobOutputs('build', 'a= x=y \r\n\nb=\r\n', POLICY);
    assert.deepEqual(parsed, { ok: true, outputs: { a: ' x=y ', b: '' } });
  });

  it('при повторе ключа действует последнее значение', () => {
    assert.deepEqual(parseJobOutputs('build', 'a=1\na=2\n', POLICY), { ok: true, outputs: { a: '2' } });
  });

  it('отклоняет строку без «=»', () => {
    const parsed = parseJobOutputs('build', 'a=1\nпросто\n', POLICY);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /build.*строка 2/);
  });

  it('отклоняет недопустимую форму ключа', () => {
    const parsed = parseJobOutputs('build', 'bad-key=1\n', POLICY);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /bad-key/);
    assert.equal(JOB_OUTPUT_KEY.test('ok_key1'), true);
  });

  it('отклоняет значение длиннее 4096 байт UTF-8', () => {
    assert.equal(parseJobOutputs('build', `a=${'я'.repeat(2048)}\n`, POLICY).ok, true);
    const parsed = parseJobOutputs('build', `a=${'я'.repeat(2049)}\n`, POLICY);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /4096/);
  });

  it('отклоняет более 32 различных ключей, но не повторов', () => {
    const many = (n: number): string => Array.from({ length: n }, (_, i) => `k${i}=v`).join('\n');
    assert.equal(parseJobOutputs('build', many(32), POLICY).ok, true);
    assert.equal(parseJobOutputs('build', `${many(32)}\nk0=again`, POLICY).ok, true);
    assert.equal(parseJobOutputs('build', many(33), POLICY).ok, false);
  });

  it('отклоняет ключ, чья переменная подпадает под env_deny, называя шаблон', () => {
    const parsed = parseJobOutputs('build', 'API_TOKEN=x\n', POLICY);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /\*_TOKEN/);
    assert.match(keyRejection('build', 'DB_SECRET', POLICY) ?? '', /\*_SECRET/);
    assert.equal(keyRejection('build', 'cache_key', POLICY), undefined);
  });

  it('отклоняет ключ, чья переменная совпадает с переменной объявленного секрета', () => {
    const policy: OutputPolicy = { envDeny: [], secretEnvs: ['NEEDS_BUILD_pass'] };
    assert.match(keyRejection('build', 'pass', policy) ?? '', /секрет/);
  });
});

describe('job-outputs: журнал', () => {
  it('запись без outputs читается как работа без выходов', () => {
    const parsed = JobRecordSchema.safeParse({ id: 'build', status: 'success', steps: [] });
    assert.equal(parsed.success, true);
    assert.equal(parsed.success ? parsed.data.outputs : 'x', undefined);
  });

  it('запись с outputs проходит круг записи и чтения', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: журнал
jobs:
  build:
    outputs: [sha]
    steps:${publish('p', 'sha=abc123\\n')}
`,
    });
    const result = await runProject(project);
    assert.equal(result.status, 'success');
    assert.deepEqual(jobStatus(result, 'build')?.outputs, { sha: 'abc123' });
    assert.equal(existsSync(jobOutputsPath(result.journal.paths, 'build')), true);
  });
});

describe('job-outputs: исполнение', () => {
  it('два шага пишут в один файл, повтор ключа даёт последнее значение, необъявленный ключ принят', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: два-шага
jobs:
  build:
    outputs: [sha]
    steps:${publish('a', 'sha=old\\nextra=e\\n')}${publish('b', 'sha=new\\n')}
`,
    });
    const result = await runProject(project);
    assert.equal(result.status, 'success');
    assert.deepEqual(jobStatus(result, 'build')?.outputs, { sha: 'new', extra: 'e' });
  });

  it('вторая попытка attempts начинает с пустого файла', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: попытки
jobs:
  build:
    attempts: { max: 2 }
    steps:
      - id: p
        run:
          - sh
          - -c
          - |
            if [ "$STEPCAST_JOB_ATTEMPT" = 1 ]; then echo stale=1 >> "$STEPCAST_JOB_OUTPUTS"; exit 1; fi
            [ -s "$STEPCAST_JOB_OUTPUTS" ] && exit 9
            echo fresh=2 >> "$STEPCAST_JOB_OUTPUTS"
        expect: [{ exit_code: 0 }]
`,
    });
    // Откат дерева между попытками требует репозитория.
    initRepo(project);
    const result = await runProject(project);
    assert.equal(result.status, 'success', jobStatus(result, 'build')?.reason);
    assert.deepEqual(jobStatus(result, 'build')?.outputs, { fresh: '2' });
  });

  const violation = async (
    text: string,
    extra = '',
  ): Promise<{ status?: string | undefined; reason?: string | undefined }> => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: нарушение
jobs:
  build:
    attempts: { max: 2 }${extra}
    steps:${publish('p', text)}
`,
    });
    const result = await runProject(project);
    const job = jobStatus(result, 'build');
    return { status: job?.status, reason: job?.reason };
  };

  it('строка без «=» роняет работу без повторных попыток', async () => {
    const outcome = await violation('просто\\n');
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.reason ?? '', /build.*без «=»/);
  });

  it('недопустимый ключ роняет работу', async () => {
    const outcome = await violation('bad-key=1\\n');
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.reason ?? '', /bad-key/);
  });

  it('ключ, похожий на секрет, роняет работу, называя шаблон', async () => {
    const outcome = await violation('API_TOKEN=x\\n');
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.reason ?? '', /API_TOKEN.*\*_TOKEN/);
  });

  it('слишком длинное значение роняет работу', async () => {
    const outcome = await violation(`log=${'x'.repeat(4097)}\\n`);
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.reason ?? '', /log.*4096/);
  });

  it('больше 32 ключей роняет работу', async () => {
    const lines = Array.from({ length: 33 }, (_, i) => `k${i}=v`).join('\\n');
    const outcome = await violation(`${lines}\\n`);
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.reason ?? '', /32/);
  });

  it('нарушение не повторяется попытками', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: без-повтора
jobs:
  build:
    attempts: { max: 3 }
    steps:${publish('p', 'просто\\n')}
`,
    });
    const result = await runProject(project);
    assert.equal(jobStatus(result, 'build')?.attempts, 1);
  });

  it('объявленный и неопубликованный ключ роняет работу, называя его', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: недостача
jobs:
  build:
    outputs: [sha, branch]
    steps:${publish('p', 'sha=1\\n')}
`,
    });
    const result = await runProject(project);
    const job = jobStatus(result, 'build');
    assert.equal(job?.status, 'failed');
    assert.match(job?.reason ?? '', /branch/);
    assert.doesNotMatch(job?.reason ?? '', /sha/);
  });

  it('в shadow-режиме работа с шагом shadow не падает на неопубликованном ключе', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: тень
jobs:
  build:
    outputs: [sha]
    steps:
      - id: p
        external: true
        run: [sh, -c, 'echo sha=1 >> "$STEPCAST_JOB_OUTPUTS"']
        expect: [{ exit_code: 0 }]
`,
    });
    const runsRoot = tempDir('runs-');
    const result = await runPipeline({
      expanded: expand(project),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      mode: 'shadow',
    });
    assert.equal(result.status, 'success');
  });

  it('предел 32 ключей считается по объединённому набору шагов, а не по файлу', async () => {
    // Второй шаг переписывает файл через `>`: в файле 32 ключа, у работы — 64.
    const keys = (prefix: string): string => Array.from({ length: 32 }, (_, i) => `${prefix}${i}=v`).join('\\n');
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: объединение
jobs:
  build:
    steps:${publish('a', `${keys('a')}\\n`)}
      - id: b
        run: [sh, -c, 'printf "${keys('b')}\\n" > "$STEPCAST_JOB_OUTPUTS"']
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await runProject(project);
    const job = jobStatus(result, 'build');
    assert.equal(job?.status, 'failed');
    assert.match(job?.reason ?? '', /больше 32/);
    assert.equal(Object.keys(job?.outputs ?? {}).length, 32);
  });

  it('работа с until публикует объявленный ключ на сошедшейся итерации и не падает на ранней', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: until
jobs:
  build:
    outputs: [sha]
    until:
      max_iterations: 3
      check:
        - cmd: 'test -f done.txt'
    steps:
      - id: p
        run: [sh, -c, 'if [ -f once.txt ]; then echo sha=abc >> "$STEPCAST_JOB_OUTPUTS"; touch done.txt; else touch once.txt; fi']
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await runProject(project);
    const job = jobStatus(result, 'build');
    assert.equal(job?.status, 'success', job?.reason);
    assert.equal(job?.iterations, 2);
    assert.deepEqual(job?.outputs, { sha: 'abc' });
  });

  it('работа с until, так и не опубликовавшая объявленный ключ, падает после сошедшейся итерации', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: until-недостача
jobs:
  build:
    outputs: [sha]
    until:
      max_iterations: 3
      check:
        - cmd: 'test -f done.txt'
    steps:
      - id: p
        run: [sh, -c, 'if [ -f once.txt ]; then touch done.txt; else touch once.txt; fi']
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await runProject(project);
    const job = jobStatus(result, 'build');
    assert.equal(job?.status, 'failed');
    assert.equal(job?.iterations, 2);
    assert.match(job?.reason ?? '', /не опубликовала: sha/);
  });

  it('новый проход loops начинает с пустого файла и без выходов прошлого прохода', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
loops:
  l:
    jobs: [work]
    while: "loop.iteration < 2"
    max_iterations: 2
    cost: 1
jobs:
  work:
    steps:
      - id: s
        run:
          - sh
          - -c
          - |
            [ -s "$STEPCAST_JOB_OUTPUTS" ] && exit 9
            echo "pass$STEPCAST_LOOP_ITERATION=x" >> "$STEPCAST_JOB_OUTPUTS"
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await runProject(project);
    const job = jobStatus(result, 'work');
    assert.equal(job?.status, 'success', job?.reason);
    assert.deepEqual(job?.outputs, { pass2: 'x' });
  });
});

describe('job-outputs: передача зависимым', () => {
  const consumer = (needs: string, command: string, extra = ''): string => `
  deploy:
    needs: ${needs}${extra}
    steps:
      - id: read
        run: [sh, -c, '${command}']
        expect: [{ exit_code: 0 }]`;

  it('прямой зависимый видит NEEDS_<РАБОТА>_<КЛЮЧ>', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: передача
jobs:
  build-a:
    outputs: [sha]
    steps:${publish('p', 'sha=abc123\\n')}${consumer('[build-a]', 'echo "$NEEDS_BUILD_A_sha" > got.txt')}
`,
    });
    const result = await runProject(project);
    assert.equal(result.status, 'success');
    assert.equal(readFileSync(project.path('got.txt'), 'utf8').trim(), 'abc123');
  });

  it('needs: all тоже получает выходы', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: все
jobs:
  build:
    outputs: [sha]
    steps:${publish('p', 'sha=abc123\\n')}${consumer('all', 'echo "$NEEDS_BUILD_sha" > got.txt')}
`,
    });
    const result = await runProject(project);
    assert.equal(result.status, 'success');
    assert.equal(readFileSync(project.path('got.txt'), 'utf8').trim(), 'abc123');
  });

  it('транзитивный производитель переменных не даёт', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: транзит
jobs:
  build:
    outputs: [sha]
    steps:${publish('p', 'sha=abc123\\n')}
  middle:
    needs: [build]
    steps:
      - id: m
        run: [echo, ok]
        expect: [{ exit_code: 0 }]${consumer('[middle]', 'echo "[$${NEEDS_BUILD_sha:-пусто}]" > got.txt')}
`,
    });
    const result = await runProject(project);
    assert.equal(result.status, 'success');
    assert.equal(readFileSync(project.path('got.txt'), 'utf8').trim(), '[пусто]');
  });

  it('упавший производитель при on: always переменных не даёт', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: упавший
jobs:
  build:
    steps:
      - id: p
        run: [sh, -c, 'echo sha=1 >> "$STEPCAST_JOB_OUTPUTS"; exit 1']
        expect: [{ exit_code: 0 }]${consumer('[build]', 'echo "[$${NEEDS_BUILD_sha:-пусто}]" > got.txt','\n    on: always')}
`,
    });
    await runProject(project);
    assert.equal(readFileSync(project.path('got.txt'), 'utf8').trim(), '[пусто]');
  });

  it('env: потребителя значение не перекрывает', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: перекрытие
jobs:
  build:
    outputs: [sha]
    steps:${publish('p', 'sha=real\\n')}${consumer('[build]', 'echo "$NEEDS_BUILD_sha" > got.txt', '\n    env: { NEEDS_BUILD_sha: fake }')}
`,
    });
    const result = await runProject(project);
    assert.equal(result.status, 'success');
    assert.equal(readFileSync(project.path('got.txt'), 'utf8').trim(), 'real');
  });

  it('две зависимости с одной переменной роняют потребителя до первого шага', async () => {
    // Линт такое отклоняет заранее; движок отказывает сам, если линт обойдён.
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: коллизия
jobs:
  build-a:
    outputs: [sha]
    steps:${publish('p', 'sha=1\\n')}
  build_a:
    outputs: [sha]
    steps:${publish('p', 'sha=2\\n')}${consumer('[build-a, build_a]', 'echo ran > got.txt')}
`,
    });
    const result = await runProject(project);
    const job = jobStatus(result, 'deploy');
    assert.equal(job?.status, 'failed');
    assert.match(job?.reason ?? '', /build-a.*build_a.*NEEDS_BUILD_A_sha/);
    assert.equal(existsSync(project.path('got.txt')), false);
  });
});

describe('job-outputs: возобновление', () => {
  // Значения приходят из окружения прогона: так видно, исполнялся шаг заново
  // или его выход перенесён из исходного прогона.
  const PIPELINE = `
version: 1
kind: pipeline
name: возобновление
jobs:
  build:
    inputs: []
    # Возобновление с отдельного шага требует сессий по шагу.
    session: per_step
    outputs: [sha]
    steps:
      - id: p
        run: [sh, -c, 'echo "sha=$TAG" >> "$STEPCAST_JOB_OUTPUTS"']
        expect: [{ exit_code: 0 }]
      - id: q
        run: [sh, -c, 'if [ -n "$BRANCH" ]; then echo "branch=$BRANCH" >> "$STEPCAST_JOB_OUTPUTS"; fi']
        expect: [{ exit_code: 0 }]
  deploy:
    needs: [build]
    steps:
      - id: read
        run: [sh, -c, 'echo "$NEEDS_BUILD_sha:$\${NEEDS_BUILD_branch:-нет}" > got.txt']
        expect: [{ exit_code: 0 }]
`;

  type Env = Readonly<Record<string, string>>;

  async function resume(from: string, firstEnv: Env, secondEnv: Env) {
    const project = makeProject({ 'stepcast.yml': PIPELINE });
    const runsRoot = tempDir('runs-');
    initRepo(project);
    const config = { ...project.config, runs: { ...project.config.runs, root: runsRoot } };

    const first = await runPipeline({
      expanded: expand(project),
      config,
      projectRoot: project.root,
      cwd: project.root,
      baseEnv: { ...testBaseEnv(), ...firstEnv },
    });
    assert.equal(first.status, 'success');
    writeFileSync(project.path('got.txt'), '');

    const source = readSourceRun(first.journal.paths);
    const plan = buildResumePlan({
      expanded: expand(project),
      config: project.config,
      source,
      changed: [],
      cwd: project.root,
      producedPaths: () => undefined,
      from: parseFrom(from),
    });
    const second = await runPipeline({
      expanded: expand(project),
      config,
      projectRoot: project.root,
      cwd: project.root,
      resume: { plan, source },
      baseEnv: { ...testBaseEnv(), ...secondEnv },
    });
    return { project, first, second };
  }

  it('переиспользованная работа переносит выходы, и зависимый их видит', async () => {
    const { project, second } = await resume('deploy', { TAG: 'abc123', BRANCH: 'main' }, { TAG: 'другое' });
    assert.equal(second.status, 'success');
    assert.deepEqual(jobStatus(second, 'build')?.outputs, { sha: 'abc123', branch: 'main' });
    assert.equal(readFileSync(project.path('got.txt'), 'utf8').trim(), 'abc123:main');
  });

  it('работа, переисполняемая с начала, выходов не наследует: берёт свои', async () => {
    const { project, second } = await resume('build', { TAG: 'old', BRANCH: 'main' }, { TAG: 'new' });
    assert.equal(second.status, 'success');
    assert.deepEqual(jobStatus(second, 'build')?.outputs, { sha: 'new' });
    assert.equal(readFileSync(project.path('got.txt'), 'utf8').trim(), 'new:нет');
  });

  it('переносятся выходы только переиспользованных шагов: ключ переисполненного шага не наследуется', async () => {
    const { project, first, second } = await resume('build/q', { TAG: 'abc123', BRANCH: 'main' }, { TAG: 'другое' });
    assert.deepEqual(
      jobStatus(first, 'build')?.steps.map((step) => step.outputs),
      [{ sha: 'abc123' }, { branch: 'main' }],
    );
    assert.equal(second.status, 'success');
    const steps = jobStatus(second, 'build')?.steps ?? [];
    assert.equal(steps[0]?.reused_from, first.journal.paths.runId);
    assert.equal(steps[1]?.reused_from, undefined);
    assert.deepEqual(jobStatus(second, 'build')?.outputs, { sha: 'abc123' });
    assert.equal(readFileSync(project.path('got.txt'), 'utf8').trim(), 'abc123:нет');
  });
});

describe('job-outputs: линт', () => {
  function errors(pipeline: string): readonly string[] {
    const project = makeProject({ 'stepcast.yml': pipeline });
    return lintPipeline(expand(project), { config: project.config, cwd: project.root })
      .filter((item) => item.severity === 'error')
      .map((item) => item.message);
  }

  const withConsumer = (producerExtra: string, command: string, needs = '[build]'): string => `
version: 1
kind: pipeline
name: линт
jobs:
  build:${producerExtra}
    steps:
      - id: p
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
  deploy:
    needs: ${needs}
    steps:
      - id: read
        run: [sh, -c, '${command}']
        expect: [{ exit_code: 0 }]
`;

  it('корректная ссылка диагностик не даёт', () => {
    assert.deepEqual(errors(withConsumer('\n    outputs: [sha]', 'echo "$NEEDS_BUILD_sha" $${NEEDS_BUILD_sha}')), []);
  });

  it('повтор в outputs', () => {
    assert.ok(errors(withConsumer('\n    outputs: [sha, sha]', 'true')).some((m) => /повторно/.test(m)));
  });

  it('больше 32 имён', () => {
    const names = Array.from({ length: 33 }, (_, i) => `k${i}`).join(', ');
    assert.ok(errors(withConsumer(`\n    outputs: [${names}]`, 'true')).some((m) => /33 выходов.*32/.test(m)));
  });

  it('имя, похожее на секрет по env_deny', () => {
    assert.ok(errors(withConsumer('\n    outputs: [API_TOKEN]', 'true')).some((m) => /API_TOKEN.*\*_TOKEN/.test(m)));
  });

  it('ссылка на не прямую зависимость, с подсказкой про needs', () => {
    const pipeline = `
version: 1
kind: pipeline
name: линт
jobs:
  build:
    outputs: [sha]
    steps:
      - id: p
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
  middle:
    needs: [build]
    steps:
      - id: m
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
  deploy:
    needs: [middle]
    steps:
      - id: read
        run: [sh, -c, 'echo $NEEDS_BUILD_sha']
        expect: [{ exit_code: 0 }]
`;
    const found = errors(pipeline).filter((m) => /не зависит напрямую/.test(m));
    assert.equal(found.length, 1);
  });

  it('ключ не объявлен — ошибка с перечнем объявленных', () => {
    const project = makeProject({
      'stepcast.yml': withConsumer('\n    outputs: [sha]', 'echo $NEEDS_BUILD_nope'),
    });
    const found = lintPipeline(expand(project), { config: project.config, cwd: project.root }).find((item) =>
      /не объявлен в outputs/.test(item.message),
    );
    assert.ok(found);
    assert.match(found.hint ?? '', /sha/);
  });

  it('ссылка в предикате cmd проверяется так же', () => {
    const pipeline = withConsumer('\n    outputs: [sha]', 'true').replace(
      'expect: [{ exit_code: 0 }]\n',
      'expect: [{ cmd: \'test -n "$NEEDS_BUILD_nope"\' }]\n',
    );
    assert.ok(errors(pipeline).some((m) => /NEEDS_BUILD_nope/.test(m)));
  });

  it('неоднозначная ссылка при двух подходящих префиксах', () => {
    const pipeline = `
version: 1
kind: pipeline
name: линт
jobs:
  build:
    outputs: [DOCS_sha]
    steps:
      - id: p
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
  build-docs:
    outputs: [sha]
    steps:
      - id: p
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
  deploy:
    needs: [build, build-docs]
    steps:
      - id: read
        run: [sh, -c, 'echo $NEEDS_BUILD_DOCS_sha']
        expect: [{ exit_code: 0 }]
`;
    assert.ok(errors(pipeline).some((m) => /неоднозначна/.test(m)));
  });

  it('две прямые зависимости с одним сегментом', () => {
    const pipeline = `
version: 1
kind: pipeline
name: линт
jobs:
  build-a:
    steps:
      - id: p
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
  build_a:
    steps:
      - id: p
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
  deploy:
    needs: [build-a, build_a]
    steps:
      - id: read
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`;
    assert.ok(errors(pipeline).some((m) => /NEEDS_BUILD_A_/.test(m)));
  });
});
