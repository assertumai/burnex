## 1. Проверка записи расписания

- [x] 1.1 Вынести проверку одной записи `triggers.schedule` из `checkTriggers`
      (`src/parts/pipeline/domain/lint.ts`) в функцию модуля
      `src/parts/pipeline/domain/trigger/` с исходом `{ ok: true, mask,
      timezone, defaultTimezone } | { ok: false, reason }` (design.md,
      Решение 2); линт вызывает её, тексты диагностик не меняются.
- [x] 1.2 Тесты: `test/lint.test.ts` по-прежнему зелёный без правки ожиданий;
      юнит-тест функции на каждую причину отказа и на умолчательный пояс.

## 2. Происхождение прогона в манифесте

- [x] 2.1 `src/parts/pipeline/run/journal/schema.ts`: необязательное
      `RunManifestSchema.trigger` — `{ kind: 'schedule', entry, cron,
      timezone?, moment, catchup }` с комментарием о несимметричности отката
      (как у `mode` и `pid`).
- [x] 2.2 `src/parts/pipeline/commands/run.ts`: флаги `--scheduled`,
      `--schedule-entry`, `--catchup`; парность флагов, разбор момента ISO
      8601 с поясом, существование и проверка записи (задача 1.1) — отказ до
      создания каталога прогона (design.md, Решение 5). Справка команды.
- [x] 2.3 `src/parts/pipeline/run/runner.ts`: поле попадает в манифест рядом с
      `mode`; `src/parts/pipeline/commands/resume.ts` его не переносит.
- [x] 2.4 `src/parts/ui/runLaunch.ts` и `src/parts/ui/runLaunch/row.ts`: опция
      `scheduled?: { entry, moment, catchup }` превращается во флаги тем же
      путём, что `shadow`; `POST /api/run` её от формы не принимает.
- [x] 2.5 Тесты: манифест с `trigger` и без; догон; номер вне расписания;
      непарные флаги; неразборчивый момент; `resume` не наследует; прежний
      манифест читается; argv `launchRun` с опцией.

## 3. API витрины

- [x] 3.1 `src/parts/ui/schedule.ts`: `buildSchedule(runsRoot, config, { now })`
      — обход проектов через `projectSection` и `listPipelineEntries`,
      раскрытый `triggers.schedule`, проверка записи (1.1) и
      `nextOccurrence`, нераскрывшийся пайплайн строкой с ошибкой
      (design.md, Решение 1).
- [x] 3.2 Последний запуск по записи: манифесты проекта через
      `readManifestSoft`, совпадение `pipeline_file`, `cron`, `timezone`,
      последний по `started_at`; идентификатор, момент, `catchup`, статус
      (design.md, Решение 7).
- [x] 3.3 `triggerServiceView(config)` — сегодня `{ present: false }`; тип
      ответа несёт и форму `present: true` с `enabled`, `keepAwake`,
      `requireNetwork`, `maxCatchupHours` (design.md, Решение 6).
- [x] 3.4 `src/parts/ui/screens/schedule/{declaration,server}.ts`: объявление
      `screen-schedule` (заголовок «Schedule») и `GET /api/schedule`; строка в
      `src/parts/ui/rows.ts`.
- [x] 3.5 `src/builtin/routes.yml`: `screen-schedule` на `/schedule`,
      `nav: { order: 9, group: system }`.
- [x] 3.6 `src/parts/ui/overview.ts`: `RunOverview.trigger` из манифеста.

## 4. Экран

- [x] 4.1 `ui/src/api.ts`: типы ответа `GET /api/schedule` и
      `RunOverview.trigger`; функция запроса.
- [x] 4.2 `ui/src/pages/Schedule.tsx` + `schedule.css`: по проекту — таблица
      «пайплайн · выражение · пояс · ближайший момент · последний запуск по
      расписанию (ссылка на прогон) · догон», ошибки записей и пайплайнов,
      блок сервиса (при `present: false` — сообщение без флагов), индикатор
      загрузки. Никаких элементов правки.
- [x] 4.3 `ui/src/screens/schedule.tsx` и запись `'screen-schedule'` в
      `ui/src/screens/index.ts`.
- [x] 4.4 `ui/src/pages/Runs.tsx`: бейдж `schedule` / `catch-up` с моментом в
      подсказке, бейджи темы.

## 5. Проверки и документация

- [x] 5.1 `test/ui-schedule.test.ts`: временный проект — пайплайн с двумя
      записями (явный пояс и умолчание), ошибочная запись с текстом линта,
      пайплайн без `triggers` отсутствует, нераскрывшийся пайплайн, прогоны
      ручные и с `trigger` (в том числе догон и запуск по прежнему выражению),
      `service.present: false`; фиксированное `now`.
- [x] 5.2 `ui/test/schedule.test.tsx`: разметка по фикстурам — таблица, ошибки,
      блок сервиса в обеих формах, отсутствие элементов правки;
      `ui/test/runs.test.tsx` (или ближайший тест списка) — бейджи.
- [x] 5.3 Ожидания маршрутов и экранов: `test/ui-routes-file.test.ts`,
      `test/ui-screens.test.ts`, `test/ui-server.test.ts`.
- [x] 5.4 `docs/pipeline-format.md`: ключ `triggers.schedule` в «Верхнем
      уровне» и ссылка на экран «Schedule»; флаги `--scheduled`,
      `--schedule-entry`, `--catchup` рядом с `--shadow`; поле `trigger` и
      несимметричность отката — в `docs/run-layout.md`.
- [ ] 5.5 `npm run check` зелёный; релиз через `scripts/release-local.sh` и
      осмотр экрана в живом демоне.
