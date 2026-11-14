---
title: Агенты и роли
description: Claude, Codex, Cursor и другие CLI в одном пайплайне — кто какую роль играет и как выбирается модель.
---

Агент в burnex — **тип шага**, а не оркестратор. Бэкенд агента — это CLI, который движок запускает на шаг: Claude Code, Codex CLI, Cursor Agent и другие. Разные шаги одного пайплайна могут идти на разных бэкендах: один пишет, другой ревьюит, третий сводит обсуждение.

```yaml
jobs:
  implement:
    agent: codex
    model_tier: deep
    steps:
      - id: code
        prompt: Исправь ошибку.          # codex, модель уровня deep
      - id: review
        agent: claude
        model_tier: fast
        prompt: Проверь правку.          # claude, модель уровня fast
```

## Бэкенды

| Бэкенд | Как подключить | Сессии | Схема вывода | Статус |
|---|---|---|---|---|
| `claude` | встроен | да | нативная | основной, проверен вживую |
| `codex` | плагин `burnex/backends/codex` | да | нативная | проверен вживую (`examples/codex`) |
| `cursor-agent` | плагин `burnex/backends/cursor` | да | движком по тексту ответа | адаптер по документации CLI, вживую не проверялся |
| `copilot` | плагин `burnex/backends/copilot` | нет | движком по тексту ответа | адаптер по документации CLI, приёмка `examples/copilot` |
| `antigravity` | плагин `burnex/backends/antigravity` | да | нативная | адаптер по документации CLI, вживую не проверялся |

Возможности бэкенда — описание того, что умеет адаптер, а не настройка. Бэкенд без сессий получает `session: shared` как `per_step` с предупреждением; строгая граница прав (`enforce: strict`) на бэкенде без неё — ошибка до запуска, а не тихое послабление. Как подключить плагин — [Подключить Codex и Cursor](/burnex/ru/guides/backends/).

## Модель: tier вместо имени

Вместо имени модели шаг называет уровень — `max`, `deep`, `balance`, `fast`, `mini` (и свои). Какая модель стоит за уровнем у каждого бэкенда, решает конфигурация пользователя:

```yaml
# ~/.burnex/config.yml
backends:
  claude: { model_tiers: { max: opus, balance: sonnet } }
  codex:  { model_tiers: { max: gpt-6-astra, balance: gpt-5.6-terra } }
```

Пайплайн переносим между машинами и подписками, а итоговая пара «модель + effort» записывается в `pipeline.lock.yml` прогона. Явная `model` на шаге побеждает tier.

## Профили и роли

Профиль — именованная связка «бэкенд + модель или tier + effort + контекст», её имя пишется в `agent:` как имя бэкенда:

```yaml
agents:
  reviewer-strict:
    backend: codex
    model_tier: max
    context: [{ text: "Ты строгий ревьюер безопасности." }]
```

В стратегиях `review` и `discuss` роли — это участники: у каждого свой профиль и фокус, у агрегатора — свой. Агента на один прогон меняет `burnex run --agent <имя>`, на отдельный шаг — `step_agents` в конфигурации; `burnex config --pipeline` показывает, кто исполнит каждый шаг и почему.

## В справочнике

[Агент, модель, effort и tier](/burnex/ru/reference/pipeline-format/#агент-модель-effort-и-tier), [агенты и модели в конфигурации](/burnex/ru/reference/config/#агенты-и-модели), [возможности бэкендов](/burnex/ru/reference/config/#возможности-бэкендов), [плагины-бэкенды](/burnex/ru/reference/plugins/#второй-бэкенд-codex).
