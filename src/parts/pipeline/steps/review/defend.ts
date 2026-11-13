import { readFileSync } from 'node:fs';

import { packagedSchemaPath } from '../../domain/package-schema.js';
import { DEFENDER_ID, type AgentStep, type ReviewParticipant, type ReviewStep } from '../../document/model.js';
import { participantStep } from './participants.js';

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
export type FreshReason = 'no_implementer' | 'other_tree' | 'no_session' | 'no_fork' | 'no_schema';

/**
 * Почему защищает форк, а не сама сессия имплементатора
 * (`review-defend-shared-session`, решение 1): `reused` — сессия
 * принадлежит исходному прогону, `shared` — её может продолжить кто-то ещё.
 */
export type ForkReason = 'reused' | 'shared';

/** Как защитник связан с имплементатором: сессия на месте, её форк, свежий агент. */
export type DefenderMode = 'resume' | 'fork' | 'fresh';

/** Первая строка `defense.ndjson`: кто защищает (решение 1). */
export interface DefenderRecord {
  readonly kind: 'defender';
  readonly mode: DefenderMode;
  /** `<работа>.<шаг>` имплементатора, если шаг его объявил. */
  readonly implementer?: string;
  readonly agent: string;
  readonly model?: string;
  /** У `fresh` и `fork` — всегда, у `resume` — нет. */
  readonly reason?: FreshReason | ForkReason;
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
 * Реплика защиты в форме A2A `Message` (`messageId`, `role`, `parts`) с
 * метаданными движка (`review-defend-shared-session`, решение 4). `from` —
 * `defender` либо ревьюер. `thread` — только у реплики ревьюера, его id:
 * реплика защитника отвечает всем ревьюерам сразу. В журналах прежнего
 * формата `thread` был и у защитника — ветка, которую он защищал. Хода нет —
 * `invalid: true` (дважды не прошёл схему) либо `failure` с причиной сбоя
 * вызова; `responses` тогда пусты.
 */
export interface DefenseMessageRecord {
  readonly kind: 'message';
  readonly messageId: string;
  readonly role: 'agent';
  readonly from: string;
  readonly thread?: string;
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

/** Агент и модель — подпись участника: «codex · gpt-5». */
function agentLabel(agent: string, model: string | undefined): string {
  return model === undefined ? agent : `${agent} · ${model}`;
}

const FRESH_WHY: Readonly<Record<FreshReason, (implementer: string) => string>> = {
  no_implementer: () => 'шаг не назвал имплементатора',
  other_tree: (implementer) => `шаг имплементатора \`${implementer}\` исполнялся в другом рабочем дереве, и его сессию отсюда не продолжить`,
  no_session: (implementer) => `у шага имплементатора \`${implementer}\` нет сессии, которую можно продолжить`,
  no_fork: (implementer) => `сессию имплементатора \`${implementer}\` нельзя продолжить на месте, а его бэкенд не умеет форк`,
  no_schema: (implementer) => `бэкенд имплементатора \`${implementer}\` не умеет ответ по схеме`,
};

/** Кто защищает — для промпта агрегатора и строки журнала. */
export function describeDefender(record: DefenderRecord): string {
  const who = agentLabel(record.agent, record.model);
  const implementer = record.implementer ?? '';
  if (record.mode === 'resume') {
    return `Защитник — сама сессия имплементатора \`${implementer}\` (${who}): он писал этот код.`;
  }
  if (record.mode === 'fork') {
    const why = record.reason === 'reused' ? 'сессия принадлежит исходному прогону' : 'сессию может продолжить другой шаг';
    return `Защитник — форк сессии имплементатора \`${implementer}\` (${who}; ${why}): он писал этот код.`;
  }
  const why = FRESH_WHY[(record.reason as FreshReason | undefined) ?? 'no_implementer'](implementer);
  return `Защитник — свежий агент (${who}), не автор кода: ${why}.`;
}

/** Подпись защитника в промпте ревьюера. */
function defenderSignature(record: DefenderRecord): string {
  const who = agentLabel(record.agent, record.model);
  if (record.mode === 'resume') return `Защитник — сессия имплементатора \`${record.implementer ?? ''}\` (${who})`;
  if (record.mode === 'fork') return `Защитник — форк сессии имплементатора \`${record.implementer ?? ''}\` (${who})`;
  return `Защитник — свежий агент (${who})`;
}

/** Подпись ревьюера в промпте защитника: id, агент, модель и фокус. */
function reviewerSignature(reviewer: ReviewParticipant): string {
  const focus = reviewer.focus === undefined ? '' : `, фокус: ${reviewer.focus}`;
  return `— Ревьюер \`${reviewer.id}\` (${agentLabel(reviewer.agent, reviewer.model)})${focus}`;
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

/** Переписка по одной находке, в порядке ходов. */
export function findingThread(findingId: string, messages: readonly DefenseMessageRecord[]): readonly string[] {
  return messages.flatMap((message) => {
    const missing = describeMissing(message);
    if (missing !== undefined) return [missing];
    return message.responses.filter((response) => response.finding === findingId).map((response) => describeResponse(message.from, message.round, response));
  });
}

/**
 * Реплики, касающиеся находок `ids`: ходы защитника с ответами только по
 * ним и ходы ревьюеров, которым эти находки принадлежат. Ревьюер видит свою
 * часть переписки, а не чужие споры.
 */
function messagesAbout(ids: ReadonlySet<string>, owners: ReadonlySet<string>, messages: readonly DefenseMessageRecord[]): readonly DefenseMessageRecord[] {
  return messages.flatMap((message) => {
    if (message.from === DEFENDER_ID) return [{ ...message, responses: message.responses.filter((response) => ids.has(response.finding)) }];
    return owners.has(message.from) ? [message] : [];
  });
}

/** Вся переписка с общим текстом каждого хода — тем, кто её не помнит. */
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
  return [`### Находки\n\n${findings.map((finding) => describeFinding(finding)).join('\n\n')}`, ...blocks].join('\n\n');
}

const DEFENSE_FORM = [
  '## Форма ответа',
  '',
  'Ответь одним ходом по схеме защиты:',
  '- `text` — общий довод хода;',
  '- `responses` — ровно по одному ответу на каждую открытую находку всех ревьюеров из этого промпта: `finding` — её id,',
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

/** Открытые находки с ответами предыдущего хода по каждой. */
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

/** Шаг глазами защиты: id для каталогов и сессий, задание для свежих участников. */
export interface DefenseStepView {
  readonly id: string;
  readonly prompt: string;
}

/** Ревьюер в защите: его находки и те, что ещё открыты. */
export interface DefenseSide {
  readonly reviewer: ReviewParticipant;
  readonly findings: readonly FindingRecord[];
  readonly open: readonly FindingRecord[];
}

export interface DefenderPromptOptions {
  readonly step: DefenseStepView;
  readonly round: number;
  /** Сессия защитника возобновляется: прежние ходы защиты уже в ней. */
  readonly resumed: boolean;
  readonly defender: DefenderRecord;
  /** Ревьюеры с открытыми находками, в порядке стратегии. */
  readonly sides: readonly DefenseSide[];
  readonly severities: ReadonlyMap<string, Severity>;
  /** Все записанные реплики защиты до этого хода. */
  readonly messages: readonly DefenseMessageRecord[];
  /** Текстовый выход шага имплементатора — свежему защитнику, если он есть. */
  readonly implementerText?: string;
  /** `defender.prompt` стратегии — дополнение свежему защитнику. */
  readonly guidance?: string;
}

function joinParts(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join('\n\n');
}

/** Последняя реплика ревьюера — его ответы прошлого раунда. */
function lastOf(from: string, messages: readonly DefenseMessageRecord[]): DefenseMessageRecord | undefined {
  return messages.filter((message) => message.from === from).at(-1);
}

/**
 * Промпт хода защитника (`review-defend-shared-session`, решение 3): один ход
 * на открытые находки всех ревьюеров. Сессии имплементатора (`resume`,
 * `fork`) — комментарий ревью к её работе: задание она помнит. Свежий
 * защитник в первом ходе получает задание шага (контекст кладёт исполнение),
 * текстовый выход имплементатора и указания стратегии. Первый раунд несёт
 * находки под подписью ревьюера. Возобновлённой сессии в следующих раундах
 * уходят только ответы ревьюеров — находки она уже видела. Без сессии каждый
 * ход несёт всю переписку.
 */
export function defenderPrompt(options: DefenderPromptOptions): string {
  const { round, defender } = options;
  const author = defender.mode !== 'fresh';
  const first = round === 1 || !options.resumed;
  const freshTask = !author && first;
  const intro = author
    ? round === 1 || !options.resumed
      ? [
          `Ревью вашей работы — шаг ${options.step.id}. Код не правьте: шаг только читает, исправления сделают следующие шаги.`,
          'Если выше в диалоге есть реплики прежнего захода этого ревью, они недействительны.',
          'Защитите решения, где находка неверна, и признайте ошибку, где она права.',
        ].join('\n')
      : 'Ревьюеры ответили на ваши доводы. Ответьте на каждую открытую находку.'
    : round === 1 || !options.resumed
      ? 'Ты защищаешь код на ревью вместо его автора. Разберись в коде и ответь на каждую находку ревьюеров. Файлы не правь.'
      : 'Ревьюеры ответили на твои доводы. Ответь на каждую открытую находку.';
  const open = options.sides.flatMap((side) => side.open.map((finding) => finding.id));
  const blocks = options.sides.map((side) => {
    if (round === 1) return joinParts([reviewerSignature(side.reviewer), describeOpen(side.open, options.severities, undefined)]);
    const last = lastOf(side.reviewer.id, options.messages);
    if (options.resumed) {
      // Находки сессия уже видела: только позиция, довод и серьёзность.
      const answers = side.open.map((finding) => {
        const answer = last?.responses.find((response) => response.finding === finding.id);
        const severity = options.severities.get(finding.id) ?? finding.severity;
        const head = `#### ${finding.id} — ${severity}${severity === finding.severity ? '' : ` (было ${finding.severity})`}`;
        return answer === undefined || last === undefined ? head : `${head}\n${describeResponse(last.from, last.round, answer)}`;
      });
      return joinParts([reviewerSignature(side.reviewer), ...answers]);
    }
    return joinParts([reviewerSignature(side.reviewer), describeOpen(side.open, options.severities, last)]);
  });
  const all = options.sides.flatMap((side) => side.findings);
  return joinParts([
    freshTask ? options.step.prompt : undefined,
    freshTask && options.implementerText !== undefined && options.implementerText.trim() !== ''
      ? `## Отчёт имплементатора \`${defender.implementer ?? ''}\`\n\n${options.implementerText.trim()}`
      : undefined,
    freshTask && options.guidance !== undefined ? `## Указания стратегии\n\n${options.guidance}` : undefined,
    `## Защита на ревью — раунд ${round}\n\n${intro}\n\nОткрытые находки: ${open.join(', ')}`,
    round > 1 && !options.resumed ? `## Переписка защиты\n\n${describeThread(all, options.messages)}` : undefined,
    round === 1 ? `## Находки ревьюеров\n\n${blocks.join('\n\n')}` : `## Ответы ревьюеров\n\n${blocks.join('\n\n')}`,
    DEFENSE_FORM,
  ]);
}

export interface RebuttalPromptOptions {
  /** Задание ревьюера — тому, чья сессия не возобновляется. */
  readonly task: string;
  readonly round: number;
  /** Сессия ревьюера возобновляется: его ревью и прежние ходы уже в ней. */
  readonly resumed: boolean;
  readonly defender: DefenderRecord;
  readonly side: DefenseSide;
  readonly severities: ReadonlyMap<string, Severity>;
  /** Все записанные реплики защиты, включая ход защитника этого раунда. */
  readonly messages: readonly DefenseMessageRecord[];
}

/**
 * Промпт хода ревьюера. Его сессия — та же `<шаг>/<ревьюер>`, что у
 * независимого ревью: возобновлённой уходят ответы защитника по его открытым
 * находкам. Без сессии — его задание и его часть переписки. Ответы защитника
 * по чужим находкам ревьюер не видит.
 */
export function rebuttalPrompt(options: RebuttalPromptOptions): string {
  const { side } = options;
  const ids = new Set(side.findings.map((finding) => finding.id));
  const own = messagesAbout(ids, new Set([side.reviewer.id]), options.messages);
  const last = own.filter((message) => message.from === DEFENDER_ID).at(-1);
  return joinParts([
    options.resumed ? undefined : options.task,
    `## Защита находок — раунд ${options.round}\n\nТы — ревьюер \`${side.reviewer.id}\`. ${defenderSignature(options.defender)} ответил на твои находки: ответь на каждую открытую.`,
    options.resumed ? undefined : `## Переписка защиты\n\n${describeThread(side.findings, own.slice(0, -1))}`,
    `## Открытые находки и ответ защитника\n\n${describeOpen(side.open, options.severities, last)}`,
    REBUTTAL_FORM,
  ]);
}

/**
 * Ход защиты как агентский шаг: бэкенд получает встроенную схему хода,
 * проверка — схему с открытыми id (`checkSchemaPath`), и невалидный ход
 * получает один повтор с ошибкой. Возобновлённой сессии контекст шага не
 * повторяется; сессия имплементатора его уже видела.
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

/**
 * Псевдоним сессии защитника: `<шаг>/defender`, один на шаг
 * (`review-defend-shared-session`, решение 1). В режиме `resume` под ним
 * засеяна сама сессия имплементатора.
 */
export function defenderSession(step: { readonly id: string }): string {
  return `${step.id}/${DEFENDER_ID}`;
}

/**
 * Вызов защитника: агент — имплементатора (агент, модель и effort) либо
 * свежего защитника; права — шага `review`, а не имплементатора: защитник не
 * правит файлы.
 */
export function defenderCallBase(step: ReviewStep, defender: ReviewParticipant): Omit<AgentStep, 'prompt' | 'outputSchemaPath' | 'expect' | 'attempts'> {
  return { ...participantStep(step, defender), session: defenderSession(step) };
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
 * Промпт агрегатора режима `defend`: задача, строка о защитнике, находки
 * каждого ревьюера со статусом, итоговой серьёзностью и перепиской, ревьюеры
 * без находок с причинами, указания стратегии и роль.
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
    const ids = new Set(entry.findings.map(({ finding }) => finding.id));
    const relevant = messagesAbout(ids, new Set([entry.id]), options.messages);
    const findings = entry.findings.map(({ finding, status, severity }) => {
      const thread = findingThread(finding.id, relevant);
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
