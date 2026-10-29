## 1. Агент launchd

- [x] 1.1 Создать `src/parts/ui/daemon/launchd.ts`: метка `ai.stepcast.daemon`,
      путь plist в `~/Library/LaunchAgents`, чистая функция генерации plist
      (`Label`, `ProgramArguments` = `process.execPath` + `bin.js` + `up` +
      `--foreground`, `WorkingDirectory`, `RunAtLoad`, `KeepAlive`,
      `EnvironmentVariables` с `PATH` и, если задана, `SSH_AUTH_SOCK`,
      `StandardOutPath`/`StandardErrorPath` в лог демона; значения экранируются
      для XML)
- [x] 1.2 В том же модуле: `installAgent` (запись plist, `bootout` старого,
      `bootstrap gui/<uid>`), `unloadAgent` (`bootout`, отсутствие агента — не
      ошибка), `removeAgent` (выгрузка и удаление plist); проверка платформы
      и порождение `launchctl` — через внедряемые функции

## 2. Команды

- [x] 2.1 `up.ts`: флаг `--install`; отказ вне macOS с причиной; остановка
      отсоединённого демона перед загрузкой агента; печать пути plist и
      подсказки `stepcast down --uninstall`
- [x] 2.2 `down.ts`: выгрузка агента при его наличии (на macOS), флаг
      `--uninstall` с удалением plist и отказом вне macOS; конфигурацию не
      читать (строка остаётся `independent`)

## 3. Проверка

- [x] 3.1 Тест генерации plist (`test/ui-daemon.test.ts` или новый файл):
      ключи `RunAtLoad`, `KeepAlive`, `PATH`, `SSH_AUTH_SOCK`; отсутствие
      `SSH_AUTH_SOCK` не даёт пустого ключа; экранирование XML в пути
- [x] 3.2 Тесты с подменой `launchctl` и домашнего каталога: установка
      пишет plist и вызывает `bootstrap`; повторная — перезаписывает;
      `down` выгружает, но оставляет plist; `down --uninstall` удаляет;
      не macOS — отказ без записи файлов и вызовов

## 4. Документация и сдача

- [x] 4.1 Дополнить `docs/config.md`: автозапуск демона (`up --install`,
      `down`, `down --uninstall`), что попадает в plist и почему `PATH` и
      `SSH_AUTH_SOCK` снимаются с оболочки установки, ограничение «только
      macOS»; поправить перечень команд, не разрешающих конфигурацию
- [x] 4.2 Прогнать `npm run check` и устранить замечания
