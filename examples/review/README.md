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

## Режим discussion

`burnex-discussion.yml` — то же ревью со стратегией `strategy-discussion.yml`:
ревьюеры обсуждают находки до трёх реплик каждый (`discussion.max_messages: 3`),
затем агрегатор оформляет согласованное предложение либо решает сам по ленте.
Тратит от четырёх до девяти вызовов модели. Запуск — как выше, с этим файлом:

```bash
cd "$T" && burnex lint /путь/к/burnex/examples/review/burnex-discussion.yml && burnex run /путь/к/burnex/examples/review/burnex-discussion.yml
```

Что сверить:

- `jobs/review/steps/1-review-diff/discussion.ndjson` — предложения `p1`, `p2`
  находок раунда 0, реплики раундов в форме A2A `Message` (`messageId`, `role`,
  `parts`) и последняя запись `outcome`: `consensus: true` с id предложения
  либо `consensus: false` с причиной (`limit`, `stalled`, `budget`);
- `participants/<ревьюер>/rounds/<раунд>/` — промпт и ответ каждой реплики;
  промпт раунда несёт только реплики другого ревьюера, которых тот ещё не видел;
- `participants/aggregator/prompt.txt` — согласованное предложение и требование
  оформить его без изменения решения либо вся лента с позициями;
- `events.ndjson` — `review.message` на каждую реплику и `review.consensus` или
  `review.no_consensus`;
- `usage.json` → `jobs.review.steps.review-diff.participants` — расход всех
  вызовов каждого ревьюера.
