## Why

Кроме встроенного `claude` у stepcast есть только один агентский бэкенд —
плагин Codex (`src/parts/backends/codex/`, изменение `codex-backend-adapter`).
Cursor Agent CLI (`cursor-agent`) — третий распространённый агентский CLI: у
него есть продолжаемые сессии (`--resume <chatId>`), неинтерактивный режим с
потоковым JSON (`-p --output-format stream-json`), песочница команд
(`--sandbox`) и перечень моделей аккаунта (`cursor-agent models`).

Его подключение — ещё и вторая проверка контракта бэкенда-плагина, причём с
другой стороны, чем Codex. Codex умеет почти всё, что умеет Claude. У Cursor
честно нет трёх вещей, которые движок до сих пор у реальных бэкендов не
встречал: передачи MCP-серверов шага, структурированного вывода по схеме и
reasoning effort. На этом выяснилось, что контракт в двух местах держится на
везении:

- `requireEffortSupport` (`src/parts/pipeline/run/runner.ts`) отклоняет прогон
  при любом effort шага, не глядя, откуда он взялся. Пользователь, у которого
  в `~/.stepcast/config.yml` стоит `defaults.effort: high` или tier с effort, не
  смог бы перевести на `cursor-agent` ни одного шага, хотя документ effort не
  просил. Сейчас это не видно только потому, что оба реальных бэкенда
  объявляют `effort: true`.
- Требование «Бэкенд не поддерживает схему вывода → ошибка конфигурации до
  начала прогона» записано в спеке `agent-backend`, но в предстартовых
  проверках агентского шага не исполняется: линт проверяет structured_output
  только у судьи. С Claude и Codex этот пробел не проявлялся — у обоих
  `structuredOutput: true`.

## What Changes

- **Плагин `stepcast/backends/cursor`, бэкенд `cursor-agent`.** Модуль
  `src/parts/backends/cursor/` (`index.ts`, `adapter.ts`, `models.ts`) по
  образцу Codex: подпуть `./backends/cursor` в `exports` у `package.json`,
  подключается ключом `plugins`, `builtinPlugin()` о нём не знает. Импорты —
  только модули публичных подпутей `stepcast/plugin` (`src/plugin/index.ts`)
  и `stepcast/pipeline` (`src/parts/pipeline/surface.ts`), плюс встроенные
  модули Node; граница в `eslint.config.js`
  распространяется на `src/parts/backends/cursor/**`.
- **Запуск.** `cursor-agent -p --output-format stream-json --force`, модель —
  `--model` (модель шага либо `default_model` бэкенда), продолжение сессии —
  `--resume <chatId>`. Промпт уходит через stdin, если установленная версия CLI
  это поддерживает. Иначе он передаётся позиционным аргументом, а ограничение
  длины названо в документации; какой путь выбран, решает проверка `--help` в
  задаче 1.1. Рабочий каталог задаёт движок процессом. `--force` нужен потому,
  что в режиме `-p` без него CLI правки только предлагает: неинтерактивный
  запуск подтверждений не ждёт, как `approval_policy="never"` у Codex.
- **Сессии.** `sessionIdSource: 'backend'`: запись `system`/`init` потока
  несёт `session_id` и превращается в `init` с `sessionId`. Механизм ядра уже
  есть со времени Codex, правки ядра для сессий не нужно.
- **Разбор потока.** `system`/`init` → `init`; `assistant` → `result` с текстом
  (последнее сообщение побеждает, как у движка); `tool_call` с `subtype:
  completed` → `tool_use` с именем вида вызова и аргументами без результата;
  `result` → итоговый `result`, а `is_error: true` даёт `failed: true` и
  классифицированный отказ (закрытый перечень формулировок). Всё прочее
  (`user`, `tool_call` started, незнакомые записи) → `ignored`, нестроковое →
  `unparsed`. Расход читается, только если поток его несёт. Иначе поля
  остаются несообщёнными, а не нулями.
- **Список моделей.** `models` вклада опрашивает `cursor-agent models` и
  разбирает строки вида `<slug> - <название>`. Effort-метаданных у моделей нет,
  `efforts` не заполняется. Неразборный вывод даёт пустой список, догадок нет.
- **Доступ: `permissions.mode` → `--sandbox`.** Словарь режимов —
  ровно значения флага CLI (`enabled`, `disabled`). Иное значение `mode`,
  непустые `allow`/`deny` — `StepcastError` из `launch()` с бэкендом,
  объявлением и словарём. Исключения, сделанного для Codex в линте и
  предстартовой проверке, у `cursor-agent` нет.
- **Возможности объявлены честно:** `mcp: false`, `structured_output: false`,
  `strict_permissions: false`, `effort: false`, `reportsCost: false`. Отсюда
  следует: MCP у шага отклоняется до старта (существующая проверка);
  `enforce: strict` отклоняется (существующая проверка); судья на
  `cursor-agent` отклоняется линтом (существующая проверка).
- **Правка ядра 1: effort различает документ и настройки.**
  `requireEffortSupport` смотрит на `effortOrigins` раскрытого пайплайна:
  effort из документа (слои `step`, `job`, `pipeline`) на бэкенде без
  возможности, как и прежде, отклоняет прогон до старта. Effort из настроек
  (`config`, `pipeline_agents`, `step_agents`, `tier`) не передаётся
  адаптеру, а журнал получает событие `backend.degraded` (`capability:
  'effort'`) с шагом и источником. Само отбрасывание делает движок в
  `agentStep.ts`, не адаптер.
- **Правка ядра 2: `output_schema` агентского шага на бэкенде без
  structured_output отклоняется до старта.** Это исполняет уже записанный
  сценарий «Бэкенд не поддерживает схему вывода» спеки `agent-backend`:
  предстартовая проверка рядом с `requireMcpSupport` и ошибка линта рядом с
  проверкой судьи.
- **Умолчания вклада:** `command: cursor-agent`, `sessions: true`,
  `structured_output: false`, `strict_permissions: false`, `mcp: false`,
  `concurrency: 2`. `default_model` не задаётся, действует умолчание CLI.
- **Тесты адаптера с подменённым CLI.** `test/cursor-adapter.test.ts`:
  сборка запуска, перевод доступа, разбор потока по фикстурам
  `test/fixtures/cursor/*.jsonl` и исполнение шага через исполняемую подмену
  `cursor-agent`, печатающую фикстуру. Фикстуры составлены по документированной
  форме потока, и README фикстур говорит это прямо: CLI в среде изменения не
  установлен.
- **Документация:** `docs/plugins.md` получает раздел «Третий бэкенд: Cursor»
  (что понадобилось, чего хватило, чего не хватило) по образцу раздела о Codex.
  В `docs/config.md` появляются подключение, умолчания, словарь
  `permissions.mode`, поведение effort из настроек и документа, а также
  `CURSOR_API_KEY` под `env_deny`.

## Capabilities

### New Capabilities
- `cursor-backend`: адаптер Cursor Agent CLI плагином пакета. Сюда входят
  сборка запуска, сессии, разбор потока, перечень моделей, перевод песочницы,
  честно выключенные возможности, умолчания вклада и тесты с подменённым CLI.

### Modified Capabilities
- `agent-backend`: требование «Объявление возможностей адаптера» дополняется
  возможностью effort: effort из документа на бэкенде без неё отклоняет
  прогон, effort из настроек отбрасывается с предупреждением
  `backend.degraded`.

## Impact

- Новые файлы: `src/parts/backends/cursor/{index,adapter,models}.ts`,
  `test/cursor-adapter.test.ts`, `test/fixtures/cursor/`.
- `package.json`: подпуть `./backends/cursor`. `eslint.config.js`: граница
  плагинов пакета включает `src/parts/backends/cursor/**`.
- Ядро: `src/parts/pipeline/run/runner.ts` (`requireEffortSupport` по
  источнику, новая предстартовая проверка схемы вывода),
  `src/parts/pipeline/run/exec/agentStep.ts` (effort не передаётся адаптеру
  без возможности), `src/parts/pipeline/domain/lint.ts` (ошибка
  `output_schema` на бэкенде без structured_output). Claude и Codex объявляют
  обе возможности и разницы не видят.
- Документация: `docs/plugins.md`, `docs/config.md`.
- Вне изменения: карточка `cursor-agent` в витрине настроек (экран сейчас
  знает только синтетическую карточку Codex), живая приёмка с настоящим CLI,
  отображение отброшенного effort в `stepcast config --pipeline`.
