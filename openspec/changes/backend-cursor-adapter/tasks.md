## 1. Разведка CLI и фикстуры

- [x] 1.1 Если `cursor-agent` установлен: снять `cursor-agent --version`, `cursor-agent --help`, `cursor-agent models` и сверить флаги `-p`, `--output-format stream-json`, `--force`, `--model`, `--resume`, `--sandbox` и приём промпта со stdin (design.md, решение 4). Если CLI нет, взять форму из документации Cursor CLI. Итог — в `test/fixtures/cursor/README.md` (версия либо «по документации», дата, источник).
- [x] 1.2 `test/fixtures/cursor/`: `new.jsonl` (init с `session_id`, assistant, tool_call started+completed, result успех), `resume.jsonl` (тот же `session_id`), `error.jsonl` (result с `is_error: true`), `models.txt` (вывод `models` с заголовком и пометкой `(current)`). Происхождение каждой — в README.

## 2. Правка ядра: effort по источнику

- [x] 2.1 Падающий тест в `test/backend.test.ts`: фейковый бэкенд с `effort: false`, `defaults.effort: high` в конфигурации, шаг без effort. Прогон стартует, журнал содержит `backend.degraded` (`capability: 'effort'`, detail с `<job>/<step>` и `defaults.effort`), вызов адаптера без `effort`.
- [x] 2.2 Падающий тест там же: effort из tier (`model_tier` в документе, effort в `model_tiers` конфигурации) деградирует так же; effort из `step_agents` — так же.
- [x] 2.3 Тест там же: effort шага, работы и корня документа на бэкенде с `effort: false` отказывает до первой работы прежним сообщением (существующий тест остаётся зелёным); бэкенд с `effort: true` получает effort из настроек без события.
- [x] 2.4 `runner.ts`: `requireEffortSupport` различает слой по `context.expanded.effortOrigins` (документ — `step`/`job`/`pipeline` либо отсутствие записи; настройки — прочие слои) и для настроек пишет `backend.degraded`. `exec/agentStep.ts`: `effort` в `AgentInvocation` только при `adapter.capabilities.effort === true`. Комментарии — почему отбрасывает движок, а не адаптер (решение 1).

## 3. Правка ядра: `output_schema` на бэкенде без структурированного вывода

- [x] 3.1 Падающий тест: агентский шаг с `output_schema` на фейковом бэкенде с `structuredOutput: false` — прогон отказывает до первой работы ошибкой с бэкендом и шагом; на бэкенде с `true` — проходит.
- [x] 3.2 Падающий тест в `test/lint.test.ts` (либо соседнем тесте линта): тот же шаг при `backends.<id>.structured_output: false` даёт ошибку линта с `at` на `output_schema` и подсказкой.
- [x] 3.3 `runner.ts`: `requireStructuredOutputSupport` рядом с `requireMcpSupport` и вызов в ряду предстартовых проверок. `domain/lint.ts`: проверка агентского шага по образцу проверки судьи.

## 4. Адаптер Cursor

- [x] 4.1 Падающий тест `test/cursor-adapter.test.ts`, сборка запуска: новая сессия — `-p`, `--output-format stream-json`, `--force`, `--model`, промпт по форме из 1.1; продолжение — `--resume <id>`; без идентификатора, без `resumeSession` или при `sessions: false` — без `--resume`; без модели — без `--model`; `--approve-mcps` нет никогда; `env` бэкенда доходит; `effort` в вызове (если передан напрямую) не даёт флага.
- [x] 4.2 Падающий тест там же, песочница: `mode: enabled|disabled` → `--sandbox <v>`; без режима флага нет; `mode: workspace-write` → `StepcastError` с `cursor-agent`, значением и словарём; непустые `allow`/`deny` → `StepcastError`; база из `backends.cursor-agent.permissions` через `effectivePermissions`.
- [x] 4.3 Падающий тест там же, разбор по фикстурам 1.2 — по таблице решения 5: init → `sessionId`; assistant → `result` с текстом и без `structured` даже для JSON-текста; tool_call один раз на completed; result успех и ошибка; классификация отказа; `usage` только при поле расхода; пустая строка → `ignored`, не JSON → `unparsed`.
- [x] 4.4 Падающий тест там же, модели: разбор `models.txt` (решение 6), дубликаты, неразборный вывод → `[]`, проба — `[command, 'models']`.
- [x] 4.5 `src/parts/backends/cursor/adapter.ts`: `createCursorAdapter(config)` с возможностями по требованию «Возможности Cursor объявлены честно», `launch()` по 4.1–4.2, `parseLine()` по 4.3. `models.ts`: `cursorModelDiscovery`, `parseCursorModelList`.
- [x] 4.6 `src/parts/backends/cursor/index.ts`: `definePipelinePlugin({ name: 'cursor', … backends: { 'cursor-agent': defineBackend({ create, models, defaults }) } })` с умолчаниями по спеке; экспорт адаптера и разбора моделей.
- [x] 4.7 `package.json`: `"./backends/cursor": "./dist/src/parts/backends/cursor/index.js"`. `eslint.config.js`: граница плагинов пакета (`files` и тексты сообщений) включает `src/parts/backends/cursor/**/*.ts`. Тест поверхности/линта, если он перечисляет каталоги плагинов, — дополнить.
- [x] 4.8 Тест манифеста и загрузки: вклад `cursor-agent` с умолчаниями, возможности (`mcp`, `structuredOutput`, `strictPermissions`, `effort`, `reportsCost` — `false`, `sessionIdSource: 'backend'`), подпуть пакета ведёт на собранный модуль, без объявления плагина — прежний отказ «не предоставлен».

## 5. Исполнение на подменённом CLI

- [x] 5.1 Тест в `test/cursor-adapter.test.ts`: временный каталог с исполняемым `cursor-agent` (node со shebang), который пишет argv и stdin в файл и печатает `new.jsonl`/`resume.jsonl`; `backends.cursor-agent.command` указывает на него; два шага в `session: shared` — второй запуск получил `--resume <session_id>`, `step.json` несёт сессию, промпты дошли.
- [x] 5.2 Там же: `defaults.effort: high` — прогон проходит, argv без effort, журнал с `backend.degraded`; шаг с `output_schema`, `mcp` или `enforce: strict` — отказ до запуска скрипта (файл argv не создан).

## 6. Документация

- [x] 6.1 `docs/plugins.md`: раздел «Третий бэкенд: Cursor» после раздела о Codex — подключение, умолчания, происхождение флагов (1.1). Подразделы «Что пришлось добавить» (effort по источнику, проверка `output_schema` агентского шага), «Чего хватило без правок» (сессии через `init.sessionId`, `backend.degraded`, проверки MCP/strict/судьи), «Чего не хватило» (MCP, схема, effort, расход, подгрузка `.cursor/mcp.json` и правил самим CLI, `--force`).
- [x] 6.2 `docs/config.md`: в списке плагинов — `stepcast/backends/cursor`; в «Возможностях бэкендов» — абзац о `cursor-agent`: словарь `permissions.mode` (`enabled`, `disabled`), отказ `allow`/`deny`, effort документа отклоняется, effort настроек отбрасывается с `backend.degraded`; `output_schema` и `mcp` на бэкенде без возможности; `CURSOR_API_KEY` под `env_deny` и `backends.cursor-agent.credentials` либо `cursor-agent login`.
- [x] 6.3 `docs/config.md`, раздел про список моделей: Cursor перечисляет `cursor-agent models`, effort у моделей нет.

## 7. Проверка

- [x] 7.1 `npm run check` зелёный; `git diff --stat src/parts/pipeline` — только `run/runner.ts`, `run/exec/agentStep.ts`, `domain/lint.ts`.
