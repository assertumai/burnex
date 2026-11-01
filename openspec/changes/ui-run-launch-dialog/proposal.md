## Why

`POST /api/run` уже принимает `env` и `shadow` (`src/parts/ui/runLaunch/row.ts`,
изменение `shadow-run-mode`), а `stepcast run` — флаги `--env` и `--shadow`, но
единственный диалог запуска на витрине («Start work» на «Scrum») шлёт только
проект, пайплайн и вход `item`. Shadow-режим и переопределение env с витрины
недоступны, агента на один прогон не выбрать ни там, ни в CLI, а на «Runs»
запустить прогон нельзя вовсе. Прогон «насухо» при этом записан в `run.json`
ключом `mode: shadow`, но обзор этот ключ не читает, и в списке такой прогон
неотличим от настоящего (`docs/ui-proposals.md`, п. 2 и 3).

## What Changes

- Общий диалог ручного запуска для «Scrum» и «Runs»: проект (на «Runs»),
  пайплайн, входы, строки env `KEY=VALUE`, переключатель shadow и выбор агента
  — одна форма, одна отправка `POST /api/run`. «Start work» на доске становится
  этим диалогом с предвыбранным пунктом; на «Runs» появляется кнопка «New run».
- Форма проверяет env теми же правилами, что схема демона и
  `validateEnvOverrides`: имя `^[A-Za-z_][A-Za-z0-9_]*$`, значение в одну
  строку и не длиннее 500 символов, ключ объявлен в верхнеуровневом `env:`
  выбранного пайплайна. Ошибка показывается у строки до отправки.
- Представление пайплайна в `GET /api/pipelines` дополняется именами
  объявленных переменных `env:` и признаком готовности к shadow-режиму
  (результат той же проверки, что `assertShadowDeclarations`, с перечнем шагов
  без `external`). Переключатель shadow у неготового пайплайна выключен, а
  причина показана рядом: иначе отказ дочернего `stepcast run` после ответа 202
  пользователь не увидел бы.
- `stepcast run --agent <имя>`: агент по умолчанию на этот прогон — слоем
  флага над `defaults.agent`, тем же путём, каким его уже применяет
  `stepcast config --agent`. Неизвестный агент — отказ до создания каталога
  прогона. Выбор пишется в `run.json` ключом `agent_override`, и `resume` берёт
  его оттуда, как `env_overrides` и `mode`.
- `POST /api/run` принимает необязательное поле `agent` (строка формы имени
  агента) и передаёт его ключом `--agent`.
- Обзор прогона несёт `mode` из манифеста; список «Runs» и страница прогона
  помечают shadow-прогон бейджем `shadow`. Прогон без ключа пометки не получает.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `pipeline-execution`: `stepcast run` принимает `--agent` — агента по
  умолчанию на один прогон, с отказом до старта для неизвестного имени.
- `run-journal`: манифест прогона называет переопределённого агента ключом
  `agent_override`; `resume` его наследует.
- `ui-daemon`: `POST /api/run` принимает поле `agent`; представление пайплайна
  несёт объявленные имена `env:` и готовность к shadow-режиму; обзор прогона
  несёт `mode`.
- `ui-dashboard`: диалог ручного запуска на «Scrum» и «Runs» с env, shadow и
  агентом; бейдж `shadow` в списке прогонов и на странице прогона.

## Impact

- CLI и журнал: `src/parts/pipeline/commands/run.ts` (флаг, повторное
  разрешение конфигурации со слоем флага), `src/parts/pipeline/run/runner.ts`,
  `src/parts/pipeline/run/journal/schema.ts`, `src/parts/pipeline/commands/resume.ts`,
  справка CLI и `docs/config.md`.
- Демон: `src/parts/ui/runLaunch.ts`, `src/parts/ui/runLaunch/row.ts`,
  `src/parts/ui/pipelines.ts`, `src/parts/ui/overview.ts`.
- Витрина: `ui/src/api.ts` (`launchRun`), новый общий компонент диалога,
  `ui/src/pages/Scrum.tsx`, `ui/src/pages/Runs.tsx`, `ui/src/pages/RunDetail.tsx`.
- Тесты: `test/run-launch.test.ts`, тесты `run`/`resume`, тесты обзора и
  `ui/test` для формы и бейджа.
- Обратная совместимость: все новые поля необязательны; манифест без
  `agent_override` и без `mode` читается как прежде.
