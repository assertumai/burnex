## 1. Вид очереди: владелец пункта

- [x] 1.1 `src/parts/ui/backlog.ts`: добавить в `BacklogItemView` поля `claimedBy?` и `ownerRunId?`; `toItemView` заполняет их из `entry.data.claimed_by` и `parseRunOwner` (импорт из `../pipeline/domain/backlog/index.js`)
- [x] 1.2 `ui/src/api.ts`: зеркально добавить те же поля в `BacklogItemView`
- [x] 1.3 `test/ui-backlog.test.ts`: `run:<id>` даёт оба поля; владелец иной формы — только `claimedBy`; пункт без `claimed_by` — ни одного

## 2. Вид очереди: блокировка

- [x] 2.1 `src/parts/ui/backlog.ts`: тип `BacklogLockView` (`free` / `held` с `command`, `pid`, `host`, `acquiredAt`, `abandoned`, `foreignHost`, `path` / `unreadable` с `path`) и поле `lock` в `BacklogProjectView`; чтение через `readOwner`, `isAbandoned` и `hostname()`
- [x] 2.2 Кэш пути lock'а по `project.path` (одна функция модуля), чтобы `backlogLockPath` не порождал git каждый такт (design.md, Решение 4); запасной путь без git — не навсегда, а до повторной проверки через `LOCK_PATH_RETRY_MS`
- [x] 2.3 `ui/src/api.ts`: зеркало `BacklogLockView` и поля `lock`
- [x] 2.4 `test/ui-backlog.test.ts`: свободная, занятая живым процессом, брошенная (pid мёртвого процесса той же машины), чужая машина, нечитаемый файл; повторная сборка не вызывает git повторно для того же проекта

## 3. Живой поток

- [x] 3.1 `src/parts/ui/daemon/watcher.ts`: часть отпечатка проекта `lock:<mtime>:<size>:<abandoned>` / `lock:-` через кэшированный путь (design.md, Решение 5)
- [x] 3.2 `test/ui-watcher.test.ts`: появление и снятие lock-файла без правки `backlog.md` дают новый кадр `backlog`; смерть владельца при неизменном файле — тоже

## 4. Экраны

- [x] 4.1 Общий компонент владельца пункта (`TargetLink` на `RUN_TARGET` с `projectKey` и `ownerRunId`; иначе строка `claimedBy` текстом) и общий компонент предупреждения о блокировке (порог в одну секунду, момент через `fmtTime`, возраст на время отрисовки, пояснения брошенной/чужой/нечитаемой; перерисовка по таймеру до порога и к смене подписи возраста; нераспознанный момент взятия — как есть, без возраста)
- [x] 4.2 `ui/src/pages/Backlog.tsx`: владелец в ячейке «Picked up / owner / reason» у `in_progress`; предупреждение о блокировке в разделе проекта
- [x] 4.3 `ui/src/pages/Scrum.tsx`: владелец в карточке/панели деталей рядом с «picked up»; предупреждение о блокировке над колонками
- [x] 4.4 Стили в `backlog.css` / `scrum.css` по токенам `@stepcast/ui`

## 5. Тесты экранов

- [x] 5.1 `ui/test/backlogOwnerLock.test.tsx`: ссылка на прогон у `run:<id>`, текст у иной формы, ничего у пункта без владельца; причина отсутствия ссылки при выключенном маршруте страницы прогона
- [x] 5.2 Там же: предупреждение о занятой блокировке с командой, pid, машиной и возрастом; пояснения брошенной и чужой; нет предупреждения у свободной и у блокировки моложе секунды
- [x] 5.3 Там же: `409` переноса карточки и сохранения панели показывает `error` ответа дословно; панель остаётся открытой с введёнными значениями (`writeFailure`, `BoardNotices`, `ItemDetailsView` — разметка по состоянию, проверяемая статическим рендером)
- [x] 5.4 `test/ui-server.test.ts`: `409` обоих маршрутов доски несёт в `error` владельца lock'а (закрепить существующее поведение, если такого теста ещё нет)

## 6. Документация и проверка

- [x] 6.1 `docs/backlog.md`: где на экранах виден владелец и блокировка; `docs/ui-proposals.md`: строка «Очередь: `claimed_by`, lock-файл» и пункт «Очередь» раздела 3 отмечены сделанными в `ui-backlog-owner-and-lock`
- [x] 6.2 `npm run check` зелёный
