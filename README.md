# Burnex

**Агентская разработка — по рельсам.** burnex исполняет YAML-пайплайн шаг за
шагом: всё детерминированное делает код, решения в гейтах принимает человек, а
Claude, Codex или Cursor берут только те шаги, где без модели не обойтись.

📖 **Документация: [assertumai.github.io/burnex](https://assertumai.github.io/burnex/)**

- **Детерминированное — кодом.** Порядок работ, повторы и бюджеты вычисляет
  движок из объявленного графа, а не модель; `burnex lint` ловит ошибки до
  первого токена.
- **Любой агент, любая роль.** Claude, Codex и Cursor работают в одном
  пайплайне: один пишет, другой ревьюит, третий сводит обсуждение.
- **Контракт на каждом шаге.** Выход агента проходит проверки, которые вы
  объявили, — схему, тесты, ограничения правок; что не прошло, дальше не идёт.
- **Человек там, где нужен, и видит всё.** Шаг `decision` ждёт решения;
  `burnex up` показывает прогоны живьём.

## Как это выглядит

Claude чинит код, пока `npm test` не станет зелёным; Codex ревьюит дифф по
схеме; человек принимает ([examples/home](examples/home)):

```yaml
version: 1
kind: pipeline
name: fix-review-ship
budget: { tokens: 1M, wallclock: 30m }

jobs:
  fix:
    until: { max_iterations: 3, check: [{ cmd: npm test }] }
    steps:
      - id: repair
        agent: claude
        prompt: Почини падающие тесты. Сами тесты не меняй.
        permissions: { mode: acceptEdits }
        expect: [{ changed_only: ["src/**"] }]
  review:
    needs: [fix]
    steps:
      - id: check
        agent: codex
        prompt: Проверь дифф починки — нет ли регрессий и обхода тестов?
        permissions: { mode: read-only }
        output_schema: ./schemas/review.json
        expect: [{ schema: ./schemas/review.json }]
  ship:
    needs: [review]
    steps:
      - id: approve
        decision: { prompt: Принять починку?, outcomes: { approve: continue, deny: reject } }
```

## Установка

```bash
curl -fsSL https://raw.githubusercontent.com/assertumai/burnex/main/scripts/install.sh | bash -s -- --ref main
```

Нужны `git`, `npm` и Node ≥ 22; `--ref main` — пока в репозитории нет релизных
тегов. Дальше — [первый прогон](https://assertumai.github.io/burnex/ru/start/first-run/).
Обновление, откат и разработка через `npm link` — [docs/install.md](docs/install.md).

### Skill для агента

Чтобы агент мог писать, проверять и запускать пайплайны Burnex, выполните
в корне проекта **одну** команду для своего агента.

| Агент | Команда | Каталог установки |
| --- | --- | --- |
| Codex | `burnex skill install --agent codex` | `.agents/skills/burnex/` |
| Cursor | `burnex skill install --agent cursor` | `.cursor/skills/burnex/` |
| Claude Code | `burnex skill install --agent claude` | `.claude/skills/burnex/` |

В каталог ложатся `SKILL.md` — модель пайплайна, правила надёжности, порядок
проверки и разбора прогона — и справочники `references/`: формат документа,
готовые рецепты, ревью и решения человека, команды CLI, диагностика прогонов,
конфигурация. Повторная установка ничего не перезаписывает: файл с локальными
правками останавливает её до первой записи.

## Статус

Ранний. Пайплайн из нескольких работ с агентскими шагами исполняется целиком,
но часть объявленного формата движок отклоняет с ошибкой — `burnex lint`
назовёт, чего не хватает. Windows не проверяется.

Движок развивает сам себя: петля
[`.burnex/pipelines/self-improve.yml`](.burnex/pipelines/self-improve.yml) берёт
улучшение из [очереди](backlog.md), заводит под него OpenSpec-изменение,
реализует до зелёной сборки, ревьюит отдельной сессией и коммитит.

Прежнее имя проекта — Stepcast; прежние имена один выпуск читаются наравне с
новыми — [переход со stepcast](docs/release.md#переход-со-stepcast).

## Документация в репозитории

Спецификация лежит в [`docs/`](docs) и публикуется на сайте разделом
«Справочник»: [формат пайплайна](docs/pipeline-format.md),
[конфигурация](docs/config.md), [прогон](docs/run-layout.md),
[решения человека](docs/decisions.md), [плагины](docs/plugins.md),
[пакеты](docs/packages.md), [память репозитория](docs/knowledge.md),
[установка](docs/install.md). Исходники сайта — [`website/`](website).
