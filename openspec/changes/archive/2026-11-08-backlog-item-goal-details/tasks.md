## 1. Формат и запись пункта

- [x] 1.1 `schema.ts`: вынести модель относительного пути из `RepoNameSchema` в общую (сообщения сохранить); `goal` — один такой путь, `details` — `commaList('details', …)` таких путей, оба необязательны в `BacklogItemSchema`
- [x] 1.2 `schema.ts`: `goal: string`, `details: string[]` в `BacklogRecordSchema`; `parse.ts`: `toRecord` отдаёт `entry.data.goal ?? ''` и `entry.data.details ?? []`, диагностика называет пункт и поле
- [x] 1.3 Пересобрать `schema/backlog.schema.json` и `schema/backlog-slots.schema.json` генератором `scripts/generate-schema.ts`; поправить тесты, сверяющие запись пункта целиком (`cli-backlog`, `cli-project-repos`, `ui-backlog` и подобные)
- [x] 1.4 Тесты разбора: поля отсутствуют, оба объявлены, абсолютный путь, `..`, глоб, пустой элемент и повтор в `details`

## 2. Отбор и команда

- [x] 2.1 Модуль в `src/parts/pipeline/domain/backlog/`: `missingRefs(entry, queueDir)` — перечень путей `goal`/`details`, не называющих существующий обычный файл относительно каталога очереди
- [x] 2.2 `select.ts`: `selectItems` принимает необязательную проверку материалов и пропускает пункт с отсутствующим путём до проверки группы (как ждущий `needs`); без неё поведение прежнее
- [x] 2.3 `commands/backlog.ts`: `claimItems` под lock'ом передаёт проверку в отбор и собирает пропущенные пункты; `pick` пишет по строке на пропущенный пункт в `writeErr`; `pick --only` на пункт с отсутствующим путём — отказ кодом 2 со всеми путями, после проверки зависимостей
- [x] 2.4 Тесты команды: пункт с отсутствующим файлом пропущен, группа не занята, пункт ниже взят, строка в потоке ошибок, очередь у пропущенного не тронута; все файлы на месте — взят; `--only` — код 2, путь в сообщении, файл очереди байт-в-байт прежний; `list` с отсутствующим файлом — код 0; `item-<дорожка>.json` несёт `goal` и `details`

## 3. Запись контекста item_refs

- [x] 3.1 `document/schema.ts`: форма `{ item_refs: string, mode? }` в `ContextEntrySchema`; `document/model.ts` и `document/expand.ts` — вид записи и подстановки в её пути
- [x] 3.2 `domain/lint.ts` принимает форму; неизвестные ключи рядом с `item_refs` отклоняются строгой схемой
- [x] 3.3 `domain/context/assemble.ts`: разрешение записи — чтение JSON, проверка формы `goal`/`details`, отказ на абсолютный путь и `..`, на отсутствующий файл записи и на отсутствующий названный файл; затем каждый путь — как запись `path` с объявленным `mode` (deny-событие, `context_exclude`, склейка, бюджет)
- [x] 3.4 `commands/context.ts`: предпросмотр контекста показывает файлы, добавленные `item_refs`, либо отказ с той же причиной
- [x] 3.5 Тесты сборки: порядок `goal` → `details`, пустые поля — ничего, отсутствующий ключ — пусто, отсутствующий файл записи и названного файла — отказ до бэкенда, deny, склейка с тем же путём из записи `path`, понижение бюджетом

## 4. Петля

- [x] 4.1 `- item_refs: ${run.dir}/item-${job.lane}.json` в `context` работ `.stepcast/jobs/propose.yml`, `plan.yml`, `implement.yml` (перед глобом документов), `review.yml`, `propose-express.yml`, `implement-express.yml`; `fix-review.yml` и `verify.yml` не трогать
- [x] 4.2 `stepcast lint` пайплайна `self-improve.yml` зелёный; тест, читающий работы петли, подтверждает запись в шести работах и её отсутствие в двух

## 5. Документация и проверка

- [x] 5.1 `docs/backlog.md`: поля `goal`/`details`, якорь путей (каталог очереди), принятое место `backlog/<слаг>/`, правило отбора и отказ `--only`, ограничение «очередь в корне дерева» для `item_refs`
- [x] 5.2 `docs/pipeline-format.md`: форма записи контекста `item_refs`, её отказы и способ передачи
- [x] 5.3 `npm run check` зелёный; `openspec validate "backlog-item-goal-details" --strict` зелёный
