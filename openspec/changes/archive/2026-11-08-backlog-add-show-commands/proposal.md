## Why

Пункт очереди заводится только правкой `backlog.md` руками: агент петли, нашедший кандидата в улучшения, записать его не может, а править файл в обход lock-файла очереди значит потерять чужую запись. Диспетчеру, в свою очередь, нечем прочитать один взятый пункт, не листая весь `list`.

## What Changes

- `stepcast backlog add <slug>` — новое действие: добавляет пункт в `backlog.md` под lock'ом очереди. Ключи: `--title`, `--why`, `--done-when` (обязательны), `--group`, `--track`, `--needs`, `--goal`, `--details`, `--status todo|postponed` (по умолчанию `todo`), `--after <slug>` (по умолчанию пункт встаёт в конец файла).
- `stepcast backlog show <slug>` — новое действие: печатает запись пункта (та же форма, что у `list`); с `--run-dir` дополнительно пишет её в `item-a.json` этого каталога. Очередь не правится и не блокируется.
- `docs/backlog.md` описывает оба действия; тесты CLI.

Решение: `add` собирает текст нового пункта из переданных ключей, разбирает итоговый файл теми же `parseBacklogFile`/`checkNeeds`/`missingRefs`, что и остальные читатели, и пишет только если разбор и проверки прошли; весь цикл читать → проверить → записать идёт под `withBacklogLock`, а запись — `writeBacklogFile`, как у `finish`. Новых полей формата и правок схемы нет: `postponed` уже допустимое слово статуса. `show` ищет слаг только в `backlog.md`; имя дорожки в `--run-dir` фиксировано — `a`, под него читает диспетчер.

## Capabilities

### New Capabilities

### Modified Capabilities

- `backlog-queue`: команда `backlog` получает действия `add` и `show`; требования к ним добавляются.

## Impact

- `src/parts/pipeline/commands/backlog.ts` — действия, ключи `--title`, `--why`, `--done-when`, `--group`, `--track`, `--needs`, `--goal`, `--details`, `--after` в строке команды, список `ACTIONS`.
- `src/parts/pipeline/domain/backlog/write.ts` — вставка нового пункта (после названного либо в конец).
- `docs/backlog.md`, тесты CLI. Формат файла очереди и JSON Schema не меняются.
