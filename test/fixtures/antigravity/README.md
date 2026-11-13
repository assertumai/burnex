# Фикстуры Antigravity CLI

Составлены **по документации**, а не записаны с живого CLI: `agy` в среде
разработки не было (2026-11-13). Источники:

- https://antigravity.google/docs/cli/reference/ — флаги (`-p/--prompt`,
  `--output-format`, `--json-schema`, `--model`, `--effort`, `--conversation`,
  `--mode`, `--dangerously-skip-permissions`);
- https://antigravity.google/docs/cli/headless/ — формы `json` и `stream-json`
  (`init`, `step_update`, `result` с `structured_output` и `usage`), статусы и
  пример ошибки неизвестной модели.

Не сверено вживую и потому только допущения адаптера:

- промпт слитной формой `--prompt=<текст>` (документация показывает `-p "<текст>"`);
- семантика `usage`: `input_tokens` включает `cache_read_tokens`, а
  `thinking_tokens` не входит в `output_tokens` (как в Gemini API);
- текст отказов лимита и аутентификации в записи `result` (документирован
  только `authentication required` в stderr с ненулевым кодом).

`new.jsonl` — ход со схемой и вызовом инструмента, `error.jsonl` — пример
ошибки из документации.
