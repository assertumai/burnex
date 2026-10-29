## ADDED Requirements

### Requirement: Автозапуск демона через launchd на macOS

Команда `stepcast up --install` SHALL записывать агент `~/Library/LaunchAgents/ai.stepcast.daemon.plist` с ключами `RunAtLoad` и `KeepAlive`, запускающий `stepcast up --foreground`, и загружать его в сессию пользователя. `EnvironmentVariables` агента MUST нести `PATH` и `SSH_AUTH_SOCK` из окружения оболочки, вызвавшей команду; переменная, не заданная в оболочке, MUST NOT попадать в plist пустой. Повторный вызов SHALL перезаписывать plist и перезагружать агент, а не завершаться ошибкой.

#### Scenario: Агент установлен

- **WHEN** `stepcast up --install` вызвана на macOS
- **THEN** записан plist с `RunAtLoad`, `KeepAlive`, `PATH` и `SSH_AUTH_SOCK` текущей оболочки, агент загружен, команда завершается кодом 0

#### Scenario: Нет агента SSH в оболочке

- **WHEN** `stepcast up --install` вызвана в оболочке без `SSH_AUTH_SOCK`
- **THEN** plist записан без этого ключа, а `PATH` в нём есть

#### Scenario: Повторная установка

- **WHEN** `stepcast up --install` вызвана при уже установленном агенте
- **THEN** plist перезаписан по текущему окружению, агент перезагружен, второго демона нет

#### Scenario: До установки был отсоединённый демон

- **WHEN** `stepcast up --install` вызвана при работающем демоне, поднятом обычным `stepcast up`
- **THEN** тот демон останавливается, чтобы агент мог занять порт `ui.port`

### Requirement: Остановка демона выгружает агент launchd

Команда `stepcast down` SHALL при загруженном агенте `ai.stepcast.daemon` выгружать его, оставляя plist на месте, — иначе `KeepAlive` поднял бы остановленный демон заново. Команда `stepcast down --uninstall` SHALL дополнительно удалять plist; при его отсутствии MUST завершаться кодом 0. Команда `down` MUST оставаться независимой от конфигурации: ни выгрузка, ни удаление не читают её значений.

#### Scenario: Остановка выгружает агент

- **WHEN** `stepcast down` вызвана на macOS при загруженном агенте
- **THEN** агент выгружен, демон остановлен и не поднимается заново, plist сохранён

#### Scenario: Удаление автозапуска

- **WHEN** `stepcast down --uninstall` вызвана при установленном агенте
- **THEN** агент выгружен, демон остановлен, plist удалён

#### Scenario: Удалять нечего

- **WHEN** `stepcast down --uninstall` вызвана, когда plist нет
- **THEN** команда сообщает, что автозапуск не установлен, и завершается кодом 0

#### Scenario: Агент не установлен

- **WHEN** `stepcast down` вызвана без флагов, а агента нет
- **THEN** поведение прежнее: демон останавливается или сообщается, что он не запущен

### Requirement: Автозапуск отказывает вне macOS

Команды `stepcast up --install` и `stepcast down --uninstall` SHALL на системе, отличной от macOS, завершаться ошибкой с причиной — launchd есть только на macOS, — не создавая и не удаляя файлов и не вызывая `launchctl`. Команда `stepcast down` без флагов MUST работать на всех системах как прежде.

#### Scenario: Установка на Linux

- **WHEN** `stepcast up --install` вызвана на Linux
- **THEN** команда завершается ошибкой, называющей причину, ни один файл не записан

#### Scenario: Остановка на Linux

- **WHEN** `stepcast down` вызвана на Linux без флагов
- **THEN** демон останавливается или сообщается, что он не запущен, без обращения к launchd
