---
title: Review by another agent
description: One agent writes, another reviews against a schema — or a panel of reviewers with an aggregator.
---

An agent checking its own work tends to agree with itself. In burnex the reviewer is a separate step, on a different backend or model, with a structured verdict.

## A single reviewer

```yaml
jobs:
  implement:
    steps:
      - id: code
        agent: claude
        prompt: file:./prompts/implement.md
        permissions: { mode: acceptEdits }

  review:
    needs: [implement]
    steps:
      - id: check
        agent: codex
        prompt: Check the diff — any regressions or tests being bypassed?
        permissions: { mode: read-only }
        output_schema: ./schemas/review.json
        expect: [{ schema: ./schemas/review.json }]
```

The reviewer's verdict is JSON matching the schema, and later jobs read it by field: `if: "jobs.review.output.verdict == 'approve'"`. Free text like "looks fine, I guess" goes no further.

## A panel of reviewers

A `review` step references a strategy — who reviews, with what focus, and who delivers the verdict:

```yaml
# .burnex/review-strategies/panel.yml
version: 1
kind: review-strategy
name: panel
reviewers:
  - id: security
    agent: codex
    focus: Trust boundaries, secrets in logs, injections
  - id: tests
    agent: claude
    focus: Test coverage of the changed behavior
aggregator:
  agent: claude
  model_tier: deep
  prompt: Verdict is request_changes if there is a critical or major finding.
mode: independent
```

```yaml
- id: review-diff
  review: panel
  prompt: Review the branch diff.
  output_schema: ./schemas/verdict.json
  permissions: { allow: [Read, Grep, Glob, "Bash(git diff*)"] }
```

Reviewers run in parallel and return findings in a built-in schema; the aggregator produces the verdict in yours. One reviewer failing doesn't fail the step. The `defend` mode lets the author of the change defend it against the findings before the verdict.

## Next

- The full example — [examples/review](https://github.com/assertumai/burnex/tree/main/examples/review).
- All fields — [review](/burnex/en/reference/pipeline-format/#review) and [defend mode](/burnex/en/reference/pipeline-format/#режим-defend).
- Strategies are visible and editable on the "Review strategies" screen of the web UI.
