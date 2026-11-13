## 1. Рендеры документа

- [ ] 1.1 `mermaid@12.2.0` — devDependency; `scripts/copy-vendor.mjs` копирует `mermaid.min.js` в `dist/vendor/` в `build:node`
- [ ] 1.2 `src/parts/pipeline/render/designDoc.ts`: разбор и проверка входа схемой `burnex:design-doc`, поля движка
- [ ] 1.3 `renderDesignHtml`: офлайн-HTML, экранирование, якоря, пометки итога, встраивание бандла только при диаграммах
- [ ] 1.4 `renderDesignOpenSpec`: Markdown по шаблону OpenSpec, ограды диаграмм
- [ ] 1.5 Тесты рендеров: детерминизм, экранирование, без сетевых ссылок, без скрипта при пустых диаграммах, разделы и ограды, отказы входа

## 2. Команда burnex render

- [ ] 2.1 `src/parts/pipeline/commands/render.ts`: строка команды `render <what> <file>` с `--format` и `--out`, регистрация в `src/parts/cli/rows.ts`
- [ ] 2.2 Тесты команды: stdout, `--out`, отказы; эталон справки CLI

## 3. Лента discuss на демоне

- [ ] 3.1 Вынести общие помощники чтения журнала участников из `reviewFeed.ts` в `participantJournal.ts`
- [ ] 3.2 Замок: участники, автор и агрегатор шага `discuss` в `lockRead.ts`
- [ ] 3.3 `src/parts/ui/discussFeed.ts`: `readDiscussFeed` — участники, фазы, предложения, черновик, возражения, раунды, исход, документ
- [ ] 3.4 `GET /api/discuss-feed` и `GET /api/design-render` в `screens/run/server.ts`
- [ ] 3.5 Тесты ленты и маршрутов на журнале поддельного прогона

## 4. Витрина

- [ ] 4.1 Типы и запросы в `ui/src/api.ts`
- [ ] 4.2 `Mermaid.tsx`: ленивая загрузка, strict, тема, исходник при загрузке и ошибке
- [ ] 4.3 `DesignDoc.tsx` и `DiscussFeed.tsx`: фазы, участники, вкладки «Документ» и «Обсуждение», скачивание
- [ ] 4.4 `RunDetail.tsx`: шаг `discuss` ведётся панелью ленты
- [ ] 4.5 Тесты витрины на ленту и документ

## 5. Документация и проверка

- [ ] 5.1 `docs/pipeline-format.md`: раздел о рендере и ленте; `examples/discuss` — шаги рендера HTML и design.md
- [ ] 5.2 `npm run check` и `openspec validate render-design --strict`
- [ ] 5.3 Живая проверка: рендер документа прогона e6ab25 в HTML и design.md, лента в витрине на свежей сборке
