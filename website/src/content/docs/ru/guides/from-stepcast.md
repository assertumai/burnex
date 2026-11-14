---
title: Переход со stepcast
description: Проект переименован из Stepcast в Burnex — что поменять в своём проекте.
---

Прежнее имя движка — Stepcast. Один выпуск прежние имена читаются наравне с новыми, а движок предупреждает, где они встретились.

## Найти отсылки

```bash
burnex migrate-stepcast [путь]
```

печатает файл, строку, что найдено и чем заменить, и завершается ошибкой, пока находки есть. Сама ничего не правит.

## Что переименовать

| Было | Стало |
|---|---|
| команда `stepcast` | `burnex` |
| `.stepcast/`, `stepcast.yml` | `.burnex/`, `burnex.yml` (`git mv .stepcast .burnex`) |
| `~/.stepcast` | `~/.burnex` — переносится сам при `install.sh`, `burnex up` или `burnex update` |
| `STEPCAST_*` | `BURNEX_*` |
| `stepcast/<подпуть>`, `stepcast:<имя>` | `burnex/<подпуть>`, `burnex:<имя>` |
| `@stepcast/slots`, `@stepcast/ui` | `@burnex/slots`, `@burnex/ui` |
| агент автозапуска `ai.stepcast.daemon` | `ai.burnex.daemon` |

Паспорт установки способом `npm`, записанный до переименования, называет пакет `stepcast` — поправьте поле `package` в `~/.burnex/install.json`.

Подробности — [Порядок выпуска, «Переход со stepcast»](https://github.com/assertumai/burnex/blob/main/docs/release.md#переход-со-stepcast).
