## Why

Строка `run` всегда идёт через `sh -c` (`cmd.exe /c` на Windows) — `runProcess` в `src/parts/pipeline/run/exec/process.ts` включает `shell: true` для любой строки. Шагу, которому нужен `bash -lc`, `zsh` или `pwsh`, остаётся вручную оборачивать команду в список argv и экранировать её, теряя читаемую строковую форму.

## What Changes

- Новый ключ `shell` — непустой список строк, префикс argv. Строковый `run` запускается как `[...shell, command]` без оболочки платформы. Объявляется на шаге `run`, на месте подключения работы и в теле работы, на корне пайплайна; действует ближайшее объявление: шаг → работа → пайплайн. Умолчание — прежнее поведение.
- Списочная форма `run` ключ не затрагивает: argv и так исполняется без оболочки. Объявление на работе или пайплайне на такие шаги, на `script`, `agent` и плагинные шаги не действует и ошибкой не является; на самом шаге, кроме `run`, ключ — ошибка разбора.
- `stepcast lint` отклоняет пустой список `shell`.
- Решение: оболочка вычисляется при раскрытии пайплайна в поле шага (по образцу `skip_exit_code`), а не при запуске, поэтому входит в ключ шага и в lock-хеш. `runProcess` не меняется: строка с префиксом превращается в список argv до его вызова.
- `docs/pipeline-format.md` описывает ключ рядом с описанием формы `run`.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `pipeline-definition`: ключ `shell`, его разрешение по ближайшему объявлению, отказ линта на пустом списке.
- `step-execution`: строковый `run` с объявленной `shell` исполняется как `[...shell, command]`.

## Impact

- `src/parts/pipeline/document/schema.ts`, `model.ts`, `expand.ts`: ключ на трёх уровнях и поле `shell` у `RunStep`.
- `src/parts/pipeline/run/exec/runStep.ts`: сборка команды перед `runProcess`.
- `src/parts/pipeline/domain/lint.ts`: проверка пустого списка.
- `schema/pipeline.schema.json`, `schema/job.schema.json`: пересборка публикуемых схем.
- `docs/pipeline-format.md`.
