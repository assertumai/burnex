## 1. Скрипт установки

- [x] 1.1 `scripts/install.sh`: разбор флагов `--repo`, `--ref`, `--force`,
      `--from-dir` (раскладка уже собранного дерева, для `release-local.sh`);
      `STEPCAST_HOME`, `STEPCAST_BIN_DIR`; проверка `git`, `npm`, Node ≥ 22
- [x] 1.2 Выбор последнего тега: `git ls-remote --tags --refs`, только строгие
      `vX.Y.Z`, сортировка по числам; отказ без тегов с подсказкой `--ref`
- [x] 1.3 Мелкий клон ссылки во временный каталог, `npm ci`, `npm run build`;
      для тега — сверка `package.json` `version` с тегом
- [x] 1.4 Раскладка в `releases/<имя>.tmp-<pid>` (`dist`, `schema`,
      `src/builtin`, `package.json`, `package-lock.json`, `install.sh`;
      `chmod +x bin.js`), `npm ci --omit=dev`, перенос на место (с заменой
      существующего каталога той же версии), `ln -sfn` для `current`;
      `trap` убирает временные каталоги при сбое
- [x] 1.5 Лаунчер `~/.local/bin/stepcast` → `current/dist/src/bin.js`; отказ
      без `--force` при чужом файле; подсказка про `PATH`
- [x] 1.6 Запись `install.json` (`managed`) атомарно (через временный файл)
- [x] 1.7 `scripts/release-local.sh` — раскладка через `install.sh --from-dir`,
      без записи паспорта; имя релиза `<ts>-<sha>[-dirty]` сохраняется

## 2. Паспорт установки

- [x] 2.1 `src/parts/install/manifest.ts`: схема zod (объединение по `method`,
      лишние ключи допустимы), `parseInstallManifest(text)` с ошибками
      `StepcastError`, путь паспорта от `STEPCAST_HOME`/домашнего каталога
- [x] 2.2 `inferInstallMethod(root, probes)` — `node_modules` → `npm`,
      git-дерево → `checkout`, каталог релизов без паспорта и прочее — отказ
      с подсказкой `install.sh`; проверки диска через внедряемые `probes`

## 3. Команда `stepcast update`

- [x] 3.1 `src/parts/install/plan.ts`: чистая функция плана из паспорта и
      флагов (список `{ cmd, args, cwd }`), решение «обновлений нет» для
      `managed` по версии последнего тега; проверка грязного дерева для
      `checkout`
- [x] 3.2 `src/parts/install/restart.ts`: выбор перезапуска — `launchctl print`
      → `kickstart -k`; живой демон с `cwd` → `stopDaemon` и `up` новой
      версии в этом каталоге; без `cwd` — подсказка; иначе ничего;
      `launchctl` и порождение процессов — через внедряемый хост (как
      `LaunchdHost`)
- [x] 3.3 `src/parts/install/commands/update.ts`: строка `update`
      (`independent: true`), флаги `--ref`, `--no-restart`; печать выбранного
      способа и шагов; регистрация в `src/parts/cli/rows.ts` и в описании
      классификации команд там же

## 4. Демон

- [x] 4.1 `daemon.ts`: поле `cwd` в `DaemonRecord`, запись при `up`, чтение
      старой записи без поля
- [x] 4.2 `up.ts`: путь входа демона — `<releases_dir>/current/dist/src/bin.js`
      при `managed` и движке внутри `releases_dir`, иначе `binPath()`; тот же
      путь для `--install` и отсоединённого запуска

## 5. Поставка через npm

- [x] 5.1 `package.json`: `prepack` со сборкой, `repository`,
      `publishConfig.access`
- [x] 5.2 `docs/release.md`: `npm version X.Y.Z`, тег `vX.Y.Z`,
      `git push --follow-tags`, `npm publish` с тега, совпадение тега и версии,
      занятое имя и scope, откат через `ln -sfn` на прежний релиз

## 6. Тесты

- [x] 6.1 Разбор `install.json`: три способа, лишний ключ, неизвестный
      способ, нет обязательного поля, невалидный JSON
- [x] 6.2 Вывод способа без паспорта: `node_modules`, git-дерево, каталог
      релизов, прочее
- [x] 6.3 План обновления: `managed` без новой версии и с новой; `checkout`
      чистый и грязный, с `--ref`; `npm` с `--ref` и без
- [x] 6.4 Перезапуск с подменой хоста: агент, отсоединённый демон с `cwd`,
      без `cwd`, не поднятый, `--no-restart`, неуспешное обновление
- [x] 6.5 Запись демона: новая с `cwd`, старая без него; путь входа `up` при
      `managed` и без паспорта
- [x] 6.6 `install.sh` вручную по локальному репозиторию с тегом во временном
      `STEPCAST_HOME`/`STEPCAST_BIN_DIR`: установка, повтор, сбой сборки не
      трогает `current`, расхождение тега и версии

## 7. Документация и сдача

- [x] 7.1 README: установка через `install.sh` первой, `npm link` — путь
      разработки, раздел `stepcast update` и откат
- [x] 7.2 `docs/config.md`: `update` в перечне команд, не читающих
      конфигурацию; `cwd` в записи демона
- [x] 7.3 Прогнать `npm run check` и устранить замечания
