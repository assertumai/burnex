# Шаг discuss: обсуждение подхода до реализации

Живой прогон шага `discuss` (`docs/pipeline-format.md`, раздел «discuss»):
участник `pragmatist` на Codex и `skeptic` на Claude независимо предлагают,
как устроить ограничение частоты входа, автор (Claude) сводит предложения в
один черновик с точками решения `d<n>` и диаграммой Mermaid, участники
возражают по точкам, автор защищает черновик одним раундом, агрегатор (Claude)
выносит документ по `burnex:design-doc` с полями `agreed`, `unresolved` и
`changed_by_aggregator`. Тратит квоту подписки: от шести до девяти вызовов.
Нужны установленные и аутентифицированные `codex` и `claude`, адаптер Codex —
подключённым плагином, как в [examples/codex/README.md](../codex/README.md).

## Как запускать

```bash
npm run build
```

```bash
T=$(mktemp -d) && mkdir -p "$T/.burnex" && printf 'version: 1\n' > "$T/.burnex/config.yml" && git -C "$T" init -q && echo "$T"
```

```bash
cd "$T" && burnex lint /путь/к/burnex/examples/discuss/burnex.yml && burnex run /путь/к/burnex/examples/discuss/burnex.yml
```

`burnex config --pipeline` называет строки `design/discuss/pragmatist`,
`…/skeptic`, `…/author` и `…/aggregator`.

## Что сверить

- `jobs/design/steps/01-discuss/discuss.ndjson` — строки `proposal` обоих
  участников, `draft` с решениями `d1…` и диаграммами `g1…`, `objection` с
  `weight`, реплики `message` автора (`from: author`) и участников, `settled`
  на каждое блокирующее возражение и последней — `outcome` со счётом;
- `participants/<участник>/` — предложение, `objections/` — возражения,
  `rounds/1/` — ответ автору; `participants/author/draft/` — черновик,
  `participants/author/rounds/1/` — защита; `participants/aggregator/` —
  итог и `output.schema.json` со схемой итога и полями движка;
- `participants/aggregator/prompt.txt` — черновик, возражения со статусами и
  правками автора, пожелания и требование не сшивать несовместимое;
- `output.json` шага — проектный документ; `report` печатает `agreed=…`;
- `events.ndjson` — `discuss.phase` по фазам, `discuss.participant.*`,
  `discuss.message`, `discuss.settled`, `discuss.finished` со счётом и `agreed`;
- `usage.json` → `jobs.design.steps.discuss.participants` — расход
  `pragmatist`, `skeptic`, `author` и `aggregator`.
