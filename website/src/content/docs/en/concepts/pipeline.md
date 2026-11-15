---
title: Pipeline and jobs
description: What burnex.yml is made of — jobs, dependencies, conditions, job output.
---

A **pipeline** is a YAML document (`burnex.yml` or `.burnex/pipelines/<name>.yml`) containing a graph of **jobs**. A **job** is a sequence of steps with its own budget, retry condition, and a single structured output.

```yaml
version: 1
kind: pipeline
name: implement

inputs:
  change: { type: string, required: true }

jobs:
  plan:
    steps: [...]
  implement:
    needs: [plan]             # after plan
    steps: [...]
  triage:
    needs: all
    on: failure               # only if something failed
    steps: [...]
```

## A graph, not a script

- `needs` declares dependencies. Jobs with no mutual dependencies run in parallel, up to `concurrency` (1 by default).
- `on: success | failure | always` is a condition on the outcome of dependencies; `if:` is a condition on data: `if: "jobs.plan.output.risk == 'high'"`. Expressions can see inputs and job statuses and outputs.
- `fail_fast: true` (the default): the first failure stops new jobs from starting, jobs already running finish, and then jobs with `on: failure` run.
- An unbounded loop, an unreachable job, or a reference to a nonexistent job are `burnex lint` errors, caught before the run.

## Job output

A job returns one JSON: the engine takes it from the `output.from` step (the last agent step by default) and validates it against `output.schema`. The engine writes the file, not the agent. Upstream outputs are **automatically** added to the context of downstream agent jobs; `context_upstream` controls this.

```yaml
  plan:
    output: { from: draft, schema: ./schemas/plan.json }
```

## A job in a separate file

A job knows nothing about the pipeline: it describes only what it does, its budget, and its convergence condition. Dependencies, conditions, and environment are set where the job is included — so one job can be reused across pipelines.

```yaml
jobs:
  review:
    uses: .burnex/jobs/review.yml
    needs: [implement]
```

## Working directory

`workspace.mode`: `cwd` works directly in the project directory, `worktree` in a separate git worktree, `copy` in a copy. The result of a run in a separate tree is carried over to the current one with `burnex apply`.

## In the Reference

- [Top level](/burnex/en/reference/pipeline-format/#верхний-уровень), [dependencies and conditions](/burnex/en/reference/pipeline-format/#зависимости-и-условия), [order and failures](/burnex/en/reference/pipeline-format/#порядок-и-отказы)
- [Job file](/burnex/en/reference/pipeline-format/#файл-работы), [job results](/burnex/en/reference/pipeline-format/#результаты-работ), [working directory](/burnex/en/reference/pipeline-format/#рабочая-директория)
