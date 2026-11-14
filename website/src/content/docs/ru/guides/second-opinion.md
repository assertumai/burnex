---
title: Ревью другим агентом
description: Один агент пишет, другой ревьюит по схеме — или панель ревьюеров с агрегатором.
---

Агент, проверяющий собственную работу, склонен с собой соглашаться. В burnex ревьюер — отдельный шаг, на другом бэкенде или модели, со структурированным вердиктом.

## Один ревьюер

```yaml
jobs:
  implement:
    steps:
      - id: code
        agent: claude
        prompt: file:./prompts/implement.md
        permissions: { mode: acceptEdits }

  review:
    needs: [implement]
    steps:
      - id: check
        agent: codex
        prompt: Проверь дифф — нет ли регрессий и обхода тестов?
        permissions: { mode: read-only }
        output_schema: ./schemas/review.json
        expect: [{ schema: ./schemas/review.json }]
```

Вердикт ревьюера — JSON по схеме, и следующие работы читают его полями: `if: "jobs.review.output.verdict == 'approve'"`. Свободный текст «вроде нормально» дальше не идёт.

## Панель ревьюеров

Шаг `review` ссылается на стратегию — кто ревьюит, с каким фокусом и кто выносит вердикт:

```yaml
# .burnex/review-strategies/panel.yml
version: 1
kind: review-strategy
name: panel
reviewers:
  - id: security
    agent: codex
    focus: Границы доверия, секреты в логах, инъекции
  - id: tests
    agent: claude
    focus: Покрытие изменённого поведения тестами
aggregator:
  agent: claude
  model_tier: deep
  prompt: Вердикт request_changes, если есть находка critical или major.
mode: independent
```

```yaml
- id: review-diff
  review: panel
  prompt: Проведи ревью диффа ветки.
  output_schema: ./schemas/verdict.json
  permissions: { allow: [Read, Grep, Glob, "Bash(git diff*)"] }
```

Ревьюеры идут параллельно и отдают находки по встроенной схеме, агрегатор сводит вердикт по вашей. Отказ одного ревьюера шаг не роняет. Режим `defend` даёт автору правки защитить её от находок до вердикта.

## Дальше

- Пример целиком — [examples/review](https://github.com/assertumai/burnex/tree/main/examples/review).
- Все поля — [review](/burnex/ru/reference/pipeline-format/#review) и [режим defend](/burnex/ru/reference/pipeline-format/#режим-defend).
- Стратегии видны и правятся на экране «Review strategies» витрины.
