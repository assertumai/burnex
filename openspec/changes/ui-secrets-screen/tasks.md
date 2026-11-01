## 1. Общая проба секрета

- [x] 1.1 `src/parts/pipeline/run/secrets.ts`: выделить `probeTarget` с исходом
      `{ ok: true, value } | { ok: false, status, error }` (design.md,
      Решения 1–2); `resolveTarget` — обёртка, бросающая `error`. Экспортировать
      пробу для секрета пайплайна и для записи `credentials`.
- [x] 1.2 `SecretProviderUnavailableError` в `src/parts/pipeline/contract.ts` и
      экспорт с поверхности `stepcast/pipeline` (`src/parts/pipeline/surface.ts`);
      комментарий контракта `SecretProviderContribution.resolve` — значение не
      включать в текст исключения.
- [x] 1.3 `src/parts/pipeline/secrets/keychain.ts`: «не macOS», таймаут/отмена
      и `ENOENT` бросают `SecretProviderUnavailableError` с прежними
      сообщениями; код 44 и прочие коды — `Error`.
- [x] 1.4 Тесты: `test/secrets-run.test.ts` и
      `test/secret-provider-keychain.test.ts` — сообщения отказов запуска не
      изменились; статус пробы для каждой стадии отказа.

## 2. API витрины

- [x] 2.1 `src/parts/ui/secrets.ts`: `buildSecrets(runsRoot, config, options)` —
      обход проектов как в `buildPipelines` (переиспользовать `projectSection`
      и `listPipelineEntries`), провайдеры реестра, записи секретов со
      сведением по «имя + объявление» и `usedBy`, признак `unused`, записи
      `credentials` с признаком использования бэкенда, пайплайн-ошибки строкой
      с `error`. Тип `SecretView` без поля значения (design.md, Решения 3, 5).
- [x] 2.2 Пробы проекта параллельно, проекты последовательно; значение не
      читается дальше проверки `ok`; срок проб проекта и отмена по закрытию
      соединения, проба не ждёт провайдера, глухого к сигналу (design.md,
      Решение 4).
- [x] 2.3 `src/parts/ui/screens/secrets/{declaration,server}.ts`: объявление
      `screen-secrets` и `GET /api/secrets`; строка в `src/parts/ui/rows.ts`.
- [x] 2.4 `src/builtin/routes.yml`: `screen-secrets` на `/secrets`,
      `nav: { order: 8, group: system }`.

## 3. Экран

- [x] 3.1 `ui/src/pages/Secrets.tsx` + `secrets.css`: по проекту — провайдеры,
      таблица «имя · env · провайдер · параметры · где используется · статус ·
      причина», бейджи статусов темы, «не используется», кнопка «Проверить
      снова», индикатор загрузки.
- [x] 3.2 `ui/src/screens/secrets.tsx` и запись `'screen-secrets'` в
      `ui/src/screens/index.ts`.

## 4. Проверки и документация

- [x] 4.1 `test/ui-secrets.test.ts`: временный проект с `env-file` (найден, нет
      ключа, нет файла), незарегистрированный провайдер, фальшивый `keychain`
      (недоступен, записи нет), неиспользуемый секрет, запись `credentials`;
      в каждом случае тело ответа не содержит значения-маркера.
- [x] 4.2 `ui/test/secrets.test.tsx`: разметка по фикстуре ответа — статусы,
      причины, отсутствие значений.
- [x] 4.3 Ожидания маршрутов и экранов: `test/ui-routes-file.test.ts`,
      `test/ui-screens.test.ts`, `test/ui-server.test.ts`.
- [x] 4.4 `docs/config.md`: раздел «Секреты на витрине» — что показывает экран,
      три статуса и их границы, что значения не показываются, побочный эффект
      пробы `keychain`; ссылка из «Секреты» в `docs/pipeline-format.md`;
      `docs/plugins.md` — `SecretProviderUnavailableError`.
- [ ] 4.5 `npm run check` зелёный; релиз через `scripts/release-local.sh` и
      осмотр в живом демоне.
