## ADDED Requirements

### Requirement: Работы дорожки получают материалы пункта записью item_refs

Работы петли `propose`, `plan`, `implement`, `review`, `propose-express` и `implement-express` SHALL объявлять в своём контексте запись `item_refs` на файл `item-<дорожка>.json` каталога прогона, так что целевой документ и материалы выбранного пункта попадают в контекст каждой из них. Работы `fix-review` и `verify` MUST NOT объявлять эту запись. Пункт без полей `goal` и `details` MUST давать этим работам тот же контекст, что и до появления записи.

#### Scenario: Материалы видны плану и реализации

- **WHEN** выбранный дорожкой `a` пункт объявляет `goal: backlog/x/goal.md`
- **THEN** состав контекста шагов работ `propose-a`, `plan-a`, `implement-a` и `review-a` содержит `backlog/x/goal.md`

#### Scenario: Облегчённая ветка

- **WHEN** выбранный пункт с `track: express` объявляет `details: backlog/x/notes.md`
- **THEN** состав контекста шагов `propose-express-a` и `implement-express-a` содержит `backlog/x/notes.md`

#### Scenario: Пункт без материалов

- **WHEN** выбранный пункт не объявляет `goal` и `details`
- **THEN** состав контекста работ дорожки не содержит записей, добавленных `item_refs`
