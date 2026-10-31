## 1. Маршруты и строка демона

- [x] 1.1 `src/builtin/routes.yml`: у `screen-agents` путь `/agents/:tab?`,
      `values: { tab: [default, backends, tiers, policy] }`,
      `nav.active_for: [screen-settings]`; у `screen-settings` цель
      `{ screen: screen-agents }`, `params: { tab: default }`, `nav` снят;
      комментарий объясняет строку-псевдоним (design.md, Решение 1, 2).
- [x] 1.2 `src/parts/ui/screens/agents/declaration.ts`: `params: ['tab']`.
- [x] 1.3 `src/parts/ui/screens/agents/server.ts`: регистрирует `GET` и `PUT
      /api/settings` рядом с `/api/models` (обработчики переносятся из
      `screens/settings/server.ts`); комментарий о «маршруте `screen-settings`»
      переписан.
- [x] 1.4 Удалить `src/parts/ui/screens/settings/` и строку `settingsRow` из
      `src/parts/ui/rows.ts` (`git rm` через `node -e spawnSync`, если прямой
      `rm` отклонён).

## 2. Браузерная половина

- [x] 2.1 `ui/src/screens/agents.tsx`: компонент-обёртка читает `params.tab`
      и `navigate`, передаёт их в страницу; `ui/src/screens/index.ts` без
      `screen-settings`; удалить `ui/src/screens/settings.tsx`.
- [x] 2.2 Чистая логика в экспортируемых функциях `ui/src/pages/Agents.tsx`
      (или соседнем модуле): `AGENT_TABS`, `tabOf(param)` → вкладка или
      `default`; `scopeOf(pipelines, settingsFile)` переезжает из `Settings.tsx`.
- [x] 2.3 Вкладка **Default**: карточка «Default agent» (агент, effort) плюс
      поле `model` с подсказкой области действия и счётом `scopeOf` по
      `/api/pipelines` («пайплайнов не известно» при отказе или пустом ответе);
      предупреждение о глобальном `model` без ссылки на `/settings`.
- [x] 2.4 Вкладка **Backends**: карточка на бэкенд — команда, бейджи
      `disabled` / `plugin not connected` / `default`, модель бэкенда,
      `N models listed` или причина `unavailableReason`, чекбокс «Connect
      Codex» у недоступного `codex`; кнопка «Reload models» в шапке экрана.
- [x] 2.5 Вкладка **Tiers**: «Shared tiers» и карточки агентов с моделью и
      tier/effort — как сейчас.
- [x] 2.6 Вкладка **Policy**: при первом открытии запрашивает
      `/api/pipelines`; по проекту → по пайплайну: имя, файл, `agent_policy`
      с файлом, пометка записи; `AgentSelector` пайплайна (при `agentEntryName`)
      и агентских шагов плоским списком `<job>/<step>` с подписями
      `agentOriginLabel`/`modelOriginLabel`/`effortOriginLabel`; запись через
      `savePipelineAgent`, ответ заменяет список; отказ — `Alert`. Пайплайн без
      `name` назван с причиной.
- [x] 2.7 Общие `Save` / `Discard` / `Saved` и `dirty` — один черновик на
      Default, Backends и Tiers; на Policy эти кнопки не показываются.
      Переключение вкладки — `navigate(hrefForTarget(AGENTS_TARGET, { tab }))`,
      черновик не сбрасывается.
- [x] 2.8 Удалить `ui/src/pages/Settings.tsx` и `settings.css`; нужные правила
      перенести в `agents.css`.

## 3. Тесты

- [x] 3.1 `test/ui-screens.test.ts`: перечень экранов без `screen-settings`;
      карта «экран → маршрут» — `screen-agents` отвечает и на `/api/models`, и
      на `/api/settings`; перечень строк в патче каркаса без `screen-settings`.
- [x] 3.2 Там же или в `test/ui-routes*.test.ts`: встроенная таблица разбирает
      `/agents/policy` в `screen-agents` с `tab: policy`, `/settings` — в
      `screen-agents` с `tab: default`, `/agents/other` не разбирает;
      `GET /api/routes` отдаёт `active_for` у `screen-agents`.
- [x] 3.3 `ui/test/agents.test.tsx`: `tabOf` — четыре значения, пустое и
      неизвестное → `default`; `scopeOf` — затронутые, объявившие сами,
      перекрытые ближним файлом, неразобранные пайплайны.
- [x] 3.4 Проверить, что `ui/test/screens.test.tsx` (`/settings` как
      неразобранный адрес в подставной таблице) остаётся осмысленным — таблица
      там своя, встроенная не участвует.

## 4. Документация

- [x] 4.1 `docs/config.md`: «Настройки правят только глобальный файл» и
      «`defaults.model` применяется только…» — экран назван вкладкой Default
      экрана «Agents»; упомянуто, что `/settings` открывает её же.
- [x] 4.2 `docs/routes.md`: строка-псевдоним адреса (`screen-settings` →
      `screen-agents` с `params`) как пример цели с параметрами; строка про
      «десять экранов поставки» исправлена на фактическое число.
- [x] 4.3 `docs/ui-proposals.md`: пункт 1 отмечен выполненным.

## 5. Проверка

- [x] 5.1 `npm run check` целиком зелёный.
- [x] 5.2 `openspec validate ui-agents-settings-merge --strict` зелёный.
- [x] 5.3 Витрина глазами после `bash scripts/release-local.sh` и перезапуска
      демона: `/agents`, `/agents/policy`, `/settings`; меню с одним пунктом.
