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

## Режим defend

`burnex-defend.yml` — ревью с защитой находок (`strategy-defend.yml`,
`mode: defend`, `defend.rounds: 2`). Шаг `implement` (Claude) пишет в рабочий
каталог маленький `login.ts`, затем шаг `review-diff` с
`implementer: implement`: ревьюеры `security` (Codex) и `tests` (Claude) ищут
находки, а защищает их сама сессия имплементатора, возобновлённая на месте
(`claude --resume <сессия implement>`). Раунд — один ход защитника на
открытые находки обоих ревьюеров, затем ревьюеры параллельно отвечают ему в
своих сессиях. Принятое защитником и снятое ревьюером закрывается сразу,
спорное после двух раундов (`contested`) решает агрегатор. Тратит от пяти до
десяти вызовов модели. Рабочий каталог — тот, где запущен burnex
(`workspace.mode: cwd`), поэтому запускайте во временном каталоге `$T`, как
выше:

```bash
cd "$T" && burnex lint /путь/к/burnex/examples/review/burnex-defend.yml && burnex run /путь/к/burnex/examples/review/burnex-defend.yml
```

`burnex config --pipeline` для этого файла называет и строку
`review/review-diff/defender` — свежего защитника, который нужен, только если
у шага `implement` нет сессии.

Что сверить:

- `jobs/review/steps/2-review-diff/defense.ndjson` — первая строка
  `{"kind":"defender","mode":"resume","implementer":"review.implement","agent":"claude",…}`,
  затем находки `security.<n>` и `tests.<n>`, реплики в форме A2A `Message`
  (`messageId`, `role`, `parts`, `from`, `round`, `responses`; у реплик
  ревьюеров ещё `thread`), по одной строке `settled` на находку и последняя
  строка `outcome` со счётом `accepted`/`withdrawn`/`contested`;
- `participants/defender/rounds/<r>/` — ходы защитника; `session_id` в их
  `step.json` совпадает с полем `session` в
  `jobs/review/steps/1-implement/step.json`;
- `participants/<ревьюер>/rounds/<r>/` — ответы ревьюера защитнику;
- `participants/aggregator/prompt.txt` — строка о защитнике, находки со
  статусами и перепиской, требование решить `contested` самому;
- `events.ndjson` — `review.defender` с `mode: resume`, `review.message` на
  каждую реплику (у защитника без `thread`), `review.settled` на каждую
  находку, `review.defense.finished`;
- `usage.json` → `jobs.review.steps.review-diff.participants.defender` — расход
  ходов защитника.
