## Why

Шаг `review` проверяет уже сделанную работу. Обсуждать фичу до реализации
нечем. Хочется, чтобы несколько агентов независимо предложили подход,
сошлись на одном проектном документе, и уже по нему шёл шаг реализации.

Прежний режим `discussion` (`review-discussion`) показал, как делать не
надо. Участники голосовали за итог целиком, у текста не было владельца, и
обсуждение уходило в лимит. Режим `defend` работает потому, что спорят по
отдельным пунктам, у документа один владелец, а остановку определяет
движок. Новый шаг строится так же.

Схему согласовали в обсуждении двух агентов (Claude Opus 5.5 и Fable 5.2).
Вариант «один автор, остальные критикуют» не даёт альтернатив: критики
шлифуют одну идею. Вариант «каждый предлагает своё, потом сходятся»
повторяет провал `discussion`. Выбран гибрид: независимые предложения, один
черновик у автора, спор по точкам решения, итог у агрегатора.

## What Changes

- Новый вид шага `discuss:`. Ключи как у `review`: `prompt`,
  `output_schema`, `permissions`, `context*`, `expect`, `timeout`,
  `attempts`, `budget`. Ключи `agent`, `model`, `model_tier`, `effort` и
  `session` шаг отклоняет: участников объявляет стратегия.
- Новый документ `kind: discussion-strategy` со слоями
  `.burnex/discussion-strategies/` и `~/.burnex/discussion-strategies/`
  либо явным путём. Поля: `name`, `description`, `profiles`,
  `participants[{ id, agent | model | model_tier, effort, focus }]`,
  `author`, `aggregator`, `rounds` (1–5, по умолчанию 1). Формы полей и
  резолвер слоёв общие со стратегией ревью.
- Исполнение по фазам:
  1. **Предложения.** Участники параллельно и независимо пишут
     предложения.
  2. **Черновик.** Автор, который не подаёт предложений, пишет один
     черновик с точками решения `d1…` и диаграммами Mermaid.
  3. **Возражения.** Участники в своих сессиях возражают по точкам и
     диаграммам: вес `blocking | preference`, «что сломается»,
     альтернатива.
  4. **Защита.** Общие раунды на механике `runDefense`: автор одним ходом
     отвечает на открытые `blocking`, участники отвечают `maintain` или
     `withdraw`.
  5. **Итог.** Агрегатор решает спорные (`contested`) точки и пишет
     документ по `output_schema` шага.
- Встроенная схема `burnex:design-doc` для итога: решения, отклонённые
  варианты, диаграммы Mermaid со ссылками на решения, риски, открытые
  вопросы.
- Поля движка в итоге — всегда, при любой `output_schema`: `agreed`,
  `unresolved[]`, `changed_by_aggregator[]`. Инвариант: при `agreed: true`
  список `unresolved` пуст.
- Журнал шага `discuss.ndjson` и события `discuss.*`. Каталоги
  участников — как у `review`.
- Линт и предстартовые проверки шага `discuss` и стратегии.

Предусловие — изменение `review-defend-shared-session`. Оно вводит общие
раунды и выносит построители промптов из `runDefense` в параметры. Без
общих раундов два форка автора приняли бы противоположные альтернативы к
одной точке решения.

Вне этого изменения:
- витрина документа и ленты шага `discuss`;
- рендер документа в HTML и в OpenSpec `design.md`;
- редактор стратегий обсуждения.

Это будет отдельное изменение `render-design`.

## Capabilities

### New Capabilities

- `discussion-step`: вид шага `discuss`, документ `discussion-strategy`,
  фазы исполнения, контракт итога (`burnex:design-doc` и поля движка),
  журнал и события, линт.

### Modified Capabilities

<!-- нет: вид шага вносится строкой встроенного слоя по действующему
     требованию step-kinds, а механика защиты меняется изменением
     review-defend-shared-session -->

## Impact

- Код:
  - `src/parts/pipeline/document/`: новый `discussionStrategy.ts`;
    `model.ts`, `expand.ts`, `lock*.ts`; общие формы вынесены из
    `reviewStrategy.ts`;
  - `src/parts/pipeline/steps/discuss/`: строка вида, участники, промпты;
  - `src/parts/pipeline/run/exec/discussStep.ts`; `runner.ts`;
    `stepKey.ts`; `journal/schema.ts`; `budget/accumulator.ts`;
  - `src/parts/pipeline/domain/lint.ts`.
- Схемы:
  - `schema/discussion-strategy.schema.json`;
  - `schema/design-doc.schema.json`;
  - ходы участников: `discuss-proposal`, `discuss-draft`,
    `discuss-objections`;
  - ходы защиты: `discuss-defense` (`accept` обязан нести `change`) и
    `discuss-rebuttal` (`maintain | withdraw`).
- Документация: `docs/pipeline-format.md` (раздел discuss),
  `docs/run-layout.md`, `examples/discuss/`.
- Зависимостей не добавляется.
