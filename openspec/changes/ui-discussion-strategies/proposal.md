## Why

Шаг `discuss` берёт участников из документа `kind: discussion-strategy`
(`discuss-step`). Стратегии ревью правятся на экране «Review strategies»
(`ui-review-strategies`), а стратегии обсуждения — только руками в YAML:
не видно, кто участвует, кто автор и агрегатор, сколько раундов защиты и
какие шаги ссылаются на файл. Последний пункт `render-design` вне его
рамок — редактор стратегий обсуждения в витрине.

## What Changes

- Новый экран **Discussion strategies** (`/discussion-strategies/:name?`) в
  группе `config` меню, рядом с «Review strategies».
- Слева — стратегии обоих слоёв (`.burnex/discussion-strategies/` проекта и
  `~/.burnex/discussion-strategies/`) с меткой слоя; перекрытая проектной —
  только для чтения.
- Справа — редактор:
  - раунды защиты (1–5) и схема хода обсуждения
    (предложения → черновик → возражения → защита → документ);
  - карточки участников: `id`, агент, модель или уровень, `effort`, `focus`;
  - карточки автора и агрегатора: агент и дополнение к промпту;
  - локальные профили тем же редактором, что у стратегий ревью;
  - шаги `discuss:` пайплайнов проекта, которые разрешаются в этот файл.
- Сохранение, создание и удаление — как у стратегий ревью: в файл слоя,
  правкой YAML-документа с сохранением комментариев, с проверкой тем же
  разбором движка до подмены файла; отказ показывается у поля по пути ключа.
- Серверный модуль стратегий и каркас экрана обобщаются по виду стратегии:
  ревью и обсуждение различаются только схемой документа, каталогом слоя,
  видом шага в «Used by» и формой редактора.

## Capabilities

### New Capabilities

- `discussion-strategies-screen`: экран стратегий обсуждения и его API
  `GET|PUT|DELETE /api/discussion-strategies`.

### Modified Capabilities

<!-- нет: экран стратегий ревью ведёт себя как прежде -->

## Impact

- `src/parts/ui/reviewStrategies.ts` → общий `strategies.ts` с видами
  `review` и `discussion`; `src/parts/ui/screens/discussion-strategies/`.
- `src/parts/ui/pipelines.ts` — ссылка шага `discuss:` на стратегию.
- `src/builtin/routes.yml` — маршрут и пункт меню.
- `ui/src/pages/ReviewStrategies.tsx` — общий каркас списка и страницы;
  новый `ui/src/pages/DiscussionStrategies.tsx`.
