---
title: Повторы и бюджеты
description: attempts, until и бюджеты — сколько раз и за какую цену burnex повторяет работу.
---

Агент ошибается, поэтому повторы — штатная часть пайплайна. Но каждый повтор ограничен: числом попыток и бюджетом. Худший случай считается заранее.

## attempts — повторить шаг

```yaml
- id: implement
  agent: claude
  attempts:
    max: 3
    escalation:
      - include_failure: true              # 2-я попытка видит, почему упала 1-я
      - include_failure: true
        model: opus                        # 3-я — на модели сильнее
```

Каждая попытка пишется в журнал отдельно, со своим расходом. Шаг, стабильно проходящий с третьего раза, — диагноз промпта или спеки, и `burnex usage` это покажет.

## until — повторять работу до проверки

```yaml
jobs:
  fix:
    until: { max_iterations: 4, check: [{ cmd: npm test }] }
    steps:
      - id: repair
        agent: claude
        prompt: Почини падающие тесты.
```

Все шаги → проверка → если не прошла и лимиты целы, новая итерация. Вывод непрошедшей проверки подмешивается шагам следующей итерации. Исчерпание итераций — отказ работы с причиной `until_not_met`.

Для повторения **группы** работ (проверка → починка) есть `loops`, для отката и повтора работы целиком — `attempts` у работы.

## Бюджет

```yaml
budget:
  tokens: 2M
  cost: 20              # доллары
  wallclock: 2h
  rate_limit_pct: 80    # не выбирать окно лимита подписки больше чем на 80%
  on_exceed: wait       # wait | stop
```

Три уровня — пайплайн, работа, шаг; срабатывает тот потолок, что упрётся первым. Расход считается непрерывно из потока бэкенда: превышение обрывает текущий шаг, не дожидаясь его конца. Перед каждым шагом потолок проверяется, и шаг, который уже не поместится, не запускается вовсе.

`burnex lint` предупреждает о цикле без бюджета и печатает худший случай: `Σ (бюджет шага × attempts) × max_iterations × attempts работы`.

## В справочнике

[attempts](/burnex/ru/reference/pipeline-format/#attempts), [until](/burnex/ru/reference/pipeline-format/#until), [loops](/burnex/ru/reference/pipeline-format/#loops), [бюджет](/burnex/ru/reference/pipeline-format/#бюджет), [расход прогона](/burnex/ru/reference/run-layout/#расход).
