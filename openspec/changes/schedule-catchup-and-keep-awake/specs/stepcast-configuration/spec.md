## ADDED Requirements

### Requirement: Секция ui.triggers настраивает сервис триггеров машины

Конфигурация SHALL принимать секцию `ui.triggers` с ключами `enabled` (умолчание `false`), `max_catchup_hours` (неотрицательное число, умолчание 2), `keep_awake` (умолчание `false`), `require_network` (умолчание `true`), `max_concurrent_runs` (целое ≥ 1, умолчание 10), `max_concurrent_agent_jobs` (целое ≥ 1, умолчание 4) и `schedules` (список записей с `repo`, `pipeline`, `cron` и необязательными `timezone`, `branch`). Секция MUST допускаться только в домашнем конфиге: её значение в проектном конфиге SHALL отклоняться так же, как другие машинно-зависимые ключи. Неизвестный ключ секции и запись `schedules` без обязательного поля MUST отклоняться разбором конфигурации с именем ключа. Происхождение значений секции SHALL показываться `stepcast config` наравне с остальными ключами.

#### Scenario: Умолчания

- **WHEN** домашний конфиг не содержит `ui.triggers`
- **THEN** `stepcast config` показывает `enabled: false`, `max_catchup_hours: 2`, `keep_awake: false`, `require_network: true`, `max_concurrent_runs: 10`, `max_concurrent_agent_jobs: 4` с происхождением из встроенного слоя

#### Scenario: Секция в проектном конфиге

- **WHEN** `.stepcast/config.yml` проекта содержит `ui.triggers.keep_awake: true`
- **THEN** разбор конфигурации отклоняет ключ как допустимый только в домашнем конфиге

#### Scenario: Запись расписания без пайплайна

- **WHEN** запись `ui.triggers.schedules` содержит `repo` и `cron`, но не `pipeline`
- **THEN** разбор конфигурации завершается ошибкой, называющей отсутствующий ключ и номер записи

#### Scenario: Отрицательное окно догона

- **WHEN** `ui.triggers.max_catchup_hours: -1`
- **THEN** разбор конфигурации отклоняет значение с именем ключа
