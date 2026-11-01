## 1. Каталог поставляемых бэкендов

- [x] 1.1 Завести `src/parts/backends/bundled.ts`: упорядоченный перечень `{ specifier, plugin }` для `stepcast/backends/codex`, `stepcast/backends/cursor`, `stepcast/backends/copilot` с импортом default export каждого `index.ts` и помощник «имя бэкенда → запись каталога» (design.md, решение 1)
- [x] 1.2 Тест: набор `specifier` каталога равен подпутям `./backends/*` поля `exports` в `package.json`; `claude` в каталоге нет; имена бэкендов каталога — `codex`, `cursor-agent`, `copilot`

## 2. Чтение настроек

- [x] 2.1 В `src/parts/ui/settings.ts` добавить `BackendView.plugin` и заменить частную ветку Codex в `readSettings` обходом каталога: недостающие бэкенды дописываются после разрешённых в порядке каталога с `command`/`default_model` из `defaults` плагина и источником `plugin:<имя плагина>`; объявленный в `backends:` без адаптера получает `plugin` и умолчание модели (решение 3); прямой импорт модуля Codex убрать
- [x] 2.2 Обновить комментарии `readSettings` и `src/parts/ui/models.ts`, называющие «синтетическую карточку codex», на общий случай

## 3. Правка настроек

- [x] 3.1 `SettingsPatchSchema`: поле `connect: z.array(ModelNameSchema)`, `connectCodex` сохранить; в `writeSettings` нормализовать оба в одно множество имён (решение 4)
- [x] 3.2 Проверки до записи: имя вне каталога — отказ `Agent <имя> cannot be connected from the dashboard`; `agent` с `available: false` принимается только при имени в `connect` и спецификаторе, ещё не объявленном в `plugins:` глобального файла
- [x] 3.3 Запись в `editGlobalConfig`: дописать каждый недостающий спецификатор в `plugins:` (точное совпадение строки), создавая последовательность при её отсутствии; обновить комментарий о `connectCodex` у возврата `readSettings`

## 4. Витрина

- [x] 4.1 `ui/src/api.ts`: `BackendView.plugin?: string`, `SettingsPatch.connect?: readonly string[]` (`connectCodex` оставить в типе для совместимости, витрина его больше не шлёт)
- [x] 4.2 `ui/src/pages/Agents.tsx`: состояние `connect: Set<string>` вместо `connectCodex`; чекбокс «Connect <имя>» на каждой карточке вкладки Backends с `!available && plugin`, подсказка с `command`; выбор агента на вкладке Default разрешает бэкенд из отмеченного множества; `dirty` и `submit` учитывают множество, `adopt` его сбрасывает (решение 5)
- [x] 4.3 Вынести правило «бэкенд можно выбрать агентом» (`enabled && (available || connect.has(name))`) в чистую функцию и покрыть в `ui/test/agents.test.tsx`

## 5. Тесты сервера

- [x] 5.1 `test/ui-server.test.ts`, `GET /api/settings` на чистом доме: `codex`, `cursor-agent`, `copilot` с `available: false` и своими `plugin`; `claude` без `plugin`; с `plugins: [stepcast/backends/cursor]` — одна запись `cursor-agent`, `available: true`, без `plugin`
- [x] 5.2 `PUT /api/settings` с `connect: ["cursor-agent"]` и `agent: "cursor-agent"`: строка в `plugins:`, комментарий сохранён, ответ показывает `available: true` и агента
- [x] 5.3 Повторный `connect` не дублирует строку; `connect: ["claude"]` и неизвестное имя — отказ без изменения файла; `agent` неподключённого бэкенда без `connect` — отказ «not connected»
- [x] 5.4 Существующий тест с `connectCodex: true` проходит без правок — это проверка совместимости
- [x] 5.5 Прогнать тесты экрана «System» (`test/ui-system.test.ts`) и `/api/models`: если они перечисляют состав бэкендов чистого дома, обновить ожидания на новый состав (design.md, риски)

## 6. Документация и проверка

- [x] 6.1 `docs/config.md`, абзац «Настройки правят только глобальный файл»: вкладка Backends перечисляет поставляемые адаптеры и дописывает выбранный в `plugins:`; CLI агента ставится и авторизуется отдельно
- [x] 6.2 `docs/ui-proposals.md`: строку «Бэкенды Cursor и Copilot» в перечне пробелов зачеркнуть с пометкой «сделано в `ui-connect-bundled-backends`»
- [x] 6.3 `npm run check` зелёный
