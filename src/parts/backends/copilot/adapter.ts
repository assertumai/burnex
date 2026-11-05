import { StepcastError } from '../../../plugin/index.js';
import { effectivePermissions } from '../../pipeline/surface.js';
import type {
  AgentInvocation,
  BackendAdapter,
  BackendConfig,
  BackendEvent,
  LaunchSpec,
} from '../../pipeline/surface.js';

/**
 * Адаптер GitHub Copilot CLI (`copilot -p … -s`).
 *
 * Плагин пакета, а не встроенный вклад: берёт только публичную поверхность
 * `burnex/plugin` и `burnex/pipeline` — это стерегут
 * `test/plugin-surface.test.ts` и правило линта. Флаги взяты из документации
 * Copilot CLI, а не сверены с установленной версией (CLI в среде не было):
 * `test/fixtures/copilot/README.md`. Документ изменения —
 * `openspec/changes/backend-copilot-adapter/design.md`.
 *
 * С `-s` CLI печатает простой текст ответа — ни записей, ни сессии, ни
 * расхода. Поэтому разбор строки отдаёт только `text`, а возможностей у
 * бэкенда нет.
 */

/**
 * Предел Linux на один аргумент (`MAX_ARG_STRLEN`): за ним `spawn` падает
 * `E2BIG` без имени бэкенда. Считается весь аргумент — префикс `--prompt=`,
 * промпт и завершающий NUL, — иначе промпт у самой границы проходил бы
 * проверку и всё равно ронял запуск.
 */
export const MAX_ARG_BYTES = 128 * 1024;
const PROMPT_FLAG = '--prompt=';

export function createCopilotAdapter(config: BackendConfig): BackendAdapter {
  return {
    name: 'copilot',
    capabilities: {
      // Ничего из этого CLI не умеет: объявление выключенным — не скромность, а
      // условие, при котором предстартовые проверки движка отклоняют шаги,
      // просящие недоступное. Флаги конфигурации (`sessions`, `mcp`,
      // `structured_output`, `strict_permissions`) здесь намеренно не читаются:
      // включить ими возможность, которой у CLI нет, значило бы обещать её молча.
      sessions: false,
      // `'backend'` при выключенных сессиях — намеренно: при `'engine'` движок
      // завёл бы идентификатор сам и записал в `step.json` сессию, которой у
      // CLI нет, а `resume` позже пошёл бы её продолжать.
      sessionIdSource: 'backend',
      structuredOutput: false,
      strictPermissions: false,
      mcp: false,
      effort: false,
      reportsCost: false,
    },

    launch(invocation: AgentInvocation): LaunchSpec {
      refuseUnsupportedPermissions(effectivePermissions(invocation.permissions, config.permissions));

      // `--allow-all`: без него неинтерактивный запуск ждёт подтверждений,
      // которых некому дать. Граница доступа — рабочее дерево шага, а не флаги
      // CLI (design.md, решения 2 и 4). `--no-color` и `-s` оставляют в stdout
      // один текст ответа: очистка от ANSI не нужна.
      const command: string[] = [config.command, '--allow-all', '--no-color', '-s'];

      const model = invocation.model ?? config.defaultModel;
      if (model !== undefined) command.push('--model', model);

      // `--resume`/`--continue` не передаются никогда: `-p` идентификатора не
      // печатает, а `--continue` берёт «последнюю» сессию каталога — при двух
      // одновременных шагах это гонка. Effort, схема и MCP-серверы тоже не
      // переводятся: их отсекают предстартовые проверки и `agentStep`.

      // Слитная форма, а не пара `-p <промпт>`: промпт, начатый с `-`, так
      // разборщик флагов принять за флаг не может. Цена — предел длины одного
      // аргумента; громкий отказ лучше `spawn E2BIG` без имени бэкенда.
      const argument = `${PROMPT_FLAG}${invocation.prompt}`;
      if (Buffer.byteLength(argument, 'utf8') + 1 > MAX_ARG_BYTES) {
        throw new StepcastError(
          `Промпт шага не помещается в аргумент запуска copilot: предел ${MAX_ARG_BYTES / 1024} KiB вместе с ${PROMPT_FLAG}`,
          { hint: 'Сократите контекст шага (context, выход прошлых работ): copilot получает промпт аргументом, не через stdin' },
        );
      }
      command.push(argument);
      return { command, stdin: '', env: config.env };
    },

    parseLine(line: string): BackendEvent {
      // Любая строка stdout — кусок ответа, пустая в том числе: абзацы
      // разделены пустой строкой, и её потеря склеила бы их. Формы, которую
      // можно не распознать, у текста нет, поэтому `unparsed` и `ignored`
      // адаптер не отдаёт. Отказ тоже не классифицируется: до `parseLine`
      // доходит только ответ агента, и совпадение по словам («rate limit»)
      // дало бы ложный `rate_limit`, останавливающий прогон. Отказ CLI
      // завершает процесс ненулевым кодом — попытка проваливается обычным
      // путём, а текст ошибки остаётся в `stderr.log`.
      return { kind: 'text', text: line.replace(/\r$/, '') };
    },
  };
}

/**
 * Любое объявление прав — отказ, а не тихое «всё можно»: запуск идёт с
 * `--allow-all`, режимов песочницы и пооперационных списков в командной строке
 * у CLI нет, а перевод `allow`/`deny` в `--allow-tool`/`--deny-tool` без живой
 * сверки синтаксиса шаблонов обещал бы границу, которой может не быть.
 */
function refuseUnsupportedPermissions(permissions: AgentInvocation['permissions']): void {
  if (permissions === undefined) return;

  if (permissions.enforce === 'strict') {
    throw new StepcastError('Бэкенд copilot не умеет применять enforce: strict', {
      hint: 'Снимите enforce: strict либо переведите шаг на бэкенд, объявляющий эту возможность',
    });
  }
  if (permissions.mode !== undefined) {
    throw new StepcastError(`Бэкенд copilot не применяет permissions.mode (${permissions.mode})`, {
      hint: 'copilot запускается с --allow-all и режимов доступа не знает; снимите mode',
    });
  }
  for (const key of ['allow', 'deny'] as const) {
    if ((permissions[key] ?? []).length === 0) continue;
    throw new StepcastError(`Бэкенд copilot не применяет permissions.${key}`, {
      hint: `copilot запускается с --allow-all; снимите ${key}`,
    });
  }
}
