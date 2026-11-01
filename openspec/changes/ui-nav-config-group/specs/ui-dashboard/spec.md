## ADDED Requirements

### Requirement: Группа меню `config` отделяет настройку от наблюдения
Витрина SHALL показывать группы поставки бокового меню в порядке `work`, `extend`, `config`, `system`, а встроенные маршруты экранов Agents, Secrets, Schedule, Packages и System SHALL объявлять `nav.group: config`; Usage и Cleanup остаются в `system`, пункты без группы — после групп.

#### Scenario: Порядок групп в меню поставки
- **WHEN** витрина открыта с составом поставки
- **THEN** заголовки групп идут в порядке Work, Extend, Config, System, а под Config стоят Agents, Secrets, Schedule, Packages и System

#### Scenario: Наблюдательные экраны остались в `system`
- **WHEN** витрина открыта с составом поставки
- **THEN** под заголовком System стоят только Usage и Cleanup

#### Scenario: Домашний слой возвращает пункт в прежнюю группу
- **WHEN** `~/.stepcast/routes.yml` объявляет `nav: { group: system }` для `screen-secrets`
- **THEN** пункт Secrets показан в группе System, остальные поля маршрута не меняются
