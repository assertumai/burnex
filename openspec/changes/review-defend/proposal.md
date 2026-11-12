## Why

Режим `discussion` (`review-discussion`) не работает, когда у ревьюеров разный
фокус. Это видно в прогоне `review-discussion-example` (b5b13d). Ревьюер
безопасности и ревьюер тестов совпали по существу уже в первом раунде, но
все шесть реплик ушли на спор о границах областей. Каждый отклонял чужой итог
как «вне фокуса», обсуждение закончилось по лимиту, и агрегатор решал сам. На
это есть три причины:

- согласие голосуется за итог целиком, поэтому согласиться значит принять
  находки чужой области;
- ревьюер не знает, что фокусов несколько, и считает чужие находки выходом
  за рамки ревью;
- возражения против находки приходят не от того, кто знает, почему код такой.

Пользователь выбрал другую схему, как в ревью кода между людьми. Каждый
ревьюер ищет в своей области и обсуждает свои замечания с имплементатором —
агентом, написавшим код. Возражает автор, который знает задачу, ограничения и
отвергнутые варианты. Спорное решает агрегатор.

## What Changes

- **BREAKING.** Режим `discussion` и блок `discussion.max_messages` удалены.
  Стратегия с `mode: discussion` отклоняется разбором с подсказкой о режиме
  `defend`. Изменения `review-discussion` и `ui-review-discussion` заменены
  этим изменением и удалены. Требования к ленте шага `review` в режиме
  `independent`, которые они вводили, перенесены сюда.
- Новый режим стратегии `mode: defend` с блоком `defend: { rounds }` (1–5,
  по умолчанию 2) и необязательным участником `defender` (выбор агента и
  `prompt`).
- Новое поле шага `review`: `implementer: <шаг>` или `<работа>.<шаг>` —
  агентский шаг, чья сессия защищает код. Защитник — **форк** сессии
  имплементатора, отдельный на каждого ревьюера. Исходная сессия не меняется,
  ветки идут параллельно.
- Без имплементатора, без записанной сессии или на бэкенде без форка
  защитник — свежий агент по `defender` стратегии. Журнал называет причину.
- Обсуждение идёт ветками «ревьюер ↔ защитник», по каждой находке отдельно.
  Защитник отвечает `accept`, `dispute` или `clarify` с доводом и
  доказательством. Ревьюер отвечает `maintain`, `withdraw` или `revise`
  (с новой серьёзностью). Находка закрывается как `accepted` или
  `withdrawn`. Открытая после `rounds` раундов — `contested`.
- Агрегатор получает каждую находку с её статусом и перепиской.
  `accepted` входит в итог, `withdrawn` не входит, `contested` решает он сам.
- Адаптеры получают возможность `forkSessions` и поле вызова `forkFrom`.
  Claude: `--resume <id> --fork-session --session-id <новый>`. Codex:
  `codex exec fork <id>`.
- Журнал шага: `defense.ndjson` (находки, реплики в форме A2A `Message`,
  закрытия находок, исход) и события `review.defender`, `review.message`,
  `review.settled`, `review.defense.finished`.
- Витрина: лента шага `review` в режиме `defend` — ветки по ревьюерам,
  карточки находок со статусами, панель находок. На экране стратегий —
  режим «Independent / Defend», поле `rounds` и выбор агента защитника.

## Capabilities

### New Capabilities

<!-- нет -->

### Modified Capabilities

- `review-strategy`: режим `defend` вместо `discussion`, поле шага
  `implementer`, защитник-форк, ветки по находкам, решение агрегатора,
  журнал и события.
- `ui-dashboard`: лента шага `review` с ветками защиты; редактор стратегии
  с режимом `defend`.

## Impact

- Код:
  - `src/parts/pipeline/document/reviewStrategy.ts`, `model.ts`, `expand.ts`;
  - `src/parts/pipeline/steps/review/*`;
  - `src/parts/pipeline/run/exec/reviewStep.ts`, `reviewDiscussion.ts` (заменяется);
  - `runner.ts`, `stepKey.ts`, `journal/schema.ts`;
  - адаптеры `claude` и `codex`, `backend/types.ts`, `agentStep.ts`;
  - линт;
  - `src/parts/ui/reviewFeed.ts`, `ui/src/components/ReviewFeed.tsx`,
    `ui/src/pages/ReviewStrategies.tsx`.
- Схемы:
  - `schema/review-strategy.schema.json`;
  - новые `schema/review-defense.schema.json` и
    `schema/review-rebuttal.schema.json`;
  - удаляется `schema/review-message.schema.json`.
- Документация: `docs/pipeline-format.md` (раздел review), `examples/review/`.
- Журналы прогонов в режиме `discussion` витрина показывает списком
  участников и вердиктом, без ленты.
