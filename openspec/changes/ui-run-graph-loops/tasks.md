## 1. Снимок прогона

- [x] 1.1 `src/parts/ui/snapshot.ts`: тип `JobLoopSnapshot` (`id`, `iterations`, `maxIterations`, `current?`, `verdict?`, `status`, `passes`) и поле `loop?` в `JobSnapshot`; `buildJob` заполняет его по записи `status.loops`, где `jobs` содержит работу (design.md, Решение 1); `current` — только при `status: running`
- [x] 1.2 Там же: перечень `passes` — каталоги `pass-<n>` в `jobs/<job>/steps`, разобранные `parsePassDirName` (при необходимости экспортировать из `journal/paths.ts`), по возрастанию; нет каталога — пустой перечень
- [x] 1.3 `buildSnapshot` передаёт `loop` (без `passes`) в `layoutJobs`; `buildSnapshotFromRecord` поля не заполняет
- [x] 1.4 `test/ui-snapshot.test.ts`: идущий цикл (`current` равен `iterations`), законченный (`verdict`, без `current`), работа вне цикла (поля нет), прогон без `loops` в `status.json`, участник с меньшим числом каталогов проходов, чем `iterations`

## 2. Раскладка графа

- [x] 2.1 `src/parts/ui/graph.ts`: `GraphInput.loop?` и `GraphNode.loop?` (`id`, `iterations`, `maxIterations`, `current?`, `verdict?`, `status`); `layoutJobs` переносит поле как есть
- [x] 2.2 `test/ui-graph.test.ts`: поле переносится в узел; колонки и строки графа с циклом совпадают с графом без него

## 3. Вывод шага по проходу

- [x] 3.1 `src/parts/ui/stepOutput.ts`: `StepOutputQuery.pass?`, передача в `findStepDir(..., undefined, undefined, pass)`; `StepOutputResult.pass?` — прочитанный проход у проходовой раскладки; `done` учитывает не последний проход (design.md, Решение 3)
- [x] 3.2 `src/parts/ui/screens/run/server.ts`: параметр `pass` в `handleStepOutput` тем же разбором, что `attempt`; `0` и мусор — `400`
- [x] 3.3 Тесты: `readStepOutput` с `pass` читает `pass-1` при наличии `pass-2`; без `pass` — последний; проход без каталога — `attempts: []`; попытки шага внутри прохода; `done` для прошлого прохода живого прогона; маршрут отвечает `400` на `pass=0` и `pass=x`

## 4. Браузер

- [x] 4.1 `ui/src/api.ts`: зеркала `loop` в `JobSnapshot` и `GraphNode`, `pass` в `StepOutputResult`, параметр `pass` у запроса вывода шага
- [x] 4.2 `ui/src/components/JobGraph.tsx`: метка прохода в верхнем правом углу узла (`pass n/max`, `N passes` + вердикт, `0/max`), подсказка с именем цикла; высота узла не меняется (design.md, Решение 2)
- [x] 4.3 `ui/src/components/StepOutput.tsx`: проп `pass?`; смена прохода сбрасывает накопленный вывод, смещения и выбранную попытку
- [x] 4.4 `ui/src/pages/RunDetail.tsx`: строка цикла в карточке работы и переключатель по `loop.passes` (виден при двух и более), по умолчанию последний; выбранный проход передаётся `StepOutput` каждого шага, последний — без `pass`; пометка «последний проход» у списка файлов шага при выбранном прошлом проходе (design.md, Решение 4)
- [x] 4.5 Стили метки и переключателя по токенам `@stepcast/ui`

## 5. Тесты разметки

- [x] 5.1 `ui/test/`: узел участника идущего цикла показывает `pass 2/5`; законченного — число проходов и вердикт; узел вне цикла метки не имеет
- [x] 5.2 Там же: карточка участника показывает переключатель проходов при двух и более проходах и не показывает при одном; переключатель попыток шага остаётся

## 6. Документация и проверка

- [x] 6.1 `docs/ui-proposals.md`: строка «`loops` на работе» в п. 2 отмечена сделанной в `ui-run-graph-loops`
- [x] 6.2 `npm run check` зелёный
