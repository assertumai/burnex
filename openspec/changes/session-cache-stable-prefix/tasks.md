## 1. Схема в тексте для вызовов в сессии

- [ ] 1.1 `schemaInPrefix` в `BackendCapabilities`, помощник `callSchemaMode`
- [ ] 1.2 `agentStep.ts` выбирает режим через `callSchemaMode`; судья не меняется
- [ ] 1.3 Claude объявляет `schemaFromText` и `schemaInPrefix`
- [ ] 1.4 Тесты: шаг на бэкенде с сессиями, без сессий, судья, адаптер без флага

## 2. Опция `user_mcp`

- [ ] 2.1 `user_mcp` в схеме и разборе конфигурации, `BackendConfig.userMcp`
- [ ] 2.2 Возможность `isolateUserMcp`; Claude: `--strict-mcp-config` и `ENABLE_CLAUDEAI_MCP_SERVERS=false`, явный `env` сильнее
- [ ] 2.3 Предстарт `requireUserMcpIsolation`
- [ ] 2.4 Тесты адаптера и предстарта

## 3. Документация и пересмотр

- [ ] 3.1 `docs/config.md` (`user_mcp`), `docs/plugins.md` (возможности)
- [ ] 3.2 Пометка о пересмотре в `review-defend-shared-session/proposal.md`
- [ ] 3.3 `npm run check`, `openspec validate --strict`
- [ ] 3.4 Живой замер тестового пайплайна `defend`: до и после, с `user_mcp: false` и без
