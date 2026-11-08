## 1. Агент на один прогон (CLI и журнал)

- [x] 1.1 `src/parts/pipeline/commands/run.ts`: флаг `--agent` (`kind: 'string'`) в
      `row`; при флаге — повторное `resolveConfig` с `flags: { 'defaults.agent': имя }`
      и умолчаниями плагинов реестра, как в `runConfigCommand` (design.md,
      Решение 1); неизвестное имя — `StepcastError` с перечнем бэкендов до
      записи прогона, в том числе при `--dry-run`. Справка флага называет
      порядок слоёв.
- [x] 1.2 `src/parts/pipeline/run/journal/schema.ts`: необязательное
      `agent_override` в `RunManifestSchema` с комментарием рядом с
      `env_overrides`/`mode`; `src/parts/pipeline/run/runner.ts` пишет его при
      флаге.
- [x] 1.3 `src/parts/pipeline/commands/resume.ts`/`runner.ts`: брать агента из
      `agent_override` исходного манифеста, разрешать конфигурацию тем же путём
      и писать ключ в новый манифест (design.md, Решение 2).
- [x] 1.4 Тесты: шаг без явного агента получает выбранного; шаг с агентом
      документа и пайплайн с `pipeline_agents` — нет; неизвестный агент —
      отказ без каталога прогона (и при `--dry-run`); `agent_override` в
      манифесте и его отсутствие; `resume` наследует; прежний манифест читается.
- [x] 1.5 `docs/config.md` и справка CLI: `--agent` рядом с `defaults.agent`.

## 2. Демон

- [x] 2.1 `src/parts/ui/runLaunch.ts`: опция `agent?: string` → `--agent`;
      `src/parts/ui/runLaunch/row.ts`: поле `agent` в `PostBodySchema`
      (`^[A-Za-z0-9_-]+$`), передача в `launchRun`; обновить текст ошибки
      формата.
- [x] 2.2 `src/parts/pipeline/run/shadow.ts`: вынести перечень шагов без
      `external` в функцию без броска; `assertShadowDeclarations` вызывает её,
      текст отказа CLI не меняется.
- [x] 2.3 `src/parts/ui/pipelines.ts`: в `PipelineView` — `envNames` (ключи
      `expanded.pipeline.env`, без значений) и `shadow: { ready } | { ready:
      false, steps }` (design.md, Решение 3).
- [x] 2.4 `src/parts/ui/overview.ts`: `RunOverview.mode?: 'shadow'` из манифеста
      рядом с `trigger`; снимок `GET /api/run` для страницы прогона несёт
      `mode` и `agent_override`.
- [x] 2.5 Тесты: `test/run-launch.test.ts` — `agent` доезжает до argv, 400 на
      `"--shadow"` и `1`, запрос без поля без `--agent`; тест представления
      пайплайна — имена env без значений, готовность и перечень шагов; тест
      обзора — `mode` есть у shadow-прогона и нет у обычного.

## 3. Витрина

- [x] 3.1 `ui/src/api.ts`: `launchRun` принимает `env`, `shadow`, `agent`; типы
      `PipelineView` и `RunOverview` дополнены новыми полями.
- [x] 3.2 Модуль правил env формы: разбор строки по первому `=`, имя, длина,
      однострочность, объявленность, повтор (design.md, Решение 4).
- [x] 3.3 Компонент `RunLaunchDialog`: проект (если не предвыбран), пайплайн,
      поля входов по `inputs` (вход `item` заполняется пунктом доски), строки
      env с ошибкой у строки, переключатель shadow с причиной недоступности,
      поле агента из `backends` `GET /api/settings` с числом затронутых шагов
      (`agentOrigin.layer === 'config'`); пустые поля в запрос не попадают.
- [x] 3.4 `ui/src/pages/Scrum.tsx`: «Start work» открывает `RunLaunchDialog` с
      предвыбором проекта и пункта вместо своей формы; `ui/src/pages/Runs.tsx`:
      кнопка «New run» открывает тот же диалог.
- [x] 3.5 `ShadowBadge` рядом с `TriggerBadge` в строке «Runs» и в шапке
      `ui/src/pages/RunDetail.tsx`; в шапке — агент из `agent_override`.
- [x] 3.6 Тесты `ui/test`: правила env (те же примеры, что в тесте схемы
      демона), тело запроса со всеми полями и без них, предвыбор на «Scrum»,
      недоступный shadow с адресами шагов, подсказка «выбор не меняет
      пайплайн», ошибка 400 в диалоге, бейдж у shadow-прогона и его отсутствие
      у обычного.

## 4. Завершение

- [x] 4.1 `docs/ui-proposals.md`: строки «Shadow-режим» и `run --env` п. 2 и
      «Диалог запуска прогона» п. 3 отметить сделанными.
- [x] 4.2 `npm run check` зелёный.
