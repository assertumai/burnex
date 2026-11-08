## 1. Реализация

- [x] 1.1 `src/builtin/routes.yml`: `nav.group: config` у `screen-agents`, `screen-secrets`, `screen-schedule`, `screen-packages`, `screen-system`; `order` не трогать
- [x] 1.2 `ui/src/plugins/shell.tsx`: `NAV_GROUP_ORDER` = `work, extend, config, system`
- [x] 1.3 `docs/routes.md`: перечень групп поставки в описании `nav.group`

## 2. Тест

- [x] 2.1 Тест в `ui/test/`: заголовки групп меню идут в порядке `work, extend, config, system`; в `config` пять экранов, в `system` — Usage и Cleanup
- [x] 2.2 `npm run check` зелёный
