---
title: Context and sessions
description: What an agent sees in a step — declared context, outputs of earlier jobs, a shared session.
---

An agent doesn't see "whatever it finds" — it sees what it was given. The engine assembles context deterministically: the same input produces the same prompt.

## Three levels

```yaml
context:                         # pipeline — seen by every agent step
  - AGENTS.md
  - text: Don't touch generated files in build/.

jobs:
  implement:
    context:                     # job
      - "openspec/changes/${inputs.change}/**/*.md"
    steps:
      - id: code
        agent: claude
        context:                 # step
          - path: reports/plan.json
            mode: inline
        context_exclude: ["build/**"]
```

Assembly goes top down: pipeline → job → step, preceded by a block with the outputs of earlier jobs. Entries keep their declaration order, and globs expand sorted. Small files are inlined in full; large ones are passed by path, and the agent reads them itself. `context_inherit: false` leaves the step with only its own context.

## Limits and exclusions

- `context.max_tokens` caps a step's assembled context and is checked **before** the agent starts: one bad glob won't ship the whole repository. When the limit is exceeded, large inline entries are demoted to references, and if that doesn't help, the step fails without spending tokens.
- Paths under `context.deny` in the configuration never make it into context.
- `required: true` on a glob fails the step if the glob matched nothing — instead of a silently thinner context.

## Preview before running

```bash
burnex context --job implement --step code
```

shows the entries, their source, how each is passed and an estimated size. In a run, the same data lives in the step's `context.json`.

## Sessions

By default, the agent steps of one job run in a **shared session** (`session: shared`): the second step sees the first step's conversation, shared context is sent once, and prompt caching works. `session: per_step` gives each step its own session — and the ability to re-run a single step on `resume`. Jobs talk to each other through files, not conversation — their JSON outputs.

## In the Reference

[Context](/burnex/en/reference/pipeline-format/#контекст), [sessions](/burnex/en/reference/pipeline-format/#сессии), [context size](/burnex/en/reference/config/#размер-контекста), [outputs of earlier jobs](/burnex/en/reference/pipeline-format/#результаты-работ).
