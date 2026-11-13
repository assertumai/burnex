## 1. Движковая схема

- [x] 1.1 `schemaFromText` в `BackendCapabilities`, помощник `structuredOutputMode`; модуль `backend/textSchema.ts` (раздел промпта, извлечение последнего JSON-блока, проверка схемой)
- [x] 1.2 `agentStep.ts`: текстовый режим — схема в промпт, без `outputSchemaPath` адаптеру, структура из текста, предикат `output_schema`
- [x] 1.3 `judgePass.ts`: вердикт из текста в текстовом режиме
- [x] 1.4 Тесты извлечения и исполнения шага (успех, невалидный ответ с повтором, нативная главнее)

## 2. Проверки до старта и выбор защитника

- [x] 2.1 Предстарт (`requireStructuredOutputSupport`) и линт принимают любой путь, отклоняют отсутствие обоих
- [x] 2.2 `defenderChoice`: причина `no_schema`; схема журнала, описание защитника, лента UI
- [x] 2.3 Тесты предстарта, линта и выбора защитника

## 3. Адаптеры

- [x] 3.1 Cursor и Copilot объявляют `schemaFromText`; тесты
- [x] 3.2 Плагин `burnex/backends/antigravity`: адаптер, умолчания, `bundled.ts`, `exports`, граница линта, перечень поверхности плагинов
- [x] 3.3 Фикстуры потока Antigravity и тесты адаптера

## 4. Документация и проверка

- [x] 4.1 `docs/`: бэкенды (таблица возможностей, Antigravity), review (схема участников, `no_schema`)
- [x] 4.2 `npm run check`, `openspec validate --strict`
