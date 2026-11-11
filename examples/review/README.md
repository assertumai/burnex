# Шаг review: два ревьюера на разных бэкендах

Живой прогон стратегии ревью (`docs/pipeline-format.md`, раздел «review»):
ревьюер `security` на Codex, ревьюер `tests` на Claude, агрегатор на Claude.
Тратит квоту подписки: три коротких вызова модели. Нужны установленные и
аутентифицированные `codex` и `claude`, а адаптер Codex — подключённым
плагином в глобальной конфигурации (`plugins:`), как описано в
[examples/codex/README.md](../codex/README.md).

## Как запускать

```bash
npm run build
```

```bash
T=$(mktemp -d) && mkdir -p "$T/.burnex" && printf 'version: 1\n' > "$T/.burnex/config.yml" && git -C "$T" init -q && echo "$T"
```

```bash
cd "$T" && burnex config --pipeline /путь/к/burnex/examples/review/burnex.yml | grep review-diff
```

Ожидаются три строки участников — `review/review-diff/security` (codex),
`…/tests` и `…/aggregator` (claude) — с источником выбора «шаг».

```bash
cd "$T" && burnex lint /путь/к/burnex/examples/review/burnex.yml && burnex run /путь/к/burnex/examples/review/burnex.yml
```

## Что сверить по журналу прогона

- статус обеих работ — `success`, работа `report` печатает вердикт агрегатора;
- `jobs/review/steps/1-review-diff/participants/{security,tests,aggregator}/` —
  `prompt.txt`, `context.json`, `stdout.log`, `stderr.log`, `output.json`,
  `step.json` у каждого; `output.json` ревьюеров — находки по
  `schema/review-findings.schema.json`;
- `output.json` шага совпадает с `participants/aggregator/output.json`;
- `usage.json` → `jobs.review.steps.review-diff.participants` — расход каждого
  участника, в сумме — расход шага;
- `events.ndjson` — по паре `review.participant.started|finished` на участника.
