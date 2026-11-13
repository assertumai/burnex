import { packagedSchemaPath } from '../../domain/package-schema.js';
import { AGGREGATOR_ID, AUTHOR_ID, DEFENDER_ID, type AgentStep, type DiscussStep, type PanelStep, type ReviewParticipant, type ReviewStep, type Step } from '../../document/model.js';

/**
 * Участники шага `review` как агентские шаги (`review-strategies`, design.md,
 * решения 3 и 4). Исполнение, предстартовые проверки и линт видят ревьюера и
 * агрегатора тем же `AgentStep`, что и обычный агентский шаг: бэкенд, модель,
 * effort, права и схема выхода проверяются и запускаются одним кодом, а не
 * копией для нового вида.
 */

/** Встроенная схема находок ревьюера (`schema/review-findings.schema.json`). */
export function reviewFindingsSchemaPath(): string {
  return packagedSchemaPath('review-findings');
}

/** Псевдоним сессии участника: `<шаг>/<участник>` — сессии живут только внутри шага. */
export function participantSession(step: { readonly id: string }, participantId: string): string {
  return `${step.id}/${participantId}`;
}

const FINDINGS_INSTRUCTION = [
  '## Форма ответа',
  '',
  'Ты — один из независимых ревьюеров. Отдай находки структурой по схеме находок:',
  '`summary` — короткий итог ревью, `findings` — список находок',
  '`{ severity, title, location, detail, suggestion }`, где `severity` — critical, major, minor или info,',
  'а `location` и `suggestion` — null, если указать нечего. Пустой список — тоже ответ.',
  'Файлы не правь: шаг review — про чтение.',
].join('\n');

/** Задание ревьюера: задача шага, затем его `focus`. */
export function reviewerTask(step: ReviewStep, reviewer: ReviewParticipant): string {
  return [step.prompt, reviewer.focus === undefined ? undefined : `## Твой фокус ревью\n\n${reviewer.focus}`]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('\n\n');
}

/** Промпт ревьюера: его задание, затем требование схемы находок. */
export function reviewerPrompt(step: ReviewStep, reviewer: ReviewParticipant): string {
  return [reviewerTask(step, reviewer), FINDINGS_INSTRUCTION].filter((part) => part !== '').join('\n\n');
}

/** Находки ревьюера либо причина, по которой их нет. */
export type ReviewerFindings =
  | { readonly id: string; readonly focus?: string; readonly findings: unknown }
  | { readonly id: string; readonly focus?: string; readonly failure: string };

/**
 * Промпт агрегатора: задача шага, находки каждого ревьюера с его `id` и
 * `focus` (либо отметка, что находок нет, и причина), дополнение стратегии и
 * роль. Форму итога задаёт `output_schema` шага.
 */
export function aggregatorPrompt(step: ReviewStep, findings: readonly ReviewerFindings[]): string {
  const blocks = findings.map((entry) => {
    const focus = entry.focus === undefined ? '' : `\n\nФокус: ${entry.focus}`;
    if ('failure' in entry) return `### Ревьюер \`${entry.id}\` не дал находок: ${entry.failure}${focus}`;
    return `### Ревьюер \`${entry.id}\`${focus}\n\n\`\`\`json\n${JSON.stringify(entry.findings, null, 2)}\n\`\`\``;
  });
  return [
    step.prompt,
    `## Находки ревьюеров\n\n${blocks.join('\n\n')}`,
    step.aggregator?.prompt === undefined ? undefined : `## Указания стратегии\n\n${step.aggregator.prompt}`,
    [
      '## Твоя роль',
      '',
      'Ты — агрегатор ревью. Сведи находки ревьюеров: объедини повторы, отбрось необоснованное,',
      'взвесь серьёзность и вынеси итог строго по схеме выхода шага. Файлы не правь.',
    ].join('\n'),
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('\n\n');
}

/**
 * Общая часть вызова участника многоагентного шага (`review`, `discuss`):
 * бэкенд, модель, сессия, права, контекст шага и профиля.
 */
export function participantStep(step: PanelStep, participant: ReviewParticipant): Omit<AgentStep, 'prompt' | 'outputSchemaPath' | 'expect' | 'attempts'> {
  return {
    id: step.id,
    index: step.index,
    env: step.env,
    context: step.context,
    contextInherit: step.contextInherit,
    contextExclude: step.contextExclude,
    ...(step.contextMaxTokens === undefined ? {} : { contextMaxTokens: step.contextMaxTokens }),
    timeoutMs: step.timeoutMs,
    kind: 'agent',
    agent: participant.agent,
    ...(participant.model === undefined ? {} : { model: participant.model }),
    ...(participant.effort === undefined ? {} : { effort: participant.effort }),
    session: participantSession(step, participant.id),
    ...(step.permissions === undefined ? {} : { permissions: step.permissions }),
    ...(participant.profile === undefined ? {} : { profile: participant.profile }),
    ...(participant.profileContext === undefined ? {} : { profileContext: participant.profileContext }),
    ...(participant.profileContextFingerprint === undefined
      ? {}
      : { profileContextFingerprint: participant.profileContextFingerprint }),
  };
}

/**
 * Ревьюер как агентский шаг: находки проверяются встроенной схемой, и
 * невалидные дают один повтор с ошибкой схемы (design.md, решение 5).
 */
export function reviewerAgentStep(step: ReviewStep, reviewer: ReviewParticipant): AgentStep {
  const schema = reviewFindingsSchemaPath();
  return {
    ...participantStep(step, reviewer),
    prompt: reviewerPrompt(step, reviewer),
    outputSchemaPath: schema,
    expect: [{ kind: 'schema', path: schema }],
    attempts: { max: 2, escalation: [{ includeFailure: true }] },
  };
}

/**
 * Агрегатор как агентский шаг: `expect`, попытки и `output_schema` — шага,
 * промпт собирается из находок. Без промпта — заготовка для проверок до
 * исполнения, которым промпт не нужен.
 */
export function aggregatorAgentStep(step: ReviewStep, prompt = step.prompt): AgentStep {
  const aggregator = step.aggregator ?? { id: AGGREGATOR_ID, agent: '' };
  return {
    ...participantStep(step, aggregator),
    prompt,
    outputSchemaPath: step.outputSchemaPath,
    expect: step.expect,
    attempts: step.attempts,
  };
}

/**
 * Заготовка вызова свежего защитника для проверок до исполнения: его агент,
 * права шага и встроенная схема хода. Настоящие ходы ветки собирает
 * исполнение (`steps/review/defend.ts`).
 */
function freshDefenderAgentStep(step: ReviewStep, defender: ReviewParticipant): AgentStep {
  const schema = packagedSchemaPath('review-defense');
  return {
    ...participantStep(step, defender),
    prompt: step.prompt,
    outputSchemaPath: schema,
    expect: [{ kind: 'schema', path: schema }],
    attempts: { max: 2, escalation: [{ includeFailure: true }] },
  };
}

/**
 * Вызовы шага `discuss` для проверок до исполнения: участники (ход
 * предложения), автор (ход черновика) и агрегатор (итог по схеме шага).
 * Настоящие ходы собирает исполнение (`steps/discuss/discuss.ts`).
 */
function discussCallsOf(step: DiscussStep): readonly ParticipantCall[] {
  if (step.author === undefined || step.aggregator === undefined) return [];
  const call = (participant: ReviewParticipant, schema: string, outputSchemaPath = packagedSchemaPath(schema)): AgentStep => ({
    ...participantStep(step, participant),
    prompt: step.prompt,
    outputSchemaPath,
    expect: [{ kind: 'schema', path: outputSchemaPath }],
    attempts: { max: 2, escalation: [{ includeFailure: true }] },
  });
  return [
    ...step.participants.map((participant) => ({ id: participant.id, call: call(participant, 'discuss-proposal') })),
    { id: AUTHOR_ID, call: call(step.author, 'discuss-draft') },
    { id: AGGREGATOR_ID, call: { ...call(step.aggregator, 'discuss-draft', step.outputSchemaPath), expect: step.expect, attempts: step.attempts } },
  ];
}

/** Участник по `id`: ревьюер, `aggregator`, `defender` либо участник и `author` шага `discuss`. */
export interface ParticipantCall {
  readonly id: string;
  readonly call: AgentStep;
}

/**
 * Агентские вызовы шага: сам шаг `agent`, участники шага `review` (ревьюеры,
 * затем агрегатор, затем свежий защитник режима `defend`), у остальных видов
 * — ни одного. Шаг `review` без разрешённой стратегии вызовов не имеет: он
 * отказывает до исполнения.
 *
 * Свежий защитник входит всегда, хотя при форке исполняется агент
 * имплементатора (`review-defend`, решение 3): форк или свежий — решает
 * исполнение, а проверить до него бэкенд свежего обязаны и предстарт, и линт.
 * Сам форк — агентский шаг имплементатора, его бэкенд проверен им.
 */
export function agentCallsOf(step: Step): readonly ParticipantCall[] {
  if (step.kind === 'agent') return [{ id: step.id, call: step }];
  if (step.kind === 'discuss') return discussCallsOf(step);
  if (step.kind !== 'review' || step.aggregator === undefined) return [];
  return [
    ...step.reviewers.map((reviewer) => ({ id: reviewer.id, call: reviewerAgentStep(step, reviewer) })),
    { id: AGGREGATOR_ID, call: aggregatorAgentStep(step) },
    ...(step.mode === 'defend' && step.defender !== undefined
      ? [{ id: DEFENDER_ID, call: freshDefenderAgentStep(step, step.defender) }]
      : []),
  ];
}
