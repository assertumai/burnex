---
name: burnex
description: Design, write, validate, run and debug Burnex pipelines — YAML workflows that drive AI coding agents (Claude, Codex, Cursor) through deterministic steps, checks, retries, reviews and human gates. Use this skill whenever the task touches burnex.yml, .burnex/pipelines, .burnex/jobs, .burnex/steps or .burnex/config.yml, any `burnex` CLI command (lint, run, resume, status, logs, decide, apply, config), or a failed, stuck or waiting Burnex run. Also use it when the user wants to automate a repeatable agent workflow — "fix until tests pass", implement → review → verify, multi-agent review or design discussion, an approval gate before release, parallel agent lanes, a nightly unattended agent job — even if they never say "Burnex" but the project contains burnex.yml or a .burnex directory.
---

# Burnex pipelines

Burnex executes a YAML pipeline step by step. The division of labour is the
whole point, and a good pipeline keeps it sharp:

- **Code does everything deterministic** — order, retries, budgets, checks.
- **Agents do only what needs a model**, and every agent result passes a
  declared contract before anything downstream sees it.
- **Humans decide at explicit gates.**

A pipeline is reliable when its success means something: a run that ends
`success` should imply that commands you trust passed, not that an agent said
it was done. Most of this skill is about building that property in.

## How to work

1. **Read the project first.** Look at `burnex.yml`, `.burnex/pipelines/`,
   `.burnex/jobs/`, `.burnex/config.yml`. Follow existing conventions (where
   prompts and schemas live, which agents and tiers are used, how the check
   command is named). In an empty project `burnex init` creates a starter.
2. **Learn the installed engine.** `burnex` with no arguments lists every
   command and flag of this version; `burnex config` shows effective
   settings; `burnex plugins` shows which backends and predicates exist. Trust
   these over memory — the engine is young and changes.
3. **Design before writing** — see the questions below.
4. **Write the smallest pipeline that enforces the contract**, starting from a
   pattern in [references/patterns.md](references/patterns.md).
5. **Validate statically, then rehearse, then run** — see "Validate and run".
6. **Read the outcome from the journal, not from the feed's last line**, and
   fix causes rather than loosening checks.

## A minimal pipeline

Runs anywhere Node is installed; useful for checking that the engine works:

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
        timeout: 30s
        expect:
          - exit_code: 0
          - matches: /^v\d+/
```

## The model in one page

```
pipeline ── jobs (a graph: needs / on / if) ── steps (in order) ── attempts
```

- **Pipeline** (`burnex.yml` or `.burnex/pipelines/<name>.yml`): inputs,
  workspace, budget, context, and the job graph.
- **Job**: an ordered list of steps with its own agent session, budget and
  optional convergence loop. Written inline or in `.burnex/jobs/<name>.yml`
  and attached with `uses:` + `with:`. A job boundary is a session boundary —
  this is how you get an independent reviewer.
- **Step**: exactly one kind —

  | Kind | Key | Use for |
  |---|---|---|
  | command | `run: [argv…]` | tests, builds, git, anything deterministic |
  | script | `script: file` | your own code with JSON in / JSON out |
  | reusable step | `uses: name` | a packaged script with declared parameters |
  | agent | `prompt:` (+ `agent:`) | work that needs a model |
  | review | `review: strategy` | several reviewers + an aggregator |
  | discuss | `discuss: strategy` | agree a design before implementing |
  | decision | `decision:` | wait for a human |

- **Contract of a step**: `expect` predicates (`exit_code`, `schema`,
  `changed_only`, `cmd`, `script`, `matches`, `file_exists`, `judge`, …),
  `timeout`, `budget`, `attempts`.
- **Retry levels**: step `attempts` (same step again) → job `until` (all steps
  again until a check passes) → job `attempts` (roll the tree back, start
  over) → `loops` (repeat a group of jobs).
- **Data flow**: structured job output (`output: { from: <step> }` →
  `${jobs.<id>.output.<field>}`), job data (`${jobs.<id>.data.<key>}`),
  outputs file (`$NEEDS_<JOB>_<key>`), or simply the shared working tree.

Field-level detail for all of this is in
[references/format.md](references/format.md).

## Design questions

Answer these before writing YAML; each maps to a construct.

| Question | Construct |
|---|---|
| What command proves the work is done? | `until.check`, a `verify` job, `expect: [{ cmd }]` |
| What may the agent change, and what must it not? | `changed_only`, `permissions` |
| What does the next job need from this one? | `output_schema` + `output.from`, `data`, `outputs` |
| Which parts are deterministic? | `run` / `script` steps instead of agent steps |
| Who checks the author's work? | a separate job, or a `review` step |
| Where must a human say yes? | a `decision` job before the irreversible step |
| What is the worst case in tokens, money, time? | `budget` on pipeline and looping jobs, `timeout` on steps |
| Will anyone be watching? | `on_exceed: wait`, `deadline` + `on_expire`, a triage job |
| May jobs run in parallel? | `workspace: worktree` + trees or `scope: job`, `concurrency` |
| What if there is nothing to do? | `skip_exit_code`, `if` |
| What happens after a failure? | `needs: all` + `on: failure` / `on: always`, `budget_exempt` |

## Reliability rules

These are the difference between a pipeline that looks fine and one that can
be trusted. Each exists because of a concrete failure mode.

**Make success objective.** An agent step with no structural predicate
succeeds as soon as the CLI exits 0. Give every agent step at least one check
that would fail if the work were not done: a command, a schema, a file. Prefer
`cmd` and `schema` to `judge` — a judge is another model call, sees only the
step's output (not the files), and is advisory unless `hard: true`.

**Bound what the agent can touch.** `changed_only` verifies after the fact
that edits stayed inside the globs (`[]` for read-only steps); `permissions`
prevents beforehand. `changed_only` alone proves nothing happened — pair it
with a check of the result. Without any `permissions` an agent step is refused
at its first write.

**Let a command, not the agent, decide convergence.** "Keep fixing until the
tests pass" is `until: { max_iterations, check: [{ cmd }] }`. The failed
check's output is given to the next iteration automatically.

**Separate author and reviewer.** Steps of one job share a dialog by default,
so a "review" step in the same job grades its own homework. Put review in
another job (fresh session), make it read-only, and have it return JSON with a
verdict field that later jobs can branch on.

**Always bound cost and time.** Put a `budget` on the pipeline and on every
job with `until`; put a `timeout` on every step — a hung CLI spends nothing,
so only the timeout stops it. Remember the multiplication: step budget ×
`attempts.max` × `max_iterations`. `burnex lint` warns about most omissions.

**Keep side effects out of anything that repeats.** Pushes, releases and
messages happen again on every retry, iteration and loop pass. Put them in a
final job, after the checks and after the gate, and mark them `external: true`
so `burnex run --shadow` can rehearse the pipeline without performing them.

**Never route secrets through an agent.** Declare `secrets:` on the pipeline
and name them on the `run` / `script` step that needs them. Agents, judges and
checks do not receive them; outputs and data are written to the journal in
clear text.

**Pass model-produced values as arguments, not as shell text.** Use the argv
form (`run: [cmd, "${jobs.x.output.slug}"]`) or a `script` step with `input:`.
The string form of `run` rejects `${jobs.*.output.*}` for this reason.

**Isolate when running in parallel.** In the default `cwd` workspace all jobs
edit the user's checkout. For `concurrency > 1` use `workspace: { mode:
worktree }` with separate trees; results then return through `burnex apply` or
`burnex merge-lanes`, not automatically.

**Plan for failure.** A job with `needs: all` and `on: failure` (triage) or
`on: always` (cleanup, report) runs even when the graph stopped; add
`budget_exempt: true` plus its own small `budget` if it must also survive a
budget stop.

**Keep pipelines portable.** Put the repository's check command, tools and
editable paths in `.burnex/config.yml` (`project.check`, `project.tools`,
`project.edit_paths`) and reference them as `${project.*}`; select models by
`model_tier` (`max`, `deep`, `balance`, `fast`, `mini`) rather than by name.

## Validate and run

```sh
burnex lint burnex.yml --input change=foo        # static check; exit 2 on errors
burnex run burnex.yml --input change=foo --dry-run   # expand everything, start nothing
burnex config --pipeline burnex.yml              # which agent/model each step really gets
burnex context burnex.yml --job implement --step code   # what an agent step will be sent
burnex run burnex.yml --input change=foo         # execute
```

- Pass the same `--input` values to `lint`, `--dry-run`, `context` and `run`.
- Treat lint warnings as review comments: fix them, or be able to say why each
  one is acceptable here.
- A run is a foreground process and agent pipelines often take tens of
  minutes. Start long runs in the background, note the run id printed on the
  first line, and follow with `burnex status` / `burnex logs`. Tell the user
  before starting a run that will spend real tokens or money.
- Exit codes: `0` success, `1` a job failed, `2` configuration or lint error,
  `3` stopped by budget, `4` backend authentication, `130` canceled.

## When a run fails, stalls or waits

```sh
burnex status                       # failing job, step, attempt, reason, resume command
burnex logs <run> <job>/<step>      # that step's output
burnex logs <run>                   # full event stream, incl. env/context/budget events
burnex usage <run>                  # spend per step and attempt
burnex resume <run> --dry-run       # what would be reused / re-executed, and why
burnex resume <run> [--from job[/step]]
```

`<run>` is the id from the first line of `burnex run`, its short tail, or
`latest`. Journals live outside the project under `~/.burnex/runs/…`; each
step directory holds `prompt.txt`, `context.json`, `stdout.log`, `expect.json`
and `diff.patch` — the evidence for what the agent was told, what it did and
which check rejected it.

- Find the cause before changing anything. A predicate that fails on every
  attempt is information about the prompt, context or permissions; weakening
  the predicate hides it.
- `resume` starts a new run that reuses successful steps whose inputs are
  unchanged. With the default shared session the unit of reuse is the whole
  job.
- A run that stays `running` may be waiting on a `decision`
  (`burnex decide <run> <outcome>`) or sleeping for a rate-limit window. A
  decision belongs to the user: show them the prompt and the outcomes and act
  on their answer.
- Results of a `worktree` / `copy` run are not in the checkout until
  `burnex apply <run>`.

Full procedure and a symptom table: [references/runs.md](references/runs.md).

## Reference files

Read the one that matches the task; none is needed for a simple edit.

| File | Read it when |
|---|---|
| [references/format.md](references/format.md) | you need exact fields: top level, job body vs wiring, each step kind, predicates, substitutions, workspace, sessions, context, budget, env, secrets |
| [references/patterns.md](references/patterns.md) | you are building a pipeline — eight complete recipes, each checked with `burnex lint`, to adapt |
| [references/collaboration.md](references/collaboration.md) | the task involves `review`, `discuss` or `decision` steps and their strategy files |
| [references/cli.md](references/cli.md) | you need a command or flag: authoring, running, observing, resuming, applying results, in-step helpers |
| [references/runs.md](references/runs.md) | a run failed, hangs, or `resume` behaves unexpectedly; layout of the run directory |
| [references/config.md](references/config.md) | choosing agents, models and tiers; backend capabilities; limits; `project.*` facts |

For anything not covered — plugin-provided predicates and step kinds in
particular — generate the project's schemas with `burnex schema` and read
`.burnex/schema/pipeline.schema.json` and `job.schema.json`; they describe
exactly what this installation accepts.
