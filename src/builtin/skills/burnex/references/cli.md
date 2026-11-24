# burnex CLI reference

Run commands from the project root: the run store is keyed by the launch
directory, so `status`, `logs` and `resume` find a run only from the project
that started it. `burnex` with no arguments prints the authoritative list of
commands and flags for the installed version — check it when a flag here is
rejected.

`<pipeline>` is a file path, `burnex:<name>` (shipped with the engine) or
`<package>:<name>` (user package). `<run>` is the full run directory name, its
short tail (`3f9a1c`) or `latest`.

## Contents

- [Author and check](#author-and-check)
- [Run](#run)
- [Observe](#observe)
- [Continue and decide](#continue-and-decide)
- [Bring results back](#bring-results-back)
- [Inside a step](#inside-a-step)
- [Project setup and housekeeping](#project-setup-and-housekeeping)
- [Exit codes](#exit-codes)

## Author and check

| Command | Purpose |
|---|---|
| `burnex init [--force]` | create a starter `burnex.yml` and `.burnex/jobs/example.yml` |
| `burnex lint <pipeline> [--input k=v]` | static check, nothing runs; errors exit 2, warnings exit 0 |
| `burnex run <pipeline> --dry-run [--input k=v]` | expand and validate the whole run, start nothing |
| `burnex config` | effective configuration with the source of every value |
| `burnex config --pipeline <pipeline>` | agent, model and effort of every step, with the layer each came from |
| `burnex context <pipeline> --job <j> --step <s> [--input k=v]` | what goes into a step's context and how large it is |
| `burnex schema [--out <dir>]` | write project-specific JSON Schemas to `.burnex/schema/` (knows plugin predicates and step kinds) |
| `burnex plugins [--json]` | loaded plugins: backends, predicates, step kinds, commands |

Pass required inputs to `lint`, `--dry-run` and `context` exactly as to `run`:
many checks depend on resolved values. `lint` has no `--budget` or `--resolve`
flag even though older docs mention them.

## Run

```sh
burnex run <pipeline> [--input k=v]... [--env NAME=value]... [--agent <profile|backend>]
                      [--dry-run] [--shadow] [--quiet]
```

- `--input` sets declared pipeline `inputs`.
- `--env` overrides a variable declared in the pipeline's `env:` for this run.
- `--agent` is a layer above `defaults.agent`; agents named by a step or job in
  the document still win.
- `--shadow` executes local steps and only records steps marked
  `external: true`; every `agent`/`run`/`script`/`uses` step must declare
  `external`.
- `--quiet` suppresses the progress feed.

The first lines print the run id and the journal directory. Record both. A run
is a foreground process: agent pipelines commonly take tens of minutes, so
start long runs in the background and follow them with `status` / `logs`.
Ctrl-C cancels cleanly (exit 130) and leaves a resume command in the status.

## Observe

| Command | Purpose |
|---|---|
| `burnex status [--run <run>]` | state of the last (or named) run: every job, the failing step and reason, spend, resume command |
| `burnex status --explain` | per step: will it be reused on resume, and why not |
| `burnex logs <run>` | the event stream (`events.ndjson`), including service events hidden from the feed |
| `burnex logs <run> <job>/<step> [--follow]` | stdout / stderr of a step |
| `burnex usage <run>` | spend per job, step and attempt: backend, model, tokens, cache, time, peak prefix, price |
| `burnex diff <run-a> <run-b>` | which steps changed between two runs: prompt, context, expectations, trees |
| `burnex up [--foreground]` / `burnex down` | dashboard for all runs at `127.0.0.1:7717` (live graph, decisions, usage) |

## Continue and decide

```sh
burnex resume <run> [--from job[/step]] [--set k=v] [--dry-run]
burnex decide <run> <outcome> [--step job[/step]] [--reason "..."] [--from job[/step]]
```

- `resume` creates a new run that reuses every successful step whose key still
  matches and re-executes the rest. `--dry-run` prints the plan first — use it
  before every resume.
- `--from` forces re-execution from a job or step; `--set` changes an input
  and invalidates everything downstream.
- `resume` inherits `--agent`, `--env` and shadow mode from the original run.
- `decide` answers a waiting `decision` step. `--reason` is required for a
  `reject` outcome, `--from` for a `restart` outcome, `--step` when several
  decisions are waiting.

## Bring results back

Only for `workspace.mode: worktree | copy`; in `cwd` the result is already in
place.

```sh
burnex apply <run> [--job <job> | --lane <lane>] [--force]
burnex merge-lanes [<run>] --lanes a,b|all --check "<cmd>" [--file backlog.md] [--onto <branch> [--keep-claim]]
burnex assert-clean [--allow path,path]
```

- `apply` does not look at outcomes: it will apply a failed job or lane too.
  Check `burnex status` first and take only what succeeded.
- `apply` puts the run's final diff onto the current tree with a three-way
  apply; on conflict nothing is touched and the conflicting paths are listed.
  `--job` on a job that continued a shared tree usually conflicts — apply the
  whole run instead.
- `merge-lanes` applies each lane in turn, runs the check, and commits green
  lanes; it needs a clean tree. Per-lane outcomes go to
  `<run dir>/merge-<lane>.json`.
- `assert-clean` verifies the launch directory (and declared nested repos) has
  no uncommitted changes; exit 0 or 2.

## Inside a step

Call these through `"$BURNEX_BIN"` so the step uses the engine of its own run
even when `burnex` is not on `PATH`.

| Command | Purpose |
|---|---|
| `burnex data set <key> <value>` | publish a job data key (must be declared in the job's `data:`) |
| `burnex data merge --json '{"k":"v"}'` | publish several keys |
| `burnex data get [<key>]` | read published data of the current job |
| `burnex data --run set description\|result "<text>"` | run-level labels for the runs table |
| `burnex render design <file> --format html\|openspec [--out <path>]` | render a `burnex:design-doc` JSON |
| `burnex backlog list\|pick\|finish\|settle\|add\|show` | improvement queue in `backlog.md` |
| `burnex knowledge index\|select\|check\|write` | repository memory |

These commands refuse to run outside a step (they read `BURNEX_JOB_DIR` /
`BURNEX_RUN_DIR`), except `backlog`, `knowledge` and `render`.

## Project setup and housekeeping

| Command | Purpose |
|---|---|
| `burnex skill install --agent codex\|cursor\|claude` | install this skill into the project |
| `burnex package list [--json]` / `burnex package new <name> [--home]` | user packages (pipelines, steps, widgets bundled in a directory) |
| `burnex init --knowledge fs` | set up the repository memory practice |
| `burnex project repos` | add declared nested repositories to a lanes document |
| `burnex gc [--older-than 30d]` | without flags only reports; with `--older-than` removes run files (keeps `run.json`, `status.json`, `usage.json`) |
| `burnex gc --stats [--older-than] [--failed] [--project <key>]` | prune the spend store instead |
| `burnex update [--ref <ref>] [--no-restart]` | update the engine the way it was installed |
| `burnex propose <target> --from <file> [--reason]` | propose an edit to a project cabinet file |
| `burnex widgets [--json]` | dashboard widgets of the project |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success (a run of successes and skips is a success) |
| 1 | a job failed |
| 2 | configuration or lint error; unknown flag |
| 3 | stopped by budget, including a failed wait for the rate-limit window |
| 4 | backend authentication failure |
| 130 | canceled |

Check the exit code of `burnex run` itself, not of a pipe after it
(`burnex run … | tail` reports `tail`'s status).
