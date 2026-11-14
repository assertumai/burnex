---
title: Виды шагов
description: Код, агент, несколько агентов и человек — какой шаг для чего.
---

Шаг — единица исполнения внутри работы. Вид шага задаёт, **кто** его исполняет.

| Вид | Кто исполняет | Для чего |
|---|---|---|
| `run` | код | команда: тесты, сборка, линтер |
| `script` | код | файл-скрипт с контрактом входа и выхода |
| `uses` | код или агент | переиспользуемый шаг из `.burnex/steps/<имя>/` |
| `agent` | один агент | написать, починить, объяснить |
| `review` | несколько агентов | ревью панелью: ревьюеры и агрегатор вердикта |
| `discuss` | несколько агентов | проектирование: предложения, черновик, возражения, итог |
| `decision` | человек | остановить прогон и ждать решения |

## Код

```yaml
- id: test
  run: [npm, test]
  expect: [{ exit_code: 0 }]
```

Команда — массив аргументов, без оболочки. Всё, что можно проверить или сделать кодом, лучше делать кодом: это быстро, бесплатно и одинаково при каждом запуске.

## Агент

```yaml
- id: fix
  agent: claude
  prompt: file:./prompts/fix.md
  permissions: { mode: acceptEdits }
  output_schema: ./schemas/fix.json
```

Промпт — строка или файл с подстановками `${inputs.*}`, `${jobs.*}`. `permissions` транслируется в флаги CLI агента; без него агент упрётся в отказ на первой записи файла. Агентские шаги одной работы по умолчанию идут в общей сессии.

## Несколько агентов

`review` и `discuss` ссылаются на **стратегию** — отдельный YAML, где перечислены участники (бэкенд, модель, фокус), автор и агрегатор. Шаг описывает только задачу и форму итога. Подробнее — [Агенты и роли](/burnex/ru/concepts/agents/).

```yaml
- id: review-diff
  review: panel                  # .burnex/review-strategies/panel.yml
  prompt: file:./prompts/review.md
  output_schema: ./schemas/review.json
```

## Человек

```yaml
- id: gate
  decision:
    prompt: Слить в main?
    outcomes: { approve: continue, deny: reject }
    deadline: 4h
    on_expire: deny
```

Подробнее — [Решения человека](/burnex/ru/concepts/human/).

## В справочнике

[Шаги](/burnex/ru/reference/pipeline-format/#шаги): [agent](/burnex/ru/reference/pipeline-format/#agent), [run](/burnex/ru/reference/pipeline-format/#run), [script](/burnex/ru/reference/pipeline-format/#script), [uses](/burnex/ru/reference/pipeline-format/#переиспользуемый-шаг-uses), [review](/burnex/ru/reference/pipeline-format/#review), [discuss](/burnex/ru/reference/pipeline-format/#discuss), [decision](/burnex/ru/reference/decisions/).
