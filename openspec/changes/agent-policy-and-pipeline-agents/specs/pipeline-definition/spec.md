## ADDED Requirements

### Requirement: Ранг выбора пользователя задаётся политикой `agent_policy`
Движок SHALL разрешать агента, модель и effort агентского шага по слоям, упорядоченным политикой. От слабого к сильному: при `force` — `defaults.*` → `pipeline_agents` → `step_agents` → корень документа → работа → шаг; при `fallback` — корень документа → `defaults.*` → `pipeline_agents` → работа → шаг → `step_agents`. Поля `agent` и `effort` разрешаются независимо: побеждает самый сильный слой, объявивший поле. Пока не объявлены `pipeline_agents`, `step_agents` и `agent_policy`, раскрытие даёт тот же шаг, ту же модель и тот же ключ шага, что до введения этих ключей.

#### Scenario: При force документ сильнее
- **WHEN** `agent_policy` не объявлена, корень пайплайна `p` объявляет `agent: claude`, а `pipeline_agents.p` — `agent: codex`
- **THEN** агентский шаг без собственного `agent` в работе без собственного `agent` исполняется агентом `claude`

#### Scenario: При force запись пользователя заполняет молчание документа
- **WHEN** `agent_policy: force`, ни шаг, ни работа, ни корень пайплайна `p` не объявляют `agent`, `defaults.agent` равен `claude`, а `pipeline_agents.p` — `agent: codex`
- **THEN** шаг исполняется агентом `codex`

#### Scenario: При fallback запись пайплайна сильнее корня документа
- **WHEN** `agent_policy: fallback`, корень пайплайна `p` объявляет `agent: claude`, а `pipeline_agents.p` — `agent: codex`
- **THEN** шаг, который ни сам, ни через работу не объявил `agent`, исполняется агентом `codex`

#### Scenario: Запись пайплайна не трогает работу, объявившую свой выбор
- **WHEN** при любой политике работа объявляет `model: opus`, а `pipeline_agents.p` — `model_tier: fast`
- **THEN** шаг этой работы без собственной модели получает модель `opus`

#### Scenario: При fallback запись шага сильнее самого шага
- **WHEN** `agent_policy: fallback`, шаг `implement/code` объявляет `model: opus`, а `step_agents.p.implement.code` — `model: sonnet`
- **THEN** шаг получает модель `sonnet`

#### Scenario: При force запись шага проигрывает шагу
- **WHEN** `agent_policy: force`, шаг `implement/code` объявляет `model: opus`, а `step_agents.p.implement.code` — `model: sonnet`
- **THEN** шаг получает модель `opus`

#### Scenario: Запись действует на все дорожки работы
- **WHEN** работа `implement` раскрыта по дорожкам `a` и `b`, а `step_agents.p.implement.code` объявляет `agent: codex` и побеждает по рангу
- **THEN** шаг `code` исполняется агентом `codex` в обеих копиях работы

### Requirement: Выбор модели слоя пользователя заменяет выбор документа целиком
Движок SHALL считать выбором модели слоя его `model`, а если её нет — его `model_tier`, и SHALL применять выбор слоя пользователя (`defaults.*`, `pipeline_agents`, `step_agents`) только тогда, когда этот слой по рангу сильнее самого близкого к шагу слоя документа, объявившего `model` или `model_tier`. Применённый выбор пользователя заменяет выбор документа целиком: tier пользователя не уступает явной `model` документа, стоящей ниже его по рангу. Между слоями документа сохраняется прежнее правило: явная `model` любого уровня побеждает `model_tier` любого уровня. Если модель пришла из tier, effort этого tier применяется по прежнему правилу.

#### Scenario: Tier пользователя бьёт явную модель корня документа
- **WHEN** `agent_policy: fallback`, корень пайплайна `p` объявляет `model: opus`, а `pipeline_agents.p` — `model_tier: fast`, и у выбранного агента `fast` назначен как `haiku`
- **THEN** шаг без собственного выбора модели в работе без собственного выбора модели получает модель `haiku`

#### Scenario: Выбор документа на работе сильнее выбора пользователя
- **WHEN** `agent_policy: fallback`, работа объявляет `model_tier: deep`, а `pipeline_agents.p` — `model: sonnet`
- **THEN** шаг этой работы получает модель tier `deep`, а не `sonnet`

#### Scenario: Effort tier пользователя едет вместе с его моделью
- **WHEN** `step_agents.p.review.check` побеждает по рангу и объявляет `model_tier: review`, а у агента `review` назначен как `{ model: opus, effort: high }`, и effort не объявлен ни одним слоем сильнее
- **THEN** шаг получает модель `opus` и effort `high`

### Requirement: Чужая агенту модель из документа отбрасывается
Движок SHALL отбрасывать явную `model` из слоя документа, если агент шага пришёл из слоя пользователя (`defaults.agent`, `pipeline_agents`, `step_agents`) и эта модель известна как модель другого бэкенда, и SHALL тогда брать ближайший по рангу `model_tier`, назначенный выбранному агенту, а без него — `backends.<агент>.default_model`. Модель принадлежит бэкенду `B`, если она равна `backends.B.default_model` или значению `backends.B.model_tiers`, либо каталог цен моделей содержит её (именем или псевдонимом) с `backend: B`. Модель, не принадлежащая ни одному бэкенду, не отбрасывается. Отбрасывание при раскрытии не запускает процессов CLI.

#### Scenario: Модель Claude не уходит в Codex
- **WHEN** корень пайплайна объявляет `model: opus` и не объявляет `agent`, `defaults.agent` равен `codex`, `opus` назначена в `backends.claude.model_tiers`, а `backends.codex.default_model` — `gpt-5.6-terra`
- **THEN** шаг исполняется агентом `codex` с моделью `gpt-5.6-terra`, а его происхождение модели называет отброшенную `opus` и слой, из которого она пришла

#### Scenario: Отброшенную модель заменяет tier
- **WHEN** агент `codex` пришёл из `pipeline_agents`, работа объявляет `model: opus`, принадлежащую `claude`, а корень пайплайна — `model_tier: deep`, назначенный у `codex`
- **THEN** шаг получает модель tier `deep` агента `codex`

#### Scenario: Неизвестная модель сохраняется
- **WHEN** агент пришёл из `defaults.agent`, а документ объявляет модель, которой нет ни в одной записи `backends` и ни в каталоге цен
- **THEN** шаг получает эту модель без изменений

#### Scenario: Агент документа не включает правило
- **WHEN** работа объявляет `agent: codex` и `model: opus`
- **THEN** модель `opus` не отбрасывается: агент пришёл не от пользователя

### Requirement: Происхождение агента, модели и effort записывается
Раскрытие SHALL записывать для каждого агентского шага слой, давший агента, слой, давший модель, и слой, давший effort. Слои — `step`, `job`, `pipeline`, `config`, `pipeline_agents`, `step_agents`, а для модели также `tier` и `backend`. Для слоёв конфигурации записывается файл, давший значение. Отброшенная чужая модель записывается вместе со слоем, из которого пришла. Происхождение не входит в шаг, по которому считается ключ шага.

#### Scenario: Агент из записи пайплайна
- **WHEN** агента шага дал `pipeline_agents.p` из `~/.stepcast/config.yml`
- **THEN** происхождение агента шага — слой `pipeline_agents` с этим файлом

#### Scenario: Справочное поле не меняет ключ шага
- **WHEN** два раскрытия дают шагу одного агента и одну модель из разных слоёв
- **THEN** ключ шага у них совпадает
