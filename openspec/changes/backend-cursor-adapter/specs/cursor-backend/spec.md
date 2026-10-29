## ADDED Requirements

### Requirement: Адаптер Cursor поставляется плагином, а не встроен

Пакет SHALL поставлять адаптер агентского бэкенда `cursor-agent` модулем, объявляемым ключом `plugins` и доступным подпутём пакета `stepcast/backends/cursor`, и MUST NOT вносить его во встроенные вклады. Модуль MUST пользоваться только публичными подпутями `stepcast/plugin` и `stepcast/pipeline` и встроенными модулями Node; проверка репозитория MUST отклонять импорт внутренних модулей движка из него. Без объявления плагина бэкенда `cursor-agent` MUST NOT существовать.

#### Scenario: Плагин объявлен

- **WHEN** конфигурация объявляет `plugins: [stepcast/backends/cursor]`
- **THEN** `resolveAdapter('cursor-agent', …)` возвращает адаптер с `sessionIdSource: 'backend'`, а `stepcast config` показывает запись `backends.cursor-agent` с источником `plugin:cursor`

#### Scenario: Плагин не объявлен

- **WHEN** пайплайн выбирает `agent: cursor-agent`, а плагин не объявлен
- **THEN** прогон отказывает до первой работы сообщением о том, что адаптер не предоставлен ни встроенно, ни плагином

#### Scenario: Импорт ядра запрещён

- **WHEN** модуль из `src/parts/backends/cursor/` импортирует внутренний модуль движка
- **THEN** линт репозитория не проходит, называя запрещённый импорт

### Requirement: Перевод запуска Cursor

Адаптер SHALL собирать неинтерактивный запуск `cursor-agent -p --output-format stream-json --force`, задавая рабочий каталог процессом. Модель шага либо умолчание бэкенда MUST переводиться в `--model`, а без обеих флаг MUST NOT передаваться. Продолжение засеянной сессии MUST собираться флагом `--resume <идентификатор>` при тех же прочих флагах; без засева либо при выключенных сессиях `--resume` MUST NOT передаваться. Промпт MUST уходить через stdin, если установленная версия CLI его так принимает, и иначе последним позиционным аргументом после конца флагов `--`, чтобы промпт, начатый с `-`, не был разобран как флаг; выбранная форма MUST быть названа в документации. Флаг `--approve-mcps` MUST NOT передаваться никогда.

#### Scenario: Новая сессия

- **WHEN** агентский шаг на `cursor-agent` с моделью `sonnet-4.5` запускается без засеянной сессии
- **THEN** команда содержит `-p`, `--output-format stream-json`, `--force`, `--model sonnet-4.5` и не содержит `--resume` и `--approve-mcps`

#### Scenario: Промпт, начатый с дефиса

- **WHEN** промпт шага начинается с `-` (например, `- пункт списка`)
- **THEN** команда заканчивается `--` и самим промптом, и ни один флаг адаптера не стоит после `--`

#### Scenario: Продолжение сессии

- **WHEN** второй шаг в `session: shared` запускается после первого, чья запись `init` назвала `session_id`
- **THEN** команда второго шага содержит `--resume <session_id>` первого

#### Scenario: Окружение бэкенда

- **WHEN** запись `backends.cursor-agent.env` задаёт переменную
- **THEN** спецификация запуска несёт её в `env`

### Requirement: Разбор потока Cursor

Адаптер SHALL переводить записи `stream-json` в события движка: `system`/`init` — в `init` с `sessionId` из `session_id`; `assistant` — в `result` с текстом сообщения; завершённый `tool_call` — в `tool_use` с именем вида вызова и его аргументами без результата; `result` — в итоговый `result`, а при `is_error: true` — с `failed: true`. Отказ MUST классифицироваться закрытым перечнем формулировок (`rate_limit`, `unauthenticated`) и иначе оставаться без класса. Начатый `tool_call`, `user` и незнакомые записи MUST давать `ignored`, строка не JSON — `unparsed`. Структурированный вывод адаптер MUST NOT извлекать. Расход MUST отдаваться событием `usage`, только если запись потока его несёт, и MUST NOT подставляться нулями.

#### Scenario: Сессия из init

- **WHEN** поток начинается записью `{"type":"system","subtype":"init","session_id":"c-1",…}`
- **THEN** адаптер отдаёт `init` с `sessionId: "c-1"`, а сессия шага в `step.json` равна `c-1`

#### Scenario: Вызов инструмента учитывается один раз

- **WHEN** поток несёт для одного `call_id` записи `tool_call` с `subtype: started` и `subtype: completed`
- **THEN** `tool_use` появляется один раз, на завершённой записи

#### Scenario: Ошибка итога

- **WHEN** запись `result` несёт `is_error: true` и текст `usage limit reached`
- **THEN** адаптер отдаёт `result` с `failed: true` и `refusal.class: rate_limit`

#### Scenario: Расход не сообщён

- **WHEN** запись `result` не несёт полей расхода
- **THEN** события `usage` нет, и поля расхода попытки помечены несообщёнными

#### Scenario: Текст похож на JSON

- **WHEN** сообщение `assistant` содержит текст `{"pass": true}`
- **THEN** событие `result` несёт текст и не несёт `structured`

### Requirement: Перевод песочницы Cursor

Адаптер SHALL переводить `permissions.mode` в `--sandbox <значение>`, принимая ровно словарь флага CLI `enabled` и `disabled`, и без объявленного режима флаг MUST NOT передаваться. Значение вне словаря, а также непустые `permissions.allow` или `permissions.deny` MUST давать `StepcastError` из сборки запуска, называющий бэкенд `cursor-agent`, объявление и допустимый словарь. Временного исключения, принимающего пооперационные списки без применения, у `cursor-agent` MUST NOT быть.

#### Scenario: Режим переводится

- **WHEN** шаг объявляет `permissions: { mode: enabled }`
- **THEN** команда содержит `--sandbox enabled`

#### Scenario: Режим чужого бэкенда

- **WHEN** шаг объявляет `permissions: { mode: workspace-write }`
- **THEN** сборка запуска отказывает ошибкой с `cursor-agent`, значением `workspace-write` и словарём `enabled, disabled`

#### Scenario: Пооперационный список

- **WHEN** шаг объявляет `permissions: { allow: [Bash(git *)] }`
- **THEN** сборка запуска отказывает ошибкой, называющей `cursor-agent` и `allow`

#### Scenario: База из конфигурации бэкенда

- **WHEN** `backends.cursor-agent.permissions.mode` равен `enabled`, а шаг политики не объявляет
- **THEN** команда содержит `--sandbox enabled`

### Requirement: Возможности Cursor объявлены честно

Адаптер SHALL объявлять `sessions` из конфигурации и `sessionIdSource: 'backend'`, а возможности `mcp`, `structuredOutput`, `strictPermissions`, `effort` и `reportsCost` MUST объявлять выключенными. Умолчания вклада MUST быть `command: cursor-agent`, `sessions: true`, `structured_output: false`, `strict_permissions: false`, `mcp: false`, `concurrency: 2`, без `default_model`. Каждое объявление, требующее выключенной возможности, MUST отклоняться до первой работы существующими проверками движка, а effort из настроек MUST отбрасываться с событием `backend.degraded`.

#### Scenario: MCP у шага

- **WHEN** шаг на `cursor-agent` объявляет непустой `mcp`
- **THEN** прогон отказывает до первой работы, а `stepcast lint` отклоняет объявление

#### Scenario: Схема вывода у шага

- **WHEN** агентский шаг на `cursor-agent` объявляет `output_schema`
- **THEN** прогон отказывает до первой работы ошибкой конфигурации, называющей бэкенд и шаг, а `stepcast lint` отклоняет шаг

#### Scenario: Судья на Cursor

- **WHEN** предикат `judge` выбирает `agent: cursor-agent`
- **THEN** `stepcast lint` отклоняет его как бэкенд без структурированного вывода

#### Scenario: Жёсткий режим

- **WHEN** шаг на `cursor-agent` объявляет `permissions.enforce: strict`
- **THEN** прогон отказывает до первой работы, а `stepcast lint` называет отсутствующую возможность

#### Scenario: Effort из настроек

- **WHEN** конфигурация задаёт `defaults.effort: high`, а шаг на `cursor-agent` effort не объявляет
- **THEN** прогон идёт, команда шага не несёт effort ни в каком виде, а журнал содержит `backend.degraded` с `backend: cursor-agent` и `capability: effort`

#### Scenario: Effort в документе

- **WHEN** шаг на `cursor-agent` объявляет `effort: high`
- **THEN** прогон отказывает до первой работы

### Requirement: Перечень моделей Cursor

Вклад бэкенда SHALL перечислять модели пробой `cursor-agent models`, разбирая строки вида `<slug> - <название>` в модели с именем и подписью, снимая пометки текущей модели и пропуская заголовки и пустые строки. Повторный slug MUST отбрасываться, а неразборный вывод MUST давать пустой список без догадок. Уровни effort у моделей MUST NOT заполняться.

#### Scenario: Каталог разобран

- **WHEN** проба печатает заголовок, строку `auto - Auto` и строку `sonnet-4.5 - Claude 4.5 Sonnet (current)`
- **THEN** список содержит `auto` с подписью `Auto` и `sonnet-4.5` с подписью `Claude 4.5 Sonnet`, без effort

#### Scenario: Неразборный вывод

- **WHEN** проба печатает текст без строк вида `<slug> - <название>`
- **THEN** список пуст

### Requirement: Адаптер проверяется подменённым CLI

Тесты адаптера SHALL проверять сборку запуска, перевод песочницы и разбор потока по фикстурам `test/fixtures/cursor/`, а исполнение шага — через исполняемую подмену `cursor-agent`, без сети и без установленного CLI. README фикстур MUST называть происхождение каждой фикстуры: запись с указанной версией CLI или составление по документированной форме.

#### Scenario: Шаг на подменённом CLI

- **WHEN** движок исполняет два шага в `session: shared` на `cursor-agent`, чья команда указывает на скрипт, печатающий фикстуру с `session_id`
- **THEN** второй запуск скрипта получил `--resume <session_id>`, а промпт каждого шага дошёл до скрипта
