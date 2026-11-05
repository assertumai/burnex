import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildGraph,
  loopEntryPoints,
  loopExit,
  loopMembersInOrder,
  loopOf,
} from '../src/parts/pipeline/domain/graph.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import type { Pipeline } from '../src/parts/pipeline/document/model.js';
import { makeProject } from './helpers.js';

function pipelineOf(yaml: string): Pipeline {
  const project = makeProject({ 'burnex.yml': yaml });
  return expandPipeline({ pipelinePath: project.path('burnex.yml'), config: project.config }).pipeline;
}

const STEP = '{ id: c, run: [echo, ok] }';

describe('graph: циклы по группе работ', () => {
  // `fix` объявлена раньше `check`: порядок записи не равен порядку исполнения.
  const CHECK_FIX = `
kind: pipeline
loops:
  fix-loop:
    jobs: [fix, check]
    max_iterations: 3
jobs:
  fix:
    needs: [check]
    on: failure
    steps: [${STEP}]
  check:
    steps: [${STEP}]
  report:
    needs: [fix]
    steps: [${STEP}]
`;

  it('цикл check→fix: принадлежность, порядок, точка входа и выход', () => {
    const pipeline = pipelineOf(CHECK_FIX);
    const { graph } = buildGraph(pipeline);
    const loop = pipeline.loops[0]!;

    assert.equal(loopOf(pipeline.loops, 'check')?.id, 'fix-loop');
    assert.equal(loopOf(pipeline.loops, 'fix')?.id, 'fix-loop');
    assert.equal(loopOf(pipeline.loops, 'report'), undefined);
    assert.deepEqual(
      loopMembersInOrder(graph, loop).map((job) => job.id),
      ['check', 'fix'],
    );
    assert.deepEqual(
      loopEntryPoints(graph, loop).map((job) => job.id),
      ['check'],
    );
    assert.equal(loopExit(graph, loop, () => true)?.id, 'fix');
    assert.equal(
      loopExit(graph, loop, (id) => id === 'check')?.id,
      'check',
      'участник без дерева (пропущенный) выходом не бывает',
    );
    assert.equal(loopExit(graph, loop, () => false), undefined);
  });

  it('цикл с двумя точками входа: обе названы, порядок — исполнения', () => {
    const pipeline = pipelineOf(`
kind: pipeline
loops:
  two:
    jobs: [join, b, a]
    max_iterations: 2
jobs:
  a:
    steps: [${STEP}]
  b:
    steps: [${STEP}]
  join:
    needs: [a, b]
    steps: [${STEP}]
`);
    const { graph } = buildGraph(pipeline);
    const loop = pipeline.loops[0]!;

    assert.deepEqual(
      loopEntryPoints(graph, loop).map((job) => job.id),
      ['a', 'b'],
    );
    assert.deepEqual(
      loopMembersInOrder(graph, loop).map((job) => job.id),
      ['a', 'b', 'join'],
    );
  });
});
