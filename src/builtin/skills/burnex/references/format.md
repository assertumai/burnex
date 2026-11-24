# Pipeline document reference

Field-level reference for `kind: pipeline` and `kind: job` documents. Unknown
keys are rejected at parse time, so anything not listed here is probably a typo
or a plugin contribution — confirm with `burnex schema` and
`.burnex/schema/*.json`.

## Contents

- [Files and path resolution](#files-and-path-resolution)
- [Pipeline top level](#pipeline-top-level)
- [Job body](#job-body)
- [Job wiring](#job-wiring-keys-on-the-jobsid-entry)
- [Steps](#steps): [agent](#agent-step), [run](#run-step), [script](#script-step), [uses](#reusable-step-uses), [review / discuss / decision](#review-discuss-decision)
- [expect predicates](#expect-predicates)
- [attempts, until, loops](#attempts-until-loops)
- [Passing values between jobs](#passing-values-between-jobs)
- [Substitutions and expressions](#substitutions-and-expressions)
- [Workspace](#workspace)
- [Sessions](#sessions)
- [Context](#context)
- [Budget](#budget)
- [Environment and secrets](#environment-and-secrets)
- [Agent, model, tier, effort](#agent-model-tier-effort)

## Files and path resolution

| File | Role |
|---|---|
| `burnex.yml` | default pipeline of the project |
| `.burnex/pipelines/<name>.yml` | named pipelines |
| `.burnex/jobs/<name>.yml` | reusable jobs (`kind: job`) |
| `.burnex/steps/<name>/step.yml` | reusable steps (`kind: step`) |
| `.burnex/scripts/` | files for `script:` steps and predicates |
| `.burnex/prompts/`, `.burnex/schemas/` | conventional homes for prompts and JSON Schemas |
| `.burnex/review-strategies/`, `.burnex/discussion-strategies/` | multi-agent strategies |
| `.burnex/config.yml` | project configuration |

Three different path rules — mixing them up is the most common authoring error:

- `uses:` of a job, `prompt: file:…`, `schema:` / `output_schema:`, and
  `review:` / `discuss:` with a `./` path resolve **from the file that declares
  them**. A job in `.burnex/jobs/` therefore writes `../prompts/x.md`.
- `context:` paths, paths inside `run:`, and `file_exists` resolve **from the
  job's working directory** (the workspace root).
- `script: name.py` and step-level `uses: name` are **names looked up in
  layers**: project `.burnex/scripts|steps/` → `~/.burnex/…` → built-in. A
  `script:` value starting with `./` or `../` is instead a path from the
  declaring file.

`schema: burnex:<name>` refers to a schema shipped with the engine (for example
`burnex:design-doc`). `burnex run burnex:<name>` runs a pipeline shipped with
the engine, `burnex run <package>:<name>` one from a user package.

## Pipeline top level

```yaml
version: 1
kind: pipeline
name: implement-change

inputs:                       # CLI: --input change=foo
  change: { type: string, required: true }
  skip_review: { type: bool, default: false }

workspace: { mode: cwd }      # cwd | worktree | copy — see Workspace
env: { NODE_ENV: test }
env_files: [.env.test]
env_deny: ["AWS_*"]
secrets: { ... }              # see Environment and secrets
context: [AGENTS.md]          # inherited by every agent step
project:                      # overrides project.* of the configuration
  check: npm run check
  tools: [npm, npx, node]
  edit_paths: [src/**, test/**]
defaults: { agent: claude, session: shared }
agent: claude                 # agent/model/model_tier/effort also allowed at the root
mcp: { ... }                  # MCP servers for agent steps
shell: [bash, -lc]            # prefix for string-form run
skip_exit_code: 78            # see run step
budget: { tokens: 2M, cost: 20, wallclock: 2h, rate_limit_pct: 80, on_exceed: stop }
concurrency: 1                # parallel jobs; default 1
fail_fast: true               # default true
triggers: { schedule: [{ cron: '0 4 * * *', timezone: Europe/Berlin }] }
jobs: { ... }
loops: { ... }                # see attempts, until, loops
```

`triggers.schedule` is only a declaration shown in the dashboard; no service
fires it yet. Start scheduled runs with an external scheduler.

## Job body

A job is written inline under `jobs.<id>` or in its own file and attached with
`uses:`. These keys belong to the job body (both forms):

```yaml
version: 1                    # only in a separate file
kind: job
name: implement
description: Implement the plan until the build is green

params:                       # filled by `with:` at the attach site
  change: { type: string, required: true }
  max_iterations: { type: int, default: 4 }

session: shared               # shared | per_step
context: [ ... ]
context_upstream: all         # all | none | [job ids]
output: { from: write-code, schema: ./schemas/implement.json }
outputs: [sha]                # keys the job must publish to $BURNEX_JOB_OUTPUTS
data: [title]                 # keys the job may publish with `burnex data`
inputs: [config/settings.json] # extra files for the step fingerprint
budget: { tokens: 500k, wallclock: 30m }
attempts: { max: 2 }          # retry the whole job on a rolled-back tree
until: { max_iterations: 4, check: [{ cmd: npm test }] }
permissions: { ... }          # default for the job's agent steps
env: { ... }
steps: [ ... ]
```

A job file may read `${params.*}`, `${project.*}` and `${job.lane}` but not
`${inputs.*}` — pass pipeline inputs through `with:` so the job stays reusable.

Job statuses: `success | failed | skipped | canceled | budget_exceeded`.

## Job wiring (keys on the `jobs.<id>` entry)

These describe the job's role in *this* pipeline. They are rejected inside a
job file.

| Key | Meaning |
|---|---|
| `uses: ./jobs/x.yml` | attach a job file |
| `with: { k: v }` | values for the job's `params` (string, number or bool) |
| `needs: [a, b]` / `needs: all` | direct dependencies / "after the rest of the graph finished in any outcome" |
| `on: success \| failure \| always` | which dependency outcome triggers the job (default `success`) |
| `if: "<expr>"` | data condition, evaluated when the job becomes ready |
| `lane: a` | bookkeeping label for a parallel lane (`apply --lane`, `merge-lanes`) |
| `session_group: build` | several jobs continue one agent dialog |
| `budget_exempt: true` | keep running after the run budget stopped the graph (only with `on: always\|failure`, needs own `budget` if it calls a model) |
| `display: { title: "${jobs.x.data.title}" }` | label shown in the dashboard |
| `workspace`, `env`, `budget`, `context`, `shell`, `skip_exit_code` | override the job body's values |

`on` is about dependency outcomes, `if` is about data; both must hold.
Skipped dependencies do not block `on: success`, but a job whose dependencies
were *all* skipped is skipped too — except with `on: always`. Triage pattern:
`needs: all` + `on: failure`. Summary pattern: `needs: all` + `on: always`.

Jobs without mutual dependencies run in parallel up to `concurrency`. With
`fail_fast: true` the first failure stops new jobs from starting; running ones
finish, then `on: failure` and `needs: all` jobs run.

## Steps

Steps of a job run in order. Every step has an `id`. Common keys: `env`,
`context`, `timeout`, `budget`, `expect`, `attempts`, `on_fail`, `external`.
Exactly one kind key per step.

Give every step a `timeout`: a hung CLI produces no spend, so a budget alone
never stops it. On expiry the step gets SIGTERM, then SIGKILL after 30 s, and
fails with reason `timeout`.

### agent step

```yaml
- id: plan
  agent: claude               # optional; inherited step → job → pipeline → config
  model: opus                 # or model_tier: deep; effort: high
  session: analysis           # optional named session inside the job
  prompt: file:./prompts/plan.md      # or inline text
  context: [docs/spec.md]
  output_schema: ./schemas/plan.json  # structured JSON output
  permissions:
    mode: acceptEdits         # backend vocabulary
    allow: [Read, Edit, "Bash(npm *)"]
    deny: ["Bash(rm *)"]
    enforce: strict           # inherit (default) | strict
  timeout: 20m
  budget: { tokens: 120k }
  expect: [{ schema: ./schemas/plan.json }]
  attempts: { max: 3, escalation: [{ include_failure: true }, { include_failure: true, model: opus }] }
```

- The step is identified as an agent step by `prompt`. Prompt files are
  templated with `${params.*}`, `${inputs.*}`, `${project.*}`, `${jobs.*}`;
  write `$${` for a literal `${`.
- Without `permissions` the agent is refused at its first file write.
- `permissions.mode` is the backend's own vocabulary: Claude Code permission
  modes (`plan`, `acceptEdits`, `auto`, …), Codex sandbox modes (`read-only`,
  `workspace-write`, `danger-full-access`). Codex accepts but does not apply
  `allow` / `deny` / `enforce`.
- `enforce: strict` turns `allow` into a boundary: user-level backend settings
  are not read at all, an unnamed tool is denied, only declared `mcp` servers
  start. It conflicts with permissive modes (`auto`, `acceptEdits`, `dontAsk`,
  `bypassPermissions`) — lint rejects the pair. `Bash(burnex data *)` is
  granted implicitly.
- A nearer `permissions` block replaces the outer one whole; lists are not
  merged.
- The agent never receives secrets.

`mcp` (pipeline, job or step; the nearest block replaces the outer one; `{}`
removes inherited servers):

```yaml
mcp:
  docs: { url: https://mcp.example.com/mcp, headers: { X-Client: burnex } }
  local: { command: [node, ./mcp/server.js], env: { PROJECT: "${params.project}" } }
```

Under `enforce: strict` a server's tools still need an `allow` entry
(`mcp__<server>` or `mcp__<server>__<tool>` for Claude Code).

### run step

```yaml
- id: test
  run: [npm, test]            # argv list — preferred
  timeout: 10m
  expect: [{ exit_code: 0 }]
  on_fail: { analyze: claude, prompt: file:./prompts/triage.md }
```

- A string `run:` goes through `sh -c` (or the nearest `shell:` prefix).
  `${jobs.*.output.*}` is rejected in string form — model-produced data belongs
  in argv, not in a command line.
- With `output_schema` the step's whole stdout must be one JSON document; it
  becomes the step's structured output (usable by `schema`, `output.from`,
  `${jobs.<id>.output.*}`).
- `on_fail.analyze` does not fix or retry: it writes `analysis.md` and the step
  still fails.
- `skip_exit_code: 78` (step, job, wiring or pipeline root; nearest wins;
  1..255) turns that exit code into "nothing to do": the step and the job
  become `skipped`, remaining steps do not run, and `fail_fast` is not
  triggered. The step sees the value as `$BURNEX_SKIP_EXIT_CODE`. Pick a rare
  code, never 1, 2, 126, 127 or 128+n.
- `secrets: [name]` delivers declared secrets to this process only.

### script step

```yaml
- id: cleanup
  script: cleanup.py          # layered name, ./relative path, or absolute path
  args: ['--dry-run']         # list only; no shell involved
  runner: uv                  # optional; else file extension, then shebang
  input: { slug: "${jobs.plan.output.slug}" }
  output_schema: ./schemas/cleanup.json
```

The script reads `$BURNEX_INPUT` (JSON written by the engine) and writes
`$BURNEX_OUTPUT` (JSON, its structured output). stdout is just a log. In
`input`, a string that is exactly one substitution keeps its original type
(object, list, number). `node` / `node-ts` runners also accept a default
export: `export default async (input) => output`.

### Reusable step (`uses`)

```yaml
- id: changed
  uses: changed-files         # .burnex/steps/changed-files/step.yml, ~/.burnex/steps, built-in
  with: { ref: HEAD, include_untracked: true }
```

Manifest `.burnex/steps/<name>/step.yml`:

```yaml
version: 1
kind: step
name: changed-files           # must equal the directory name
description: Files of the working tree changed relative to ref.
file: ./main.mjs              # same input/output contract as script
params:                       # JSON Schema of the whole `with` object
  type: object
  properties:
    ref: { type: string, default: HEAD }
output_schema: ./output.schema.json
```

`script`, `args`, `runner`, `input`, `output_schema` are not allowed next to
`uses`; the manifest owns them. Lint checks `with` against `params`.

### review, discuss, decision

Multi-agent review, pre-implementation discussion and human gates are step
kinds too — see [collaboration.md](collaboration.md).

### external and shadow runs

`external: true|false` on `agent`, `run`, `script`, `uses` steps declares
whether the step acts outside the machine (push, publish, message).
`burnex run --shadow` executes local steps and only records external ones
(`action-<n>.json`), answering "what would this run do outwards". In shadow
mode every such step must declare `external`, otherwise the run is refused
before it starts. The flag is the author's claim; the engine does not sandbox.

## expect predicates

`expect` is a list; predicates are evaluated in order. A step with an empty
`expect` still checks its exit code.

| Predicate | Passes when |
|---|---|
| `exit_code: 0` | process exit code matches |
| `file_exists: <path>` | file exists (path from the working directory) |
| `schema: <path>` | structured output validates against the JSON Schema |
| `matches: /re/` / `not_matches: /re/` | text result (agent `result`, or stdout of `run`) matches / does not |
| `changed_only: [glob]` | every file changed since the step started is inside the globs (`**` crosses `/`); `[]` means "changed nothing" |
| `cmd: "..."` | the shell command exits 0 |
| `script: <path>` | the check file exits 0; may write `{ "reason": "…" }` to `$BURNEX_OUTPUT` |
| `knowledge_valid: true` | repository memory passes `check` (needs a configured knowledge practice) |
| `judge: "<claim>"` | a separate agent call answers `{ pass, reason }` |

- `changed_only` checks boundaries, not that work happened — an agent that
  changed nothing passes. Lint warns when it is the only predicate.
- `judge` is advisory unless `hard: true`. It may name its own `agent` and
  `model`. The judge sees only the claim, the step's task and the step's
  output — not the step's context, not project files — so phrase the claim so
  it can be verified from the output alone. It is skipped when a hard
  structural predicate already failed, and its spend counts toward budgets.
- Plugins may add predicates; `burnex schema` lists what this project has.

## attempts, until, loops

Three retry levels, nested as: job attempt → `until` iteration → step → step
attempt.

**Step `attempts`** — retry one step on the same tree:

```yaml
attempts:
  max: 3
  escalation:                 # optional, one entry per retry
    - include_failure: true   # feed the failed attempt's output to the next
    - include_failure: true
      model: opus             # and/or switch model
```

With `session: shared` the failed attempt stays in the dialog; use
`per_step` if the retry must start clean.

**Job `attempts: { max: N }`** — the failed job discards its changes (only the
paths it touched are rolled back; requires git) and reruns from its first step
with fresh sessions, `data` and `outputs`. No `escalation`. Retried only for
`expect_failed`, `timeout`, `spawn_failed`, `until_not_met`. External side
effects of the steps happen again.

**`until`** — repeat all steps of one job until a check passes:

```yaml
until:
  max_iterations: 4           # required
  check:
    - cmd: npm test
```

All steps run → `check` → if it failed, the failing check's output (tail,
truncated to `context.note_max_tokens`) is added to the next iteration's agent
context. Sessions restart every iteration; step attempts reset. A step that
exhausts its own `attempts` fails the job without another iteration.
Exhausting iterations gives `failed` with reason `until_not_met`.

**`loops`** — repeat a *group of jobs* in passes ("check → fix"):

```yaml
loops:
  fix-loop:
    jobs: [check, fix]        # members; exactly one entry point
    while: "jobs.check.status != 'success'"   # continue condition; default: a member failed
    max_iterations: 3         # required
    cost: 5                   # shared money cap for all passes
    wallclock: 1h
```

- `while` may read only `jobs.<member>.{status,output,data}` and
  `loop.{id,iteration,max_iterations}`.
- Jobs outside the loop that depend on a member wait for the verdict and run
  once, seeing the last pass. A loop that did not end with `done` counts as a
  failed dependency (`loop_exhausted`).
- A new pass continues the tree of the previous one; member sessions, `data`,
  and outputs reset. A member's `budget` applies per pass.
- Members may not use `needs: all` or `session_group`; loops do not nest or
  overlap; no non-member job may sit between members.
- Member side effects repeat every pass — put publishing in a job below the
  loop.

## Passing values between jobs

| Mechanism | Declared by | Read as | Use for |
|---|---|---|---|
| Structured output | `output: { from: <step>, schema }` on the job | `${jobs.<id>.output.<field>}`; also auto-injected into downstream agent context | model results, typed data |
| Data | `data: [key]` + `burnex data set key value` inside a step | `${jobs.<id>.data.<key>}`, `if`, `display` | flat strings, dashboard labels |
| Outputs file | `outputs: [key]` + `echo "key=value" >> "$BURNEX_JOB_OUTPUTS"` in a `run` step | `$NEEDS_<JOB>_<key>` in steps of *direct* dependents | values for shell commands |
| Files | — | the shared working tree | code, large artifacts |

- Declare `output: { from: <step> }` explicitly on every job whose output is
  read downstream. Only the last *agent* step is picked up by default; the
  result of a `run` (with `output_schema`), `script`, `uses`, `review`,
  `discuss` or `decision` step is not published unless named, and lint does
  not catch the omission — the reading job fails at run time.
- A reference to a missing key or to a job that failed is a failure with an
  explanation, never an empty string.
- `data` keys are fail-closed: an undeclared key is rejected on write and
  fails the job if written around the command.
- `NEEDS_BUILD_sha`: job id upper-cased with non-alphanumerics replaced by
  `_`; the key is kept as written. In a document write the literal as
  `$NEEDS_BUILD_sha` or `$${NEEDS_BUILD_sha}` (plain `${…}` is an engine
  substitution).
- Never pass secrets through outputs or data: both land in `status.json`.
- Run-level labels: `burnex data --run set description|result "<text>"`.

## Substitutions and expressions

`${space.name}` in strings:

| Space | Available | Resolved |
|---|---|---|
| `inputs.*` | pipeline document | at parse |
| `params.*`, `job.lane` | job file | at parse |
| `project.check\|tools\|edit_paths\|spec.dir\|spec.rules\|spec.tool\|spec.check` | everywhere | at parse; error if not declared |
| `jobs.<id>.status`, `jobs.<id>.output.*`, `jobs.<id>.data.*` | jobs downstream of `<id>` | before the job runs |
| `run.id`, `run.dir`, `run.workspace`, `run.scratch` | everywhere | before the job runs |
| `env.<NAME>` | declared `env` of the job (not secrets) | before the job runs |

- `${project.tools}` and `${project.edit_paths}` are lists: inside a list
  element they expand to one element per value
  (`"Bash(${project.tools} *)"` → `Bash(npm *)`, `Bash(npx *)`, …). They are an
  error in scalar fields.
- Numeric fields (`concurrency`, `max_iterations`, `attempts.max`,
  `rate_limit_pct`, `skip_exit_code`, `exit_code`) accept only `${inputs.*}` /
  `${params.*}`, and no `k`/`M`/`h` suffixes.
- Expressions (`if`, `while`): comparisons, `and`, `or`, `not`, field access
  over `inputs`, `params`, `run`, `env`, `jobs.<id>.status|output|data`.
  Anything more complex belongs in a `run` step.

## Workspace

```yaml
workspace:
  mode: cwd | worktree | copy
  scope: run | job            # pipeline only, default run
  trees: [main, b]            # pipeline only, with scope: run
```

| mode | Effect | Cost |
|---|---|---|
| `cwd` (default) | jobs edit the launch directory in place | no isolation; lint warns with `concurrency > 1` |
| `worktree` | detached git worktree from `HEAD` at run start | needs git; uncommitted changes are not included; result returns via `burnex apply` |
| `copy` | copy of the launch directory | slow, large; works outside git and with uncommitted changes |

- `scope: run`: one tree per run; jobs go through it one at a time and see each
  other's files, dependencies and caches. Declare extra `trees` and put a job
  on one with `workspace: { tree: b }` (or `tree: own`) to run in parallel.
- `scope: job`: every job gets its own tree, seeded from the tree of its
  dependency. With several dependencies — including `needs: all` — name the
  source: `workspace: { inherit: <job> | none }`, or give the job
  `workspace: { mode: cwd }` if it only reports; lint rejects the job
  otherwise.
- Only one job runs in a tree at a time. Trees never merge by themselves: a
  job depending on a job in another tree gets its outputs, not its files.
  Bring code together with `burnex apply`, `burnex merge-lanes` or a step.
- A job may override `mode` (for example a final `cwd` job in a `worktree`
  pipeline to touch the real checkout).
- `worktree` extras: `source: commit` pins `HEAD` once for all later
  worktrees; `preserve_local_changes: true` lets `merge-lanes` publish on top
  of local edits; `live_files: [{ path, writeback: always, commit_on_success }]`
  syncs named files with the checkout.

## Sessions

Agent steps of a job share one agent session by default (`session: shared`):
later steps see the earlier dialog, and the job context is sent once.
`session: per_step` gives every step a fresh session. Named sessions
(`session: writing` on steps) split a job into several dialogs.

Trade-offs to decide deliberately:

- With `shared`, `resume` reruns the whole job (a step's result depends on the
  dialog). `per_step` allows step-level resume.
- A new `until` iteration, job attempt or loop pass always starts sessions
  over.
- `session_group: <name>` on several attach sites makes those jobs continue
  one dialog. Requirements: ordered by `needs`, same tree, no `until`, no job
  `attempts.max > 1`, not a loop member. It often costs more than it saves
  (the inherited dialog is resent as a prefix on every turn); use it only when
  an upstream job gathered expensive knowledge that several jobs reuse.
- The same session alias on two different agents is two separate sessions.

## Context

```yaml
context:
  - AGENTS.md                          # path
  - "src/**/*.kt"                      # glob, expanded sorted
  - text: Generated files in build/ are off limits.
  - { path: reports/plan.json, mode: inline }      # inline | reference | auto
  - { path: "changes/${params.change}/**/*.md", required: true }
  - item_refs: ${run.dir}/item-a.json  # goal/details files of a backlog item
  - knowledge: index                   # or { scope: "src/**" } / { id: x, budget: 4k }
```

- Levels merge pipeline → job → step, after an automatic block with upstream
  job outputs (control with `context_upstream`).
- `mode: auto` inlines files below `context.inline_threshold`, passes larger
  ones as a path for the agent to read.
- A glob that matches nothing is silently empty — add `required: true` when
  the step must not run without it.
- The assembled context is capped by `context.max_tokens` (override with
  `context_max_tokens` at any level) and checked before the backend starts.
- `context_inherit: false` drops inherited context; `context_exclude: [glob]`
  drops part of it.
- Claude Code still loads its own `CLAUDE.md`, hooks and MCP unless the step
  uses `enforce: strict`; do not duplicate that content in `context`.
- Inspect without running: `burnex context <pipeline> --job <j> --step <s>`.

## Budget

```yaml
budget:
  tokens: 2M            # in + out + cache_write + weighted cache_read, over all API calls
  cost: 20              # USD; "$20.50" also accepted
  wallclock: 2h         # from the start of its own scope
  rate_limit_pct: 80    # share of the subscription rate-limit window
  on_exceed: stop       # stop | wait
```

- Three levels: pipeline, job, step. Whichever cap is hit first applies.
- `tokens` is traffic, not context size: an agent session resends its prefix
  on every turn, so traffic is typically an order of magnitude above the
  largest single request.
- `cost` is checked only at attempt boundaries, so allow headroom of one
  attempt. It does nothing when the backend reports no price and the model is
  not in the price catalogue — the run prints a warning; protect such steps
  with `tokens`.
- `on_exceed: wait` sleeps until the subscription window resets (bounded by
  `defaults.max_wait`, 6 h by default). The time asleep is not counted toward
  any `wallclock`. It never rescues `tokens`, `wallclock` or `cost` caps.
- After a budget stop only jobs with `budget_exempt: true` still run.
- Worst case of a job ≈ Σ(step budget × `attempts.max`) × `max_iterations` ×
  job `attempts.max`, capped by the job budget.

## Environment and secrets

Merge order: process env → `env_files` → pipeline `env` → wiring `env` → job
`env` → step `env` → `BURNEX_*` (not overridable) → `env_deny` removes →
secrets.

Injected into every step: `BURNEX_RUN_ID`, `BURNEX_RUN_DIR`, `BURNEX_BIN`
(the engine of this run — call it instead of `burnex` from steps),
`BURNEX_JOB`, `BURNEX_JOB_DIR`, `BURNEX_STEP`, `BURNEX_STEP_DIR`,
`BURNEX_ATTEMPT`, `BURNEX_JOB_ATTEMPT`, `BURNEX_JOB_ATTEMPT_MAX`,
`BURNEX_WORKSPACE`, `BURNEX_ARTIFACTS`, `BURNEX_SCRATCH` (scratch directory
outside the tree, invisible to `changed_only`).
Conditional: `BURNEX_JOB_OUTPUTS` (`run` steps), `BURNEX_INPUT` /
`BURNEX_OUTPUT` (`script`, `uses`), `BURNEX_SKIP_EXIT_CODE`,
`BURNEX_LOOP` / `BURNEX_LOOP_ITERATION` / `BURNEX_LOOP_ITERATION_MAX` (loop
members), `BURNEX_PREV_FAILURE` (retry after a failure), `NEEDS_<JOB>_<key>`.
Print `env | grep BURNEX_` in a `run` step when unsure what a step receives.

`env_deny` globs (built-in defaults include `*_TOKEN`, `*_SECRET`, `*_KEY`)
strip variables from every step. Declaring a variable in `env` that
`env_deny` removes is a lint error.

```yaml
secrets:
  gh-token: { provider: env-file, file: .env.local, key: GITHUB_TOKEN, env: GITHUB_TOKEN }
  npm-token: { provider: keychain, service: registry.npmjs.org, account: alice }  # macOS
jobs:
  release:
    steps:
      - id: publish
        run: [gh, release, create, "${inputs.tag}"]
        secrets: [gh-token]
```

Secrets are declared only in the pipeline document and delivered only to
`run` / `script` / `uses` steps that name them. Agent steps, judges and
`expect` checks never get them. Values must be at least 8 characters and
single-line; they are masked as `***` in logs (not in files the step writes,
nor in derived forms such as base64).

## Agent, model, tier, effort

`agent`, `model`, `model_tier`, `effort` may be set on the pipeline root, a
job (body or wiring) and an agent step; each is inherited independently
step → job → pipeline → configuration.

- Model: explicit `model` → `backends.<agent>.model_tiers.<tier>` →
  `backends.<agent>.default_model`. An explicit `model` at any level beats a
  tier at any level.
- Built-in tiers: `max`, `deep`, `balance`, `fast`, `mini`. Prefer tiers over
  model names when a pipeline must run on several backends or machines.
- Users can override per pipeline and per step in configuration
  (`pipeline_agents`, `step_agents`, `agent_policy`) and per run with
  `burnex run --agent`. See [config.md](config.md).
- Verify the outcome: `burnex config --pipeline <file>` prints agent, model
  and effort of every step with the layer each came from.
