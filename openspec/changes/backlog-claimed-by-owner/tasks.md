## 1. Формат и владелец

- [x] 1.1 `src/parts/pipeline/domain/backlog/schema.ts`: необязательное строковое поле `claimed_by` в `BacklogItemSchema` (в `BacklogRecord` не входит); значение любой формы разбирается
- [x] 1.2 Новый модуль `src/parts/pipeline/domain/backlog/owner.ts`: разбор и проверка формы `run:<id>` (непустой идентификатор без пробелов и `/`), тип судьи `OwnerState = 'alive' | 'dead' | 'unknown'`, экспорт из `index.ts`
- [x] 1.3 Судья живости прогона (рядом с `isRunAlive`, `src/parts/pipeline/run/journal/`): каталог `runPaths(runsRoot, projectKey(findProjectRoot(dirname(file))), id)`; нет каталога — `unknown`; `isRunAlive` — `alive`; иначе `alive`, если живой прогон проекта несёт владельца в цепочке `resumed_from` (обход с защитой от цикла), иначе `dead`; кэш ответа на вызов
- [x] 1.4 Предок по `resume`: функция «прогон A — сам B или предок B по `resumed_from`» для проверки своего владельца в `finish`

## 2. Отбор

- [x] 2.1 `isFree`, `isBusy`, `selectItems` (`select.ts`): необязательный судья владельца; `dead` — свободен, `alive` — занят, `unknown`/нет судьи/нет `claimed_by` — прежний порог давности; комментарий `isFree` переписать под новое правило
- [x] 2.2 `backlog pick` (`src/parts/pipeline/commands/backlog.ts`): ключ `--owner` с проверкой формы до захвата; судья строится из `resolveConfig` лишь при наличии `in_progress` с `claimed_by`, отказ конфигурации — предупреждение в stderr и `unknown`; судья передаётся в `isFree` проверки `--only` и в `selectItems`
- [x] 2.3 `applyPick`: с `--owner` — `claimed_by` вместе со `status` и `started_at`; без него — `withoutFields(..., ['claimed_by'])`

## 3. Исход

- [x] 3.1 `finishItem` (`file.ts`): необязательный владелец и проверка «своего» под тем же lock'ом после `already-final`; новый исход `foreign-owner` с владельцем пункта, файл не тронут
- [x] 3.2 `backlog finish --owner`: при `foreign-owner` — строка в stderr с пунктом и владельцем, код 0
- [x] 3.3 `backlog settle`: владелец `run:<basename(runDir)>`; `foreign-owner` — строка о пропуске, пункт не считается сведённым
- [x] 3.4 `merge-lanes` (`src/parts/pipeline/domain/lanes/merge.ts`): все вызовы `finishItem` — с владельцем `run:<paths.runId>`; `foreign-owner` не роняет сведение и попадает в его отчёт; дорожка чужого пункта не накладывается и не коммитится, исход `foreign_owner`, перехват во время проверки снимает наложенное откатом
- [x] 3.5 Справка команды: описания `--owner` у `pick` и `finish`, уточнение `--stale-hours` («для пунктов без владельца»); обновить снимок `test/cli-help-baseline.test.ts`

## 4. Пайплайн и документация

- [x] 4.1 `.stepcast/jobs/slots.yml`: `backlog pick ... --owner "run:$(basename "$STEPCAST_RUN_DIR")"`
- [x] 4.2 `docs/backlog.md`: поле `claimed_by` в таблице полей (поле движка, как `started_at`), правило зависшего с владельцем, ключи `--owner`, поведение `finish`/`settle` при чужом владельце

## 5. Тесты

- [x] 5.1 `test/backlog.test.ts` (отбор с подставным судьёй): мёртвый владелец свежего пункта — свободен; живой владелец старше порога — занят и держит группу; `unknown` и пункт без `claimed_by` — по порогу; `--only` и занятость групп по тому же правилу
- [x] 5.2 Судья прогона на временном каталоге прогонов: нет каталога — `unknown`; `running` с живым `pid` — `alive`; завершённый либо мёртвый `pid` — `dead`; мёртвый владелец с живым продолжением по `resumed_from` — `alive`; цикл в цепочке не зацикливает
- [x] 5.3 `test/cli-backlog.test.ts`: `pick --owner run:R1` пишет `claimed_by`; `pick` без `--owner` по зависшему пункту снимает его; неверная форма `--owner` — код 2, файл не тронут; очередь без владельцев работает без конфигурации проекта
- [x] 5.4 `test/backlog-file.test.ts` / `cli-backlog.test.ts`: `finish --owner` — свой, предок по `resume`, пункт без владельца (исход проставлен); чужой — файл не тронут, сообщение в stderr, код 0; `already-final` раньше проверки владельца
- [x] 5.5 `settle` и `merge-lanes`: пункт, перехваченный другим владельцем, не получает `failed`/`done` и попадает в сообщение о пропуске
- [x] 5.6 Полная проверка `npm run check` зелёная
