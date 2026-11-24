# Reliability patterns

Complete pipelines for recurring situations. Each one passes `burnex lint`
when the files it references exist (`./schemas/*.json`, the `panel` review
strategy from [collaboration.md](collaboration.md), an `npm test` script).
Adapt commands, paths and limits to the project; keep the structure, because
the structure is what makes the run trustworthy.

## Contents

1. [Fix until a command is green](#1-fix-until-a-command-is-green)
2. [Plan, implement, independent review, verify](#2-plan-implement-independent-review-verify)
3. [Check and fix as separate jobs (loop)](#3-check-and-fix-as-separate-jobs-loop)
4. [Human gate before an external action](#4-human-gate-before-an-external-action)
5. [Parallel lanes in isolated trees](#5-parallel-lanes-in-isolated-trees)
6. [Unattended run: skip, wait, triage](#6-unattended-run-skip-wait-triage)
7. [Deterministic sandwich around an agent](#7-deterministic-sandwich-around-an-agent)
8. [Reusable job with parameters](#8-reusable-job-with-parameters)

## 1. Fix until a command is green

The loop condition is a command the engine runs, not the agent's claim that it
finished. The failing output is fed into the next iteration automatically.

```yaml
version: 1
kind: pipeline
name: fix-until-green
budget: { tokens: 1M, wallclock: 40m }
jobs:
  fix:
    budget: { tokens: 800k, wallclock: 30m }
    until:
      max_iterations: 3
      check:
        - cmd: npm test
    steps:
      - id: repair
        agent: claude
        prompt: |
          Make the failing tests pass by fixing the code under src/.
          Do not edit, skip or delete tests.
        permissions: { mode: acceptEdits }
        timeout: 15m
        expect:
          - changed_only: ["src/**"]
        attempts:
          max: 2
          escalation:
            - include_failure: true
```

Why each part is there: `changed_only` turns "do not touch the tests" from a
request into a check; `attempts` with `include_failure` lets the agent see why
its attempt was rejected; the job `budget` caps the worst case of
iterations × attempts; `timeout` stops a hung CLI, which spends nothing and so
never trips a budget. `burnex lint` warns that `changed_only` is the step's
only predicate — acceptable here because `until.check` proves the work.

## 2. Plan, implement, independent review, verify

Separate jobs give separate agent sessions: the reviewer does not sit in the
dialog that wrote the code. The last word belongs to a command.

```yaml
version: 1
kind: pipeline
name: implement-review-verify
inputs:
  task: { type: string, required: true }
budget: { tokens: 3M, wallclock: 2h }
jobs:
  plan:
    output: { from: draft }
    steps:
      - id: draft
        agent: claude
        model_tier: deep
        prompt: |
          Plan the change: ${inputs.task}
          List the files you expect to touch. Do not edit anything.
        permissions: { mode: plan }
        output_schema: ./schemas/plan.json
        timeout: 15m
        expect:
          - schema: ./schemas/plan.json
          - changed_only: []
  implement:
    needs: [plan]
    until: { max_iterations: 3, check: [{ cmd: npm test }] }
    budget: { tokens: 1500k, wallclock: 1h }
    steps:
      - id: code
        agent: claude
        prompt: "Implement the plan for: ${inputs.task}. Add or update tests."
        permissions: { mode: acceptEdits }
        timeout: 30m
        expect:
          - changed_only: ["src/**", "test/**"]
          - cmd: test -n "$(git status --porcelain)"
  review:
    needs: [implement]
    context_upstream: [plan]
    output: { from: check }
    steps:
      - id: check
        review: panel
        prompt: |
          Review the uncommitted diff (git diff HEAD) against the task: ${inputs.task}
        output_schema: ./schemas/review.json
        permissions: { enforce: strict, allow: [Read, Grep, Glob, "Bash(git diff*)", "Bash(git status*)"] }
        timeout: 25m
        expect:
          - schema: ./schemas/review.json
          - changed_only: []
  fix-review:
    needs: [review]
    if: "jobs.review.output.verdict == 'changes_requested'"
    until: { max_iterations: 2, check: [{ cmd: npm test }] }
    budget: { tokens: 800k, wallclock: 40m }
    steps:
      - id: apply
        agent: claude
        prompt: Fix every critical and major finding of the review. Explain any finding you reject.
        permissions: { mode: acceptEdits }
        timeout: 30m
        expect:
          - changed_only: ["src/**", "test/**"]
          - cmd: test -n "$(git status --porcelain)"
  verify:
    needs: [fix-review]
    on: always
    if: "jobs.implement.status == 'success'"
    steps:
      - id: check
        run: [npm, run, check]
        timeout: 15m
        expect: [{ exit_code: 0 }]
```

Notes:

- The plan and the review return JSON validated by a schema, so downstream
  conditions (`jobs.review.output.verdict`) read a field instead of parsing
  prose. `output: { from: <step> }` names the step whose result becomes the
  job's output; declare it on every job whose output is read downstream. Upstream outputs are also placed into downstream agent context
  automatically; `context_upstream` narrows that.
- `fix-review` runs only when the review asked for changes. `verify` uses
  `on: always` so that a skipped `fix-review` does not skip it, and an `if` so
  that it does not run after a failed implementation.
- Read-only steps prove it with `changed_only: []` and, for the review, a
  strict allow-list without `Edit` or `Write`.
- For a single reviewer replace the `review:` step with an agent step in the
  same separate job; keep the schema and the read-only permissions.

## 3. Check and fix as separate jobs (loop)

Use `loops` when checking and fixing need different jobs — different trees,
budgets, agents or several steps each. For one agent job plus a command,
pattern 1 is simpler.

```yaml
version: 1
kind: pipeline
name: check-fix-loop
budget: { tokens: 1500k, wallclock: 1h }
loops:
  green:
    jobs: [check, fix]
    while: "jobs.check.status != 'success'"
    max_iterations: 3
    cost: 10
    wallclock: 45m
jobs:
  check:
    steps:
      - id: test
        run: [npm, test]
        timeout: 10m
        expect: [{ exit_code: 0 }]
  fix:
    needs: [check]
    on: failure
    budget: { tokens: 400k }
    steps:
      - id: repair
        agent: claude
        prompt: |
          The test job failed. Run `npm test` to see the failure, fix the
          cause in src/, and leave the tests untouched.
        permissions: { mode: acceptEdits }
        timeout: 20m
        expect:
          - changed_only: ["src/**"]
          - cmd: test -n "$(git status --porcelain)"
  publish:
    needs: [check]
    steps:
      - id: tag
        run: [git, tag, -f, green]
        timeout: 1m
```

A pass runs `check`, then `fix` only if it failed; the next pass re-checks.
`publish` is outside the loop: it waits for the verdict, runs once, and is
skipped if the loop was exhausted. Nothing is carried between passes except
the tree and job data, so the fixing agent re-reads the failure itself.
Side effects inside members repeat on every pass.

## 4. Human gate before an external action

```yaml
version: 1
kind: pipeline
name: gated-release
inputs:
  tag: { type: string, required: true }
budget: { wallclock: 1h }
secrets:
  gh-token: { provider: env-file, file: .env.local, key: GITHUB_TOKEN, env: GITHUB_TOKEN }
jobs:
  build:
    outputs: [sha]
    steps:
      - id: check
        run: [npm, run, check]
        external: false
        timeout: 15m
      - id: record
        run: [sh, -c, 'echo "sha=$(git rev-parse HEAD)" >> "$BURNEX_JOB_OUTPUTS"']
        external: false
        timeout: 1m
  approve:
    needs: [build]
    steps:
      - id: gate
        decision:
          prompt: "Publish ${inputs.tag}?"
          outcomes:
            approve: continue
            deny: { effect: reject, label: Reject }
          deadline: 4h
          on_expire: deny
  release:
    needs: [approve, build]
    steps:
      - id: publish
        run: [sh, -c, 'gh release create "$1" --target "$NEEDS_BUILD_sha"', release, "${inputs.tag}"]
        external: true
        secrets: [gh-token]
        timeout: 5m
```

- The irreversible step lives in a job that `needs` the gate; the deadline
  expires into the *rejecting* outcome, so an unattended run fails safe.
  Time spent waiting for the decision does not count toward `wallclock`.
- `release` lists `build` although it is transitive (lint warns): `NEEDS_*`
  variables come only from direct dependencies.
- The input reaches the shell as a positional argument (`"$1"`), not
  interpolated into the command string.
- The secret reaches only the `publish` process; no agent sees it.
- `external:` on every step makes `burnex run --shadow` usable as a rehearsal:
  it runs `build` for real and records what `publish` would have done.

## 5. Parallel lanes in isolated trees

```yaml
version: 1
kind: pipeline
name: parallel-lanes
workspace: { mode: worktree, scope: job }
concurrency: 2
fail_fast: false
budget: { tokens: 3M, wallclock: 2h }
jobs:
  api:
    lane: api
    budget: { tokens: 1M }
    until: { max_iterations: 3, check: [{ cmd: npm test }] }
    steps:
      - id: code
        agent: claude
        prompt: Add input validation to the handlers in src/api/.
        permissions: { mode: acceptEdits }
        timeout: 30m
        expect:
          - changed_only: ["src/api/**", "test/api/**"]
          - cmd: test -n "$(git status --porcelain)"
  docs:
    lane: docs
    budget: { tokens: 500k }
    steps:
      - id: write
        agent: claude
        prompt: Update docs/api.md to describe the current handlers in src/api/.
        permissions: { mode: acceptEdits }
        timeout: 20m
        expect:
          - changed_only: ["docs/**"]
          - cmd: test -n "$(git status --porcelain docs/)"
```

- Parallel agents in `cwd` overwrite each other; `worktree` + `scope: job`
  gives each job its own tree from the commit at run start. Uncommitted
  changes are not included — commit first, or use `copy`.
- The checkout stays untouched. Bring results back afterwards with
  `burnex apply <run> --lane api`, then `--lane docs`, or let a final `cwd`
  job run `"$BURNEX_BIN" merge-lanes "$BURNEX_RUN_ID" --lanes all --check "npm test"`.
- `fail_fast: false` lets one lane finish when the other fails.
- Raise `backends.<agent>.concurrency` in configuration to match
  `concurrency`, or the lanes queue for the backend.
- Two lanes may not reference each other's jobs; lint rejects it.

## 6. Unattended run: skip, wait, triage

```yaml
version: 1
kind: pipeline
name: nightly-deps
budget: { tokens: 600k, wallclock: 45m, rate_limit_pct: 80, on_exceed: wait }
skip_exit_code: 78
jobs:
  detect:
    outputs: [count]
    steps:
      - id: outdated
        run:
          - sh
          - -c
          - |
            n=$(npm outdated --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s||"{}")).length))')
            [ "$n" -gt 0 ] || exit "$BURNEX_SKIP_EXIT_CODE"
            echo "count=$n" >> "$BURNEX_JOB_OUTPUTS"
        timeout: 5m
  update:
    needs: [detect]
    budget: { tokens: 500k }
    until: { max_iterations: 2, check: [{ cmd: npm test }] }
    steps:
      - id: bump
        agent: claude
        prompt: Update outdated dependencies one major version at most and fix resulting breakage.
        permissions: { mode: acceptEdits }
        timeout: 30m
        expect:
          - changed_only: ["package.json", "package-lock.json", "src/**"]
          - cmd: test -n "$(git status --porcelain)"
  triage:
    needs: all
    on: failure
    budget_exempt: true
    budget: { tokens: 100k, wallclock: 10m }
    steps:
      - id: explain
        agent: claude
        model_tier: fast
        prompt: Explain in five lines why the dependency update failed and what a human should do.
        permissions: { mode: plan }
        timeout: 5m
        expect:
          - changed_only: []
          - matches: /\S/
```

- "Nothing to do" is a skip, not a failure and not a wasted agent call: the
  detecting step exits with the declared code, `update` is skipped with it,
  and the run ends `success`.
- `on_exceed: wait` sleeps through a subscription rate-limit window instead of
  failing at 3 a.m.; it does not rescue `tokens` or `wallclock`.
- `triage` runs after any failure, even one caused by the run budget
  (`budget_exempt`), under its own small budget.
- Nobody is watching, so nothing here asks a human. If a gate is needed, give
  the `decision` a `deadline` and a safe `on_expire`.

## 7. Deterministic sandwich around an agent

Collect inputs with code, let the model do only the judgement, then check the
contract with code.

```yaml
version: 1
kind: pipeline
name: changelog
budget: { tokens: 300k, wallclock: 20m }
jobs:
  write:
    session: per_step
    steps:
      - id: collect
        run: [sh, -c, 'git log --oneline -50 > "$BURNEX_SCRATCH/commits.txt"']
        timeout: 1m
      - id: draft
        agent: claude
        prompt: |
          Read ${run.scratch}/commits.txt and add a section for the next
          release to CHANGELOG.md, grouped as Added / Changed / Fixed.
        permissions: { mode: acceptEdits }
        timeout: 10m
        expect:
          - changed_only: ["CHANGELOG.md"]
          - cmd: grep -q "^## " CHANGELOG.md
        attempts: { max: 2, escalation: [{ include_failure: true }] }
      - id: lint-md
        run: [npx, --yes, markdownlint-cli, CHANGELOG.md]
        timeout: 3m
```

`$BURNEX_SCRATCH` is outside the working tree, so intermediate files do not
violate `changed_only` or end up in the diff. `session: per_step` makes each
step individually resumable.

## 8. Reusable job with parameters

`.burnex/jobs/green.yml` — no `needs`, `on`, `if`, `with` or `lane` in here;
wiring belongs to the pipeline:

```yaml
version: 1
kind: job
name: green
description: Edit until the project check passes
params:
  goal: { type: string, required: true }
  max_iterations: { type: int, default: 3 }
until:
  max_iterations: ${params.max_iterations}
  check:
    - cmd: ${project.check}
steps:
  - id: edit
    agent: claude
    prompt: file:../prompts/green.md        # relative to this job file
    permissions:
      enforce: strict
      allow: [Read, Grep, Glob, Edit, Write, "Bash(${project.tools} *)", "Bash(git status*)", "Bash(git diff*)"]
    timeout: 30m
    expect:
      - changed_only: ["${project.edit_paths}"]
```

`.burnex/pipelines/feature.yml`:

```yaml
version: 1
kind: pipeline
name: feature
inputs:
  goal: { type: string, required: true }
budget: { tokens: 2M, wallclock: 90m }
jobs:
  build:
    uses: ../jobs/green.yml               # relative to this pipeline file
    with: { goal: "${inputs.goal}" }
    budget: { tokens: 1500k }
```

`${project.check}`, `${project.tools}` and `${project.edit_paths}` come from
`.burnex/config.yml` ([config.md](config.md)), so the job carries no
stack-specific command and moves between repositories unchanged. The prompt
file reads the goal as `${params.goal}`.
