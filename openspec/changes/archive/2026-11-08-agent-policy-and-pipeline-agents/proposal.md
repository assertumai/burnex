## Why

Агента, модель, tier и effort агентского шага выбирает цепочка
**step → job → pipeline → конфигурация** (`docs/pipeline-format.md`, «Агент,
модель, effort и tier»; `parseAgentStep` и `expandPipeline` в
`src/parts/pipeline/document/expand.ts`). Пользователь в ней всегда стоит
внизу. `defaults.agent` и `defaults.model` действуют только на шаги,
которым документ ничего не назначил
(`docs/config.md`, «`defaults.model` применяется только к шагам, не
объявившим модель…»). Поэтому заменить `opus` на `sonnet` в одном пайплайне
или отправить один шаг в Codex можно только правкой файла пайплайна. Для
поставляемого пайплайна (`stepcast:<имя>`) правка — это ещё и форк пакета.
Указать выбор для одного пайплайна или одного шага тоже негде: `defaults.*`
действует на все пайплайны машины сразу.

Есть и вторая беда. Если агент пришёл от пользователя, а модель — из
документа, получается заведомо нерабочая пара. Например, `defaults.agent:
codex` вместе с `model: opus` в документе: модель передаётся в Codex как есть,
и шаг падает уже у CLI.

Burnex решил это ключами `pipeline_agents`/`step_agents` и политикой
`agent_policy: force | fallback` (`docs/burnex-after-stepcast.md`, «Агент и
уровень на шаг и на весь пайплайн»). Это изменение переносит то же
устройство: по умолчанию поведение остаётся прежним, а пользователь, которому
нужно, может стать сильнее документа.

## What Changes

- **Новые ключи конфигурации** `pipeline_agents` и `step_agents`
  (`src/parts/pipeline/config/schema.ts`). Запись — частичный выбор
  `{ agent?, model?, model_tier?, effort? }`.
  `pipeline_agents.<имя пайплайна>` действует на весь пайплайн,
  `step_agents.<имя пайплайна>.<работа>.<шаг>` — на один агентский шаг.
  Пайплайн определяется по полю `name` документа. Запись, где одновременно
  есть `model` и `model_tier`, отклоняется. Оба ключа допустимы в обоих слоях
  и сливаются по листьям.
- **Новый ключ `agent_policy: force | fallback`**, умолчание `force`.
  - `force`: документ сильнее. Выбор пользователя достаётся только тем
    шагам, для которых ни шаг, ни работа, ни корень документа ничего не
    объявили. Существующее поведение `defaults.*` не меняется.
  - `fallback`: пользователь сильнее корня документа.
    `pipeline_agents` и `defaults.*` побеждают `agent`/`model`/`model_tier`
    корня пайплайна, но уступают работе и шагу. `step_agents` побеждает и
    сам шаг.
  - При обеих политиках `pipeline_agents` не трогает шаг, который сам или
    через свою работу объявил `agent`, `model` или `model_tier`.
- **Чужая модель отбрасывается.** Агент может прийти от пользователя
  (`defaults.agent`, `pipeline_agents`, `step_agents`), а модель — из
  документа. Если эта модель известна как модель другого бэкенда, она
  отбрасывается. Вместо неё берётся ближайший tier, затем
  `backends.<агент>.default_model`. Принадлежность модели определяется
  статически: по назначениям `backends.*` конфигурации и по каталогу цен
  `src/builtin/prices/model-prices.json`. Неизвестную модель не трогаем.
- **Источник агента и модели виден.** Раскрытие записывает, какой слой дал
  агента: сегодня это не записывается вовсе. К слоям модели (`ModelOrigin`)
  добавляются `pipeline_agents`, `step_agents` и отметка об отброшенной
  чужой модели.
- **`stepcast config --pipeline <p>`.** `<p>` — путь к файлу пайплайна или
  `stepcast:<имя>`. Команда раскрывает пайплайн и печатает действующую
  политику, а для каждого агентского шага — агента, модель и effort с
  источником каждого. Отдельно перечисляются записи
  `pipeline_agents`/`step_agents`, которые проиграли документу или ссылаются
  на шаг, которого в пайплайне нет.
- **Экран Pipelines пишет выбор.** На карточке пайплайна и шага можно выбрать
  агента, tier или модель и effort. Выбор записывается в
  `pipeline_agents`/`step_agents` файла `~/.stepcast/config.yml` тем же
  способом, что пишет экран настроек: с сохранением комментариев, атомарно и
  с проверкой схемой. Экран показывает действующую политику и предупреждает,
  если запись проигрывает документу.
- **Документация.** В `docs/pipeline-format.md` описан полный порядок выбора
  при обеих политиках, в `docs/config.md` — новые ключи.

Сознательно вне объёма:

- `agent`/`model` предиката `judge`, `attempts.escalation[].model` и
  агент `on_fail`: у них свои цепочки, и в этом изменении они не меняются;
- политика отдельно для каждого пайплайна (`pipeline_agents.<p>.policy`);
- перечисление моделей CLI (`discoverModels`) при раскрытии: раскрытие
  остаётся детерминированным и не запускает процессы.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `stepcast-configuration`: ключи `pipeline_agents`, `step_agents`,
  `agent_policy`; отчёт `stepcast config --pipeline`; запись выбора с экрана
  Pipelines.
- `pipeline-definition`: порядок выбора агента, модели, tier и effort с
  учётом слоёв пользователя и политики; отбрасывание чужой модели.

## Impact

- `src/parts/pipeline/config/schema.ts`, `resolve.ts`, `merge.ts`: новые ключи,
  их нормализация в `Config`, происхождение значений.
- `src/parts/pipeline/document/expand.ts` (`StepDefaults`, `parseAgentStep`,
  `expandPipeline`) и `document/model.ts` (`ModelOrigin`, `EffortOrigin`,
  новый `AgentOrigin`, `ExpandedPipeline.agentOrigins`).
- `src/parts/pipeline/run/budget/priceCatalog.ts`: поиск бэкенда по имени
  модели только для чтения.
- `src/parts/pipeline/commands/config.ts`: флаг `--pipeline`.
- `src/parts/ui/pipelines.ts`, `src/parts/ui/screens/pipelines/server.ts`,
  `ui/src/pages/Pipelines.tsx`: показ источника агента, новый маршрут записи;
  запись в файл переиспользует код `src/parts/ui/settings.ts`.
- Публикуемая JSON-схема конфигурации (`schema/`) пересобирается.
- Ключ шага (`computeStepKey`) хеширует итогового агента и модель. Поэтому
  правка `pipeline_agents`/`step_agents`, которая меняет выбор, меняет и ключ
  затронутых шагов. `resume` остаётся на паре, закреплённой в
  `pipeline.lock.yml`.
