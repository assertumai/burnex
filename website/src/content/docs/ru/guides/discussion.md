---
title: Обсуждение несколькими агентами
description: Шаг discuss — несколько агентов проектируют решение до кода, итог — проектный документ по схеме.
---

Перед реализацией крупной фичи полезно, чтобы подход предложили и оспорили несколько моделей. Шаг `discuss` делает это по объявленным фазам и отдаёт проектный документ по схеме `burnex:design-doc`: решения, отклонённые варианты с причинами, риски, открытые вопросы, диаграммы.

```yaml
# .burnex/discussion-strategies/design-panel.yml
version: 1
kind: discussion-strategy
name: design-panel
participants:
  - id: pragmatist
    agent: codex
    model_tier: max
    focus: Минимум новых сущностей, цена сопровождения
  - id: skeptic
    agent: claude
    model_tier: deep
    focus: Что сломается, чего не хватает в требованиях
author:
  agent: claude
  model_tier: max
  prompt: Своди честно, отклонённые варианты не теряй.
aggregator:
  agent: claude
  model_tier: max
rounds: 2
```

```yaml
jobs:
  design:
    steps:
      - id: discuss
        discuss: design-panel
        prompt: file:./prompts/feature.md
        output_schema: burnex:design-doc
        permissions: { allow: [Read, Grep, Glob] }
```

## Фазы

1. **Предложения.** Участники параллельно и независимо предлагают подход.
2. **Черновик.** Автор сводит предложения в черновик с точками решения.
3. **Возражения и защита.** Участники возражают по точкам, автор защищает или правит — столько раундов, сколько объявлено в `rounds`.
4. **Итог.** Агрегатор решает спорное и пишет документ: что решено, кто что предлагал и почему отклонено, `agreed` и нерешённое.

Документ — обычный выход работы: следующая работа может по нему реализовывать, а человек — принять его шагом `decision`.

## Дальше

- Пример с отчётом в HTML — [examples/discuss](https://github.com/assertumai/burnex/tree/main/examples/discuss).
- Все поля и фазы — [discuss](/burnex/ru/reference/pipeline-format/#discuss).
