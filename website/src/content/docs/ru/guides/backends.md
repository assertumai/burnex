---
title: Подключить Codex и Cursor
description: Бэкенды агентов кроме Claude подключаются плагином в конфигурации пользователя.
---

Claude Code встроен. Остальные бэкенды поставляются в пакете burnex плагинами и подключаются одной строкой в **глобальной** конфигурации — один раз на машину.

## Codex

1. Установите [Codex CLI](https://github.com/openai/codex) и войдите в аккаунт: `codex login`.
2. Подключите плагин:

   ```yaml
   # ~/.burnex/config.yml
   plugins:
     - burnex/backends/codex
   ```

3. Проверьте:

   ```bash
   burnex config | grep codex
   ```

   Ожидается запись `backends.codex.*` с источником `plugin:codex`.

Шаг выбирает Codex полем `agent: codex`. Права у Codex — режимы песочницы: `permissions: { mode: read-only | workspace-write | danger-full-access }`.

## Cursor

```yaml
# ~/.burnex/config.yml
plugins:
  - burnex/backends/codex
  - burnex/backends/cursor
```

Шаг — `agent: cursor-agent`. Структурированный вывод Cursor получает через текст ответа: схема уходит в промпт, движок проверяет последний JSON-блок. Адаптер написан по документации Cursor CLI и вживую ещё не проверялся.

Так же подключаются `burnex/backends/copilot` и `burnex/backends/antigravity`.

## Модели по уровням

Чтобы пайплайн не зависел от имён моделей, назначьте уровни каждому бэкенду:

```yaml
# ~/.burnex/config.yml
backends:
  claude:
    model_tiers: { max: opus, deep: opus, balance: sonnet }
  codex:
    model_tiers: { max: gpt-6-astra, deep: gpt-6-sol, balance: gpt-5.6-terra }
defaults:
  agent: claude
```

Шаги пишут `model_tier: deep` — и на любом бэкенде получают модель этого уровня. То же настраивается в витрине на странице «Агенты».

:::caution
Плагин объявляйте в одном месте. Одно и то же имя бэкенда из двух объявлений (например, в глобальной и проектной конфигурации) — ошибка «Имя бэкенда codex занято».
:::

## В справочнике

[Плагины](/burnex/ru/reference/plugins/): [Codex](/burnex/ru/reference/plugins/#второй-бэкенд-codex), [Cursor](/burnex/ru/reference/plugins/#третий-бэкенд-cursor), [Copilot](/burnex/ru/reference/plugins/#четвёртый-бэкенд-copilot), [Antigravity](/burnex/ru/reference/plugins/#пятый-бэкенд-antigravity); [возможности бэкендов](/burnex/ru/reference/config/#возможности-бэкендов).
