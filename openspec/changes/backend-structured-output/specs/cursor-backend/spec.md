## MODIFIED Requirements

### Requirement: Возможности Cursor объявлены честно

Адаптер SHALL объявлять `sessions` из конфигурации, `sessionIdSource: 'backend'` и `schemaFromText: true` (итоговая запись `result` несёт полный текст ответа), а возможности `mcp`, `structuredOutput`, `strictPermissions`, `effort` и `reportsCost` MUST объявлять выключенными. Умолчания вклада MUST быть `command: cursor-agent`, `sessions: true`, `structured_output: false`, `strict_permissions: false`, `mcp: false`, `concurrency: 2`, без `default_model`. Каждое объявление, требующее выключенной возможности, MUST отклоняться до первой работы существующими проверками движка, а effort из настроек MUST отбрасываться с событием `backend.degraded`. Схему вывода, участие в `review` и судейство Cursor MUST получать движковой схемой по итоговому тексту.

#### Scenario: MCP у шага

- **WHEN** шаг на `cursor-agent` объявляет непустой `mcp`
- **THEN** прогон отказывает до первой работы, а `burnex lint` отклоняет объявление

#### Scenario: Схема вывода у шага

- **WHEN** агентский шаг на `cursor-agent` объявляет `output_schema`
- **THEN** запуск не несёт флага схемы, промпт несёт схему, а `output.json` — JSON из итогового текста, проверенный схемой

#### Scenario: Судья на Cursor

- **WHEN** предикат `judge` выбирает `agent: cursor-agent`
- **THEN** `burnex lint` его принимает, а вердикт берётся из итогового текста

#### Scenario: Жёсткий режим

- **WHEN** шаг на `cursor-agent` объявляет `permissions.enforce: strict`
- **THEN** прогон отказывает до первой работы, а `burnex lint` называет отсутствующую возможность

#### Scenario: Effort из настроек

- **WHEN** конфигурация задаёт `defaults.effort: high`, а шаг на `cursor-agent` effort не объявляет
- **THEN** прогон идёт, команда шага не несёт effort ни в каком виде, а журнал содержит `backend.degraded` с `backend: cursor-agent` и `capability: effort`

#### Scenario: Effort в документе

- **WHEN** шаг на `cursor-agent` объявляет `effort: high`
- **THEN** прогон отказывает до первой работы
