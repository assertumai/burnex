## ADDED Requirements

### Requirement: Адаптер Antigravity поставляется плагином, а не встроен

Пакет SHALL поставлять адаптер агентского бэкенда `antigravity` модулем, объявляемым ключом `plugins` и доступным подпутём пакета `burnex/backends/antigravity`, и MUST NOT вносить его во встроенные вклады. Модуль MUST пользоваться только публичными подпутями `burnex/plugin` и `burnex/pipeline` и встроенными модулями Node. Витрина поставляемых бэкендов MUST включать его.

#### Scenario: Плагин объявлен

- **WHEN** конфигурация объявляет `plugins: [burnex/backends/antigravity]`
- **THEN** бэкенд `antigravity` существует с умолчаниями `command: agy`, `sessions: true`, `structured_output: true`, `strict_permissions: false`, `mcp: false`, `concurrency: 2`

### Requirement: Перевод запуска Antigravity

Адаптер SHALL собирать запуск print-режима `agy --output-format stream-json` с промптом последним аргументом в слитной форме `--prompt=<промпт>`. Модель шага либо умолчание бэкенда MUST переводиться в `--model`, effort — в `--effort`. Схема вызова при включённом `structured_output` MUST переводиться в `--json-schema <путь>`. Продолжение засеянной сессии MUST собираться флагом `--conversation <идентификатор>`. Без `permissions.mode` запуск MUST нести `--dangerously-skip-permissions`; `permissions.mode` из `accept-edits`, `auto`, `plan` MUST переводиться в `--mode` без пропуска подтверждений; иное значение, `allow`, `deny` и `enforce: strict` MUST отклоняться ошибкой. Промпт длиннее предела одного аргумента MUST отклоняться ошибкой, называющей бэкенд.

#### Scenario: Ревьюер со схемой

- **WHEN** вызов несёт `outputSchemaPath`, модель `gemini-3.1-pro-high` и effort `high`
- **THEN** команда содержит `--model gemini-3.1-pro-high`, `--effort high`, `--json-schema <путь>` и заканчивается `--prompt=<промпт>`

#### Scenario: Продолжение

- **WHEN** вызов продолжает сессию `c-1`
- **THEN** команда содержит `--conversation c-1`

### Requirement: Разбор потока Antigravity

Адаптер SHALL разбирать NDJSON `stream-json`: запись `event: init` — событие `init` с идентификатором сессии из `conversation_id`; `event: step_update` с `step_type: tool` и `state: DONE` — `tool_use` с именем и параметрами инструмента; `event: result` — итог с текстом `response`, структурой `structured_output` и расходом `usage`. Итог со статусом не `SUCCESS` MUST быть `failed` с текстом `error`, а формулировки об аутентификации и лимите MUST классифицироваться отказом `unauthenticated` и `rate_limit`. Незнакомые записи MUST пропускаться.

#### Scenario: Успешный итог со схемой

- **WHEN** поток заканчивается записью `result` со статусом `SUCCESS`, `response` и `structured_output`
- **THEN** шаг получает текст, структуру и расход `tokens_in`, `tokens_out`, `cache_read`

#### Scenario: Отказ аутентификации

- **WHEN** запись `result` несёт статус `ERROR` и ошибку `authentication required`
- **THEN** итог отмечен `failed` с отказом класса `unauthenticated`

### Requirement: Возможности Antigravity объявлены по документации

Адаптер SHALL объявлять `sessions` из конфигурации, `sessionIdSource: 'backend'`, `structuredOutput` из `structured_output`, `schemaFromText: true`, `effort: true`, а `mcp`, `strictPermissions` и `reportsCost` — выключенными; `forkSessions` MUST NOT объявляться. Адаптер, не запускавшийся на живом CLI, MUST быть проверен на фикстурах потока, а документация MUST называть его непроверенным вживую.

#### Scenario: Защитник при имплементаторе на Antigravity

- **WHEN** имплементатор режима `defend` исполнен на `antigravity`
- **THEN** защитник — свежий агент с причиной `no_fork`
