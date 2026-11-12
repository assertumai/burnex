import { readFileSync } from 'node:fs';

import { packagedSchemaPath } from '../../domain/package-schema.js';
import { DEFENDER_ID, type AgentStep, type ReviewParticipant, type ReviewStep } from '../../document/model.js';
import { participantStep, reviewerTask } from './participants.js';

/**
 * Защита находок имплементатором (`review-defend`): записи `defense.ndjson`,
 * схемы ходов, промпты защитника, ревьюера и агрегатора. Порядок раундов,
 * параллельность веток и журнал — в исполнении шага
 * (`run/exec/reviewDefense.ts`); здесь — то, что от исполнения не зависит и
 * проверяется без бэкенда.
 */

export const SEVERITIES = ['critical', 'major', 'minor', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type DefenderStance = 'accept' | 'dispute' | 'clarify';
export type ReviewerStance = 'maintain' | 'withdraw' | 'revise';
export type FindingStatus = 'accepted' | 'withdrawn' | 'contested';

/** Причина свежего защитника (`review-defend`, решение 3). */
export type FreshReason = 'no_implementer' | 'no_session' | 'no_fork';

/** Первая строка `defense.ndjson`: кто защищает (решение 3). */
export interface DefenderRecord {
  readonly kind: 'defender';
  readonly mode: 'fork' | 'fresh';
  /** `<работа>.<шаг>` имплементатора, если шаг его объявил. */
  readonly implementer?: string;
  readonly agent: string;
  readonly model?: string;
  readonly reason?: FreshReason;
}

/** Находка ревьюера с id `<ревьюер>.<n>` в порядке его выхода (решение 5). */
export interface FindingRecord {
  readonly kind: 'finding';
  readonly id: string;
  readonly by: string;
  readonly severity: Severity;
  readonly title: string;
  readonly location: string | null;
  readonly detail: string;
  readonly suggestion: string | null;
}

export interface DefenseResponse {
  readonly finding: string;
  readonly stance: DefenderStance;
  readonly text: string;
  readonly evidence: string | null;
}

export interface RebuttalResponse {
  readonly finding: string;
  readonly stance: ReviewerStance;
  readonly text: string;
  readonly severity: Severity | null;
}

/**
 * Реплика ветки в форме A2A `Message` (`messageId`, `role`, `parts`) с
 * метаданными движка (решение 7). `thread` — ревьюер ветки, `from` —
 * `defender` либо он сам. Хода нет — `invalid: true` (дважды не прошёл
 * схему) либо `failure` с причиной сбоя вызова; `responses` тогда пусты.
 */
export interface DefenseMessageRecord {
  readonly kind: 'message';
  readonly messageId: string;
  readonly role: 'agent';
  readonly from: string;
  readonly thread: string;
  readonly round: number;
  readonly parts: readonly { readonly kind: 'text'; readonly text: string }[];
  readonly responses: readonly (DefenseResponse | RebuttalResponse)[];
  readonly invalid?: true;
  readonly failure?: string;
}

/** Закрытие находки: пишется в момент закрытия, `contested` — в конце ветки. */
export interface SettledRecord {
  readonly kind: 'settled';
  readonly finding: string;
  readonly status: FindingStatus;
  /** Итоговая серьёзность — с учётом `revise` ревьюера. */
  readonly severity: Severity;
  readonly round: number;
}

export interface DefenseOutcomeRecord {
  readonly kind: 'outcome';
  readonly accepted: number;
  readonly withdrawn: number;
  readonly contested: number;
}

export type DefenseRecord = DefenderRecord | FindingRecord | DefenseMessageRecord | SettledRecord | DefenseOutcomeRecord;

/** Ответ защитника по схеме защиты — то, что вернул бэкенд. */
export interface DefensePayload {
  readonly text: string;
  readonly responses: readonly DefenseResponse[];
}

/** Ответ ревьюера по схеме возражения. */
export interface RebuttalPayload {
  readonly text: string;
  readonly responses: readonly RebuttalResponse[];
}

/** Встроенная схема хода защитника (`schema/review-defense.schema.json`). */
export function reviewDefenseSchemaPath(): string {
  return packagedSchemaPath('review-defense');
}

/** Встроенная схема хода ревьюера (`schema/review-rebuttal.schema.json`). */
export function reviewRebuttalSchemaPath(): string {
  return packagedSchemaPath('review-rebuttal');
}

/**
 * Схема проверки хода: встроенная схема плюс то, что статической схемой не
 * выразить (бэкенды со строгим структурным выходом не принимают условий):
 * ответы покрывают ровно открытые находки ветки — каждая по разу, чужих нет.
 * У ревьюера `revise` требует новую серьёзность. Невалидный ход получает
 * повтор с этой ошибкой, как всякая ошибка схемы (решение 5).
 */
export function turnCheckSchema(kind: 'defense' | 'rebuttal', openIds: readonly string[]): unknown {
  const base = JSON.parse(
    readFileSync(kind === 'defense' ? reviewDefenseSchemaPath() : reviewRebuttalSchemaPath(), 'utf8'),
  ) as { properties: { responses: { items: { properties: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown> } } & Record<string, unknown>;
  const responses = base.properties.responses;
  const items = responses.items;
  return {
    ...base,
    properties: {
      ...base.properties,
      responses: {
        ...responses,
        minItems: openIds.length,
        maxItems: openIds.length,
        items: {
          ...items,
          properties: { ...items.properties, finding: { type: 'string', enum: [...openIds] } },
          ...(kind === 'rebuttal'
            ? {
                if: { properties: { stance: { const: 'revise' } }, required: ['stance'] },
                then: { properties: { severity: { type: 'string', enum: [...SEVERITIES] } } },
              }
            : {}),
        },
        allOf: openIds.map((id) => ({ contains: { properties: { finding: { const: id } }, required: ['finding'] } })),
      },
    },
  };
}

/**
 * Находки ревьюера из его выхода по схеме находок: id `<ревьюер>.<n>` в
 * порядке выхода. Выход, не похожий на схему, находок не даёт — его уже
 * отклонила бы проверка ревьюера.
 */
export function findingsOf(reviewer: string, structured: unknown): readonly FindingRecord[] {
  const list = (structured as { readonly findings?: unknown } | null)?.findings;
  if (!Array.isArray(list)) return [];
  return list.map((raw, index) => {
    const entry = raw as Partial<Record<'severity' | 'title' | 'location' | 'detail' | 'suggestion', unknown>>;
    const severity = (SEVERITIES as readonly unknown[]).includes(entry.severity) ? (entry.severity as Severity) : 'info';
    return {
      kind: 'finding',
      id: `${reviewer}.${index + 1}`,
      by: reviewer,
      severity,
      title: typeof entry.title === 'string' ? entry.title : '',
      location: typeof entry.location === 'string' ? entry.location : null,
      detail: typeof entry.detail === 'string' ? entry.detail : '',
      suggestion: typeof entry.suggestion === 'string' ? entry.suggestion : null,
    };
  });
}

/** Кто защищает — для промпта агрегатора и строки журнала. */
export function describeDefender(record: DefenderRecord): string {
  if (record.mode === 'fork') {
    return `Защитник — форк сессии имплементатора \`${record.implementer ?? ''}\` (${record.agent}${record.model === undefined ? '' : `, ${record.model}`}): он писал этот код.`;
  }
  const why =
    record.reason === 'no_implementer'
      ? 'шаг не назвал имплементатора'
      : record.reason === 'no_session'
        ? `у шага имплементатора \`${record.implementer ?? ''}\` нет записанной сессии`
        : `бэкенд имплементатора \`${record.implementer ?? ''}\` не умеет форк сессии`;
  return `Защитник — свежий агент (${record.agent}${record.model === undefined ? '' : `, ${record.model}`}), не автор кода: ${why}.`;
}

function describeFinding(finding: FindingRecord, severity: Severity = finding.severity): string {
  const lines = [
    `### ${finding.id} — ${severity}${severity === finding.severity ? '' : ` (было ${finding.severity})`}: ${finding.title}`,
    finding.location === null ? undefined : `Место: ${finding.location}`,
    finding.detail === '' ? undefined : finding.detail,
    finding.suggestion === null ? undefined : `Предложение: ${finding.suggestion}`,
  ];
  return lines.filter((line): line is string => line !== undefined).join('\n\n');
}

function isDefense(response: DefenseResponse | RebuttalResponse): response is DefenseResponse {
  return 'evidence' in response;
}

/** Ответ хода по одной находке — строка переписки. */
function describeResponse(from: string, round: number, response: DefenseResponse | RebuttalResponse): string {
  const who = from === DEFENDER_ID ? 'защитник' : `ревьюер \`${from}\``;
  if (isDefense(response)) {
    const evidence = response.evidence === null ? '' : `\n  Доказательство: ${response.evidence}`;
    return `- раунд ${round}, ${who}: **${response.stance}** — ${response.text}${evidence}`;
  }
  const severity = response.stance === 'revise' && response.severity !== null ? ` → ${response.severity}` : '';
  return `- раунд ${round}, ${who}: **${response.stance}${severity}** — ${response.text}`;
}

/** Сорванный ход — строка переписки вместо ответов. */
function describeMissing(message: DefenseMessageRecord): string | undefined {
  const who = message.from === DEFENDER_ID ? 'защитника' : `ревьюера \`${message.from}\``;
  if (message.invalid === true) return `- раунд ${message.round}: ход ${who} дважды не прошёл схему — ответа нет`;
  if (message.failure !== undefined) return `- раунд ${message.round}: ход ${who} сорвался — ${message.failure}`;
  return undefined;
}

/** Переписка ветки по одной находке, в порядке ходов. */
export function findingThread(findingId: string, messages: readonly DefenseMessageRecord[]): readonly string[] {
  return messages.flatMap((message) => {
    const missing = describeMissing(message);
    if (missing !== undefined) return [missing];
    return message.responses.filter((response) => response.finding === findingId).map((response) => describeResponse(message.from, message.round, response));
  });
}

/** Вся переписка ветки, с общим текстом каждого хода, — тем, кто её не помнит. */
function describeThread(findings: readonly FindingRecord[], messages: readonly DefenseMessageRecord[]): string {
  const blocks = messages.map((message) => {
    const missing = describeMissing(message);
    if (missing !== undefined) return missing;
    const who = message.from === DEFENDER_ID ? 'Защитник' : `Ревьюер \`${message.from}\``;
    const text = message.parts.map((part) => part.text).join('\n').trim();
    const responses = message.responses.map((response) => describeResponse(message.from, message.round, response).replace(/^- /, `- ${response.finding}, `));
    return [`#### ${message.messageId} — ${who}, раунд ${message.round}`, text === '' ? undefined : text, responses.join('\n')]
      .filter((part): part is string => part !== undefined && part !== '')
      .join('\n\n');
  });
  return [`### Находки ветки\n\n${findings.map((finding) => describeFinding(finding)).join('\n\n')}`, ...blocks].join('\n\n');
}

const DEFENSE_FORM = [
  '## Форма ответа',
  '',
  'Ответь одним ходом по схеме защиты:',
  '- `text` — общий довод хода;',
  '- `responses` — ровно по одному ответу на каждую открытую находку из этого промпта: `finding` — её id,',
  '  `stance` — `accept` (находка верна), `dispute` (неверна) или `clarify` (верна не так, как сказано),',
  '  `text` — довод, `evidence` — ссылка на код или факт (`файл:строка`, выдержка) либо null.',
  '',
  'Принимай только то, что подтверждается кодом: согласие с неверной находкой уводит в итог лишнюю правку,',
  'а оспаривать верное без доказательства бессмысленно — спорное решит агрегатор по доводам обеих сторон.',
  'Новых находок не заводи: ты не ревьюер. Файлы не правь: шаг review — про чтение.',
].join('\n');

const REBUTTAL_FORM = [
  '## Форма ответа',
  '',
  'Ответь одним ходом по схеме возражения:',
  '- `text` — общий довод хода;',
  '- `responses` — ровно по одному ответу на каждую открытую находку из этого промпта: `finding` — её id,',
  '  `stance` — `maintain` (находка остаётся как есть), `withdraw` (снимаешь её) или `revise` (остаётся с другой',
  '  серьёзностью), `text` — довод, `severity` — новая серьёзность при `revise` (critical, major, minor, info), иначе null.',
  '',
  'Снимай находку, только если довод защитника её действительно опровергает; держись своей области ревью.',
  'Файлы не правь.',
].join('\n');

/** Открытые находки с ответами предыдущего хода ветки по каждой. */
function describeOpen(
  open: readonly FindingRecord[],
  severities: ReadonlyMap<string, Severity>,
  last: DefenseMessageRecord | undefined,
): string {
  return open
    .map((finding) => {
      const answer = last?.responses.find((response) => response.finding === finding.id);
      const head = describeFinding(finding, severities.get(finding.id) ?? finding.severity);
      return answer === undefined || last === undefined ? head : `${head}\n\n${describeResponse(last.from, last.round, answer)}`;
    })
    .join('\n\n');
}

export interface TurnPromptOptions {
  readonly step: ReviewStep;
  readonly reviewer: ReviewParticipant;
  readonly round: number;
  /** Сессия хода возобновляется: прежние ходы ветки уже в ней. */
  readonly resumed: boolean;
  readonly findings: readonly FindingRecord[];
  readonly open: readonly FindingRecord[];
  readonly severities: ReadonlyMap<string, Severity>;
  /** Записанные ходы ветки до этого. */
  readonly messages: readonly DefenseMessageRecord[];
}

export interface DefenderPromptOptions extends TurnPromptOptions {
  readonly mode: 'fork' | 'fresh';
  /** Текстовый выход шага имплементатора — свежему защитнику, если он есть. */
  readonly implementerText?: string;
  readonly implementer?: string;
  /** `defender.prompt` стратегии — дополнение свежему защитнику. */
  readonly guidance?: string;
}

function joinParts(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join('\n\n');
}

/**
 * Промпт хода защитника (`review-defend`, решения 3 и 5). Форк помнит, как
 * писал код, — ему задание не повторяется. Свежий защитник в первом ходе
 * получает задание шага (контекст шага кладёт исполнение) и текстовый выход
 * имплементатора. Возобновлённой сессии со второго раунда уходят только
 * ответы ревьюера; без сессии — каждый раз вся ветка.
 */
export function defenderPrompt(options: DefenderPromptOptions): string {
  const { reviewer, round } = options;
  const focus = reviewer.focus === undefined ? '' : `\n\nФокус ревьюера: ${reviewer.focus}`;
  const intro =
    options.mode === 'fork'
      ? `Ты — автор кода, который сейчас ревьюят. Ревьюер \`${reviewer.id}\` оставил находки; защити решения, где они верны, и признай ошибки, где находка права.${focus}`
      : `Ты защищаешь код на ревью вместо его автора. Ревьюер \`${reviewer.id}\` оставил находки; разберись в коде и ответь на каждую.${focus}`;
  const freshTask = options.mode === 'fresh' && (round === 1 || !options.resumed);
  const last = options.messages.at(-1);
  return joinParts([
    freshTask ? options.step.prompt : undefined,
    freshTask && options.implementerText !== undefined && options.implementerText.trim() !== ''
      ? `## Отчёт имплементатора \`${options.implementer ?? ''}\`\n\n${options.implementerText.trim()}`
      : undefined,
    freshTask && options.guidance !== undefined ? `## Указания стратегии\n\n${options.guidance}` : undefined,
    `## Защита на ревью — раунд ${round}\n\n${intro}`,
    round > 1 && !options.resumed ? `## Ветка защиты\n\n${describeThread(options.findings, options.messages)}` : undefined,
    round === 1
      ? `## Находки\n\n${describeOpen(options.open, options.severities, undefined)}`
      : `## Открытые находки и ответ ревьюера\n\n${describeOpen(options.open, options.severities, last)}`,
    DEFENSE_FORM,
  ]);
}

/**
 * Промпт хода ревьюера. Его сессия — та же `<шаг>/<ревьюер>`, что у
 * независимого ревью: возобновлённой уходят ответы защитника по открытым
 * находкам. Без сессии — его задание и вся ветка.
 */
export function rebuttalPrompt(options: TurnPromptOptions): string {
  const last = options.messages.at(-1);
  return joinParts([
    options.resumed ? undefined : reviewerTask(options.step, options.reviewer),
    `## Защита находок — раунд ${options.round}\n\nТы — ревьюер \`${options.reviewer.id}\`. Имплементатор ответил на твои находки: ответь на каждую открытую.`,
    options.resumed ? undefined : `## Ветка защиты\n\n${describeThread(options.findings, options.messages.slice(0, -1))}`,
    `## Открытые находки и ответ защитника\n\n${describeOpen(options.open, options.severities, last)}`,
    REBUTTAL_FORM,
  ]);
}

/**
 * Ход ветки как агентский шаг: бэкенд получает встроенную схему хода,
 * проверка — схему с открытыми id (`checkSchemaPath`), и невалидный ход
 * получает один повтор с ошибкой. Возобновлённой сессии контекст шага не
 * повторяется; форк его уже видел у имплементатора.
 */
export function turnAgentStep(
  base: Omit<AgentStep, 'prompt' | 'outputSchemaPath' | 'expect' | 'attempts'>,
  kind: 'defense' | 'rebuttal',
  prompt: string,
  checkSchemaPath: string,
  carriesContext: boolean,
): AgentStep {
  return {
    ...base,
    ...(carriesContext ? {} : { context: [] }),
    prompt,
    outputSchemaPath: kind === 'defense' ? reviewDefenseSchemaPath() : reviewRebuttalSchemaPath(),
    expect: [{ kind: 'schema', path: checkSchemaPath }],
    attempts: { max: 2, escalation: [{ includeFailure: true }] },
  };
}

/** Псевдоним сессии защитника ветки: `<шаг>/defender/<ревьюер>` (решение 3). */
export function defenderSession(step: ReviewStep, reviewer: string): string {
  return `${step.id}/${DEFENDER_ID}/${reviewer}`;
}

/**
 * Вызов защитника ветки: агент — форка (агент, модель и effort
 * имплементатора) либо свежего защитника; права — шага `review`, а не
 * имплементатора (решение 3): защитник не правит файлы.
 */
export function defenderCallBase(
  step: ReviewStep,
  defender: ReviewParticipant,
  reviewer: string,
): Omit<AgentStep, 'prompt' | 'outputSchemaPath' | 'expect' | 'attempts'> {
  const base = participantStep(step, defender);
  return { ...base, session: defenderSession(step, reviewer) };
}

/** Итоги находок для промпта агрегатора. */
export interface SettledFinding {
  readonly finding: FindingRecord;
  readonly status: FindingStatus;
  readonly severity: Severity;
}

const STATUS_TEXT: Readonly<Record<FindingStatus, string>> = {
  accepted: 'accepted — защитник принял',
  withdrawn: 'withdrawn — ревьюер снял',
  contested: 'contested — спор не разрешён',
};

/**
 * Промпт агрегатора режима `defend` (решение 6): задача, строка о
 * защитнике, находки каждого ревьюера со статусом, итоговой серьёзностью и
 * перепиской, ревьюеры без находок с причинами, указания стратегии и роль.
 */
export function defendAggregatorPrompt(options: {
  readonly step: ReviewStep;
  readonly defender: DefenderRecord;
  readonly reviewers: readonly {
    readonly id: string;
    readonly focus?: string;
    readonly summary?: string;
    readonly findings: readonly SettledFinding[];
  }[];
  readonly without: readonly { readonly id: string; readonly focus?: string; readonly reason: string }[];
  readonly messages: readonly DefenseMessageRecord[];
}): string {
  const blocks = options.reviewers.map((entry) => {
    const head = joinParts([
      `### Ревьюер \`${entry.id}\``,
      entry.focus === undefined ? undefined : `Фокус: ${entry.focus}`,
      entry.summary === undefined || entry.summary === '' ? undefined : `Итог ревьюера: ${entry.summary}`,
    ]);
    const findings = entry.findings.map(({ finding, status, severity }) => {
      const thread = findingThread(
        finding.id,
        options.messages.filter((message) => message.thread === entry.id),
      );
      return joinParts([
        describeFinding(finding, severity),
        `Статус: ${STATUS_TEXT[status]}`,
        thread.length === 0 ? undefined : `Переписка:\n${thread.join('\n')}`,
      ]);
    });
    return joinParts([head, ...findings]);
  });
  return joinParts([
    options.step.prompt,
    `## Защита находок\n\n${describeDefender(options.defender)}`,
    blocks.length === 0 ? undefined : `## Находки ревьюеров\n\n${blocks.join('\n\n')}`,
    options.without.length === 0
      ? undefined
      : `## Ревьюеры без находок\n\n${options.without
          .map((entry) => `- \`${entry.id}\`${entry.focus === undefined ? '' : ` (фокус: ${entry.focus})`}: ${entry.reason}`)
          .join('\n')}`,
    options.step.aggregator?.prompt === undefined ? undefined : `## Указания стратегии\n\n${options.step.aggregator.prompt}`,
    [
      '## Твоя роль',
      '',
      'Ты — агрегатор ревью. Находки уже прошли защиту у имплементатора:',
      '- `accepted` включи в итог: повторы можно объединить, понизить серьёзность — только с объяснением;',
      '- `withdrawn` не включай;',
      '- `contested` реши сам, взвесив доводы ревьюера и защитника.',
      'Вынеси итог строго по схеме выхода шага. Файлы не правь.',
    ].join('\n'),
  ]);
}
