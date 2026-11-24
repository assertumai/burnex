# Multi-agent and human steps: review, discuss, decision

Three step kinds put more than one mind on a result. All three produce a
structured output. To read it downstream as `${jobs.<id>.output.*}`, the job
must name the step: `output: { from: <step id> }` — without it the reference
fails at run time with "the job publishes no output", and lint does not catch
it.

| Kind | Use when | Who takes part |
|---|---|---|
| `review` | a change exists and needs independent scrutiny | reviewers → (defender) → aggregator |
| `discuss` | a design must be agreed *before* implementation | participants → author → aggregator |
| `decision` | a human must approve, reject or send back | the user |

A plain second agent step is not a review: in the default shared session it
sits in the same dialog as the author and inherits its blind spots. Put the
reviewer in another job, or use `review`.

## review

```yaml
- id: review-diff
  review: panel                        # strategy name, or ./path/to/strategy.yml
  prompt: file:../prompts/review.md    # the task: what to review, against what
  output_schema: ../schemas/review.json
  permissions: { enforce: strict, allow: [Read, Grep, Glob, "Bash(git diff*)"] }
  timeout: 25m
  budget: { cost: $15 }                # shared by all participants
  expect:
    - schema: ../schemas/review.json
    - changed_only: []                 # reviewers must not edit
```

Required: `review`, `prompt`, `output_schema`. Not allowed: `agent`, `model`,
`model_tier`, `effort`, `session` — the strategy names the participants.
`expect` and `attempts` apply to the aggregator; a retry reruns only the
aggregator with the same findings.

Strategy (`.burnex/review-strategies/<name>.yml`, then
`~/.burnex/review-strategies/`; the file's `name` must equal the name used):

```yaml
version: 1
kind: review-strategy
name: panel
profiles:                              # optional local profiles
  arch: { backend: claude, model_tier: deep }
reviewers:
  - id: correctness
    model_tier: deep                   # default agent of the machine, deep tier
    focus: "Divergence from the plan, edge cases, error handling"
  - id: compatibility
    agent: claude
    model_tier: deep
    focus: "Regressions, consumers of changed contracts, missing tests"
aggregator:                            # optional; default profile otherwise
  agent: claude
  model_tier: max
  prompt: "Report only findings backed by evidence in the diff."
mode: independent                      # independent (default) | defend
```

`focus` and `prompt` also accept `file:./path.md`, resolved from the strategy
file.

`independent`: reviewers run in parallel, each returns findings; the
aggregator receives the task, every reviewer's findings with its `focus`, and
writes the verdict in the step's `output_schema`. One failed reviewer does not
fail the step; no findings from anyone fails it without calling the
aggregator. Give reviewers different focuses, and different model families
where available — two identical reviewers mostly agree with each other.

`defend`: reviewers' findings are argued with the *implementer* before the
aggregator decides.

```yaml
# strategy
mode: defend
defend: { rounds: 2 }                  # 1..5
defender: { agent: claude, model_tier: max, prompt: "Defend with evidence from the code." }
```

```yaml
# step
- id: review-diff
  review: panel
  implementer: implement               # agent step of this job declared earlier,
  # implementer: build.implement       # or <job>.<step> of an upstream job
```

Per round the defender answers every open finding (`accept | dispute |
clarify`), then each reviewer answers on its own findings (`maintain |
withdraw | revise`). Findings still open after the rounds are `contested` and
the aggregator rules on them.

The defender is the implementer's own session only when the implementer step
ran in the same working tree in this run and its backend supports sessions;
otherwise a fresh agent defends (reason recorded, for example `other_tree`).
With `workspace.scope: job` every job has its own tree, so `defend` would get
a memoryless defender — prefer `independent` there.

## discuss

```yaml
- id: design
  discuss: design-panel
  prompt: file:../prompts/feature.md
  output_schema: burnex:design-doc     # shipped schema, or your own object schema
  permissions: { enforce: strict, allow: [Read, Grep, Glob] }
  expect:
    - judge: "Every requirement of the task is covered by a decision or an open question"
```

Strategy (`.burnex/discussion-strategies/<name>.yml`):

```yaml
version: 1
kind: discussion-strategy
name: design-panel
participants:
  - { id: pragmatist, model_tier: balance, focus: "Fewest new entities" }
  - { id: skeptic, agent: claude, model_tier: deep, focus: "What breaks, what is missing" }
author: { agent: claude, model_tier: deep }       # merges proposals into a draft, defends it
aggregator: { agent: claude, model_tier: deep }   # rules on disputes, writes the document
rounds: 1                                         # defence rounds, 1..5
```

Phases: independent proposals → the author's draft with decision points
`d1, d2, …` → participants' objections (`blocking` needs `breaks` and
`alternative`; `preference` is a note) → defence rounds on blocking objections
→ the aggregator's final document.

The engine adds three fields to the output: `agreed` (boolean), `unresolved`
(`[{ decision, reason }]`) and `changed_by_aggregator`. Gate implementation on
agreement instead of assuming it:

```yaml
jobs:
  design:
    output: { from: design }          # the discuss step's id
    steps: [ ... ]
  implement:
    needs: [design]
    if: "jobs.design.output.agreed == true"
```

`burnex:design-doc` fields: `title`, `summary`, `decisions[{ id, question,
choice, rationale, rejected[] }]`, `diagrams[{ id, title, kind: mermaid,
source, decisions }]`, `risks[]`, `open_questions`. Render it with
`burnex render design "$BURNEX_ARTIFACTS/<job>.json" --format html|openspec`.

## decision

```yaml
- id: gate
  decision:
    prompt: Merge the fix into main?
    outcomes:
      approve: continue
      deny: { effect: reject, label: Reject }
      redo: { effect: restart, label: Redo }
    deadline: 4h            # optional; counted from the start of waiting
    on_expire: deny         # required with deadline; must not be a restart outcome
```

Effects are a closed set:

| Effect | Result |
|---|---|
| `continue` | the step succeeds and the run goes on |
| `reject` | the run stops as canceled with the given reason |
| `restart` | the run stops and continues as a new run from the point given to `decide --from` |

The step's output carries `outcome`, `effect`, `by` (`user` or `deadline`),
`reason`, `restart_from`. With `output: { from: gate }` on the job it is
readable downstream as `${jobs.<job>.output.outcome}` — useful when several
outcomes continue and later jobs branch on which one was chosen.

Rules that keep a gate meaningful:

- Put the gate in its own job after the work it judges, and put irreversible
  actions (push, publish, deploy) in a job that `needs` the gate.
- `timeout` does not apply to a decision; `attempts` above 1 is rejected.
- Without a `deadline` the run waits indefinitely. For unattended runs declare
  `deadline` with a safe `on_expire` (normally the rejecting outcome).
- While waiting, the job holds its working tree; in a single-tree run nothing
  else proceeds.
- Inside `until` the gate asks again on every iteration.

Answering: `burnex decide <run> <outcome> [--reason "…"] [--from job[/step]]
[--step job/step]`, or the dashboard's `/decisions` screen. The outcome is the
user's to choose — show them the prompt and outcomes rather than answering on
their behalf.
