import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
    project.write(path, 'local edits');
    assert.notEqual((await cli(project, ...args)).code, 0);
    assert.equal(readFileSync(project.path(path), 'utf8'), 'local edits');
  });
}

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
