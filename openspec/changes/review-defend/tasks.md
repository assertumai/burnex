## 1. Документ стратегии и шага

- [ ] 1.1 `REVIEW_MODES = ['independent', 'defend']`; блоки `defend.rounds` (1–5, по умолчанию 2) и `defender` в `reviewStrategy.ts` и `schema/review-strategy.schema.json`; отказы: `mode: discussion` с подсказкой, блоки при другом режиме, `rounds` вне диапазона, ревьюер `defender`
- [ ] 1.2 Поле шага `implementer` в разборе и раскрытии (`expand.ts`): агентский шаг своей работы до `review` либо работы-предка; ключ шага включает ссылку; адрес `step_agents` `<работа>.<шаг>/defender`
- [ ] 1.3 Линт: `implementer` при режиме не `defend`; неразрешённая ссылка
- [ ] 1.4 Тесты разбора, раскрытия и линта по сценариям

## 2. Форк сессии

- [ ] 2.1 `forkSessions` в возможностях, `forkFrom` в вызове (`backend/types.ts`); `agentStep.ts` передаёт `forkFrom` только на первом вызове псевдонима
- [ ] 2.2 Claude: `--resume <id> --fork-session --session-id <новый>`; Codex: `codex exec fork <id>`; оба объявляют `forkSessions`
- [ ] 2.3 Тесты адаптеров и исполнения агентского шага

## 3. Защита

- [ ] 3.1 Схемы `review-defense.schema.json` и `review-rebuttal.schema.json` (все поля обязательные, null допускается); удалить `review-message.schema.json` и код режима `discussion`
- [ ] 3.2 Выбор защитника: форк по записи шага имплементатора (текущий прогон, затем исходный при переиспользовании) либо свежий агент с причиной
- [ ] 3.3 Ветки по ревьюерам: id находок, раунды защитник → ревьюер, закрытия, `contested` по лимиту и сбою, бюджет и отмена; параллельность по `limits.concurrency`
- [ ] 3.4 Промпты защитника (форк и свежий), ревьюера и агрегатора режима `defend`
- [ ] 3.5 Журнал `defense.ndjson`, каталоги ходов, события `review.defender|message|settled|defense.finished` в схеме журнала (старые события читаемы); расход `defender`
- [ ] 3.6 Тесты на поддельном бэкенде: всё принято в первом раунде; снятие; спор до лимита; сбой защитника; форк против свежего; бюджет; повтор агрегатора

## 4. Витрина

- [x] 4.1 Модель ленты `reviewFeed.ts` для `defend`: защитник, находки со статусами, ветки, исход; `independent` — как прежде; журнал `discussion` — участники и вердикт
- [x] 4.2 `ReviewFeed.tsx`: строка защитника, карточки находок с бейджами, реплики веток с метками по находкам, панель находок/раундов/расхода; живое обновление по `review.message`/`review.settled`
- [x] 4.3 Редактор стратегии: режим Independent / Defend, `rounds`, блок защитника, схема хода
- [x] 4.4 Тесты модели ленты и компонентов по сценариям спеки

## 5. Документация и проверка

- [ ] 5.1 `docs/pipeline-format.md` (раздел review), `examples/review/` (стратегия `defend`, пайплайн с шагом реализации и `implementer`)
- [ ] 5.2 Удалить изменения `review-discussion` и `ui-review-discussion`; поправить упоминания `discussion` в `review-strategies` и `ui-review-strategies`
- [ ] 5.3 `npm test`, UI-тесты, все typecheck, lint, `openspec validate --strict`
- [ ] 5.4 Живой прогон примера: форк сессии имплементатора на Claude, ветки двух ревьюеров, лента в витрине
