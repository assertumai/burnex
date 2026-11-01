## 1. Общие функции движка

- [x] 1.1 `src/parts/install/plan.ts`: `checkUpdate(manifest, host)` — исходы
      `available` / `up-to-date` / `blocked` / `no-tags` / `unknown` для
      `managed`, `checkout` (`git fetch`, `rev-list --count HEAD..@{u}`) и
      `npm` (`npm view <package> version`) (design.md, Решение 4); `capture`
      получает предел времени.
- [x] 1.2 `src/parts/install/commands/update.ts`: «обновлять нечего» и отказы
      грязного дерева и отцеплённого HEAD — через `checkUpdate`; тексты CLI не
      меняются (`test/` команды `update` проходят без правки ожиданий).
- [x] 1.3 `src/parts/pipeline/run/budget/priceCatalog.ts`: `isUnpricedCall(adapter,
      model, catalog)`; `warnAboutUnpricedCalls` раннера зовёт его (design.md,
      Решение 6).
- [x] 1.4 `src/parts/ui/daemon/launchd.ts`: `launchctl` хозяина возвращает и
      `stdout`; `agentState(host)` — `plist`, `loaded`, pid агента, путь входа
      из `ProgramArguments`; константа `STABLE_ENTRY` — общая с `restart.ts`
      (design.md, Решения 1–2).
- [x] 1.5 `src/parts/pipeline/backend/models.ts`: `heldModelDiscovery(name,
      command)` — удержанный исход без запуска пробы.

## 2. API витрины

- [x] 2.1 `src/parts/ui/daemon/server.ts`: сведения о самом демоне (pid, время
      подъёма, порт, `projectRoot`, путь входа) в окружении API; внедряемый
      `launchMaintenance` по образцу `launchRun` — отсоединённый процесс в
      своей сессии, вывод дозаписью в `~/.stepcast/update.log` /
      `autostart.log`, учёт живого ребёнка для `409` (design.md, Решение 3).
- [x] 2.2 `src/parts/ui/system.ts`: `buildSystem(env, host)` — движок, демон,
      автозапуск, бэкенды (поиск команды по `PATH` окружения шага, удержанная
      проба, последний `backend.refused` по 20 новейшим прогонам проекта с
      бэкендом из `usage.json`, иначе строка «бэкенд не установлен»), модели
      без цены с путями в конфигурации и датой каталога (design.md,
      Решения 1, 2, 5, 6). Системные вызовы — через внедряемого хозяина.
- [x] 2.3 `src/parts/ui/screens/system/{declaration,server}.ts`: строка
      `screen-system` с `GET /api/system`, `GET /api/system/update`
      (удержание 10 мин, `?refresh=1`), `POST /api/system/update`,
      `POST /api/system/autostart` (`{ enabled }`, `409` вне macOS и при
      живом ребёнке), `GET /api/system/log?kind=update|autostart` (200
      последних строк); запись в `src/parts/ui/rows.ts`.
- [x] 2.4 `src/builtin/routes.yml`: `screen-system` на `/system`,
      `nav: { order: 10, group: system }`.

## 3. Экран

- [x] 3.1 `ui/src/api.ts`: типы ответа и вызовы пяти маршрутов.
- [x] 3.2 `ui/src/pages/System.tsx` + `system.css`: карточки «Engine»,
      «Daemon», «Autostart» (переключатель, состояния «plist есть, агент не
      загружен» и «путь в конкретный релиз» с подсказкой), «Update» (кнопки
      «Проверить обновления» и «Обновить», предупреждение о перезапуске,
      ожидание нового pid до 60 с, хвост журнала по таймауту), таблица
      «Backends» с кнопкой «Проверить» (`/api/models?refresh=1`) и пояснением
      про авторизацию, список «Models without price».
- [x] 3.3 `ui/src/screens/system.tsx` и запись `'screen-system'` в
      `ui/src/screens/index.ts`.

## 4. Проверки и документация

- [x] 4.1 `test/update-check.test.ts`: `checkUpdate` на всех способах и исходах;
      совпадение с решением `runUpdateCommand`.
- [x] 4.2 `test/ui-system.test.ts`: `GET /api/system` с поддельным хозяином —
      паспорт `managed` и отсутствующий паспорт в каталоге релизов, демон под
      launchd без `ui.pid`, не macOS, команда бэкенда `found`/`missing`,
      удержанная и отсутствующая проба, `backend.refused` в журнале с
      бэкендом из `usage.json` и без него, модели без цены и в каталоге;
      `GET /api/system/update` с удержанием и `refresh`; `POST`-маршруты —
      argv и `cwd` порождения, `409` вне macOS и при живом ребёнке, отказ
      чужого `Origin`.
- [x] 4.3 `test/launchd*.test.ts`: `agentState` по выводу `launchctl print`.
- [x] 4.4 `ui/test/system.test.tsx`: разметка по фикстуре — состояния
      автозапуска, неактивные кнопки с причиной, отказы бэкендов, модели без
      цены.
- [x] 4.5 Ожидания маршрутов и экранов: `test/ui-routes-file.test.ts`,
      `test/ui-screens.test.ts`, `test/ui-server.test.ts`.
- [x] 4.6 `docs/release.md`: раздел «Экран System» — что показано и откуда,
      проверка обновления по способам установки, «Обновить» как отсоединённый
      `stepcast update` и журнал `~/.stepcast/update.log`, переключатель
      автозапуска (только macOS, перезапуск демона), что авторизация бэкенда
      видна только по отказу прогона.

## 5. Итог

- [x] 5.1 `npm run check` зелёный.
- [ ] 5.2 Релиз через `scripts/release-local.sh`, перезапуск демона и осмотр
      экрана в живом демоне; на macOS — включение и выключение автозапуска с
      экрана и возвращение демона с новым pid.
