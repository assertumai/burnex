## 1. Демон

- [ ] 1.1 `loadDiscussionStrategy` в `discussionStrategy.ts`; общий `src/parts/ui/strategies.ts` по виду стратегии, обёртки ревью
- [ ] 1.2 `discussStrategy` у шага в `PipelineView`
- [ ] 1.3 Экран `screen-discussion-strategies`: декларация, `GET|PUT|DELETE /api/discussion-strategies`, маршрут и пункт меню
- [ ] 1.4 Тесты: чтение, перекрытие, использование, запись с отказом у поля, удаление

## 2. Витрина

- [ ] 2.1 Общий каркас страницы стратегий; «Review strategies» на нём без изменения поведения
- [ ] 2.2 `DiscussionStrategies.tsx`: черновик ↔ документ, редактор, схема хода
- [ ] 2.3 Тесты витрины

## 3. Проверка

- [ ] 3.1 Документация, `npm run check`, `openspec validate --strict`
- [ ] 3.2 Живая проверка на демоне из worktree
