---
title: Human decisions
description: The decision step — a declared point where the run waits for a human.
---

In burnex, a human isn't "an operator watching the agent" but the executor of a declared step. A `decision` step pauses the run and waits for a human to pick one of the named outcomes.

```yaml
- id: gate
  decision:
    prompt: Apply the plan to the working tree?
    outcomes:
      approve: continue
      deny: { effect: reject, label: Reject }
      redo: { effect: restart, label: Check again }
    deadline: 1h
    on_expire: deny
```

## Outcomes

There are exactly three effects, and the set is closed:

| Effect | What happens |
|---|---|
| `continue` | the step succeeds and the run moves on |
| `reject` | the run stops with the reason "rejected — `<reason>`"; a reason is required |
| `restart` | the run stops and resumes from the specified step |

`deadline` is the time limit from when waiting starts; `on_expire` is the outcome once it passes (not `restart`: a run that restarts itself without a human would loop forever). The step's output — `outcome`, `effect`, `by`, `reason` — is available to jobs further down the graph.

## How to respond

```bash
burnex decide <run> approve
burnex decide <run> deny --reason "too early"
burnex decide <run> redo --from check/inspect
```

or on the "Decisions" screen of the web UI (`burnex up`). The wait shows up in `burnex status`, survives a restart of the web UI daemon, and the run status stays `running`.

## Where to place it

Before anything irreversible: merging into main, publishing, applying a plan to a live environment. Anything a code check can decide is better decided by a check — a human is needed where a choice is needed.

## In the Reference

[Human decisions](/burnex/en/reference/decisions/) — fields, deadline, waiting in the run log, restart as resume. Example: [examples/decision](https://github.com/assertumai/burnex/tree/main/examples/decision).
