## ADDED Requirements

### Requirement: Учётные данные бэкенда объявляются только глобальной конфигурацией

Ключ `backends.<id>.credentials` SHALL быть допустим только в `~/.stepcast/config.yml`, а проектный конфиг и слой умолчаний вклада плагина MUST его отклонять.
Отказ MUST называть путь ключа и файл, в котором он найден.

#### Scenario: credentials в проектном конфиге

- **WHEN** `.stepcast/config.yml` содержит `backends.claude.credentials.ANTHROPIC_API_KEY`
- **THEN** разбор конфигурации отклоняет её с указанием, что ключ допустим только в глобальной конфигурации

#### Scenario: credentials в умолчаниях плагина

- **WHEN** вклад плагина бэкенда приносит в умолчаниях запись `credentials`
- **THEN** загрузка плагина отклоняет умолчания с путём ключа
