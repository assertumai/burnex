import type { JSX } from 'react';

import type { GraphLoop, JobGraph as Graph, GraphNode } from '../api';

/**
 * Граф работ по зависимостям — как стадии в gitlab: колонка на уровень,
 * узлы столбиком, связи кривыми между ними.
 *
 * Раскладку считает демон: колонка и строка приходят в снимке. Здесь остаётся
 * геометрия — перевести номера в координаты и провести кривые.
 */

const NODE_WIDTH = 168;
/** Две строки: имя работы и подпись. */
const NODE_HEIGHT = 46;
/**
 * Три строки: имя, подпись и объявленный работой заголовок. Высота общая на
 * весь граф, а не своя у каждого узла: узлы стоят рядами, и разная высота
 * развалила бы ряд.
 */
const NODE_HEIGHT_TITLED = 60;
const GAP_X = 72;
const GAP_Y = 16;
const PADDING = 8;

/**
 * Строка, объявленная работой через `display: { title: … }` и раскрытая
 * демоном против её данных. Прочие ключи подписи показывает карточка работы:
 * в узле места ровно на одну строку.
 */
function titleOf(node: GraphNode): string | undefined {
  const title = node.display?.title;
  return title === undefined || title.trim() === '' ? undefined : title;
}

/**
 * Метка прохода в верхнем правом углу узла участника цикла. Строка короткая и
 * высоту узла не меняет: полное имя цикла и предел — в подсказке узла.
 * Законченный цикл называет число проходов и вердикт, но не «текущий проход»:
 * его читатель спутал бы с идущим.
 */
export function loopLabel(loop: GraphLoop): string {
  if (loop.iterations === 0) return `0/${loop.maxIterations}`;
  if (loop.current !== undefined) return `pass ${loop.current}/${loop.maxIterations}`;
  const passes = `${loop.iterations} ${loop.iterations === 1 ? 'pass' : 'passes'}`;
  return loop.verdict === undefined ? passes : `${passes} · ${loop.verdict}`;
}

/** Ширина знака метки прохода: моноширинный шрифт 10px, знак ≈ 0.6em. */
const LOOP_CHAR_WIDTH = 6;
/** Зазор между обрезанным именем работы и меткой прохода. */
const LOOP_GAP = 6;

/**
 * Ширина обрезки имени работы рядом с меткой прохода. Метка стоит в правом
 * верхнем углу, а имя над подписью поднимается на её высоту: без обрезки
 * длинное имя и `5 passes · exhausted` наслаивались бы друг на друга.
 */
export function idClipWidth(label: string): number {
  return Math.max(0, NODE_WIDTH - 10 - label.length * LOOP_CHAR_WIDTH - LOOP_GAP);
}

function x(column: number): number {
  return PADDING + column * (NODE_WIDTH + GAP_X);
}

function y(row: number, height: number): number {
  return PADDING + row * (height + GAP_Y);
}

/** Связь ведётся кривой Безье: прямые углы между колонками читаются хуже. */
function edgePath(from: GraphNode, to: GraphNode, height: number): string {
  const x1 = x(from.column) + NODE_WIDTH;
  const y1 = y(from.row, height) + height / 2;
  const x2 = x(to.column);
  const y2 = y(to.row, height) + height / 2;
  const bend = Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

export interface JobGraphProps {
  readonly graph: Graph;
  readonly selected?: string;
  readonly onSelect?: (id: string) => void;
  /** Подпись под именем работы: статус в прогоне, шаги в пайплайне. */
  readonly subtitle?: (node: GraphNode) => string | undefined;
}

export function JobGraph({ graph, selected, onSelect, subtitle }: JobGraphProps): JSX.Element {
  if (graph.nodes.length === 0) {
    return <p className="note dim">This graph has no jobs.</p>;
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const rows = Math.max(...graph.nodes.map((node) => node.row)) + 1;
  const columns = Math.max(...graph.nodes.map((node) => node.column)) + 1;
  const titled = graph.nodes.some((node) => titleOf(node) !== undefined);
  const nodeHeight = titled ? NODE_HEIGHT_TITLED : NODE_HEIGHT;
  const width = x(columns - 1) + NODE_WIDTH + PADDING;
  const height = y(rows - 1, nodeHeight) + nodeHeight + PADDING;

  return (
    <div className="graph">
      <svg width={width} height={height} role="img" aria-label="Job graph">
        {/*
         * Обрезка по рамке узла. Ни имя работы, ни подпись под ним не
         * ограничены длиной: имя приходит из пайплайна, подпись — из статуса
         * или списка шагов, и достаточно длинной любая из них вылезает за
         * рамку и наезжает на соседний узел. Обрезка внутри перенесённой
         * группы, поэтому одного описания хватает на все узлы.
         */}
        <defs>
          <clipPath id="job-node-box">
            <rect width={NODE_WIDTH - 6} height={nodeHeight} rx={7} />
          </clipPath>
        </defs>
        {graph.edges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (from === undefined || to === undefined) return null;
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              className={edge.blocking ? 'edge blocking' : 'edge'}
              d={edgePath(from, to, nodeHeight)}
            >
              {/* Ребро к пропущенной работе называет виновника прямо в подсказке. */}
              <title>
                {edge.blocking
                  ? `${edge.to} canceled by the outcome of ${edge.from}`
                  : `${edge.to} waits for ${edge.from}`}
              </title>
            </path>
          );
        })}

        {graph.nodes.map((node, index) => {
          const classes = ['node'];
          if (node.conditional) classes.push('conditional');
          if (node.status !== undefined) classes.push(`status-${node.status}`);
          if (node.id === selected) classes.push('selected');
          const sub = subtitle?.(node);
          const title = titleOf(node);
          const label = node.loop === undefined ? undefined : loopLabel(node.loop);
          // Без подписи имя стоит ниже метки и с ней не пересекается.
          const idClip = label === undefined || sub === undefined ? undefined : `job-node-id-${index}`;

          return (
            <g
              key={node.id}
              className={classes.join(' ')}
              transform={`translate(${x(node.column)}, ${y(node.row, nodeHeight)})`}
              onClick={() => onSelect?.(node.id)}
            >
              <rect width={NODE_WIDTH} height={nodeHeight} rx={7} />
              {idClip === undefined || label === undefined ? null : (
                <clipPath id={idClip}>
                  <rect width={idClipWidth(label)} height={nodeHeight} />
                </clipPath>
              )}
              <text x={10} y={sub === undefined ? 27 : 20} clipPath={`url(#${idClip ?? 'job-node-box'})`}>
                {node.id}
              </text>
              {sub === undefined ? null : (
                <text className="sub" x={10} y={35} clipPath="url(#job-node-box)">
                  {sub}
                </text>
              )}
              {node.loop === undefined || label === undefined ? null : (
                <text
                  className={node.loop.verdict === 'exhausted' ? 'loop-label failed' : 'loop-label'}
                  x={NODE_WIDTH - 10}
                  y={14}
                  textAnchor="end"
                >
                  {label}
                </text>
              )}
              {title === undefined ? null : (
                <text className="sub display" x={10} y={50} clipPath="url(#job-node-box)">
                  {title}
                </text>
              )}
              <title>
                {[
                  title === undefined ? undefined : title,
                  node.loop === undefined
                    ? undefined
                    : `loop ${node.loop.id}: up to ${node.loop.maxIterations} passes`,
                  node.needs.length === 0 ? 'no dependencies' : `needs: ${node.needs.join(', ')}`,
                  node.on === 'success' ? undefined : `on: ${node.on}`,
                  node.if === undefined ? undefined : `if: ${node.if}`,
                  node.blockedBy.length === 0
                    ? undefined
                    : `canceled by the outcome of: ${node.blockedBy.join(', ')}`,
                ]
                  .filter((line): line is string => line !== undefined)
                  .join('\n')}
              </title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
