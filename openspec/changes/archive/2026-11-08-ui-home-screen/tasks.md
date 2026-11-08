## 1. Строка демона и маршруты

- [x] 1.1 `src/parts/ui/screens/home/{declaration,server}.ts`: объявление
      `screen-home` без маршрутов API; строка в `SCREEN_ROWS`
      (`src/parts/ui/rows.ts`).
- [x] 1.2 `src/builtin/routes.yml`: `screen-home` на `/`, `screen-runs` на
      `/runs` с прежними `id`, `active_for` и группой.

## 2. Браузерная половина

- [x] 2.1 `ui/src/pages/Home.tsx` + `home.css`: `homeStats()` — чистая свёртка
      обзора и очереди предложений; `SECTIONS` — карта разделов по группам
      меню; плитки и карточки — `TargetLink`.
- [x] 2.2 `ui/src/screens/home.tsx` и запись в `BUILTIN_SCREENS`.

## 3. Проверки и документация

- [x] 3.1 Обновить ожидания корня: `test/ui-server.test.ts`,
      `test/ui-routes-file.test.ts`, `test/ui-screens.test.ts`.
- [x] 3.2 `ui/test/home.test.tsx`: свёртка, разметка, полнота карты разделов.
- [x] 3.3 `docs/routes.md`: стартовая страница поставки — «Home», прогоны на
      `/runs`.
- [x] 3.4 `npm run check` зелёный; релиз через `scripts/release-local.sh` и
      осмотр в живом демоне.
