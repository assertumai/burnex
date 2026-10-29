## 1. Вставка пункта

- [x] 1.1 В `domain/backlog/write.ts` добавить функцию, возвращающую новый текст файла с пунктом, вставленным после названного слага либо в конец; остальной текст не трогать

## 2. Действие `add`

- [x] 2.1 В `commands/backlog.ts` добавить `add` в `ACTIONS` и ключи `--title`, `--why`, `--done-when`, `--group`, `--track`, `--needs`, `--goal`, `--details`, `--after` в `spec.flags`; `--status` описать для `finish` и `add`; обновить описание команды
- [x] 2.2 Под `withBacklogLock` прочитать очередь, проверить слаг (в очереди и архиве), обязательные ключи, одну строку, `--status`, `--after`; собрать текст, разобрать его `parseBacklogFile`, прогнать `checkNeeds` и `missingRefs` — всё до записи; записать `writeBacklogFile`

## 3. Действие `show`

- [x] 3.1 Добавить `show`: прочитать очередь без lock'а, найти слаг, напечатать `toRecord`; с `--run-dir` записать `item-a.json` через `atomicWrite` после успешного поиска

## 4. Документация и тесты

- [x] 4.1 Дополнить `docs/backlog.md`: разделы `add` и `show` в «Команде `stepcast backlog`», упоминание в «Блокировке очереди» и «Правке файла»
- [x] 4.2 Тесты CLI: добавление в конец и после названного, `postponed`, все отказы без изменения файла, параллельные `add`, `show` с `--run-dir` и без, отказ `show`
- [x] 4.3 Прогнать `npm install --no-audit --no-fund && npm run check`
