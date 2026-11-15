---
title: Retries and budgets
description: attempts, until, and budgets — how many times and at what cost burnex retries work.
---

Agents make mistakes, so retries are a normal part of a pipeline. But every retry is bounded: by the number of attempts and by a budget. The worst case is computed up front.

## attempts — retry a step

```yaml
- id: implement
  agent: claude
  attempts:
    max: 3
    escalation:
      - include_failure: true              # attempt 2 sees why attempt 1 failed
      - include_failure: true
        model: opus                        # attempt 3 uses a stronger model
```

Each attempt is logged separately, with its own spend. A step that reliably passes only on the third try points to a problem in the prompt or spec, and `burnex usage` will show it.

## until — retry a job until a check passes

```yaml
jobs:
  fix:
    until: { max_iterations: 4, check: [{ cmd: npm test }] }
    steps:
      - id: repair
        agent: claude
        prompt: Fix the failing tests.
```

All steps → check → if it fails and limits remain, a new iteration. The failed check's output is fed to the steps of the next iteration. Running out of iterations fails the job with reason `until_not_met`.

To repeat a **group** of jobs (check → fix), use `loops`; to roll back and retry a whole job, use `attempts` on the job.

## Budget

```yaml
budget:
  tokens: 2M
  cost: 20              # dollars
  wallclock: 2h
  rate_limit_pct: 80    # don't use more than 80% of the subscription rate-limit window
  on_exceed: wait       # wait | stop
```

There are three levels — pipeline, job, step; whichever cap is hit first applies. Spend is tracked continuously from the backend's stream: exceeding it aborts the current step without waiting for it to finish. Before each step the cap is checked, and a step that no longer fits isn't started at all.

`burnex lint` warns about a loop without a budget and prints the worst case: `Σ (step budget × attempts) × max_iterations × job attempts`.

## In the Reference

[attempts](/burnex/en/reference/pipeline-format/#attempts), [until](/burnex/en/reference/pipeline-format/#until), [loops](/burnex/en/reference/pipeline-format/#loops), [budget](/burnex/en/reference/pipeline-format/#бюджет), [run spend](/burnex/en/reference/run-layout/#расход).
