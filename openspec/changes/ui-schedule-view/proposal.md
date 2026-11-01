## Why

Расписание пайплайна объявляется ключом `triggers.schedule` документа
(`schedule-trigger`: `cron` и `timezone`), но витрина о нём не знает ничего: ни
какие пайплайны вообще стоят на расписании, ни когда они сработают, ни был ли
прогон запущен расписанием или догоном пропущенного момента
(`schedule-catchup-and-keep-awake`). Прогон в списке не несёт следа своего
происхождения — `Runs.tsx` отличает shadow-прогон, но не прогон по расписанию
(`docs/ui-proposals.md`, п. 2: «просмотр расписания; следов догона в `Runs.tsx`
нет», решение — «просмотр, не редактор»).

Пункт очереди называет ключ `on.schedule` и флаги `keep_awake` и
`require_network` свойствами документа пайплайна. В репозитории не так: ключ —
`triggers.schedule` (`on:` — условие работы, а не триггер), а `keep_awake`,
`require_network` и окно догона `max_catchup_hours` по
`schedule-catchup-and-keep-awake` — машинная секция `ui.triggers` домашнего
конфига, и она ещё не заведена; сервиса, который запускал бы прогоны по
расписанию, тоже пока нет (группа 4 задач `schedule-trigger` и всё
`schedule-catchup-and-keep-awake` не сделаны). Экран должен честно показывать
это состояние, а не выдумывать флаги на уровне пайплайна.

## What Changes

- **Происхождение прогона в манифесте.** Необязательное поле `trigger` в
  `run.json`: `{ kind: 'schedule', entry, cron, timezone, moment, catchup }` —
  номер записи `triggers.schedule`, её выражение и пояс на момент запуска,
  момент расписания, ради которого запущен прогон, и признак догона. Ключа нет у
  прогона, запущенного человеком, и у прогона прежней версии. Поле пишет
  `stepcast run` по флагам `--scheduled <ISO-момент>`, `--schedule-entry <N>` и
  `--catchup`, предназначенным для запускающего (будущий сервис триггеров,
  команда `stepcast schedule`, внешний cron); `launchRun` витрины получает
  соответствующую опцию. Запись с неверным номером или неразборчивым моментом
  отклоняется до старта прогона. `resume` поле не наследует.
- **API `GET /api/schedule`** — строка поставки `screen-schedule`. По каждому
  проекту корня прогонов (тот же обход и та же проектная конфигурация, что у
  `GET /api/pipelines`) — пайплайны с непустым `triggers.schedule`; по каждой
  записи: выражение, пояс (явный или пояс машины), ближайший момент по
  `nextOccurrence`, либо ошибка записи словами линта; последний прогон этого
  пайплайна по этой записи (по совпадению файла пайплайна, выражения и пояса) —
  идентификатор, момент, признак догона, статус. Пайплайн, который не
  раскрылся, — строка с ошибкой.
- **Блок сервиса триггеров.** Ответ несёт `service`: включён ли сервис,
  `keep_awake`, `require_network`, `max_catchup_hours`. Пока секции
  `ui.triggers` и сервиса нет, блок — `{ present: false }`, и экран говорит
  прямо: «расписания объявлены, но сами не срабатывают». Значения флагов
  наполнит `schedule-catchup-and-keep-awake` через ту же точку чтения.
- **Экран «Schedule»** — `ui/src/pages/Schedule.tsx`,
  `ui/src/screens/schedule.tsx`: по проекту — таблица «пайплайн · выражение ·
  пояс · ближайший момент · последний запуск по расписанию · догон»; блок
  сервиса и его флагов. Ни кнопок правки, ни записи документа пайплайна.
- **Маршрут** `screen-schedule` на `/schedule`, `nav: { group: system, order: 9 }`.
- **Пометка в списке прогонов.** `RunOverview` получает `trigger`; `Runs.tsx`
  показывает у такого прогона бейдж `schedule` или `catch-up` с моментом
  расписания в подсказке.
- **Тесты**: ответ API на временном проекте (две записи, ошибочная запись,
  нераскрывшийся пайплайн, прогоны с `trigger` и без, догон), разбор флагов
  `run`, пометка в `RunOverview`, разметка экрана и бейдж в списке прогонов,
  ожидания таблицы маршрутов.
- **Документация**: в `docs/pipeline-format.md` — ключ `triggers.schedule` в
  «Верхнем уровне» со ссылкой на экран; поле `trigger` — в `docs/run-layout.md`;
  флаги `--scheduled`, `--schedule-entry`, `--catchup` — рядом с `--shadow`.

## Capabilities

### New Capabilities

<!-- нет -->

### Modified Capabilities

- `ui-dashboard`: экран «Schedule» и `GET /api/schedule`; пометка прогона по
  расписанию в списке прогонов.
- `run-journal`: манифест прогона несёт происхождение запуска по расписанию.

## Impact

- Код движка: `src/parts/pipeline/run/journal/schema.ts` (`RunManifestSchema.
  trigger`), `src/parts/pipeline/commands/run.ts` (флаги и проверка записи),
  `src/parts/pipeline/run/runner.ts` (передача поля в манифест),
  `src/parts/pipeline/commands/resume.ts` (не наследовать).
- Код витрины: `src/parts/ui/schedule.ts` (свёртка ответа),
  `src/parts/ui/screens/schedule/{declaration,server}.ts`, `src/parts/ui/rows.ts`,
  `src/builtin/routes.yml`, `src/parts/ui/runLaunch.ts` и `runLaunch/row.ts`
  (опция запуска), `src/parts/ui/runsView.ts` (поле `trigger`),
  `ui/src/api.ts`, `ui/src/pages/{Schedule,Runs}.tsx`,
  `ui/src/screens/{schedule,index}.ts(x)`.
- API: новый `GET /api/schedule` (только чтение); `RunOverview` аддитивно
  получает `trigger`. Существующие маршруты не меняются.
- Совместимость журнала: манифест с `trigger` прежняя версия движка не прочтёт
  (`RunManifestSchema` строгая) — тот же необратимый шаг, что у `mode` и `pid`.
- Связь с `schedule-catchup-and-keep-awake`: его требование «Экран расписаний
  показывает расписания и решения сервиса» ложится поверх этого экрана
  (решения сервиса, сниппет sudoers, записи `ui.triggers.schedules`), а связь
  решения с прогоном может идти по полю `trigger` вместо поиска по `pid`.
  Документ того изменения здесь не правится.
- Зависимостей не добавляется.
