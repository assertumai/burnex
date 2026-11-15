---
title: Contracts
description: expect, the output schema, and the judge — how burnex checks a step's result.
---

A step succeeds only if its checks — **`expect`** — pass. The pipeline author declares the checks; the engine evaluates them after every attempt, and a failed check fails the step.

```yaml
- id: implement
  agent: claude
  prompt: file:./prompts/implement.md
  output_schema: ./schemas/implement.json
  expect:
    - schema: ./schemas/implement.json        # output matches the schema
    - changed_only: ["src/**", "test/**"]     # edits stayed within bounds
    - cmd: npm test                           # tests are green
```

## Predicates

| Predicate | What it checks |
|---|---|
| `exit_code: 0` | exit code |
| `schema: <path>` | structured output matches a JSON Schema |
| `changed_only: [glob]` | changed files stay within the patterns |
| `cmd: "..."` | the command exits with zero |
| `script: <path>` | a check script in any language exits with zero |
| `file_exists`, `matches`, `not_matches` | a file was created; the result text does or doesn't contain something |
| `judge: "..."` | evaluation by a judge agent |

Keys are closed: a typo like `exit_cod` is a parse error, not a silently skipped check. Plugins add their own predicates.

## Output schema

`output_schema` is passed to the agent through its CLI's native structured output mechanism (Claude, Codex). For a backend without one (Cursor, Copilot), the schema goes into the prompt, and the engine takes the last JSON block of the response and validates it itself; a response that doesn't match the schema triggers a retry with the schema error.

## Hard checks and the judge

Hard gates should be checks that are cheaper and more reliable than the work itself: exit code, schema, tests. The judge is a separate agent call in its own session; it sees only the step's output and is **advisory** by default (`hard: false`): its verdict goes into the log but doesn't fail the step.

```yaml
expect:
  - judge: "The plan covers every requirement in the spec"
    hard: true
```

## What a contract doesn't do

- It doesn't check that an attempt differs from the previous one: retries are bounded only by the number of attempts and the budget.
- `changed_only` checks boundaries, not that work was done: a step that changed nothing passes it. Pair it with a check of the result.

## In the Reference

[expect](/burnex/en/reference/pipeline-format/#expect), [judge](/burnex/en/reference/pipeline-format/#judge), [job results](/burnex/en/reference/pipeline-format/#результаты-работ).
