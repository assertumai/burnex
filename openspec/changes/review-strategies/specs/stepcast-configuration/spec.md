## ADDED Requirements

### Requirement: Участник стратегии ревью адресуется в step_agents

Запись `step_agents.<пайплайн>.<работа>.<шаг>` для шага вида `review` SHALL выбирать агента агрегатору стратегии, а запись `step_agents.<пайплайн>.<работа>.<шаг>/<ревьюер>` — ревьюеру с этим `id`. Для участника слой стратегии MUST занимать место слоя «шаг» в рангах `agent_policy`. Запись с `/<ревьюер>`, которого в стратегии нет, или у шага не вида `review` MUST считаться записью без действия с названной причиной, а не ошибкой.

#### Scenario: Подмена агента ревьюеру

- **WHEN** при `agent_policy: fallback` запись `step_agents.p.review.review-diff/security` объявляет `agent: claude`, а стратегия даёт ревьюеру `security` профиль на `codex`
- **THEN** ревьюер `security` исполняется агентом `claude`, остальные участники — прежними

#### Scenario: Запись шага — агрегатор

- **WHEN** при `agent_policy: fallback` запись `step_agents.p.review.review-diff` объявляет `model_tier: deep`
- **THEN** агрегатор исполняется уровнем `deep`, а ревьюеры — своими выборами из стратегии

#### Scenario: Ревьюера нет

- **WHEN** запись `step_agents.p.review.review-diff/perf` объявлена, а в стратегии нет ревьюера `perf`
- **THEN** пайплайн исполняется, а `burnex config --pipeline` называет запись без действия с причиной «ревьюера нет в стратегии»
