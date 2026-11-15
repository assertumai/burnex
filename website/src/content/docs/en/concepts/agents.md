---
title: Agents and roles
description: Claude, Codex, Cursor and other CLIs in one pipeline — who plays which role and how the model is chosen.
---

In burnex, an agent is a **step type**, not an orchestrator. An agent backend is the CLI the engine launches for a step: Claude Code, Codex CLI, Cursor Agent and others. Different steps of one pipeline can run on different backends: one writes, another reviews, a third wraps up the discussion.

```yaml
jobs:
  implement:
    agent: codex
    model_tier: deep
    steps:
      - id: code
        prompt: Fix the bug.             # codex, deep-tier model
      - id: review
        agent: claude
        model_tier: fast
        prompt: Review the change.       # claude, fast-tier model
```

## Backends

| Backend | How to connect | Sessions | Output schema | Status |
|---|---|---|---|---|
| `claude` | built in | yes | native | primary, tested live |
| `codex` | plugin `burnex/backends/codex` | yes | native | tested live (`examples/codex`) |
| `cursor-agent` | plugin `burnex/backends/cursor` | yes | by the engine from the response text | adapter based on CLI docs, not tested live |
| `copilot` | plugin `burnex/backends/copilot` | no | by the engine from the response text | adapter based on CLI docs, acceptance via `examples/copilot` |
| `antigravity` | plugin `burnex/backends/antigravity` | yes | native | adapter based on CLI docs, not tested live |

Backend capabilities describe what the adapter can do; they are not settings. A backend without sessions treats `session: shared` as `per_step` with a warning; a strict permission boundary (`enforce: strict`) on a backend that lacks one is an error before the run, not a silent downgrade. To connect a plugin, see [Connect Codex and Cursor](/burnex/en/guides/backends/).

## Model: tier instead of name

Instead of a model name, a step names a tier — `max`, `deep`, `balance`, `fast`, `mini` (or your own). Which model stands behind a tier for each backend is decided by the user's configuration:

```yaml
# ~/.burnex/config.yml
backends:
  claude: { model_tiers: { max: opus, balance: sonnet } }
  codex:  { model_tiers: { max: gpt-6-astra, balance: gpt-5.6-terra } }
```

The pipeline stays portable across machines and subscriptions, and the resolved "model + effort" pair is recorded in the run's `pipeline.lock.yml`. An explicit `model` on a step wins over the tier.

## Profiles and roles

A profile is a named bundle of "backend + model or tier + effort + context"; its name goes in `agent:` just like a backend name:

```yaml
agents:
  reviewer-strict:
    backend: codex
    model_tier: max
    context: [{ text: "You are a strict security reviewer." }]
```

In the `review` and `discuss` strategies, roles are the participants: each has its own profile and focus, and the aggregator has its own. `burnex run --agent <name>` swaps the agent for one run; `step_agents` in the configuration does it for a single step. `burnex config --pipeline` shows who will execute each step and why.

## In the Reference

[Agent, model, effort and tier](/burnex/en/reference/pipeline-format/#агент-модель-effort-и-tier), [agents and models in the configuration](/burnex/en/reference/config/#агенты-и-модели), [backend capabilities](/burnex/en/reference/config/#возможности-бэкендов), [backend plugins](/burnex/en/reference/plugins/#второй-бэкенд-codex).
