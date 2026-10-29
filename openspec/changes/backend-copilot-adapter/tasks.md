## 1. Разведка CLI и фикстуры

- [x] 1.1 (CLI недоступен — сверка по документации, так и записано в README) Установить `copilot` (`npm i -g @github/copilot`) и залогиниться. Снять `copilot --version` и `copilot --help`, сверить `-p`/`--prompt`, `--allow-all` (иначе его части), `--no-color`, `-s`, `--model` и приём промпта со stdin (design.md, решение 2). Итог — в `test/fixtures/copilot/README.md`: версия, дата, выбранная форма промпта.
- [x] 1.2 `test/fixtures/copilot/answer.txt`: многострочный ответ с пустой строкой между абзацами, записанный с живого `copilot -s` (или составленный, если 1.1 не удалась, — тогда так и сказано в README).

## 2. Правка ядра: событие `text`

- [x] 2.1 Падающий тест в `test/backend.test.ts`: фейковый бэкенд отдаёт события `text` (`Итог:`, пустую строку, `готово`) — текст шага в `step.json` равен `Итог:\n\nготово`; завершающие пустые куски отсечены.
- [x] 2.2 Падающий тест там же: `text`, затем `result` с текстом — побеждает `result`; ни одного куска и ни одного `result` — текст `undefined`, как прежде.
- [x] 2.3 `backend/types.ts`: вид `{ kind: 'text'; text: string }` в `BackendEvent` с комментарием, зачем он (design.md, решение 1). `run/exec/agentStep.ts`: накопление кусков попытки и выбор текста после выхода процесса. Проверить, что `switch` в `judgePass.ts` и прочих потребителях `BackendEvent` компилируется (новый вид там игнорируется).

## 3. Адаптер Copilot

- [x] 3.1 Падающий тест `test/copilot-adapter.test.ts`, сборка запуска: `--allow-all`, `--no-color`, `-s`; `--model` из шага либо `default_model`, без обеих — флага нет; промпт по форме из 1.1 (для аргумента — слитный `--prompt=…`, промпт с `-` в начале не стоит отдельным аргументом); промпт сверх 128 KiB в форме аргумента → `StepcastError` с `copilot`; `--resume`/`--continue` нет даже при `resumeSession: true` и `sessionId`; `effort` не даёт флага; `env` бэкенда доходит.
- [x] 3.2 Падающий тест там же, доступ: `mode` любой → `StepcastError` с `copilot` и `permissions.mode`; непустые `allow`/`deny` → `StepcastError` с ключом; база из `backends.copilot.permissions` через `effectivePermissions`; `enforce: strict` → `StepcastError`; без объявления — запуск собирается.
- [x] 3.3 Падающий тест там же, разбор: каждая строка `answer.txt` → `text`, пустая — `text` с `''`, `\r` в конце снимается; строка `{"pass": true}` → `text`, не `structured`; `rate limit reached` → `text` без отказа.
- [x] 3.4 `src/parts/backends/copilot/adapter.ts`: `createCopilotAdapter(config)` с возможностями по требованию «Возможности Copilot объявлены честно», `launch()` по 3.1–3.2, `parseLine()` по 3.3. Комментарии — почему `sessionIdSource: 'backend'` при выключенных сессиях и почему отказ не классифицируется (решения 3 и 5).
- [x] 3.5 `src/parts/backends/copilot/index.ts`: `definePipelinePlugin({ name: 'copilot', … backends: { copilot: defineBackend({ create, defaults }) } })` без `models`, умолчания по спеке; экспорт адаптера.
- [x] 3.6 `package.json`: `"./backends/copilot": "./dist/src/parts/backends/copilot/index.js"`. `eslint.config.js`: граница плагинов пакета (`files` и тексты сообщений) включает `src/parts/backends/copilot/**/*.ts`; `test/eslint-config.test.ts` — проба `src/parts/backends/copilot/…`; `test/plugin-surface.test.ts` — каталог в перечне.
- [x] 3.7 Тест манифеста и загрузки в `test/plugin-load.test.ts`: вклад `copilot` с умолчаниями, возможности (`sessions`, `structuredOutput`, `strictPermissions`, `mcp`, `effort`, `reportsCost` — `false`, `sessionIdSource: 'backend'`), отсутствие `models`, подпуть ведёт на собранный модуль, без объявления плагина — прежний отказ «не предоставлен».

## 4. Исполнение на подменённом CLI

- [x] 4.1 Тест в `test/copilot-adapter.test.ts`: временный каталог с исполняемым `copilot` (node со shebang), который пишет argv и stdin в файл и печатает `answer.txt`; `backends.copilot.command` указывает на него. Шаг проходит, текст шага в `step.json` равен `answer.txt` целиком, промпт дошёл до скрипта.
- [x] 4.2 Там же: два шага в `session: shared` — предупреждение о деградации сессий, оба запуска без `--resume`, `step.json` без сессии; `defaults.effort: high` — прогон идёт, argv без effort, журнал с `backend.degraded`; шаг с `output_schema`, `mcp` или `enforce: strict` — отказ до запуска скрипта (файл argv не создан).

## 5. Документация

- [x] 5.1 `docs/plugins.md`: в описании `parseLine` — событие `text` и правило склейки; раздел «Четвёртый бэкенд: Copilot» после раздела о Cursor — подключение, умолчания, происхождение флагов (1.1), «Что пришлось добавить» (событие `text`), «Чего хватило без правок» (деградация сессий, effort по источнику, проверки `output_schema`/MCP/strict/судьи), «Чего не хватило» (сессии, расход, модели, классификация отказа, перевод `allow`/`deny`).
- [x] 5.2 `docs/config.md`: `stepcast/backends/copilot` в списке плагинов; абзац о `copilot` в «Возможностях бэкендов» — `--allow-all` и граница рабочего дерева, отказ любых `permissions`, нет сессий/расхода/списка моделей, effort документа отклоняется, effort настроек отбрасывается; форма промпта и предел 128 KiB, если промпт идёт аргументом; `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` под `env_deny` и `backends.copilot.credentials` либо `copilot` с `/login`.

## 6. Проверка

- [x] 6.1 `npm run check` зелёный; `git diff --stat src/parts/pipeline` — только `backend/types.ts` и `run/exec/agentStep.ts` (плюс `backend/fake.ts`: необязательная опция `parseLine` фейкового бэкенда для тестов события `text`).

## 7. Живой прогон

- [x] 7.1 `examples/copilot/stepcast.yml` и `examples/copilot/README.md`: один агентский шаг на `agent: copilot`, создающий файл и отвечающий двумя абзацами, с проверкой `file_exists` (design.md, решение 6).
- [ ] 7.2 Собрать (`npm run build`) и прогнать пример на живом `copilot` с `plugins: [stepcast/backends/copilot]`. В раздел «Живой прогон» в `design.md` записать: `copilot --version`, команду, статус шага `success`, выдержку из `step.json` с обоими абзацами, наблюдение о тишине до ответа и расхождения с решениями 2 и 5. Если прогон не удался, записать причину и не отмечать задачу.
