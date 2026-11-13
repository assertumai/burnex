## Why

Шаг `review:` ждёт от каждого участника JSON по схеме: ревьюер — находки
(`review-findings.schema.json`), защитник — ход защиты
(`review-defense.schema.json`), ревьюер в ветке — возражение
(`review-rebuttal.schema.json`), агрегатор — `output_schema` шага. Схему
передаёт CLI только адаптер с `structuredOutput`: Claude (`--json-schema`) и
Codex (`--output-schema`). Cursor и Copilot объявляют `structuredOutput: false`,
и в ролях ревью они непригодны, а Google Antigravity CLI адаптера в burnex нет
вовсе.

По документации на 2026-11:

- **Cursor CLI** (`cursor.com/docs/cli/reference/parameters`,
  `…/output-format`) флага схемы не имеет, поля структурного результата в
  `json`/`stream-json` нет; но итоговая запись `result` несёт поле `result` —
  «полный текст ответа ассистента».
- **Antigravity CLI** (`agy`, `antigravity.google/docs/cli/reference`,
  `…/cli/headless`) в print-режиме принимает `--json-schema <строка|путь>`, а
  итоговая запись `stream-json` несёт `structured_output`.
- **GitHub Copilot CLI** (`docs.github.com/…/cli-command-reference`,
  `…/acp-server`, `github/copilot-sdk`) схемы не принимает ни флагом, ни через
  ACP `session/new`, ни в SDK; `-s` отдаёт простой текст ответа.

Кроме того, выбор защитника режима `defend` форкает сессию имплементатора,
не спрашивая, умеет ли его бэкенд схему: на бэкенде без неё каждый ход
защитника оказывался бы невалидным уже после траты токенов.

## What Changes

- **Движковая схема по итоговому тексту.** Новая необязательная возможность
  адаптера `schemaFromText`: бэкенд надёжно отдаёт итоговый текст ответа, и
  схему за него держит движок. Если вызов несёт схему (`output_schema`, схема
  участника `review`, схема хода защиты, вердикт судьи), а адаптер не
  объявляет нативный `structuredOutput`, но объявляет `schemaFromText`, движок
  дописывает схему в промпт, схему адаптеру не передаёт, берёт из итогового
  текста последний JSON-блок и проверяет его той же схемой. Невалидный ответ —
  провал попытки предикатом `output_schema` с текстом ошибки, то есть тот же
  повтор с ошибкой схемы, что у нативной схемы. Нативная схема главнее
  движковой.
- **Проверки до старта.** Предстартовые проверки прогона и `burnex lint`
  принимают шаг со схемой и судью, если у бэкенда есть хотя бы один из путей,
  и отклоняют, если нет ни одного. Участники шага `review` уже проверялись как
  агентские шаги — теперь та же проверка различает пути.
- **Выбор защитника.** Форк сессии имплементатора — только если адаптер его
  агента объявляет какую-либо схему; иначе свежий агент с новой причиной
  `no_schema` в `defense.ndjson` и событиях.
- **Cursor** объявляет `schemaFromText: true` (нативного `structuredOutput`
  по-прежнему нет).
- **Copilot** объявляет `schemaFromText: true`: итоговый текст собирается
  движком из строк `-s`.
- **Antigravity** — новый плагин `burnex/backends/antigravity`, бэкенд
  `antigravity` (`agy`): print-режим `stream-json`, модель, effort, нативная
  `--json-schema` (из `structured_output` конфигурации) и `schemaFromText`,
  продолжение `--conversation <id>`, идентификатор из записи `init`, разбор
  инструментов, итога, расхода и отказов. Форка нет (в CLI он только
  интерактивной командой `/fork`), MCP и жёсткого режима нет. CLI в среде не
  установлен: адаптер проверен на фикстурах по документации, вживую — нет.

## Capabilities

### New Capabilities

- `antigravity-backend`: адаптер Antigravity CLI.

### Modified Capabilities

- `agent-backend`: возможность `schemaFromText`, движковая проверка схемы,
  проверки до старта и судья с любым из путей.
- `review-strategy`: участник `review` требует схемы до старта; выбор
  защитника учитывает схему бэкенда имплементатора.
- `cursor-backend`: Cursor объявляет `schemaFromText`.
- `copilot-backend`: Copilot объявляет `schemaFromText`. Спека этого бэкенда
  ещё не архивирована (`backend-copilot-adapter`); её сценарий «Схема вывода,
  MCP, жёсткий режим, судья» сужен там же до MCP и жёсткого режима.

## Impact

- `src/parts/pipeline/backend/types.ts`, новый `backend/textSchema.ts`;
  `run/exec/agentStep.ts`, `run/exec/judgePass.ts`, `run/runner.ts`
  (предстарт, выбор защитника), `domain/lint.ts`, `steps/review/defend.ts`,
  схема журнала (`no_schema`), UI ленты ревью.
- `src/parts/backends/cursor`, `copilot`; новый `src/parts/backends/antigravity`,
  `bundled.ts`, `package.json` (`exports`), `eslint.config.js`,
  `test/plugin-surface.test.ts`.
- `docs/` — разделы бэкендов и review.
