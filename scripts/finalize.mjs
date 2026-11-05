#!/usr/bin/env node
/**
 * Завершение захода петли больше не ведёт этот скрипт — работа `finalize`
 * зовёт `burnex backlog settle` напрямую через `$BURNEX_BIN`
 * (`.burnex/jobs/finalize.yml`). Файл остаётся заглушкой, а не исчезает:
 * физическое удаление вне прав работы `implement-express`
 * (openspec/changes/agent-cannot-clean-up/proposal.md) — тело, несущее
 * прежнюю логику, читалось бы вторым, расходящимся источником правды.
 */
process.stderr.write(
  'finalize.mjs: команда заменена `burnex backlog settle` — этот скрипт больше не проставляет исходы\n',
);
process.exit(1);
