---
title: Step kinds
description: Code, an agent, several agents, and a human — which step is for what.
---

A step is the unit of execution inside a job. The step kind determines **who** executes it.

| Kind | Executed by | Used for |
|---|---|---|
| `run` | code | a command: tests, builds, linters |
| `script` | code | a script file with an input and output contract |
| `uses` | code or agent | a reusable step from `.burnex/steps/<name>/` |
| `agent` | one agent | writing, fixing, explaining |
| `review` | several agents | panel review: reviewers and a verdict aggregator |
| `discuss` | several agents | design: proposals, draft, objections, outcome |
| `decision` | a human | stop the run and wait for a decision |

## Code

```yaml
- id: test
  run: [npm, test]
  expect: [{ exit_code: 0 }]
```

The command is an array of arguments, with no shell. Anything that can be checked or done with code is better done with code: it's fast, free, and the same on every run.

## Agent

```yaml
- id: fix
  agent: claude
  prompt: file:./prompts/fix.md
  permissions: { mode: acceptEdits }
  output_schema: ./schemas/fix.json
```

The prompt is a string or a file with `${inputs.*}` and `${jobs.*}` substitutions. `permissions` is translated into the agent CLI's flags; without it, the agent will be denied on its first file write. Agent steps in the same job share a session by default.

## Several agents

`review` and `discuss` refer to a **strategy** — a separate YAML listing the participants (backend, model, focus), the author, and the aggregator. The step describes only the task and the shape of the outcome. More in [Agents and roles](/burnex/en/concepts/agents/).

```yaml
- id: review-diff
  review: panel                  # .burnex/review-strategies/panel.yml
  prompt: file:./prompts/review.md
  output_schema: ./schemas/review.json
```

## Human

```yaml
- id: gate
  decision:
    prompt: Merge into main?
    outcomes: { approve: continue, deny: reject }
    deadline: 4h
    on_expire: deny
```

More in [Human decisions](/burnex/en/concepts/human/).

## In the Reference

[Steps](/burnex/en/reference/pipeline-format/#шаги): [agent](/burnex/en/reference/pipeline-format/#agent), [run](/burnex/en/reference/pipeline-format/#run), [script](/burnex/en/reference/pipeline-format/#script), [uses](/burnex/en/reference/pipeline-format/#переиспользуемый-шаг-uses), [review](/burnex/en/reference/pipeline-format/#review), [discuss](/burnex/en/reference/pipeline-format/#discuss), [decision](/burnex/en/reference/decisions/).
