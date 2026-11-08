## Why

Экраны Agents, Secrets, Schedule и Packages — настройка, а Usage, Cleanup и
System — наблюдение, но сейчас Agents, Secrets, Schedule, System, Usage и
Cleanup лежат в одной группе `system` (`src/builtin/routes.yml`), а Packages — в
`extend`. Группа `system` смешивает чтение состояния с правкой конфигурации
(`docs/ui-proposals.md`, п. 3); экраны настроек уже есть, поэтому разделять
пора сейчас.

## What Changes

- `src/builtin/routes.yml`: у `screen-agents`, `screen-secrets`,
  `screen-schedule`, `screen-packages` и `screen-system` — `nav.group: config`;
  `screen-usage` и `screen-cleanup` остаются в `system`. Поля `order` не
  меняются: они сквозные по всей таблице, поэтому порядок внутри групп
  сохраняется.
- `ui/src/plugins/shell.tsx`: `NAV_GROUP_ORDER` становится
  `work, extend, config, system`; заголовок группы по-прежнему строится из
  её имени (`Config`).
- `docs/routes.md`: перечень групп поставки в описании `nav.group` — те же
  четыре.
- Тест порядка групп в боковом меню (рядом с тестами каркаса в `ui/test/`).

Решение: System (здоровье установки) уходит в `config`, как закреплено в
`done_when` пункта очереди, а `system` остаётся группой наблюдения с Usage и
Cleanup; нового механизма групп не вводится — меняются только данные и
константа порядка.

## Capabilities

### New Capabilities

### Modified Capabilities
- `ui-dashboard`: порядок групп бокового меню поставки и состав группы `config`.

## Impact

`src/builtin/routes.yml`, `ui/src/plugins/shell.tsx`, `docs/routes.md`, тест в
`ui/test/`. Перекрытия пользовательских `routes.yml` по `id` и явному
`nav.group` продолжают действовать; у тех, кто группу не переопределял,
пункты переедут сами. Требование о порядке `work, extend, system` пока заведено
в неархивированном `ui-overhaul`; порядок этого изменения идёт после него и
вытесняет прежний.
