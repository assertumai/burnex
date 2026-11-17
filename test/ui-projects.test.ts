import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { projectKey } from '../src/parts/pipeline/run/journal/paths.js';
import { tempDir } from './tmp.js';
import { addProject, buildProjects, removeProject, shownProjects } from '../src/parts/ui/projects.js';

/** Корень прогонов с двумя проектами в указателе, у каждого по каталогу прогона. */
function fixture(): { runsRoot: string; first: string; second: string } {
  const root = realpathSync(tempDir('burnex-projects-'));
  const runsRoot = join(root, 'runs');
  const first = join(root, 'first');
  const second = join(root, 'second');
  const index: Record<string, { path: string }> = {};
  for (const project of [first, second]) {
    mkdirSync(project, { recursive: true });
    const key = projectKey(project);
    mkdirSync(join(runsRoot, key, '2026-01-01T00-00-00Z-aaaaaa'), { recursive: true });
    index[key] = { path: project };
  }
  writeFileSync(join(runsRoot, 'projects.json'), JSON.stringify(index));
  return { runsRoot, first, second };
}

describe('реестр проектов витрины', () => {
  it('без реестра показывает все проекты указателя', () => {
    const { runsRoot, first, second } = fixture();
    assert.deepEqual(shownProjects(runsRoot).map((project) => project.path).sort(), [first, second]);
    const overview = buildProjects(runsRoot);
    assert.equal(overview.registered, false);
    assert.equal(overview.projects.length, 0);
  });

  it('после добавления показывает только добавленные', () => {
    const { runsRoot, first } = fixture();
    const added = addProject(runsRoot, first);
    assert.equal(added.key, projectKey(first));
    assert.equal(added.runs, 1);
    assert.deepEqual(shownProjects(runsRoot), [{ key: projectKey(first), path: first }]);
    assert.equal(buildProjects(runsRoot).registered, true);
  });

  it('добавленный проект виден и без единого прогона', () => {
    const { runsRoot } = fixture();
    const fresh = realpathSync(tempDir('burnex-projects-fresh-'));
    addProject(runsRoot, fresh);
    assert.deepEqual(shownProjects(runsRoot), [{ key: projectKey(fresh), path: fresh }]);
    assert.equal(buildProjects(runsRoot).projects[0]?.runs, 0);
  });

  it('снятие последнего проекта оставляет пустой список, а не возвращает показ всех', () => {
    const { runsRoot, first } = fixture();
    addProject(runsRoot, first);
    removeProject(runsRoot, projectKey(first));
    assert.deepEqual(shownProjects(runsRoot), []);
    assert.equal(buildProjects(runsRoot).registered, true);
  });

  it('отказывает относительному пути, несуществующему каталогу и чужому ключу', () => {
    const { runsRoot, first } = fixture();
    assert.throws(() => addProject(runsRoot, 'relative/path'), /must be absolute/);
    assert.throws(() => addProject(runsRoot, join(first, 'nope')), /not an existing directory/);
    assert.throws(() => removeProject(runsRoot, 'ffffffffffff'), /not in the added projects registry/);
  });
});
