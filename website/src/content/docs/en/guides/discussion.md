---
title: Multi-agent discussion
description: The discuss step — several agents design a solution before any code; the result is a design document matching a schema.
---

Before implementing a large feature, it helps to have several models propose and challenge an approach. The `discuss` step does this in declared phases and returns a design document matching the `burnex:design-doc` schema: decisions, rejected options with reasons, risks, open questions, diagrams.

```yaml
# .burnex/discussion-strategies/design-panel.yml
version: 1
kind: discussion-strategy
name: design-panel
participants:
  - id: pragmatist
    agent: codex
    model_tier: max
    focus: Fewest new entities, maintenance cost
  - id: skeptic
    agent: claude
    model_tier: deep
    focus: What will break, what's missing from the requirements
author:
  agent: claude
  model_tier: max
  prompt: Consolidate honestly, don't lose rejected options.
aggregator:
  agent: claude
  model_tier: max
rounds: 2
```

```yaml
jobs:
  design:
    steps:
      - id: discuss
        discuss: design-panel
        prompt: file:./prompts/feature.md
        output_schema: burnex:design-doc
        permissions: { allow: [Read, Grep, Glob] }
```

## Phases

1. **Proposals.** Participants propose an approach in parallel and independently.
2. **Draft.** The author consolidates the proposals into a draft with decision points.
3. **Objections and defense.** Participants object point by point; the author defends or revises — for as many rounds as declared in `rounds`.
4. **Outcome.** The aggregator settles disputes and writes the document: what was decided, who proposed what and why it was rejected, `agreed`, and what remains unresolved.

The document is an ordinary job output: the next job can implement from it, and a human can accept it with a `decision` step.

## Next

- An example with an HTML report — [examples/discuss](https://github.com/assertumai/burnex/tree/main/examples/discuss).
- All fields and phases — [discuss](/burnex/en/reference/pipeline-format/#discuss).
