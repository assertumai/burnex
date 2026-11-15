---
title: Fix until tests pass
description: The agent fixes, code checks, and the loop is capped by iterations and budget.
---

The goal: an agent fixes failing tests until they pass — but not forever, not over a set cost, and without touching the tests themselves.

```yaml
version: 1
kind: pipeline
name: fix-tests

budget: { tokens: 1M, cost: 5, wallclock: 30m }

jobs:
  fix:
    until:
      max_iterations: 3
      check: [{ cmd: npm test }]          # code is the judge, not the agent
    steps:
      - id: repair
        agent: claude
        prompt: |
          Fix the failing tests. Don't change the tests themselves.
          If the cause is in the test rather than the code, explain and don't edit anything.
        permissions: { mode: acceptEdits }
        expect:
          - changed_only: ["src/**"]      # edits only in src/
        attempts: { max: 2 }

  verify:
    needs: [fix]
    steps:
      - id: lint
        run: [npm, run, lint]
        expect: [{ exit_code: 0 }]
```

## What happens here

1. The `repair` step edits the code. If it touched anything outside `src/`, the `changed_only` check fails the attempt, and `attempts` grants a second one.
2. After the job's steps, the engine runs `npm test`. Red means a new iteration, and the output of the failing tests goes into the agent's context.
3. Three iterations without green — the job fails with reason `until_not_met`, and `verify` doesn't run.
4. The run budget stops everything that hits 1M tokens, $5, or 30 minutes.

## Check before running

```bash
burnex lint burnex.yml
```

`lint` warns that the looping job has no budget of its own and prints the worst case — how many step executions are possible.

## Next

- Add a review by a second agent after the fix — [Review by another agent](/burnex/en/guides/second-opinion/).
- Repeat a group of "check → fix" jobs — [`loops`](/burnex/en/reference/pipeline-format/#loops).
- More on retries — [Retries and budgets](/burnex/en/concepts/retries-and-budgets/).
