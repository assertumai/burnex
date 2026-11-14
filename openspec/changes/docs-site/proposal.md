## Why

Документация burnex — 13 тыс. строк Markdown в `docs/`, читать её можно только
на GitHub, вперемешку с внутренними записками (очередь, предложения, целевая
архитектура). Пакету нужен публичный сайт на GitHub Pages, который выдержит
несколько линий версий: впереди ломающие изменения форматов и API.

Подход согласован в обсуждении Fable 5.2 и Codex Astra (шаг `discuss`,
итог — `discussion.json`, `agreed: true`): Starlight (Astro), версии из
релизных тегов, справочник генерируется из данных ревизии. Это изменение
реализует **этап 1** из `d14` — каркас и предварительную публикацию из `main`.

## What Changes

- Каталог `website/` — отдельный npm-пакет со своим lockfile: Astro +
  Starlight, корневая локаль `ru`, поиск Pagefind, Mermaid на клиенте
  (`astro-mermaid`), база `/burnex/` на `https://assertumai.github.io`.
- Источником страниц остаётся `docs/`: на них ссылаются сообщения `lint` и
  агенты. Манифест `website/pages.mjs` перечисляет публичные страницы и
  разделы; скрипт синхронизации перед сборкой кладёт их в gitignored
  каталог контента Starlight с заголовком из первого `# …`, ссылкой
  «редактировать» на исходник в `docs/` и баннером предварительной версии
  с SHA. Главная — из `README.md`.
- Плагин remark переписывает ссылки: на опубликованные страницы — в адреса
  сайта, на прочие файлы репозитория — в `github.com/assertumai/burnex/blob/main/…`.
- Workflow `.github/workflows/docs.yml`: в PR — сборка без публикации, в
  `main` — сборка и публикация через `actions/deploy-pages`.
- Внутренние документы (`proposals.md`,
  `ui-proposals.md`, `microkernel-target.md`, `burnex-after-stepcast.md`,
  `design/`, `superpowers/`) на сайт не попадают.

Не в этом изменении (этапы 2–3 `d14`): дробление больших страниц,
генерация справочника (схемы, `help --json`, typedoc, коды lint),
английская локаль, `versions.json` и линии версий.

## Capabilities

### New Capabilities

- `docs-site`: сборка и публикация сайта документации из `docs/` и `README.md`.

### Modified Capabilities

—

## Impact

- Новые файлы: `website/**`, `.github/workflows/docs.yml`.
- Корневой пакет движка и его зависимости не меняются.
- Требуется однократная настройка репозитория: Settings → Pages → Source:
  GitHub Actions.
