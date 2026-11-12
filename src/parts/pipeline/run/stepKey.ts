import { createHash } from 'node:crypto';

import { forStepHash, type Step } from '../document/model.js';
import { normalizePackagePaths, portableForm, type PackagePathForm } from '../document/packagePaths.js';
import { agentCallsOf } from '../steps/review/participants.js';

/**
 * Ключ шага отвечает на один вопрос: остаётся ли прошлый успех шага
 * действительным.
 *
 * Функция чистая и живёт отдельно намеренно. Ключ считают двое: исполнитель —
 * когда пишет запись шага, и планировщик возобновления — когда решает, можно
 * ли шаг переиспользовать. Если бы у них были разные реализации, они рано или
 * поздно разошлись бы, и переиспользование стало бы то ложно-отрицательным
 * (лишняя работа), то ложно-положительным (устаревший результат). Второе
 * гораздо хуже, и заметить его почти невозможно.
 */
export interface StepKeyInput {
  readonly lockHash: string;
  readonly jobId: string;
  readonly step: Step;
  /** Отпечаток входов: якорь дерева, наблюдённые или объявленные пути. */
  readonly inputsFingerprint: string | undefined;
  /** Команда бэкенда: смена CLI меняет результат при том же промпте. */
  readonly backendCommand: string | undefined;
  /**
   * Команды бэкендов участников шага `review` по их `id` (`stepBackendCommands`):
   * у такого шага бэкендов несколько, и смена CLI любого из них меняет итог.
   */
  readonly participantCommands?: Readonly<Record<string, string | null>>;
  /** Выходы работ выше по графу на момент исполнения этого шага. */
  readonly upstream: readonly { readonly job: string; readonly value: unknown }[];
  /**
   * Форма путей поставки в хешируемом шаге. По умолчанию — переносимая
   * (`stepcast-package:<путь>#sha256:<отпечаток>`) от корня пакета движка;
   * `lockHash` обязан быть посчитан в той же форме.
   */
  readonly packagePaths?: PackagePathForm;
}

/**
 * Команды бэкендов вызовов шага для ключа — одна функция для исполнителя и
 * планировщика возобновления: у агентского шага команда его бэкенда, у шага
 * `review` — команды всех участников, у остальных видов — ничего.
 */
export function stepBackendCommands(
  step: Step,
  backends: Readonly<Record<string, { readonly command?: string | undefined }>>,
): Pick<StepKeyInput, 'backendCommand' | 'participantCommands'> {
  if (step.kind === 'agent') return { backendCommand: backends[step.agent]?.command };
  const calls = agentCallsOf(step);
  if (calls.length === 0) return { backendCommand: undefined };
  return {
    backendCommand: undefined,
    participantCommands: Object.fromEntries(calls.map(({ id, call }) => [id, backends[call.agent]?.command ?? null])),
  };
}

/**
 * Составляющая `upstream` для ключа: выходы работ выше по графу.
 *
 * Порядок задаётся здесь, а не тем, как выходы накопились. Исполнитель
 * складывает их в порядке завершения работ, планировщик возобновления — в
 * порядке разбора прогона; разошедшийся порядок даёт разный JSON, то есть
 * разный ключ при неизменном определении и одном и том же составе выходов.
 * Сортировка по идентификатору работы снимает вопрос конструктивно: обе
 * стороны подают одну и ту же последовательность независимо от того, как они
 * до неё дошли.
 */
export function upstreamForKey(
  outputs: readonly { readonly job: string; readonly value: unknown }[],
): readonly { readonly job: string; readonly value: unknown }[] {
  return [...outputs]
    .map((output) => ({ job: output.job, value: output.value }))
    .sort((left, right) => (left.job === right.job ? 0 : left.job < right.job ? -1 : 1));
}

/**
 * Отпечаток скрипта и действующий argv раннера отдельного места в ключе не
 * занимают — они уже часть `step.resolved` (`ScriptStep`), а `step` ниже
 * хешируется целиком. Правка скрипта или `runners.<имя>.command` меняет
 * `resolved.fingerprint`/`resolved.argv` при раскрытии, и один этот факт
 * пробрасывает изменение сквозь `JSON.stringify(step)` — тем же путём, каким
 * ключ агентского шага уже чувствителен к тексту промпта (design.md, решение
 * 8; test/expand.test.ts, `pipeline.lock.yml: шаг script`).
 */
/**
 * Поля шага плагинного вида (`PluginStep.fields`) входят в ключ той же
 * дорогой, что и всё остальное определение шага, — хешированием `step`
 * целиком: правка поля меняет ключ бесплатно, без отдельной ветки здесь.
 * Поведение исполнителя (`StepKindContribution.execute`) в ключ не входит —
 * то же ограничение, что и у плагинного предиката (`evaluate` тоже вне
 * ключа): смена поведения вклада при той же версии не инвалидирует успешный
 * шаг, а версия плагина видна в манифесте прогона (design.md, риски).
 */
/**
 * Пути ресурсов поставки — схема `burnex:<имя>`, обёртка, встроенный скрипт
 * или шаг — входят в ключ по имени и отпечатку содержимого, а не абсолютным
 * путём выпуска (`document/packagePaths.ts`): смена выпуска при неизменной
 * схеме ключ не меняет, правка содержимого схемы — меняет.
 */
export function computeStepKey(input: StepKeyInput): string {
  // Имя профиля — справочное (`agent-profiles`, решение 6): его контекст и
  // отпечаток файлов вне дерева остаются в шаге и входят в ключ, имя — нет.
  // Слой и путь стратегии ревью — тоже (`review-strategies`, решение 7).
  const step = normalizePackagePaths(forStepHash(input.step), input.packagePaths ?? portableForm());

  return createHash('sha256')
    .update(
      JSON.stringify({
        lock: input.lockHash,
        job: input.jobId,
        step,
        inputs: input.inputsFingerprint ?? null,
        backend:
          step.kind === 'agent'
            ? {
                name: step.agent,
                command: input.backendCommand ?? null,
                model: step.model ?? null,
              }
            : input.participantCommands === undefined
              ? null
              : { commands: input.participantCommands },
        upstream: input.upstream.map((output) => ({ job: output.job, value: output.value })),
      }),
    )
    .digest('hex')
    .slice(0, 16);
}
