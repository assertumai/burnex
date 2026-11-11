import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BurnexError } from '../src/kernel/errors.js';
import { resolveConfig } from '../src/parts/pipeline/config/resolve.js';
import { projectPipelines } from '../src/parts/ui/pipelines.js';
import {
  deleteReviewStrategy,
  readReviewStrategies,
  saveReviewStrategy,
  StrategyRejected,
} from '../src/parts/ui/reviewStrategies.js';
import { tempDir } from './tmp.js';

/**
 * Экран «Review strategies» (`ui-review-strategies`), серверная половина:
 * оба слоя тем же разрешением, что движок, отказ разбора с путём ключа до
 * записи, запись через `Document` с сохранением комментариев, использование
 * шагами `review:` раскрытых пайплайнов проекта.
 */

const BACKENDS = ['claude', 'codex'];

function bed() {
  const root = tempDir('ui-review-');
  const home = join(root, 'home');
  const projectRoot = join(root, 'project');
  const homeDir = join(home, '.burnex', 'review-strategies');
  const projectDir = join(projectRoot, '.burnex', 'review-strategies');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  return { home, projectRoot, homeDir, projectDir };
}

function strategy(name: string, extra = ''): string {
  return `version: 1
kind: review-strategy
name: ${name}
reviewers:
  - id: security
    agent: codex
    focus: Границы доверия
${extra}`;
}

const COMMENTED = `# Панель ревью проекта
version: 1
kind: review-strategy
name: panel
reviewers:
  # безопасность — на Codex
  - id: security
    agent: codex
    focus: Границы доверия # фокус ревьюера
  - id: tests
    agent: claude
mode: independent # пока единственный
`;

describe('ui-review-strategies: чтение слоёв', () => {
  it('показывает стратегии обоих слоёв с меткой слоя', () => {
    const { home, projectRoot, homeDir, projectDir } = bed();
    writeFileSync(join(projectDir, 'panel.yml'), strategy('panel'));
    writeFileSync(join(homeDir, 'duo.yml'), strategy('duo'));

    const { strategies } = readReviewStrategies({ home, projectRoot, backendNames: BACKENDS });

    assert.deepEqual(
      strategies.map((entry) => [entry.name, entry.layer, entry.shadowed ?? false, entry.error]),
      [['panel', 'project', false, undefined], ['duo', 'home', false, undefined]],
    );
    assert.equal((strategies[0]!.document as { name: string }).name, 'panel');
  });

  it('домашняя стратегия, одноимённая проектной, помечена перекрытой', () => {
    const { home, projectRoot, homeDir, projectDir } = bed();
    writeFileSync(join(projectDir, 'panel.yml'), strategy('panel'));
    writeFileSync(join(homeDir, 'panel.yml'), strategy('panel'));

    const { strategies } = readReviewStrategies({ home, projectRoot, backendNames: BACKENDS });

    assert.deepEqual(strategies.map((entry) => [entry.layer, entry.shadowed ?? false]), [['project', false], ['home', true]]);
  });

  it('без проекта демона виден только домашний слой', () => {
    const { home, homeDir } = bed();
    writeFileSync(join(homeDir, 'duo.yml'), strategy('duo'));

    const overview = readReviewStrategies({ home, backendNames: BACKENDS });

    assert.equal(overview.projectDir, undefined);
    assert.deepEqual(overview.strategies.map((entry) => entry.name), ['duo']);
  });

  it('сломанный файл остаётся в списке с текстом ошибки разбора и текстом файла', () => {
    const { home, projectRoot, projectDir } = bed();
    const broken = strategy('broken', '  - id: security\n    agent: claude\n');
    writeFileSync(join(projectDir, 'broken.yml'), broken);
    writeFileSync(join(projectDir, 'wrong.yml'), strategy('other'));

    const { strategies } = readReviewStrategies({ home, projectRoot, backendNames: BACKENDS });
    const [first, second] = strategies;

    assert.equal(first?.name, 'broken');
    assert.equal(first?.document, undefined);
    assert.equal(first?.text, broken);
    assert.deepEqual(first?.error, { message: 'повторный id ревьюера security', at: 'reviewers.1.id' });
    assert.equal(second?.error?.at, 'name');
    assert.match(second?.error?.message ?? '', /name: other/);
  });
});

describe('ui-review-strategies: запись', () => {
  it('правка focus меняет только этот узел, комментарии остаются на месте', () => {
    const { home, projectRoot, projectDir } = bed();
    const path = join(projectDir, 'panel.yml');
    writeFileSync(path, COMMENTED);
    const document = readReviewStrategies({ home, projectRoot, backendNames: BACKENDS }).strategies[0]!.document!;
    const reviewers = document.reviewers as Record<string, unknown>[];
    const edited = { ...document, reviewers: [{ ...reviewers[0], focus: 'Секреты в логах' }, reviewers[1]] };

    saveReviewStrategy({ layer: 'project', name: 'panel', document: edited }, { home, projectRoot, backendNames: BACKENDS });

    assert.equal(readFileSync(path, 'utf8'), COMMENTED.replace('focus: Границы доверия', 'focus: Секреты в логах'));
    assert.deepEqual(readdirSync(projectDir), ['panel.yml']);
  });

  it('повторный id отклоняется текстом разбора с путём ключа, файл не меняется', () => {
    const { home, projectRoot, projectDir } = bed();
    const path = join(projectDir, 'panel.yml');
    writeFileSync(path, COMMENTED);
    const document = readReviewStrategies({ home, projectRoot, backendNames: BACKENDS }).strategies[0]!.document!;
    const reviewers = document.reviewers as Record<string, unknown>[];
    const edited = { ...document, reviewers: [...reviewers, { id: 'tests', agent: 'codex' }] };

    assert.throws(
      () => saveReviewStrategy({ layer: 'project', name: 'panel', document: edited }, { home, projectRoot, backendNames: BACKENDS }),
      (error: unknown) =>
        error instanceof StrategyRejected && error.message === 'повторный id ревьюера tests' && error.at === 'reviewers.2.id',
    );
    assert.equal(readFileSync(path, 'utf8'), COMMENTED);
    assert.deepEqual(readdirSync(projectDir), ['panel.yml']);
  });

  it('режим discussion с лимитом сохраняется, без лимита отклоняется у поля лимита', () => {
    const { home, projectRoot, projectDir } = bed();
    writeFileSync(join(projectDir, 'panel.yml'), COMMENTED);
    const document = readReviewStrategies({ home, projectRoot, backendNames: BACKENDS }).strategies[0]!.document!;
    const save = (edited: Record<string, unknown>): string =>
      saveReviewStrategy({ layer: 'project', name: 'panel', document: edited }, { home, projectRoot, backendNames: BACKENDS });

    let rejected: StrategyRejected | undefined;
    try {
      save({ ...document, mode: 'discussion' });
    } catch (error) {
      if (!(error instanceof StrategyRejected)) throw error;
      rejected = error;
    }
    assert.equal(rejected?.at, 'discussion.max_messages');
    assert.equal(readFileSync(join(projectDir, 'panel.yml'), 'utf8'), COMMENTED);

    save({ ...document, mode: 'discussion', discussion: { max_messages: 6 } });
    const saved = readReviewStrategies({ home, projectRoot, backendNames: BACKENDS }).strategies[0]!;
    assert.equal(saved.error, undefined);
    assert.equal(saved.document?.mode, 'discussion');
    assert.deepEqual(saved.document?.discussion, { max_messages: 6 });
    assert.match(readFileSync(join(projectDir, 'panel.yml'), 'utf8'), /# безопасность — на Codex/);
  });

  it('новая стратегия создаётся в выбранном слое с именем файла по name; занятое имя отклоняется', () => {
    const { home, projectRoot, homeDir } = bed();
    const document = { version: 1, kind: 'review-strategy', name: 'duo', reviewers: [{ id: 'a', agent: 'claude' }] };

    const path = saveReviewStrategy({ layer: 'home', name: 'duo', document, create: true }, { home, projectRoot, backendNames: BACKENDS });

    assert.equal(path, join(homeDir, 'duo.yml'));
    assert.equal(readReviewStrategies({ home, projectRoot, backendNames: BACKENDS }).strategies[0]?.error, undefined);
    assert.throws(
      () => saveReviewStrategy({ layer: 'home', name: 'duo', document, create: true }, { home, projectRoot, backendNames: BACKENDS }),
      StrategyRejected,
    );
  });

  it('name документа, расходящийся с именем файла, отклоняется у поля name и не создаёт файла', () => {
    const { home, projectRoot, projectDir } = bed();
    const document = { version: 1, kind: 'review-strategy', name: 'other', reviewers: [{ id: 'a' }] };

    assert.throws(
      () => saveReviewStrategy({ layer: 'project', name: 'duo', document, create: true }, { home, projectRoot, backendNames: BACKENDS }),
      (error: unknown) => error instanceof StrategyRejected && error.at === 'name',
    );
    assert.deepEqual(readdirSync(projectDir), []);
  });

  it('удаление снимает файл слоя; без проекта демона проектный слой недоступен', () => {
    const { home, projectRoot, projectDir } = bed();
    writeFileSync(join(projectDir, 'panel.yml'), strategy('panel'));

    deleteReviewStrategy('project', 'panel', { home, projectRoot });

    assert.equal(existsSync(join(projectDir, 'panel.yml')), false);
    assert.throws(() => deleteReviewStrategy('project', 'panel', { home, projectRoot }), BurnexError);
    assert.throws(() => deleteReviewStrategy('project', 'panel', { home }), /project layer is unavailable/);
  });
});

describe('ui-review-strategies: использование', () => {
  it('шаг review: проекта, разрешивший имя в файл стратегии, называет пайплайн, работу и шаг', async () => {
    const { home, projectRoot, homeDir, projectDir } = bed();
    writeFileSync(join(projectDir, 'panel.yml'), strategy('panel'));
    writeFileSync(join(homeDir, 'panel.yml'), strategy('panel'));
    // Корень проекта раскрытие ищет по `.git`, как у настоящего репозитория.
    mkdirSync(join(projectRoot, '.git'));
    mkdirSync(join(projectRoot, '.burnex', 'pipelines', 'schemas'), { recursive: true });
    writeFileSync(join(projectRoot, '.burnex', 'pipelines', 'schemas', 'verdict.json'), '{"type":"object"}');
    writeFileSync(
      join(projectRoot, '.burnex', 'pipelines', 'loop.yml'),
      `version: 1
kind: pipeline
name: self-improve
jobs:
  review:
    steps:
      - id: review-diff
        review: panel
        prompt: Проверь изменения
        output_schema: ./schemas/verdict.json
`,
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const { pipelines } = await projectPipelines('k', projectRoot, config, { home });

    const { strategies } = readReviewStrategies({ home, projectRoot, backendNames: BACKENDS, pipelines });

    assert.equal(pipelines[0]?.error, undefined);
    assert.deepEqual(strategies[0]?.usage, [
      { pipeline: 'self-improve', file: '.burnex/pipelines/loop.yml', job: 'review', step: 'review-diff' },
    ]);
    // Перекрытая домашняя стратегия шагам не достаётся.
    assert.deepEqual(strategies[1]?.usage, []);
  });
});
