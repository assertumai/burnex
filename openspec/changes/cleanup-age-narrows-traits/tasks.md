## 1. Тесты, падающие до правки

- [x] 1.1 `test/cleanup.test.ts`: «отказавшие + срок» не берёт свежий отказавший и старый успешный; «оборванные + отказавшие + срок» берёт оба исхода старше срока; прогон с нечитаемым журналом берётся сроком без исхода и не берётся исходом со сроком.
- [x] 1.2 `test/usage-store.test.ts`: `selectUsageRecords` с `failed` и сроком отбирает только отказавшие записи старше срока.
- [x] 1.3 `test/ui-server.test.ts` или `test/gc.test.ts`: `GET /api/runs?trait=failed&older-than=…` и `stepcast gc --stats --failed --older-than …` отвечают сужением.

## 2. Ядро

- [x] 2.1 `selectCandidates`: исход по «или» между собой, срок по «и»; обновить заголовок функции.
- [x] 2.2 `selectUsageRecords`: то же для `failed` и срока; обновить заголовок и комментарий `UsageRecordSelectOptions`.
- [x] 2.3 Поправить прежние тесты, закреплявшие «или» между сроком и исходом.

## 3. Страница

- [x] 3.1 `ui/src/pages/Cleanup.tsx`: подписи обоих разделов называют правило — исходы по «или», срок сужает.

## 4. Проверка

- [x] 4.1 `npm run check` целиком.
- [x] 4.2 `openspec validate cleanup-age-narrows-traits --strict`.
