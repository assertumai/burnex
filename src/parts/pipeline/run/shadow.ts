import { BurnexError } from '../../../kernel/errors.js';
import type { AgentStep, Pipeline, RunStep, ScriptStep } from '../document/model.js';
import type { RunJournal } from './journal/writer.js';

/**
 * Shadow-режим прогона (`shadow-run-mode`): шаги, объявленные внешними,
 * не исполняются — вместо этого журнал получает запись того, что было бы
 * сделано. Режим перехватывает объявленное, а не изолирует: `external: false`
 * — утверждение автора, и движок его не проверяет (design.md, решение 1).
 */

/** Адрес шага в сообщениях и ключах — `<работа>.<шаг>`. */
function stepAddress(jobId: string, stepId: string): string {
  return `${jobId}.${stepId}`;
}

/**
 * Проверка объявлений до старта: в shadow-режиме отсутствие `external` у шага
 * встроенного вида — отказ, а не умолчание `false` (design.md, решение 1).
 * Все недостающие шаги собираются в одну ошибку, чтобы автор исправил их за
 * один заход. Плагинные шаги (и встроенный `decision`) не называются: их
 * признак объявляет контракт вида, а не документ.
 */
export function assertShadowDeclarations(pipeline: Pick<Pipeline, 'jobs'>): void {
  const undeclared = stepsMissingExternal(pipeline);
  if (undeclared.length === 0) return;
  throw new BurnexError(
    `Shadow-режим требует объявить external у каждого шага agent, run, script и uses; не объявлено: ${undeclared.join(', ')}`,
    {
      hint: 'Поставьте external: true шагу, который действует вовне рабочего дерева, и external: false — локальному',
    },
  );
}

/**
 * Адреса шагов встроенных видов без `external`. Без броска: витрина показывает
 * тот же перечень заранее, а CLI превращает его в отказ.
 */
export function stepsMissingExternal(pipeline: Pick<Pipeline, 'jobs'>): string[] {
  const undeclared: string[] = [];
  for (const job of pipeline.jobs) {
    for (const step of job.steps) {
      // Шаг `review` действует только чтением (`review-strategies`, design.md,
      // Non-Goals): объявлять ему `external` нечего, как и плагинному виду.
      if (step.kind === 'plugin' || step.kind === 'review') continue;
      if (step.external === undefined) undeclared.push(stepAddress(job.id, step.id));
    }
  }
  return undeclared;
}

/**
 * Записать неисполненное действие: файл `action-<n>.json` в каталоге шага и
 * событие `step.action`. Файл идёт через маскировщик журнала, событие несёт
 * только адрес и путь.
 */
export function recordShadowAction(
  journal: RunJournal,
  target: { readonly job: string; readonly step: string; readonly stepDir: string },
  attempt: number,
  n: number,
  record: unknown,
): void {
  const path = journal.writeActionRecord(target.stepDir, n, record);
  journal.event({ kind: 'step.action', job: target.job, step: target.step, attempt, n, path });
}

/**
 * Первое место в значении, которое JSON не представит без потерь, — путь и
 * причина; `undefined`, если значение представимо целиком. `JSON.stringify`
 * на таком значении либо бросает (BigInt, цикл), либо молча роняет поле
 * (`undefined`, функция, символ) или подменяет его (`NaN` → `null`), и запись
 * действия оказалась бы неполной без всякого сигнала.
 */
export function jsonRepresentationProblem(value: unknown, path: string): string | undefined {
  const seen = new Set<object>();
  const visit = (current: unknown, at: string): string | undefined => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return undefined;
    if (typeof current === 'number') return Number.isFinite(current) ? undefined : `${at}: число ${String(current)}`;
    if (typeof current !== 'object') return `${at}: значение типа ${typeof current}`;
    const proto: unknown = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && proto !== Object.prototype && proto !== null) {
      return `${at}: объект ${(current as { constructor?: { name?: string } }).constructor?.name ?? 'без конструктора'}`;
    }
    if (seen.has(current)) return `${at}: циклическая ссылка`;
    seen.add(current);
    const entries: [string, unknown][] = Array.isArray(current)
      ? current.map((item, index) => [`${at}[${index}]`, item])
      : Object.entries(current).map(([key, item]) => [`${at}.${key}`, item]);
    for (const [itemAt, item] of entries) {
      const problem = visit(item, itemAt);
      if (problem !== undefined) return problem;
    }
    seen.delete(current);
    return undefined;
  };
  return visit(value, path);
}

/** Что известно о запуске шага помимо самого шага: рабочий каталог, окружение, секреты. */
export interface ShadowActionContext {
  readonly cwd: string;
  /**
   * Имена переменных объявленного `env:` шага — пайплайна с переопределениями,
   * работы и шага, — но не всего окружения процесса: иначе в запись ушли бы
   * имена переменных оператора (design.md, решение 5). Значения в запись не
   * попадают никогда.
   */
  readonly envNames: readonly string[];
  /** Имена секретов, названных шагом. */
  readonly secrets: readonly string[];
}

/** Запись неисполненного шага встроенного вида (`action-<n>.json`). */
export function describeBuiltinAction(
  step: AgentStep | RunStep | ScriptStep,
  context: ShadowActionContext,
): Record<string, unknown> {
  const common = {
    kind: step.kind,
    cwd: context.cwd,
    env_names: [...context.envNames].sort(),
    secrets: [...context.secrets],
  };
  switch (step.kind) {
    case 'run':
      return {
        ...common,
        command: step.command,
        ...(typeof step.command === 'string' && step.shell !== undefined ? { shell: [...step.shell] } : {}),
      };
    case 'script':
      return {
        ...common,
        path: step.resolved?.absolutePath ?? step.path,
        argv: step.resolved === undefined ? [step.path, ...step.args] : [...step.resolved.argv],
        input: step.input ?? {},
        ...(step.uses === undefined ? {} : { uses: step.uses.name }),
      };
    case 'agent':
      return {
        ...common,
        agent: step.agent,
        ...(step.model === undefined ? {} : { model: step.model }),
        session: step.session,
        prompt: step.prompt,
      };
  }
}
