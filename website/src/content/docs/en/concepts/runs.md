---
title: Runs and the web UI
description: Run log, status, spend, resume and the burnex up web UI.
---

Every pipeline launch is a **run** with its own directory in `~/.burnex/runs/<project>/<time>-<id>/`. Everything goes there: the lock of the expanded pipeline, the state, the events, and for every attempt of every step — the prompt, the assembled context, the output, the structured result, check verdicts and spend.

## Commands

| Command | What it shows or does |
|---|---|
| `burnex status [--run <id>]` | run outcome by job, failure reason, pending decisions |
| `burnex logs <id> [<job>/<step>] [--follow]` | step output |
| `burnex usage <id>` | tokens and money by job, step and attempt |
| `burnex diff <a> <b>` | how two runs differ |
| `burnex resume <id> [--from <job/step>]` | a new run that reuses the old run's successful steps |
| `burnex apply <id>` | apply a run's result from a separate tree onto the current one |
| `burnex gc [--older-than 30d]` | remove old runs |

## Resume

`burnex resume` creates a new run: steps whose inputs haven't changed and that passed are taken from the old run; everything else runs again. A step's inputs are its key: prompt, context, model, the files it reads. Edit the third job's prompt and the first two won't re-run. Steps in a shared session resume as a whole job.

## Web UI

```bash
burnex up      # start
burnex down    # stop
```

A single local daemon watches runs across all projects and shows them live: the job graph, each job's input and output, run log files, a context breakdown for agent steps, spend. It also has the "Decisions" screen for `decision` steps, pipeline launching, agent and model settings, and review and discussion strategies.

## Explainability

- `burnex config` — the effective configuration with the source of each value.
- `burnex config --pipeline <file>` — who will execute each step: backend, model, effort and where they came from.
- `burnex context` — what a step will see, before the run.
- `burnex lint` — structure, references, budgets, before the first token.

## In the Reference

[Run](/burnex/en/reference/run-layout/): [run tree](/burnex/en/reference/run-layout/#дерево-прогона), [resume](/burnex/en/reference/run-layout/#возобновление), [spend](/burnex/en/reference/run-layout/#расход), [web UI](/burnex/en/reference/run-layout/#витрина), [CLI](/burnex/en/reference/run-layout/#cli).
