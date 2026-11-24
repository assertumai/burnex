import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { run } from '../src/parts/cli/main.js';
import { makeProject, withHome, type Project } from './helpers.js';

async function cli(project: Project, ...args: string[]) {
  const lines: string[] = [];
  const write = (line: string) => lines.push(line);
  const code = await withHome(project.home, () => run(args, { cwd: project.root, out: write, err: write }));
  return { code, output: lines.join('\n') };
}

for (const [agent, dir] of Object.entries({ codex: '.agents', cursor: '.cursor', claude: '.claude' })) {
  it(`installs the skill for ${agent} alone and preserves local edits`, async () => {
    const project = makeProject();
    const args = ['skill', 'install', '--agent', agent];
    const path = `${dir}/skills/burnex/SKILL.md`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await cli(project, ...args);
      assert.equal(result.code, 0, result.output);
    }
    assert.deepEqual(readdirSync(project.root), [dir]);
    assert.deepEqual(readdirSync(project.path(`${dir}/skills/burnex`)).sort(), ['SKILL.md', 'references']);
    project.write(path, 'local edits');
    assert.notEqual((await cli(project, ...args)).code, 0);
    assert.equal(readFileSync(project.path(path), 'utf8'), 'local edits');
  });
}

it('refuses before writing anything when one installed file differs', async () => {
  const project = makeProject({ '.agents/skills/burnex/references/cli.md': 'local edits' });
  assert.notEqual((await cli(project, 'skill', 'install', '--agent', 'codex')).code, 0);
  assert.deepEqual(readdirSync(project.path('.agents/skills/burnex')), ['references']);
  assert.deepEqual(readdirSync(project.path('.agents/skills/burnex/references')), ['cli.md']);
});

it('installs every file the skill links to', async () => {
  const project = makeProject();
  assert.equal((await cli(project, 'skill', 'install', '--agent', 'claude')).code, 0);
  const root = project.path('.claude/skills/burnex');
  for (const file of ['SKILL.md', ...readdirSync(join(root, 'references')).map((name) => `references/${name}`)]) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const [, link] of text.matchAll(/\]\(((?:references\/)?[\w-]+\.md)(?:#[\w-]+)?\)/g)) {
      const target = file === 'SKILL.md' ? link! : `references/${link!}`;
      assert.doesNotThrow(() => readFileSync(join(root, target)), `${file} ссылается на отсутствующий ${target}`);
    }
  }
});

it('requires an install action and a supported agent before writing', async () => {
  const project = makeProject();
  for (const args of [['install'], ['install', '--agent', 'unknown'], ['--agent', 'codex']]) {
    assert.notEqual((await cli(project, 'skill', ...args)).code, 0);
  }
  assert.deepEqual(readdirSync(project.root), []);
});

it('validates and executes the example from the installed skill', async () => {
  const project = makeProject();
  const result = await cli(project, 'skill', 'install', '--agent', 'codex');
  assert.equal(result.code, 0, result.output);
  const skill = readFileSync(project.path('.agents/skills/burnex/SKILL.md'), 'utf8');
  const example = /```yaml\n([\s\S]*?)```/.exec(skill)?.[1];
  assert.ok(example);
  project.write('burnex.yml', example);
  for (const args of [['lint'], ['run', '--dry-run'], ['run']]) {
    const outcome = await cli(project, ...args, 'burnex.yml');
    assert.equal(outcome.code, 0, outcome.output);
  }
});

const schema = (properties: Record<string, unknown>) =>
  JSON.stringify({ type: 'object', required: Object.keys(properties), additionalProperties: false, properties });

it('lints every complete pipeline of the installed skill', async () => {
  const project = makeProject({
    '.burnex/config.yml': 'version: 1\nkind: config\nproject:\n  check: npm run check\n  tools: [npm]\n  edit_paths: [src/**]\n',
    '.burnex/prompts/green.md': 'Цель: ${params.goal}\n',
    '.burnex/pipelines/schemas/plan.json': schema({ summary: { type: 'string' } }),
    '.burnex/pipelines/schemas/review.json': schema({ verdict: { enum: ['approve', 'changes_requested'] } }),
  });
  assert.equal((await cli(project, 'skill', 'install', '--agent', 'codex')).code, 0);
  const read = (name: string) => readFileSync(project.path(`.agents/skills/burnex/${name}`), 'utf8');
  const documents = (text: string, kind: string) =>
    [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]!).filter((body) => new RegExp(`^kind: ${kind}$`, 'm').test(body));
  const nameOf = (body: string) => /^name: ([\w-]+)$/m.exec(body)![1]!;

  for (const strategy of documents(read('references/collaboration.md'), 'review-strategy')) {
    project.write(`.burnex/review-strategies/${nameOf(strategy)}.yml`, strategy);
  }
  const patterns = read('references/patterns.md');
  for (const job of documents(patterns, 'job')) project.write(`.burnex/jobs/${nameOf(job)}.yml`, job);

  const pipelines = [...documents(read('SKILL.md'), 'pipeline'), ...documents(patterns, 'pipeline')];
  assert.ok(pipelines.length >= 8, `пайплайнов найдено: ${pipelines.length}`);
  for (const pipeline of pipelines) {
    const file = `.burnex/pipelines/${nameOf(pipeline)}.yml`;
    project.write(file, pipeline);
    const declared = /^inputs:\n((?:  .+\n)+)/m.exec(pipeline)?.[1] ?? '';
    const inputs = [...declared.matchAll(/^  (\w+):/gm)].flatMap(([, name]) => ['--input', `${name}=x`]);
    const outcome = await cli(project, 'lint', file, ...inputs);
    assert.equal(outcome.code, 0, `${file}\n${outcome.output}`);
  }
});
