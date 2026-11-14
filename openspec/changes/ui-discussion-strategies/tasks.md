## 1. Демон

- [x] 1.1 `loadDiscussionStrategy` в `discussionStrategy.ts`; общий `src/parts/ui/strategies.ts` по виду стратегии, обёртки ревью
- [x] 1.2 `discussStrategy` у шага в `PipelineView`
- [x] 1.3 Экран `screen-discussion-strategies`: декларация, `GET|PUT|DELETE /api/discussion-strategies`, маршрут и пункт меню
- [x] 1.4 Тесты: чтение, перекрытие, использование, запись с отказом у поля, удаление

## 2. Витрина

- [x] 2.1 Общий каркас страницы стратегий (`StrategyScreen.tsx`); «Review strategies» на нём без изменения поведения — его тесты не правились; главная называет новый экран
- [x] 2.2 `DiscussionStrategies.tsx`: черновик ↔ документ, редактор, схема хода
- [x] 2.3 Тесты витрины

## 3. Проверка

- [x] 3.1 Документация, `npm run check`, `openspec validate --strict`
- [x] 3.2 Живая проверка на демоне из worktree: экран в меню и на главной; создание `ui-check` в домашнем слое — отказ `participants.0.id` у поля при `id: author`, затем файл с `rounds: 2` и схемой хода «≤ 2 rounds»; удаление через экран снимает файл; экран ревью на общем каркасе открывается
