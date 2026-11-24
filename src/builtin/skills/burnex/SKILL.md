---
name: burnex
description: Write, validate, run, and diagnose Burnex YAML pipelines in a project. Use when editing burnex.yml or .burnex pipelines, jobs, and steps, or when a user asks to execute or troubleshoot a Burnex workflow.
---

# Burnex pipelines

Work from the project root. Look for `burnex.yml`, named pipelines in
`.burnex/pipelines/`, and reusable jobs and steps under `.burnex/`. Follow
the project's existing conventions. In a new project, `burnex init` creates
a starter pipeline and an example job.

## Write a pipeline

This standalone `burnex.yml` exercises the engine using only Node:

```yaml
version: 1
kind: pipeline
name: smoke
budget: { wallclock: 1m }
jobs:
  check:
    steps:
      - id: node-version
        run: [node, --version]
```

Use a job's `needs: [check]` to depend on the job named `check`. Steps in
one job execute in order. Use `run` with an argument list for deterministic
work such as tests. For a model task, give the step an `id`, an `agent`
matching the project's configuration, and a `prompt` with an observable
result. Use `expect` for executable checks, e.g. `expect: [{ cmd: npm test }]`
when the project defines that test script. Use a `decision` step for human
approval. The editor's skill installation and the pipeline's execution
backend are separate choices.

For exact fields and plugin predicates, generate the project-specific JSON
schemas with `burnex schema` and inspect `.burnex/schema/`. Check resolved
agents and models with `burnex config --pipeline burnex.yml`.

## Validate and execute

Run these from the project root, substituting the actual pipeline path.
For a parameterized pipeline pass the same `--input key=value` arguments
to lint, dry run, and execution.

```sh
burnex lint burnex.yml
burnex run burnex.yml --dry-run
burnex run burnex.yml
```

Fix lint errors at the reported file and field before executing. Dry run
checks the expanded workflow without executing jobs. Use the final command
when the task calls for execution. Record the run ID and outcome. Inspect
a specific run with `burnex status --run <run-id>` and a failing step with
`burnex logs <run-id> <job>/<step>`. A run waiting on a human decision
needs the user's chosen outcome before it can continue.
