import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { BurnexError } from '../src/kernel/errors.js';
import { resolveConfig, type Config } from '../src/parts/pipeline/config/resolve.js';
import { renderConfigReport } from '../src/parts/pipeline/commands/config.js';
import { renderAgentsReport } from '../src/parts/pipeline/commands/configAgents.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { jobLockHash, serializeLock } from '../src/parts/pipeline/document/lock.js';
import type { AgentStep } from '../src/parts/pipeline/document/model.js';
import { lintPipeline } from '../src/parts/pipeline/domain/lint.js';
import { assembleContext } from '../src/parts/pipeline/domain/context/assemble.js';
import { ContextReportSchema } from '../src/parts/pipeline/run/journal/schema.js';
import { computeStepKey } from '../src/parts/pipeline/run/stepKey.js';
import { tempDir } from './tmp.js';

/**
 * `agent-profiles`: профили агентов — ключ `agents:` конфигурации, агент шага
 * через профиль и уровень контекста «профиль».
 */

interface Box {
  readonly home: string;
  readonly cwd: string;
  readonly globalPath: string;
  readonly projectPath: string;
}

const BACKENDS = `backends:
  codex:
    model_tiers: { max: gpt-max, fast: gpt-fast }
  claude:
    model_tiers: { deep: opus }
`;

function box(files: { global?: string; project?: string; pipeline?: string } = {}): Box {
  const root = tempDir('profiles-');
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  mkdirSync(join(home, '.burnex'), { recursive: true });
  mkdirSync(join(cwd, '.burnex'), { recursive: true });
  const globalPath = join(home, '.burnex', 'config.yml');
  const projectPath = join(cwd, '.burnex', 'config.yml');
  writeFileSync(globalPath, `${BACKENDS}${files.global ?? ''}`);
  if (files.project !== undefined) writeFileSync(projectPath, files.project);
  if (files.pipeline !== undefined) writeFileSync(join(cwd, 'burnex.yml'), files.pipeline);
  return { home, cwd, globalPath, projectPath };
}

function resolveIn(b: Box) {
  return resolveConfig({ cwd: b.cwd, home: b.home, globalPath: b.globalPath, projectPath: b.projectPath });
}

function expandIn(b: Box, config: Config = resolveIn(b).config) {
  return expandPipeline({ pipelinePath: join(b.cwd, 'burnex.yml'), config });
}

function stepOf(expanded: ReturnType<typeof expandIn>, id = 'build/check'): AgentStep {
  const [jobId, stepId] = id.split('/');
  const step = expanded.pipeline.jobs.find((job) => job.id === jobId)?.steps.find((candidate) => candidate.id === stepId);
  assert.equal(step?.kind, 'agent');
  return step as AgentStep;
}

function pipeline(step: string, root = '', job = ''): string {
  return `version: 1
kind: pipeline
name: p
${root}jobs:
  build:
${job}    steps:
      - id: check
        prompt: проверь
${step}`;
}

const STRICT = 'agents:\n  reviewer-strict: { backend: codex, model_tier: max, effort: high }\n';

function keyOf(expanded: ReturnType<typeof expandIn>, id = 'build/check'): string {
  const job = expanded.pipeline.jobs.find((candidate) => candidate.id === id.split('/')[0])!;
  return computeStepKey({
    lockHash: jobLockHash(expanded.pipeline, job),
    jobId: job.id,
    step: stepOf(expanded, id),
    inputsFingerprint: undefined,
    backendCommand: undefined,
    upstream: [],
  });
}

function rejection(fn: () => unknown): BurnexError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BurnexError, String(error));
    return error;
  }
  assert.fail('ожидался отказ');
}

describe('agent-profiles: профиль в конфигурации', () => {
  it('профиль принимается, отчёт burnex config называет файл источником', () => {
    const b = box({ global: STRICT });
    const resolved = resolveIn(b);
    assert.deepEqual(resolved.config.agents['reviewer-strict'], {
      name: 'reviewer-strict', backend: 'codex', modelTier: 'max', effort: 'high', context: [], file: b.globalPath,
    });
    const report = renderConfigReport(resolved).join('\n');
    assert.match(report, new RegExp(`agents\\.reviewer-strict\\.backend\\s+codex\\s+${b.globalPath}`));
  });

  it('проектный профиль заменяет глобальный целиком, а не по листьям', () => {
    const b = box({
      global: 'agents:\n  arch: { backend: claude, model_tier: deep, context: [{ text: правила }] }\n',
      project: 'agents:\n  arch: { backend: codex }\n',
    });
    const { config, provenance } = resolveIn(b);
    assert.deepEqual(config.agents.arch, { name: 'arch', backend: 'codex', context: [], file: b.projectPath });
    assert.equal(provenance.get('agents.arch.context'), undefined);
    assert.equal(provenance.get('agents.arch.model_tier'), undefined);
  });

  it('agents.default отклоняется разбором с подсказкой про defaults.*', () => {
    const b = box({ global: 'agents:\n  default: { backend: claude }\n' });
    const error = rejection(() => resolveIn(b));
    assert.equal(error.file, b.globalPath);
    assert.equal(error.at, 'agents.default');
    assert.match(error.hint ?? '', /defaults\.agent.*defaults\.model.*defaults\.effort/);
  });

  it('имя подключённого или поставляемого бэкенда отклоняется с файлом и путём ключа', () => {
    const connected = box({ project: 'agents:\n  claude: { backend: claude, model_tier: deep }\n' });
    const error = rejection(() => resolveIn(connected));
    assert.equal(error.file, connected.projectPath);
    assert.equal(error.at, 'agents.claude');
    assert.match(error.hint ?? '', /неявным профилем/);

    // copilot не объявлен в backends и не подключён — но поставляется пакетом.
    const bundled = box({ global: 'agents:\n  copilot: { backend: claude }\n' });
    assert.equal(rejection(() => resolveIn(bundled)).at, 'agents.copilot');
  });

  it('model вместе с model_tier и неизвестное поле отклоняются с путём agents.<имя>', () => {
    const both = box({ global: 'agents:\n  x: { backend: claude, model: sonnet, model_tier: fast }\n' });
    const error = rejection(() => resolveIn(both));
    assert.equal(error.file, both.globalPath);
    assert.match(error.at ?? '', /^agents\.x/);

    const unknown = box({ global: 'agents:\n  x: { backend: claude, permissions: {} }\n' });
    assert.match(rejection(() => resolveIn(unknown)).at ?? '', /^agents\.x/);
  });

  it('пути контекста разрешаются от слоя: глобальный — от ~/.burnex/, проектный — от корня репозитория', () => {
    const b = box({
      global: 'agents:\n  sec:\n    backend: codex\n    context: [{ path: guides/security.md }, "~/notes.md", /abs/rules.md, { text: t }]\n',
      project: 'agents:\n  arch:\n    backend: claude\n    context: [{ path: docs/review-rules.md }]\n',
    });
    const { config } = resolveIn(b);
    assert.deepEqual(config.agents.sec?.context, [
      { path: join(b.home, '.burnex', 'guides', 'security.md') },
      join(b.home, 'notes.md'),
      '/abs/rules.md',
      { text: 't' },
    ]);
    // Относительный путь проектного профиля читается от рабочего дерева шага —
    // то есть от корня репозитория — и остаётся в отпечатке входов работы.
    assert.deepEqual(config.agents.arch?.context, [{ path: 'docs/review-rules.md' }]);
  });

  it('опубликованная схема принимает профиль и отклоняет model вместе с model_tier', () => {
    const schema = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../schema/config.schema.json', import.meta.url)), 'utf8'),
    ) as object;
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.equal(validate({ agents: { r: { backend: 'codex', model_tier: 'max', context: [{ text: 'x' }, 'a.md'] } } }), true,
      JSON.stringify(validate.errors));
    assert.equal(validate({ agents: { r: { backend: 'codex', model: 'm', model_tier: 'max' } } }), false);
    assert.equal(validate({ agents: { R: { backend: 'codex' } } }), false);
  });
});

describe('agent-profiles: агент шага через профиль', () => {
  it('профиль в шаге: бэкенд, уровень и effort профиля; происхождение называет профиль', () => {
    const b = box({ global: STRICT, pipeline: pipeline('        agent: reviewer-strict\n') });
    const expanded = expandIn(b);
    const step = stepOf(expanded);
    assert.equal(step.agent, 'codex');
    assert.equal(step.model, 'gpt-max');
    assert.equal(step.effort, 'high');
    assert.equal(step.profile, 'reviewer-strict');
    assert.deepEqual(expanded.agentOrigins.get('build/check'), { layer: 'step', profile: 'reviewer-strict' });
    assert.deepEqual(expanded.modelOrigins.get('build/check'), {
      layer: 'tier', backend: 'codex', tier: 'max', tierLayer: 'step', profile: 'reviewer-strict',
    });
    assert.deepEqual(expanded.effortOrigins.get('build/check'), { layer: 'step', profile: 'reviewer-strict' });
  });

  it('собственное поле слоя сильнее профиля', () => {
    const b = box({ global: STRICT, pipeline: pipeline('        agent: reviewer-strict\n        effort: low\n') });
    const expanded = expandIn(b);
    assert.equal(stepOf(expanded).effort, 'low');
    assert.equal(stepOf(expanded).model, 'gpt-max');
    assert.deepEqual(expanded.effortOrigins.get('build/check'), { layer: 'step' });
  });

  it('профиль работы и корня раскрывается в своём слое', () => {
    const b = box({ global: STRICT, pipeline: pipeline('', '', '    agent: reviewer-strict\n') });
    const expanded = expandIn(b);
    assert.equal(stepOf(expanded).agent, 'codex');
    assert.equal(stepOf(expanded).model, 'gpt-max');
    assert.deepEqual(expanded.agentOrigins.get('build/check'), { layer: 'job', profile: 'reviewer-strict' });

    const root = box({ global: STRICT, pipeline: pipeline('', 'agent: reviewer-strict\n') });
    assert.deepEqual(expandIn(root).agentOrigins.get('build/check'), { layer: 'pipeline', profile: 'reviewer-strict' });
  });

  it('профиль из step_agents при force: чужая модель шага отбрасывается, модель — уровень профиля', () => {
    const b = box({
      global: `${STRICT}agent_policy: force\nstep_agents:\n  p:\n    build:\n      check: { agent: reviewer-strict }\n`,
      pipeline: pipeline('        model: opus\n'),
    });
    const expanded = expandIn(b);
    const step = stepOf(expanded);
    assert.equal(step.agent, 'codex');
    assert.equal(step.model, 'gpt-max');
    assert.deepEqual(expanded.agentOrigins.get('build/check'), { layer: 'step_agents', file: b.globalPath, profile: 'reviewer-strict' });
    assert.deepEqual(expanded.modelOrigins.get('build/check'), {
      layer: 'tier', backend: 'codex', tier: 'max', tierLayer: 'step_agents', file: b.globalPath,
      profile: 'reviewer-strict', dropped: { model: 'opus', layer: 'step' },
    });
  });

  it('pipeline_agents и defaults.agent принимают имя профиля', () => {
    const entry = box({ global: `${STRICT}pipeline_agents:\n  p: { agent: reviewer-strict }\n`, pipeline: pipeline('') });
    assert.equal(stepOf(expandIn(entry)).agent, 'codex');

    const defaults = box({ global: `${STRICT}defaults:\n  agent: reviewer-strict\n`, pipeline: pipeline('') });
    const expanded = expandIn(defaults);
    assert.equal(stepOf(expanded).model, 'gpt-max');
    assert.deepEqual(expanded.modelOrigins.get('build/check'), {
      layer: 'tier', backend: 'codex', tier: 'max', tierLayer: 'config', profile: 'reviewer-strict',
    });
  });

  it('встроенный default — это defaults.agent, defaults.model и defaults.effort', () => {
    const b = box({ global: 'defaults:\n  agent: codex\n  model: gpt-fast\n  effort: low\n', pipeline: pipeline('        agent: default\n') });
    const step = stepOf(expandIn(b));
    assert.equal(step.agent, 'codex');
    assert.equal(step.model, 'gpt-fast');
    assert.equal(step.effort, 'low');
    assert.equal(step.profile, 'default');
  });

  it('неизвестное имя: отказ линта и записи выбора перечисляют профили и бэкенды раздельно', () => {
    const b = box({ global: STRICT, pipeline: pipeline('        agent: nosuch\n') });
    const { config } = resolveIn(b);
    const diagnostic = lintPipeline(expandIn(b, config), { config, cwd: b.cwd }).find((item) => item.at?.endsWith('.agent'));
    assert.ok(diagnostic !== undefined);
    assert.equal(diagnostic.file, join(b.cwd, 'burnex.yml'));
    assert.match(diagnostic.hint ?? '', /^Профили: default, reviewer-strict\. Бэкенды: .*claude.*codex/);

    const entry = box({ global: `${STRICT}pipeline_agents:\n  p: { agent: nosuch }\n`, pipeline: pipeline('') });
    const error = rejection(() => expandIn(entry));
    assert.equal(error.at, 'pipeline_agents.p.agent');
    assert.equal(error.file, entry.globalPath);
    assert.match(error.hint ?? '', /Профили: default, reviewer-strict\. Бэкенды:/);
  });

  it('профиль с неизвестным бэкендом отклоняет только пайплайны, которые им исполняются', () => {
    const broken = 'agents:\n  ghost: { backend: nowhere }\n';
    const user = box({ global: broken, pipeline: pipeline('        agent: ghost\n') });
    const error = rejection(() => expandIn(user));
    assert.equal(error.at, 'agents.ghost.backend');
    assert.equal(error.file, user.globalPath);

    const other = box({ global: broken, pipeline: pipeline('        agent: claude\n') });
    assert.equal(stepOf(expandIn(other)).agent, 'claude');
  });

  it('pipeline.lock и burnex config --pipeline называют профиль шага', () => {
    const b = box({ global: STRICT, pipeline: pipeline('        agent: reviewer-strict\n') });
    const resolved = resolveIn(b);
    const expanded = expandIn(b, resolved.config);
    assert.match(serializeLock(expanded.pipeline), /profile: reviewer-strict/);
    const report = renderAgentsReport(resolved, expanded).join('\n');
    assert.match(report, /build\/check\s+codex\s+шаг через профиль reviewer-strict/);
    assert.match(report, /через профиль reviewer-strict\s+high\s+шаг через профиль reviewer-strict/);
  });

  it('без agents шаг и ключ прежние: агент бэкенда — неявный профиль без поля profile', () => {
    const b = box({ pipeline: pipeline('        agent: claude\n') });
    const before = expandIn(b);
    writeFileSync(b.globalPath, `${BACKENDS}${STRICT}`);
    const after = expandIn(b);
    assert.equal(stepOf(after).profile, undefined);
    assert.equal(stepOf(after).profileContext, undefined);
    assert.deepEqual(stepOf(after), stepOf(before));
    assert.equal(keyOf(after), keyOf(before));
  });
});

describe('agent-profiles: контекст профиля', () => {
  it('уровни идут в порядке «профиль, пайплайн, работа, шаг», источник — profile:<имя>', () => {
    const assembled = assembleContext({
      workspace: tempDir('ctx-'),
      profile: { name: 'reviewer-strict', entries: [{ kind: 'text', text: 'профиль' }] },
      pipeline: [{ kind: 'text', text: 'пайплайн' }],
      job: [{ kind: 'text', text: 'работа' }],
      step: [{ kind: 'text', text: 'шаг' }],
      upstream: [],
      contextUpstream: 'all',
      inherit: true,
      exclude: [],
      deny: [],
      inlineThreshold: 1000,
      maxTokens: 100_000,
    });
    assert.deepEqual(assembled.report.entries.map((entry) => entry.origin), ['profile:reviewer-strict', 'pipeline', 'job', 'step']);
    assert.ok(assembled.text.indexOf('профиль') < assembled.text.indexOf('пайплайн'));
    assert.equal(ContextReportSchema.safeParse(assembled.report).success, true);
  });

  it('context_inherit: false и context_exclude не снимают профиль', () => {
    const workspace = tempDir('ctx-');
    writeFileSync(join(workspace, 'rules.md'), 'правила');
    const assembled = assembleContext({
      workspace,
      profile: { name: 'p', entries: [{ kind: 'text', text: 'профиль' }, { kind: 'path', path: 'rules.md', mode: 'auto' }] },
      pipeline: [{ kind: 'text', text: 'пайплайн' }],
      job: [{ kind: 'text', text: 'работа' }],
      step: [],
      upstream: [],
      contextUpstream: 'all',
      inherit: false,
      exclude: ['rules.md'],
      deny: [],
      inlineThreshold: 1000,
      maxTokens: 100_000,
    });
    assert.deepEqual(assembled.report.entries.map((entry) => [entry.origin, entry.kind]), [['profile:p', 'text'], ['profile:p', 'path']]);
  });

  it('context.deny и предел действуют на профиль', () => {
    const workspace = tempDir('ctx-');
    writeFileSync(join(workspace, '.env'), 'SECRET=1');
    const denied: string[] = [];
    const assembled = assembleContext({
      workspace,
      profile: { name: 'p', entries: [{ kind: 'path', path: '.env', mode: 'auto' }] },
      pipeline: [], job: [], step: [], upstream: [], contextUpstream: 'all',
      inherit: true, exclude: [], deny: ['.env'], inlineThreshold: 1000, maxTokens: 100_000,
      onDenied: (path, pattern) => denied.push(`${path} ${pattern}`),
    });
    assert.deepEqual(assembled.report.entries, []);
    assert.deepEqual(denied, ['.env .env']);

    assert.throws(() => assembleContext({
      workspace,
      profile: { name: 'p', entries: [{ kind: 'text', text: 'x'.repeat(4000) }] },
      pipeline: [], job: [], step: [], upstream: [], contextUpstream: 'all',
      inherit: true, exclude: [], deny: [], inlineThreshold: 1000, maxTokens: 100,
    }), /превышает предел/);
  });

  it('шаг несёт контекст профиля; правка файла вне дерева меняет ключ, переименование профиля — нет', () => {
    const b = box({ pipeline: pipeline('        agent: sec\n') });
    const guide = join(b.home, '.burnex', 'guides', 'security.md');
    mkdirSync(join(b.home, '.burnex', 'guides'), { recursive: true });
    writeFileSync(guide, 'v1');
    const profile = (name: string) =>
      `${BACKENDS}agents:\n  ${name}: { backend: codex, context: [{ path: guides/security.md }, { text: строгий }] }\n`;
    writeFileSync(b.globalPath, profile('sec'));

    const first = expandIn(b);
    const step = stepOf(first);
    assert.deepEqual(step.profileContext, [{ kind: 'path', path: guide, mode: 'auto' }, { kind: 'text', text: 'строгий' }]);
    assert.match(step.profileContextFingerprint ?? '', /^sha256:/);
    assert.match(serializeLock(first.pipeline), /profile_context:/);

    writeFileSync(guide, 'v2');
    const edited = expandIn(b);
    assert.notEqual(keyOf(edited), keyOf(first));

    writeFileSync(b.globalPath, profile('security'));
    writeFileSync(join(b.cwd, 'burnex.yml'), pipeline('        agent: security\n'));
    const renamed = expandIn(b);
    assert.equal(stepOf(renamed).profile, 'security');
    assert.equal(keyOf(renamed), keyOf(edited));
  });
});
