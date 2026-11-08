## ADDED Requirements

### Requirement: Запись демона хранит каталог запуска
Запись отсоединённого демона в `~/.stepcast/ui.pid` SHALL содержать поле `cwd` — каталог, в котором вызван `stepcast up`, а запись без этого поля SHALL читаться как прежде, с отсутствующим каталогом.

#### Scenario: Новая запись
- **WHEN** `stepcast up` поднимает демон в каталоге `/p`
- **THEN** `ui.pid` содержит `"cwd": "/p"` наряду с `pid`, `port` и `started_at`

#### Scenario: Запись прежней версии
- **WHEN** `ui.pid` содержит только `pid`, `port` и `started_at`
- **THEN** запись читается, демон считается поднятым, а каталог — неизвестным

### Requirement: Демон управляемой установки запускается через current
Если исполняемый движок лежит в каталоге релизов паспорта `managed`, `stepcast up` и `stepcast up --install` SHALL запускать демон по пути `<releases_dir>/current/dist/src/bin.js`, а не по пути конкретного релиза.

#### Scenario: Агент переживает обновление
- **WHEN** `stepcast up --install` вызван движком из `releases/0.3.0` при паспорте `managed`
- **THEN** `ProgramArguments` агента содержат `<releases_dir>/current/dist/src/bin.js`

#### Scenario: Движок не из релизов
- **WHEN** `stepcast up` вызван из рабочего дерева при отсутствии паспорта
- **THEN** демон запускается по пути `bin.js` этого дерева, как прежде
