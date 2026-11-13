import { readFileSync } from 'node:fs';

import { packagedSchemaPath } from '../../domain/package-schema.js';
import { AGGREGATOR_ID, AUTHOR_ID, type AgentStep, type DiscussStep, type ReviewParticipant } from '../../document/model.js';
import type { DefenseSideOf } from '../../run/exec/reviewDefense.js';
import type { DefenseMessageRecord, FindingStatus } from '../review/defend.js';
import { participantStep } from '../review/participants.js';

/**
 * Шаг `discuss` (`discuss-step`, design.md, решения 2–7): записи журнала
 * `discuss.ndjson`, схемы ходов, промпты фаз и проверки движка поверх схем.
 * Порядок фаз, параллельность и журнал — в исполнении шага
 * (`run/exec/discussStep.ts`); здесь — то, что от исполнения не зависит и
 * проверяется без бэкенда.
 */

/** Журнал шага в его каталоге. Имя `discussion.ndjson` занято прежним режимом ревью. */
export const DISCUSS_FILE = 'discuss.ndjson';

export const DISCUSS_PHASES = ['proposals', 'draft', 'objections', 'defense', 'aggregate'] as const;
export type DiscussPhase = (typeof DISCUSS_PHASES)[number];

/** Поля итога, которые движок требует при любой `output_schema` шага (решение 7). */
export const ENGINE_FIELDS = ['agreed', 'unresolved', 'changed_by_aggregator'] as const;

export interface ProposalDecision {
  readonly question: string;
  readonly choice: string;
  readonly rationale: string;
}

export interface Diagram {
  readonly title: string;
  readonly kind: 'mermaid';
  readonly source: string;
}

/** Предложение участника по схеме `discuss-proposal`. */
export interface Proposal {
  readonly summary: string;
  readonly approach: string;
  readonly decisions: readonly ProposalDecision[];
  readonly risks: readonly string[];
  readonly diagrams: readonly Diagram[];
}

export interface DraftDecision {
  readonly id: string;
  readonly question: string;
  readonly options: readonly { readonly by: string; readonly summary: string }[];
  readonly choice: string;
  readonly rationale: string;
}

export interface DraftDiagram extends Diagram {
  readonly id: string;
  readonly decisions: readonly string[];
}

/** Черновик автора по схеме `discuss-draft`. */
export interface Draft {
  readonly summary: string;
  readonly decisions: readonly DraftDecision[];
  readonly diagrams: readonly DraftDiagram[];
  readonly risks: readonly { readonly risk: string; readonly mitigation: string }[];
}

export type ObjectionWeight = 'blocking' | 'preference';

/** Возражение участника с id `<участник>.<n>` в порядке его ответа. */
export interface ObjectionRecord {
  readonly kind: 'objection';
  readonly id: string;
  readonly by: string;
  /** Id решения или диаграммы черновика. */
  readonly target: string;
  readonly weight: ObjectionWeight;
  readonly title: string;
  readonly breaks: string | null;
  readonly alternative: string | null;
}

/** Правка решения, принятая автором вместе с возражением. */
export interface Change {
  readonly choice: string;
  readonly rationale: string;
}

export interface AuthorResponse {
  readonly finding: string;
  readonly stance: 'accept' | 'dispute' | 'clarify';
  readonly text: string;
  readonly evidence: string | null;
  readonly change: Change | null;
}

/** Строки `discuss.ndjson` сверх реплик и закрытий защиты. */
export type DiscussRecord =
  | { readonly kind: 'proposal'; readonly participant: string; readonly status: string; readonly reason?: string }
  | ({ readonly kind: 'draft' } & Draft)
  | ObjectionRecord
  | {
      readonly kind: 'outcome';
      readonly accepted: number;
      readonly withdrawn: number;
      readonly contested: number;
      readonly preference: number;
    };

export function schemaPathOf(name: 'discuss-proposal' | 'discuss-draft' | 'discuss-objections' | 'discuss-defense' | 'discuss-rebuttal'): string {
  return packagedSchemaPath(name);
}

function readSchema(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

type Json = Record<string, unknown>;

function withProperty(schema: Json, path: readonly string[], patch: (value: Json) => Json): Json {
  const [head, ...rest] = path;
  if (head === undefined) return patch(schema);
  const properties = (schema.properties ?? {}) as Record<string, Json>;
  const items = head === '[]';
  if (items) return { ...schema, items: withProperty(schema.items as Json, rest, patch) };
  return { ...schema, properties: { ...properties, [head]: withProperty(properties[head] as Json, rest, patch) } };
}

/**
 * Схема проверки черновика: `options[].by` — участник, давший предложение,
 * либо `author`. Остальное, что схемой не выразить (сквозная нумерация,
 * ссылки диаграмм), проверяет `draftProblems` после хода.
 */
export function draftCheckSchema(proposers: readonly string[]): unknown {
  return withProperty(readSchema(schemaPathOf('discuss-draft')), ['decisions', '[]', 'options', '[]', 'by'], () => ({
    type: 'string',
    enum: [...proposers, AUTHOR_ID],
  }));
}

/**
 * Проверки черновика сверх схемы (решение 4): решения — `d1, d2, …` по
 * порядку, диаграммы — `g1, g2, …`, ссылки диаграмм — на решения черновика.
 * Пустой список — черновик годен.
 */
export function draftProblems(draft: Draft): readonly string[] {
  const problems: string[] = [];
  draft.decisions.forEach((decision, index) => {
    if (decision.id !== `d${index + 1}`) problems.push(`решение ${index + 1} обязано иметь id d${index + 1}, а не ${decision.id}`);
  });
  const ids = new Set(draft.decisions.map((decision) => decision.id));
  draft.diagrams.forEach((diagram, index) => {
    if (diagram.id !== `g${index + 1}`) problems.push(`диаграмма ${index + 1} обязана иметь id g${index + 1}, а не ${diagram.id}`);
    for (const ref of diagram.decisions) {
      if (!ids.has(ref)) problems.push(`диаграмма ${diagram.id} ссылается на решение ${ref}, которого в черновике нет`);
    }
  });
  if (draft.decisions.length === 0) problems.push('в черновике нет ни одной точки решения');
  return problems;
}

/**
 * Схема проверки возражений (решение 5): `target` — id решения или диаграммы
 * черновика; у `blocking` поля `breaks` и `alternative` не `null`.
 */
export function objectionsCheckSchema(draft: Draft): unknown {
  const targets = [...draft.decisions.map((decision) => decision.id), ...draft.diagrams.map((diagram) => diagram.id)];
  return withProperty(readSchema(schemaPathOf('discuss-objections')), ['objections', '[]'], (item) => ({
    ...item,
    properties: { ...(item.properties as Json), target: { type: 'string', enum: targets } },
    if: { properties: { weight: { const: 'blocking' } }, required: ['weight'] },
    then: { properties: { breaks: { type: 'string', minLength: 1 }, alternative: { type: 'string', minLength: 1 } } },
  }));
}

/** Возражения участника из его выхода: id `<участник>.<n>` в порядке ответа. */
export function objectionsOf(participant: string, structured: unknown): readonly ObjectionRecord[] {
  const list = (structured as { readonly objections?: unknown } | null)?.objections;
  if (!Array.isArray(list)) return [];
  return list.map((raw, index) => {
    const entry = raw as Partial<Record<'target' | 'weight' | 'title' | 'breaks' | 'alternative', unknown>>;
    return {
      kind: 'objection',
      id: `${participant}.${index + 1}`,
      by: participant,
      target: typeof entry.target === 'string' ? entry.target : '',
      weight: entry.weight === 'blocking' ? 'blocking' : 'preference',
      title: typeof entry.title === 'string' ? entry.title : '',
      breaks: typeof entry.breaks === 'string' ? entry.breaks : null,
      alternative: typeof entry.alternative === 'string' ? entry.alternative : null,
    };
  });
}

/** Правка у `accept`: не `null`, с непустым выбором. */
const CHANGE_REQUIRED: Json = {
  type: 'object',
  properties: { choice: { type: 'string', minLength: 1 }, rationale: { type: 'string' } },
  required: ['choice', 'rationale'],
  additionalProperties: false,
};

/**
 * Схема проверки хода защиты: ответы покрывают ровно открытые возражения, у
 * `accept` правка `change` обязательна (решение 6); ход участника —
 * `maintain | withdraw` по каждому своему открытому возражению.
 */
export function discussTurnCheckSchema(kind: 'defense' | 'rebuttal', openIds: readonly string[]): unknown {
  const base = readSchema(schemaPathOf(kind === 'defense' ? 'discuss-defense' : 'discuss-rebuttal'));
  return withProperty(base, ['responses'], (responses) => {
    const items = responses.items as Json;
    return {
      ...responses,
      minItems: openIds.length,
      maxItems: openIds.length,
      items: {
        ...items,
        properties: { ...(items.properties as Json), finding: { type: 'string', enum: [...openIds] } },
        ...(kind === 'defense'
          ? {
              if: { properties: { stance: { const: 'accept' } }, required: ['stance'] },
              then: { properties: { change: CHANGE_REQUIRED } },
            }
          : {}),
      },
      allOf: openIds.map((id) => ({ contains: { properties: { finding: { const: id } }, required: ['finding'] } })),
    };
  });
}

/** Поля движка в схеме итога (решение 7). */
const ENGINE_PROPERTIES: Json = {
  agreed: { type: 'boolean', description: 'Все точки решения согласованы: спорные решены без сшивки, несогласованного нет' },
  unresolved: {
    type: 'array',
    description: 'Несогласованные решения — по точке на запись',
    items: {
      type: 'object',
      properties: { decision: { type: 'string' }, reason: { type: 'string' } },
      required: ['decision', 'reason'],
      additionalProperties: false,
    },
  },
  changed_by_aggregator: {
    type: 'array',
    description: 'Id решений, изменённых агрегатором, хотя их никто не оспаривал и автор не принимал',
    items: { type: 'string' },
  },
};

/**
 * Почему схему шага нельзя дополнить полями движка: корень — не объект,
 * либо схема сама объявляет одно из полей. `undefined` — дополнить можно.
 */
export function engineFieldsConflict(schema: unknown): string | undefined {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return 'корень output_schema — не JSON-объект';
  const record = schema as Json;
  if (record.type !== undefined && record.type !== 'object') return 'корень output_schema шага discuss обязан описывать объект (type: object)';
  const properties = record.properties;
  if (properties !== undefined && (typeof properties !== 'object' || properties === null)) return 'properties корня output_schema — не объект';
  for (const field of ENGINE_FIELDS) {
    if (properties !== undefined && Object.hasOwn(properties as object, field)) {
      return `output_schema сама объявляет поле ${field}, которое шаг discuss добавляет к итогу сам`;
    }
  }
  return undefined;
}

/**
 * Схема итога: схема шага с полями движка в `properties` и `required` корня,
 * а не через `allOf`, — так схема с `additionalProperties: false` остаётся
 * рабочей (решение 7).
 */
export function withEngineFields(schema: Json): Json {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return {
    ...schema,
    type: 'object',
    properties: { ...((schema.properties as Json | undefined) ?? {}), ...ENGINE_PROPERTIES },
    required: [...required.filter((name) => !(ENGINE_FIELDS as readonly string[]).includes(name)), ...ENGINE_FIELDS],
  };
}

/**
 * Схема проверки итога: инварианты движка поверх схемы итога — при
 * `agreed: true` список `unresolved` пуст, id в `unresolved[].decision` и
 * `changed_by_aggregator` — решения черновика.
 */
export function aggregateCheckSchema(merged: Json, decisionIds: readonly string[]): Json {
  const ids = { type: 'string', enum: [...decisionIds] };
  const properties = merged.properties as Json;
  const unresolved = properties.unresolved as Json;
  return {
    ...merged,
    properties: {
      ...properties,
      unresolved: { ...unresolved, items: { ...(unresolved.items as Json), properties: { decision: ids, reason: { type: 'string' } } } },
      changed_by_aggregator: { type: 'array', items: ids },
    },
    if: { properties: { agreed: { const: true } }, required: ['agreed'] },
    then: { properties: { unresolved: { maxItems: 0 } } },
  };
}

// --- Промпты.

function joinParts(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join('\n\n');
}

function agentLabel(participant: Pick<ReviewParticipant, 'agent' | 'model'>): string {
  return participant.model === undefined ? participant.agent : `${participant.agent} · ${participant.model}`;
}

function signature(participant: ReviewParticipant): string {
  const focus = participant.focus === undefined ? '' : `, фокус: ${participant.focus}`;
  return `— Участник \`${participant.id}\` (${agentLabel(participant)})${focus}`;
}

/** Задание участника: задача шага, затем его `focus`. */
export function participantTask(step: DiscussStep, participant: ReviewParticipant): string {
  return joinParts([step.prompt, participant.focus === undefined ? undefined : `## Твой фокус\n\n${participant.focus}`]);
}

const PROPOSAL_FORM = [
  '## Форма ответа',
  '',
  'Ты — один из участников, независимо предлагающих подход. Чужих предложений ты не видишь.',
  'Отдай предложение по схеме: `summary` — суть в двух-трёх фразах, `approach` — как устроить реализацию,',
  '`decisions` — ключевые решения `{ question, choice, rationale }`, `risks` — риски,',
  '`diagrams` — диаграммы Mermaid `{ title, kind: "mermaid", source }`, если они проясняют подход (пустой список — тоже ответ).',
  'Файлы не правь: шаг discuss — про обсуждение, реализацию сделают следующие шаги.',
].join('\n');

export function proposalPrompt(step: DiscussStep, participant: ReviewParticipant): string {
  return joinParts([participantTask(step, participant), PROPOSAL_FORM]);
}

function describeProposal(participant: ReviewParticipant, proposal: Proposal): string {
  const decisions = proposal.decisions.map((decision) => `- ${decision.question}: **${decision.choice}** — ${decision.rationale}`);
  const diagrams = proposal.diagrams.map((diagram) => `${diagram.title}\n\n\`\`\`mermaid\n${diagram.source}\n\`\`\``);
  return joinParts([
    signature(participant),
    proposal.summary,
    `Подход: ${proposal.approach}`,
    decisions.length === 0 ? undefined : `Решения:\n${decisions.join('\n')}`,
    proposal.risks.length === 0 ? undefined : `Риски:\n${proposal.risks.map((risk) => `- ${risk}`).join('\n')}`,
    ...diagrams,
  ]);
}

const DRAFT_FORM = [
  '## Твоя роль',
  '',
  'Ты — автор. Своих предложений ты не подавал; сведи предложения участников в ОДИН черновик и будь готов его защищать.',
  '- Точки решения — вопросы, по которым нужно выбрать: `d1, d2, …` строго по порядку. В каждой —',
  '  `options` — варианты участников (`by` — id участника; свой вариант — `author`), `choice` — выбранный, `rationale` — почему',
  '  он, а не остальные. Отклонённые варианты не теряй: по ним участники будут возражать.',
  '- Несовместимые архитектуры не смешивай: корневая точка выбирает одну, другая уходит в отклонённые варианты.',
  '- `diagrams` — диаграммы Mermaid `g1, g2, …` по порядку, `decisions` — id решений, которые диаграмма показывает.',
  '- `risks` — риски с мерами.',
  'Ответь черновиком по схеме. Файлы не правь.',
].join('\n');

export function draftPrompt(options: {
  readonly step: DiscussStep;
  readonly proposals: readonly { readonly participant: ReviewParticipant; readonly proposal: Proposal }[];
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
}): string {
  return joinParts([
    options.step.prompt,
    `## Предложения участников\n\n${options.proposals.map(({ participant, proposal }) => describeProposal(participant, proposal)).join('\n\n')}`,
    options.failed.length === 0
      ? undefined
      : `## Участники без предложения\n\n${options.failed.map((entry) => `- \`${entry.id}\`: ${entry.reason}`).join('\n')}`,
    options.step.author?.prompt === undefined ? undefined : `## Указания стратегии\n\n${options.step.author.prompt}`,
    DRAFT_FORM,
  ]);
}

/** Черновик markdown-текстом — участникам и агрегатору. */
export function describeDraft(draft: Draft): string {
  const decisions = draft.decisions.map((decision) =>
    joinParts([
      `### ${decision.id} — ${decision.question}`,
      `Выбор: **${decision.choice}** — ${decision.rationale}`,
      decision.options.length === 0 ? undefined : `Варианты:\n${decision.options.map((option) => `- ${option.by}: ${option.summary}`).join('\n')}`,
    ]),
  );
  const diagrams = draft.diagrams.map(
    (diagram) => `### ${diagram.id} — ${diagram.title} (решения: ${diagram.decisions.join(', ') || '—'})\n\n\`\`\`mermaid\n${diagram.source}\n\`\`\``,
  );
  const risks = draft.risks.map((risk) => `- ${risk.risk} — ${risk.mitigation}`);
  return joinParts([
    draft.summary,
    `## Решения\n\n${decisions.join('\n\n')}`,
    diagrams.length === 0 ? undefined : `## Диаграммы\n\n${diagrams.join('\n\n')}`,
    risks.length === 0 ? undefined : `## Риски\n\n${risks.join('\n')}`,
  ]);
}

const OBJECTIONS_FORM = [
  '## Форма ответа',
  '',
  'Возражай против черновика по точкам, а не против черновика целиком, и не защищай своё предложение как таковое:',
  '`objections` — список `{ target, weight, title, breaks, alternative }`, где `target` — id решения (`d<n>`) или диаграммы (`g<n>`),',
  '`weight` — `blocking`, если с этим решением реализация сломается или будет заметно хуже, иначе `preference`.',
  'У `blocking` обязательны `breaks` — что именно сломается — и `alternative` — что выбрать вместо; у `preference` они могут быть null.',
  'Пожелания (`preference`) уйдут агрегатору заметками, спорить по ним не будут. Пустой список — тоже ответ. Файлы не правь.',
].join('\n');

/** Ход возражений: участник видит черновик; его предложение уже в его сессии. */
export function objectionsPrompt(options: {
  readonly step: DiscussStep;
  readonly participant: ReviewParticipant;
  readonly draft: Draft;
  /** Сессия участника возобновляется: его задание и предложение в ней уже есть. */
  readonly resumed: boolean;
  readonly proposal: Proposal;
}): string {
  return joinParts([
    options.resumed ? undefined : participantTask(options.step, options.participant),
    options.resumed ? undefined : `## Твоё предложение\n\n${describeProposal(options.participant, options.proposal)}`,
    `## Черновик автора\n\nАвтор свёл предложения участников в один черновик.\n\n${describeDraft(options.draft)}`,
    OBJECTIONS_FORM,
  ]);
}

export type ObjectionSide = DefenseSideOf<ObjectionRecord>;

function describeObjection(objection: ObjectionRecord): string {
  return joinParts([
    `### ${objection.id} — ${objection.target}: ${objection.title}`,
    objection.breaks === null ? undefined : `Что сломается: ${objection.breaks}`,
    objection.alternative === null ? undefined : `Альтернатива: ${objection.alternative}`,
  ]);
}

function describeAnswer(message: DefenseMessageRecord, finding: string): string | undefined {
  const response = message.responses.find((entry) => entry.finding === finding) as (AuthorResponse | { finding: string; stance: string; text: string }) | undefined;
  if (response === undefined) return undefined;
  const who = message.from === AUTHOR_ID ? 'автор' : `участник \`${message.from}\``;
  const change = 'change' in response && response.change !== null ? `\n  Правка: **${response.change.choice}** — ${response.change.rationale}` : '';
  const evidence = 'evidence' in response && response.evidence !== null ? `\n  Довод из кода или задачи: ${response.evidence}` : '';
  return `- раунд ${message.round}, ${who}: **${response.stance}** — ${response.text}${evidence}${change}`;
}

function describeMissing(message: DefenseMessageRecord): string | undefined {
  const who = message.from === AUTHOR_ID ? 'автора' : `участника \`${message.from}\``;
  if (message.invalid === true) return `- раунд ${message.round}: ход ${who} дважды не прошёл схему — ответа нет`;
  if (message.failure !== undefined) return `- раунд ${message.round}: ход ${who} сорвался — ${message.failure}`;
  return undefined;
}

/** Переписка по одному возражению, в порядке ходов. */
export function objectionThread(id: string, messages: readonly DefenseMessageRecord[]): readonly string[] {
  return messages.flatMap((message) => {
    const missing = describeMissing(message);
    if (missing !== undefined) return message.from === AUTHOR_ID || id.startsWith(`${message.from}.`) ? [missing] : [];
    const line = describeAnswer(message, id);
    return line === undefined ? [] : [line];
  });
}

const DEFENSE_FORM = [
  '## Форма ответа',
  '',
  'Ответь одним ходом по схеме защиты: `text` — общий довод, `responses` — ровно по одному ответу на каждое открытое возражение:',
  '`finding` — его id, `stance` — `accept` (возражение верно), `dispute` (неверно) или `clarify` (верно не так, как сказано),',
  '`text` — довод, `evidence` — опора в коде или задаче либо null, `change` — у `accept` обязательно: `{ choice, rationale }` —',
  'новая формулировка решения, на которое возражали; иначе null.',
  'Принимай только то, что действительно лучше: согласие «чтобы не спорить» портит документ, а спорное решит агрегатор по доводам сторон.',
  'Черновик не переписывай: принятая правка живёт в `change`. Файлы не правь.',
].join('\n');

const REBUTTAL_FORM = [
  '## Форма ответа',
  '',
  'Ответь одним ходом: `text` — общий довод, `responses` — ровно по одному ответу на каждое своё открытое возражение:',
  '`finding` — его id, `stance` — `maintain` (настаиваешь) или `withdraw` (снимаешь), `text` — довод.',
  'Снимай возражение, только если довод автора его действительно снимает. Файлы не правь.',
].join('\n');

/**
 * Ход автора в раунде защиты (решение 6): первый раунд несёт возражения под
 * подписью участника, следующие — только ответы участников; без сессии —
 * черновик и всю переписку заново.
 */
export function authorDefensePrompt(options: {
  readonly step: DiscussStep;
  readonly draft: Draft;
  readonly round: number;
  readonly resumed: boolean;
  readonly sides: readonly ObjectionSide[];
  readonly messages: readonly DefenseMessageRecord[];
}): string {
  const { round } = options;
  const open = options.sides.flatMap((side) => side.open.map((objection) => objection.id));
  const blocks = options.sides.map((side) => {
    if (round === 1 || !options.resumed) {
      const last = options.messages.filter((message) => message.from === side.reviewer.id).at(-1);
      return joinParts([
        signature(side.reviewer),
        ...side.open.map((objection) => joinParts([describeObjection(objection), last === undefined ? undefined : describeAnswer(last, objection.id)])),
      ]);
    }
    const last = options.messages.filter((message) => message.from === side.reviewer.id).at(-1);
    return joinParts([
      signature(side.reviewer),
      ...side.open.map((objection) => `#### ${objection.id}\n${(last === undefined ? undefined : describeAnswer(last, objection.id)) ?? ''}`),
    ]);
  });
  const transcript = round > 1 && !options.resumed
    ? options.messages.map((message) => describeMissing(message) ?? `#### ${message.messageId} — ${message.from === AUTHOR_ID ? 'автор' : `участник \`${message.from}\``}, раунд ${message.round}\n\n${message.parts.map((part) => part.text).join('\n')}`).join('\n\n')
    : undefined;
  return joinParts([
    !options.resumed && round > 1 ? `## Черновик\n\n${describeDraft(options.draft)}` : undefined,
    `## Защита черновика — раунд ${round}\n\n${round === 1 ? 'Участники возразили против черновика. Ответь на каждое блокирующее возражение.' : 'Участники ответили на твои доводы. Ответь на каждое открытое возражение.'}\n\nОткрытые возражения: ${open.join(', ')}`,
    transcript === undefined ? undefined : `## Переписка защиты\n\n${transcript}`,
    `## ${round === 1 ? 'Возражения участников' : 'Ответы участников'}\n\n${blocks.join('\n\n')}`,
    DEFENSE_FORM,
  ]);
}

/** Ход участника в раунде защиты: ответы автора по его открытым возражениям. */
export function participantRebuttalPrompt(options: {
  readonly step: DiscussStep;
  readonly draft: Draft;
  readonly round: number;
  readonly resumed: boolean;
  readonly side: ObjectionSide;
  readonly messages: readonly DefenseMessageRecord[];
}): string {
  const author = options.messages.filter((message) => message.from === AUTHOR_ID).at(-1);
  const blocks = options.side.open.map((objection) =>
    joinParts([describeObjection(objection), author === undefined ? undefined : describeAnswer(author, objection.id) ?? describeMissing(author)]),
  );
  return joinParts([
    options.resumed ? undefined : participantTask(options.step, options.side.reviewer),
    options.resumed ? undefined : `## Черновик автора\n\n${describeDraft(options.draft)}`,
    `## Защита черновика — раунд ${options.round}\n\nТы — участник \`${options.side.reviewer.id}\`. Автор ответил на твои возражения: ответь на каждое открытое.\n\nОткрытые возражения: ${options.side.open.map((objection) => objection.id).join(', ')}`,
    `## Твои возражения и ответ автора\n\n${blocks.join('\n\n')}`,
    REBUTTAL_FORM,
  ]);
}

const STATUS_TEXT: Readonly<Record<FindingStatus, string>> = {
  accepted: 'accepted — автор принял, правка ниже',
  withdrawn: 'withdrawn — участник снял',
  contested: 'contested — спор не разрешён, решай ты',
};

/** Промпт агрегатора (решение 7). */
export function aggregatePrompt(options: {
  readonly step: DiscussStep;
  readonly draft: Draft;
  readonly blocking: readonly { readonly objection: ObjectionRecord; readonly status: FindingStatus }[];
  readonly preferences: readonly ObjectionRecord[];
  readonly messages: readonly DefenseMessageRecord[];
  readonly without: readonly { readonly id: string; readonly reason: string }[];
}): string {
  const blocking = options.blocking.map(({ objection, status }) => {
    const thread = objectionThread(objection.id, options.messages);
    return joinParts([
      describeObjection(objection),
      `Статус: ${STATUS_TEXT[status]}`,
      thread.length === 0 ? undefined : `Переписка:\n${thread.join('\n')}`,
    ]);
  });
  return joinParts([
    options.step.prompt,
    `## Черновик автора\n\n${describeDraft(options.draft)}`,
    blocking.length === 0 ? '## Блокирующие возражения\n\nНет: участники не возразили по существу.' : `## Блокирующие возражения\n\n${blocking.join('\n\n')}`,
    options.preferences.length === 0
      ? undefined
      : `## Пожелания участников\n\n${options.preferences.map((objection) => `- ${objection.id} (${objection.target}): ${objection.title}${objection.alternative === null ? '' : ` — ${objection.alternative}`}`).join('\n')}`,
    options.without.length === 0
      ? undefined
      : `## Участники без предложения или возражений\n\n${options.without.map((entry) => `- \`${entry.id}\`: ${entry.reason}`).join('\n')}`,
    options.step.aggregator?.prompt === undefined ? undefined : `## Указания стратегии\n\n${options.step.aggregator.prompt}`,
    [
      '## Твоя роль',
      '',
      'Ты — агрегатор. Собери итоговый документ строго по схеме выхода шага:',
      '- за основу — черновик; `accepted` — примени правку автора к своему решению;',
      '- `withdrawn` — решение остаётся как в черновике;',
      '- `contested` — реши сам, взвесив доводы сторон;',
      '- пожелания учитывай, только если они не спорят с решениями.',
      'Не сшивай несовместимое: если решение по спорной точке затрагивает другие решения и пересобрать их согласованно нельзя,',
      'поставь `agreed: false` и перечисли несогласованное в `unresolved` (`decision` — id решения черновика, `reason`).',
      'Решения, которые ты изменил, хотя их никто не оспаривал и автор не принимал правку, перечисли в `changed_by_aggregator`.',
      '`agreed: true` — только если несогласованного нет. Диаграммы — Mermaid, со ссылками на id решений. Файлы не правь.',
    ].join('\n'),
  ]);
}

// --- Вызовы участников.

function turn(
  step: DiscussStep,
  participant: ReviewParticipant,
  prompt: string,
  outputSchemaPath: string,
  checkSchemaPath: string,
  carriesContext: boolean,
): AgentStep {
  // Сессия участника — `<шаг>/<участник>`: живёт только внутри шага.
  return {
    ...participantStep(step, participant),
    ...(carriesContext ? {} : { context: [] }),
    prompt,
    outputSchemaPath,
    expect: [{ kind: 'schema', path: checkSchemaPath }],
    attempts: { max: 2, escalation: [{ includeFailure: true }] },
  };
}

/** Ход участника или автора: встроенная схема ответа и схема проверки хода. */
export function discussTurn(
  step: DiscussStep,
  participant: ReviewParticipant,
  schema: Parameters<typeof schemaPathOf>[0],
  prompt: string,
  checkSchemaPath: string,
  carriesContext = true,
): AgentStep {
  return turn(step, participant, prompt, schemaPathOf(schema), checkSchemaPath, carriesContext);
}

/** Агрегатор: схема итога с полями движка, `expect` и попытки — шага. */
export function aggregateCall(step: DiscussStep, prompt: string, mergedSchemaPath: string, checkSchemaPath: string): AgentStep {
  const aggregator = step.aggregator ?? { id: AGGREGATOR_ID, agent: '' };
  return {
    ...participantStep(step, aggregator),
    prompt,
    outputSchemaPath: mergedSchemaPath,
    expect: [{ kind: 'schema', path: checkSchemaPath }, ...step.expect],
    attempts: step.attempts,
  };
}
