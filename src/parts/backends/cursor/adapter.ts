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
 * Адаптер Cursor Agent CLI (`cursor-agent -p`).
 *
 * Плагин пакета, а не встроенный вклад: берёт только публичную поверхность
 * `burnex/plugin` и `burnex/pipeline` — это стерегут
 * `test/plugin-surface.test.ts` и правило линта. Флаги и форма потока взяты
 * из документации Cursor CLI, а не сверены с установленной версией (CLI в
 * среде не было): `test/fixtures/cursor/README.md`. Документ изменения —
 * `openspec/changes/backend-cursor-adapter/design.md`.
 *
 * Идентификатор сессии выдаёт сам CLI записью `system`/`init`, поэтому
 * `sessionIdSource: 'backend'`; продолжение — флагом `--resume <id>`.
 */

/** Словарь `--sandbox` CLI — и ровно он принимается в `permissions.mode`. */
export const SANDBOX_MODES = ['enabled', 'disabled'] as const;

export function createCursorAdapter(config: BackendConfig): BackendAdapter {
  return {
    name: 'cursor-agent',
    capabilities: {
      sessions: config.sessions,
      sessionIdSource: 'backend',
      // Ничего из этого CLI не умеет: объявление выключенным — не скромность, а
      // условие, при котором предстартовые проверки движка отклоняют шаги,
      // просящие недоступное. Флаги конфигурации (`mcp`, `structured_output`,
      // `strict_permissions`) здесь намеренно не читаются: включить ими
      // возможность, которой у CLI нет, значило бы обещать её молча.
      structuredOutput: false,
      strictPermissions: false,
      mcp: false,
      effort: false,
      // Поток цену не несёт; токены — только если запись `result` их назовёт.
      reportsCost: false,
    },

    launch(invocation: AgentInvocation): LaunchSpec {
      const command: string[] = [
        config.command,
        '-p',
        '--output-format',
        'stream-json',
        // В режиме `-p` без `--force` CLI правки только предлагает, и шаг
        // «реализуй» ничего бы не сделал. Граница доступа — песочница и
        // рабочее дерево шага (design.md, решение 4).
        '--force',
      ];

      const model = invocation.model ?? config.defaultModel;
      if (model !== undefined) command.push('--model', model);

      if (invocation.resumeSession && invocation.sessionId !== undefined && config.sessions) {
        command.push('--resume', invocation.sessionId);
      }

      const sandbox = sandboxMode(effectivePermissions(invocation.permissions, config.permissions));
      if (sandbox !== undefined) command.push('--sandbox', sandbox);

      // `--approve-mcps` не передаётся никогда: MCP у адаптера выключен, и
      // подтверждать серверы, подгруженные CLI из `.cursor/mcp.json`, он не
      // должен. Схема вывода, effort и MCP-серверы шага тоже не переводятся:
      // их отсекают предстартовые проверки и `agentStep`.

      // Промпт — последний позиционный аргумент: документация показывает
      // только эту форму, чтение со stdin в ней не обещано (README фикстур).
      // Цена — предел длины аргументов ОС. Перед промптом — `--`, конец
      // флагов: промпт, начатый с `-` (markdown-список, «--help» в тексте),
      // иначе разбирался бы как флаг. Сам `--` CLI на Node с разбором в духе
      // commander понимает по умолчанию; живой версией это не сверено (README).
      command.push('--', invocation.prompt);
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

      switch (record.type) {
        case 'system':
          if (record.subtype !== 'init') return { kind: 'ignored' };
          return {
            kind: 'init',
            data: record,
            ...(typeof record.session_id === 'string' ? { sessionId: record.session_id } : {}),
          };
        case 'assistant': {
          const text = assistantText(record.message);
          return text === undefined ? { kind: 'ignored' } : { kind: 'result', text };
        }
        case 'tool_call':
          // Событие отдаётся на `completed`, не на `started`: один вызов несёт
          // обе записи с общим `call_id`, и двойной учёт дал бы лишний
          // `tool_use`.
          return record.subtype === 'completed' ? completedToolCall(record.tool_call) : { kind: 'ignored' };
        case 'result':
          return finalResult(record);
        default:
          // `user`, `thinking` и незнакомые записи будущих версий: пропуск, а
          // не отказ — контракт `parseLine`.
          return { kind: 'ignored' };
      }
    },
  };
}

/**
 * `permissions.mode` → значение `--sandbox`. Пооперационных списков у CLI в
 * командной строке нет, а временного исключения «принять и не применять», как у
 * Codex, `cursor-agent` не получает: переносимый pipeline, объявивший
 * `allow`/`deny`, молча остался бы без границы, которую обещал.
 */
function sandboxMode(permissions: AgentInvocation['permissions']): string | undefined {
  if (permissions === undefined) return undefined;

  if (permissions.enforce === 'strict') {
    throw new BurnexError('Бэкенд cursor-agent не умеет применять enforce: strict', {
      hint: 'Снимите enforce: strict либо переведите шаг на бэкенд, объявляющий эту возможность',
    });
  }
  for (const key of ['allow', 'deny'] as const) {
    if ((permissions[key] ?? []).length === 0) continue;
    throw new BurnexError(`Бэкенд cursor-agent не применяет permissions.${key}`, {
      hint: `У cursor-agent есть только permissions.mode (${SANDBOX_MODES.join(', ')}); снимите ${key}`,
    });
  }
  if (permissions.mode === undefined) return undefined;
  if (!(SANDBOX_MODES as readonly string[]).includes(permissions.mode)) {
    throw new BurnexError(`Бэкенд cursor-agent не знает режима доступа ${permissions.mode}`, {
      hint: `Допустимые значения permissions.mode для cursor-agent: ${SANDBOX_MODES.join(', ')}`,
    });
  }
  return permissions.mode;
}

/** Текст сообщения — склейка текстовых частей; сообщение без текста событием не считается. */
function assistantText(message: unknown): string | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  const parts = message.content.flatMap((part): string[] =>
    isRecord(part) && typeof part.text === 'string' ? [part.text] : [],
  );
  return parts.length === 0 ? undefined : parts.join('');
}

/**
 * Завершённый вызов: ключ вида (`shellToolCall`, `readToolCall`, …) даёт имя,
 * его `args` — вход. Результат вызова — не вход и раздувал бы `step.json`.
 */
function completedToolCall(raw: unknown): BackendEvent {
  if (!isRecord(raw)) return { kind: 'ignored' };
  const kind = Object.keys(raw)[0];
  if (kind === undefined) return { kind: 'ignored' };

  const body = raw[kind];
  const name = kind.endsWith('ToolCall') && kind.length > 'ToolCall'.length ? kind.slice(0, -'ToolCall'.length) : kind;
  if (!isRecord(body)) return { kind: 'tool_use', name, input: undefined };
  return { kind: 'tool_use', name, input: body.args };
}

function finalResult(record: Record<string, unknown>): BackendEvent {
  const text = typeof record.result === 'string' ? record.result : undefined;
  if (record.is_error === true) {
    const refusal = readRefusal(text ?? '');
    return {
      kind: 'result',
      ...(text === undefined ? {} : { text }),
      failed: true,
      ...(refusal === undefined ? {} : { refusal }),
    };
  }
  const usage = readUsage(record.usage);
  return {
    kind: 'result',
    ...(text === undefined ? {} : { text }),
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Класс отказа — по закрытому перечню формулировок: кода статуса поток не
 * несёт, а расширять перечень по весу равно смене кодов возврата.
 */
function readRefusal(message: string): BackendRefusal | undefined {
  const refusalClass = classifyRefusal(message);
  return refusalClass === undefined ? undefined : { class: refusalClass, message };
}

function classifyRefusal(text: string): BackendRefusalClass | undefined {
  if (/rate limit|usage limit/i.test(text)) return 'rate_limit';
  if (/unauthorized|not logged in|authentication/i.test(text)) return 'unauthenticated';
  return undefined;
}

/**
 * Расход — только то, что запись назвала, нулями ничего не добивается.
 * Документация поля не обещает, поэтому принимаются обе известные формы имён:
 * у Anthropic `input_tokens` не включает кеш, у OpenAI — включает, и движок
 * иначе посчитал бы кеш дважды.
 */
function readUsage(raw: unknown): Partial<Usage> | undefined {
  if (!isRecord(raw)) return undefined;
  const num = (key: string): number | undefined =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? (raw[key] as number) : undefined;

  const input = num('input_tokens');
  const output = num('output_tokens');
  const written = num('cache_creation_input_tokens') ?? num('cache_write_input_tokens');
  const anthropicRead = num('cache_read_input_tokens');
  const openAiCached = anthropicRead === undefined ? num('cached_input_tokens') : undefined;
  const read = anthropicRead ?? openAiCached;

  const usage: Partial<Usage> = {
    ...(input === undefined ? {} : { tokens_in: Math.max(0, input - (openAiCached ?? 0)) }),
    ...(output === undefined ? {} : { tokens_out: output }),
    ...(read === undefined ? {} : { cache_read: read }),
    ...(written === undefined ? {} : { cache_write: written }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
