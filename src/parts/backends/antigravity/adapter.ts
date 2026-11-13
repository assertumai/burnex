import { BurnexError } from '../../../plugin/index.js';
import { effectivePermissions } from '../../pipeline/surface.js';
import type {
  AgentInvocation,
  BackendAdapter,
  BackendConfig,
  BackendEvent,
  BackendRefusal,
  BackendRefusalClass,
  LaunchSpec,
  Usage,
} from '../../pipeline/surface.js';

/**
 * Адаптер Google Antigravity CLI (`agy --prompt=…`, print-режим).
 *
 * Плагин пакета, а не встроенный вклад: берёт только публичную поверхность
 * `burnex/plugin` и `burnex/pipeline`. Флаги и форма потока взяты из
 * документации (`antigravity.google/docs/cli/reference`, `…/cli/headless`) и
 * не сверены с установленной версией — CLI в среде не было
 * (`test/fixtures/antigravity/README.md`). Документ изменения —
 * `openspec/changes/backend-structured-output/design.md`, решение 7.
 *
 * Идентификатор разговора выдаёт сам CLI записью `init`
 * (`conversation_id`), поэтому `sessionIdSource: 'backend'`; продолжение —
 * флагом `--conversation <id>`. Форка в print-режиме нет (только
 * интерактивная команда `/fork`).
 */

/** Режимы `--mode` CLI — и ровно они принимаются в `permissions.mode`. */
export const AGENT_MODES = ['accept-edits', 'auto', 'plan'] as const;

/** Предел Linux на один аргумент (`MAX_ARG_STRLEN`), как у адаптера Copilot. */
export const MAX_ARG_BYTES = 128 * 1024;
const PROMPT_FLAG = '--prompt=';

export function createAntigravityAdapter(config: BackendConfig): BackendAdapter {
  return {
    name: 'antigravity',
    capabilities: {
      sessions: config.sessions,
      sessionIdSource: 'backend',
      // `--json-schema` print-режима, результат — `structured_output` записи
      // `result`. Флаг конфигурации читается: без живой сверки пользователь
      // может выключить нативный путь, и тогда схему держит движок по тексту.
      structuredOutput: config.structuredOutput,
      schemaFromText: true,
      // Правил доступа из командной строки нет, MCP — только командой `/mcp`.
      strictPermissions: false,
      mcp: false,
      effort: true,
      // В записи `result` только токены, цены поток не несёт.
      reportsCost: false,
    },

    launch(invocation: AgentInvocation): LaunchSpec {
      const command: string[] = [config.command, '--output-format', 'stream-json'];

      const model = invocation.model ?? config.defaultModel;
      if (model !== undefined) command.push('--model', model);
      if (invocation.effort !== undefined) command.push('--effort', invocation.effort);

      if (invocation.outputSchemaPath !== undefined && config.structuredOutput) {
        command.push('--json-schema', invocation.outputSchemaPath);
      }

      if (invocation.resumeSession && invocation.sessionId !== undefined && config.sessions) {
        command.push('--conversation', invocation.sessionId);
      }

      const mode = agentMode(effectivePermissions(invocation.permissions, config.permissions));
      // Без режима — пропуск подтверждений: print-режим иначе мягко отклоняет
      // каждую правку, и шаг «реализуй» ничего бы не сделал. Граница доступа
      // — рабочее дерево шага, как у Cursor `--force` и Copilot `--allow-all`.
      command.push(...(mode === undefined ? ['--dangerously-skip-permissions'] : ['--mode', mode]));

      // Слитная форма `--prompt=`: промпт, начатый с `-`, разборщик флагов
      // принять за флаг не может, а stdin в простой форме документация не
      // обещает. Цена — предел длины одного аргумента; громкий отказ лучше
      // `spawn E2BIG` без имени бэкенда.
      const argument = `${PROMPT_FLAG}${invocation.prompt}`;
      if (Buffer.byteLength(argument, 'utf8') + 1 > MAX_ARG_BYTES) {
        throw new BurnexError(
          `Промпт шага не помещается в аргумент запуска antigravity: предел ${MAX_ARG_BYTES / 1024} KiB вместе с ${PROMPT_FLAG}`,
          { hint: 'Сократите контекст шага (context, выход прошлых работ): antigravity получает промпт аргументом, не через stdin' },
        );
      }
      command.push(argument);
      return { command, stdin: '', env: config.env };
    },

    parseLine(line: string): BackendEvent {
      const trimmed = line.trim();
      if (trimmed === '') return { kind: 'ignored' };

      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        return { kind: 'unparsed', line: trimmed };
      }
      if (!isRecord(record)) return { kind: 'ignored' };

      switch (record.event) {
        case 'init':
          return {
            kind: 'init',
            data: record,
            ...(typeof record.conversation_id === 'string' && record.conversation_id !== ''
              ? { sessionId: record.conversation_id }
              : {}),
          };
        case 'step_update':
          return toolStep(record.step_update);
        case 'result':
          return isRecord(record.result) ? finalResult(record.result) : { kind: 'ignored' };
        default:
          return { kind: 'ignored' };
      }
    },
  };
}

/**
 * `permissions.mode` → `--mode`. Пооперационных правил командной строкой CLI
 * не принимает (только файлом настроек), и молча принять `allow`/`deny`
 * значило бы обещать границу, которой нет.
 */
function agentMode(permissions: AgentInvocation['permissions']): string | undefined {
  if (permissions === undefined) return undefined;

  if (permissions.enforce === 'strict') {
    throw new BurnexError('Бэкенд antigravity не умеет применять enforce: strict', {
      hint: 'Снимите enforce: strict либо переведите шаг на бэкенд, объявляющий эту возможность',
    });
  }
  for (const key of ['allow', 'deny'] as const) {
    if ((permissions[key] ?? []).length === 0) continue;
    throw new BurnexError(`Бэкенд antigravity не применяет permissions.${key}`, {
      hint: `У antigravity есть только permissions.mode (${AGENT_MODES.join(', ')}); снимите ${key}`,
    });
  }
  if (permissions.mode === undefined) return undefined;
  if (!(AGENT_MODES as readonly string[]).includes(permissions.mode)) {
    throw new BurnexError(`Бэкенд antigravity не знает режима доступа ${permissions.mode}`, {
      hint: `Допустимые значения permissions.mode для antigravity: ${AGENT_MODES.join(', ')}`,
    });
  }
  return permissions.mode;
}

/** Завершённый шаг-инструмент; остальные шаги (текст, контрольные точки) — пропуск. */
function toolStep(raw: unknown): BackendEvent {
  if (!isRecord(raw) || raw.step_type !== 'tool' || raw.state !== 'DONE') return { kind: 'ignored' };
  const info = isRecord(raw.tool_info) ? raw.tool_info : {};
  const name = typeof info.name === 'string' ? info.name : typeof raw.tool_name === 'string' ? raw.tool_name : undefined;
  if (name === undefined) return { kind: 'ignored' };
  return { kind: 'tool_use', name, input: info.parameters };
}

/**
 * Итог хода. Расход берётся только отсюда: пошаговый `usage` записей
 * `step_update` при сложении с итогом посчитался бы дважды.
 */
function finalResult(result: Record<string, unknown>): BackendEvent {
  const text = typeof result.response === 'string' ? result.response : undefined;
  const usage = readUsage(result.usage);
  if (result.status !== 'SUCCESS') {
    const message = typeof result.error === 'string' && result.error !== '' ? result.error : String(result.status ?? '');
    const refusal = readRefusal(message);
    return {
      kind: 'result',
      ...(text === undefined || text === '' ? {} : { text }),
      ...(usage === undefined ? {} : { usage }),
      failed: true,
      ...(refusal === undefined ? {} : { refusal }),
    };
  }
  return {
    kind: 'result',
    ...(text === undefined ? {} : { text }),
    ...(result.structured_output === undefined ? {} : { structured: result.structured_output }),
    ...(usage === undefined ? {} : { usage }),
  };
}

/** Класс отказа — по закрытому перечню формулировок: кода статуса запись не несёт. */
function readRefusal(message: string): BackendRefusal | undefined {
  const refusalClass = classifyRefusal(message);
  return refusalClass === undefined ? undefined : { class: refusalClass, message };
}

function classifyRefusal(text: string): BackendRefusalClass | undefined {
  if (/rate limit|quota|limit remaining|resource.?exhausted/i.test(text)) return 'rate_limit';
  if (/authentication required|unauthenticated|not logged in/i.test(text)) return 'unauthenticated';
  return undefined;
}

/**
 * Расход итога. Семантика полей — по Gemini API, живьём не сверена:
 * `input_tokens` включает кешированное чтение (вычитается, чтобы движок не
 * посчитал его дважды), `thinking_tokens` — выход модели сверх `output_tokens`.
 * Нулями ничего не добивается.
 */
function readUsage(raw: unknown): Partial<Usage> | undefined {
  if (!isRecord(raw)) return undefined;
  const num = (key: string): number | undefined =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? (raw[key] as number) : undefined;

  const input = num('input_tokens');
  const output = num('output_tokens');
  const thinking = num('thinking_tokens');
  const read = num('cache_read_tokens');

  const usage: Partial<Usage> = {
    ...(input === undefined ? {} : { tokens_in: Math.max(0, input - (read ?? 0)) }),
    ...(output === undefined && thinking === undefined ? {} : { tokens_out: (output ?? 0) + (thinking ?? 0) }),
    ...(read === undefined ? {} : { cache_read: read }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
