## 1. Модель пакетов

- [x] 1.1 `src/parts/packages/summary.ts`: `packageContents(dir)` — имена по
      видам в порядке `ResourceKind`, пустые виды опущены; `routes` — `id`
      строк `routes.yml`, нечитаемый файл даёт пустой список без исключения
      (design.md, Решение 1). Поле `contents` в `PackageSummary`, в том числе у
      сломанного и затенённого пакета.
- [x] 1.2 `provides` выводить из `contents`, сохранив правило «`routes` — по
      наличию файла»; вывод `stepcast package list` без `--json` не меняется.
- [x] 1.3 `packageConflicts(summaries)`: по слою и виду (кроме `pipelines`)
      имена у двух и более пакетов со `status: ok`, текст — `describeConflict`
      (design.md, Решение 2).
- [x] 1.4 Тесты модели (`test/packages-summary.test.ts` или существующий файл
      сводки): состав всех видов, сломанный и затенённый пакет, конфликт шага и
      скрипта, одноимённые ресурсы разных слоёв — не конфликт, сломанный пакет
      конфликта не даёт; `package list` текстом прежний, `--json` с `contents`.

## 2. API витрины

- [x] 2.1 `src/parts/ui/packages.ts`: `buildPackageProblems` — отказы с одним
      пакетом из `currentWidgets`, `currentDashboards().failures`,
      `currentRoutes().failures`, отказавших `RowOutcome` пакетных плагинов
      ядра `currentDaemonKernel`, плюс `packageConflicts`; порядок — слой,
      пакет, вид, `id`; несобранное ядро — `pluginsError` (design.md, Решение 3).
- [x] 2.2 `src/parts/ui/screens/packages/{declaration,server}.ts`: строка
      `screen-packages` с объявлением экрана и `GET /api/packages`
      (`{ packages, problems, pluginsError? }`); удалить
      `src/parts/ui/packages/row.ts`, заменить строку в `src/parts/ui/rows.ts`.
- [x] 2.3 `src/builtin/routes.yml`: `screen-packages` на `/packages`,
      `nav: { order: 3, group: extend }`, комментарий со ссылкой на изменение.
- [x] 2.4 `test/ui-server.test.ts` (блок `packages-directory-layer`): ответ с
      `contents`; `problems` со сломанным дашбордом пакета и конфликтом виджета
      двух пакетов — запись одна; множество конфликтов `packageConflicts`
      совпадает с конфликтами составов виджетов, дашбордов и маршрутов.

## 3. Экран

- [x] 3.1 `ui/src/pages/Packages.tsx` + `packages.css`: секции «Project» и
      «Home», пустой слой с путём каталога, карточка пакета (имя, версия,
      описание, каталог, бейдж статуса, причина или затенение), состав по видам
      с адресами `<пакет>:<имя>` у пайплайнов, приглушённый состав у
      неучаствующего пакета, `unmetNeeds`, отказы пакета, «Обновить»,
      индикатор загрузки (design.md, Решение 4).
- [x] 3.2 `ui/src/screens/packages.tsx` и запись `'screen-packages'` в
      `ui/src/screens/index.ts`.
- [x] 3.3 `ui/src/pages/RoutesEditor.tsx`: предупреждение `packageFailures`
      ведёт на `/packages`.
- [x] 3.4 `ui/test/packages.test.tsx`: разметка по фикстуре — оба слоя, три
      статуса, состав, конфликт в обеих карточках, пустой слой; ссылка на
      «Маршруты» в `ui/test/routes.test.tsx`.

## 4. Проверки и документация

- [x] 4.1 Ожидания маршрутов и экранов: `test/ui-routes-file.test.ts`,
      `test/ui-screens.test.ts`, `ui/test/screens.test.tsx` — новая строка
      `screen-packages`, `ui-packages` нет.
- [x] 4.2 `docs/packages.md`, раздел «Витрина»: экран «Packages» по адресу
      `/packages` — что показывает, поле `contents` и список `problems`;
      строка поставки теперь `screen-packages`. В разделе «Команды» —
      `contents` в `--json`.
- [x] 4.3 `npm run check` зелёный.
