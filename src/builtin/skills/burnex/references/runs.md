# Runs: layout, diagnosis, resume

## Contents

- [Where a run lives](#where-a-run-lives)
- [Statuses and stop causes](#statuses-and-stop-causes)
- [Diagnosis procedure](#diagnosis-procedure)
- [Symptom table](#symptom-table)
- [Resume semantics](#resume-semantics)
- [Waiting runs](#waiting-runs)

## Where a run lives

Journals never live in the project. `burnex run` prints the directory; the
same path is `$BURNEX_RUN_DIR` inside steps and `${run.dir}` in documents.

```
~/.burnex/runs/<project key>/
  latest -> <run>
  2026-08-16T14-03-22Z-3f9a1c/        # run id; short form: 3f9a1c
    run.json             # manifest: pipeline, inputs, source commits, plugins, outcome, resumed_from
    pipeline.lock.yml    # the pipeline after expanding uses / defaults / inputs / params
    status.json          # state: jobs, failed step, cause, budget, awaiting, resume.command
    events.ndjson        # every event, one JSON per line
    usage.json           # spend
    decisions/<wait_id>.json
    artifacts/<job>.json # structured output of a job
    workspace/trees/<tree>/ , workspace/jobs/<job>/   # isolated trees (worktree | copy)
    jobs/<job>/
      resolved.json      # job definition with late substitutions resolved
      data.json          # burnex data
      outputs.env        # $BURNEX_JOB_OUTPUTS
      scratch/           # $BURNEX_SCRATCH
      steps/[pass-<n>/][attempt-<k>/][iter-<m>/]NN-<step>/
        step.json        # key, status, attempts, usage, tree ids
        prompt.txt       # what the engine sent (prompt.2.txt … for later attempts)
        context.json     # what entered the context, from where, how many tokens
        stdout.log, stderr.log
        output.json, input.json, expect.json, diff.patch
        judge-<n>/ , script-<n>/ , participants/<id>/ , action-<n>.json
```

`iter-<m>` exists for jobs with `until`, `attempt-<k>` for jobs with job-level
`attempts`, `pass-<n>` for loop members. A step is addressed as
`<job>/<step>` by id; the `NN-` prefix is only ordering.

## Statuses and stop causes

Run, job and step statuses: `pending`, `running`, `success`, `failed`,
`skipped`, `canceled`, `budget_exceeded`.

A skipped job carries `skip`: `condition` (graph or `if`), `declared` (a step
exited with `skip_exit_code`), `halted` (the run stopped before reaching it).

Stop causes: `expect_failed`, `timeout`, `spawn_failed`, `until_not_met`,
`loop_exhausted`, `budget_exceeded`, `canceled`, `backend_rate_limited`,
`backend_unauthenticated`.

A `running` run may actually be: sleeping until a rate-limit reset (`wake_at`
in `status.json`), waiting for a human (`awaiting` is non-empty), or abandoned
(its process is dead).

## Diagnosis procedure

1. `burnex status` — which job failed, in which step and attempt, the stated
   reason, and the suggested resume command.
2. `burnex logs <run> <job>/<step>` — the step's own output. For an agent step
   this is the backend stream; the answer to "what did it do" is there.
3. Open the step directory for the evidence the reason points at:
   `expect.json` (which predicate failed and why), `prompt.txt` and
   `context.json` (what the agent was actually told), `diff.patch` (what it
   changed), `output.json` (what it returned).
4. `burnex logs <run>` when the cause is not in the step: service events such
   as `env.denied`, `context.downgraded`, `backend.degraded`, `budget.*` are
   written only to `events.ndjson`, not to the progress feed.
5. Fix the cause in the pipeline, prompt, configuration or code, then
   `burnex resume <run> --dry-run` to see what will be reused, and resume.

Do not answer a failed predicate by weakening the predicate. A step that fails
the same way on every attempt points at the prompt, the context or the
permissions — `burnex usage <run>` shows the spend per attempt.

## Symptom table

| Symptom | Look at |
|---|---|
| `expect` failed | `expect.json`, `stdout.log`, `stderr.log`; `judge-<n>/verdict.json` for a judge; `script-<n>/stderr.log` for a script predicate |
| Agent did the wrong thing | `prompt.txt`, `context.json`, `diff.patch`, `jobs/<job>/resolved.json`; compare with a good run using `burnex diff` |
| Agent refused to write or run a command | `permissions` of the step, job and backend; the refusal is in `stdout.log` |
| Agent changed files outside the allowed area | `changed_only` failure in `expect.json` lists the paths |
| Variable missing in a step | events `env.denied` (matched `env_deny`), `env.withheld` (belongs to a secret the step did not name) |
| File missing from context, or context too large | events `context.denied`, `context.downgraded`; `burnex context <pipeline> --job --step` |
| Step timed out or went silent | cause `timeout`, event `step.stalled`; raise the step `timeout` only if the work was genuinely progressing |
| Exit 3, `budget_exceeded` | `status.json` → `budget.exceeded` (scope, dimension, used, limit, job, step); `burnex usage <run>` |
| Money cap never triggers | events `budget.cost_unpriced` / `budget.cost_unreported`: the backend reports no price for that model — cap `tokens` instead |
| Rate limit or authentication (exit 3 / 4) | event `backend.refused`; `wake_at` in `status.json` when the run sleeps |
| `until` or loop did not converge | causes `until_not_met` / `loop_exhausted`; compare `steps/iter-N/…` or `steps/pass-N/…`: is each iteration making different progress? |
| Reference to a job output failed | the producing job failed, was skipped, or the key is not in its schema / `data:` declaration |
| Job failed while publishing data | a key in `jobs/<job>/data.json` that the job's `data:` does not declare |
| Run hangs in `running` | `awaiting` → `burnex decide`; `wake_at` → sleeping for the rate-limit window; otherwise the process died → `burnex resume` |
| `resume` re-executes more than expected | `burnex resume <run> --dry-run`, `burnex status --explain` |
| `apply` / `merge-lanes` refused | conflict list in the output, `<run dir>/merge-<lane>.json`, `<run dir>/integration/` |
| Exit 2 before anything ran | the message names the file and field; `burnex lint`, `burnex config`, `burnex plugins` |

## Resume semantics

`burnex resume <run>` starts a *new* run (`resumed_from` in `run.json`) that
reuses steps instead of repeating them.

A step is reused when it succeeded and its **step key** is unchanged. The key
covers the step and job definition, the prompt text and context, the backend,
model and backend version, the outputs of upstream jobs, and a fingerprint of
the step's inputs in the tree. It does not cover `CLAUDE.md`, secret values,
or late substitutions (`run.*`, `jobs.*`, `env.*`) themselves.

What determines how much is repeated:

- **Session mode.** With `session: shared` (the default) the unit of retry is
  the whole job, because a step's result depends on the dialog. With
  `per_step` a single step can be reused or rerun.
- **Job-level `attempts.max > 1`** and **loops** are also units: the job or
  the whole loop reruns. `--from` must name the job / the loop's entry job.
- **Input fingerprint.** By default the whole tree; narrowed by what agent
  steps were observed to read and by the job's declared `inputs:`. A pipeline
  of command steps only gets reuse by declaring `inputs:` on its jobs.
- **Upstream changes.** A recomputed upstream output invalidates everything
  below it.

Flags: `--from job[/step]` reruns from that point and reuses everything above
it without checking tree changes; `--set k=v` changes an input and invalidates
what depends on it; `--dry-run` prints the plan with a reason per step.

On resume the tree is restored only for the paths produced by reused steps;
ignored leftovers (`node_modules`, build output) stay. Job data, `run` step
outputs, structured outputs and unanswered decisions are carried over. The
first re-executed step receives the previous failure as context.

In `cwd` mode, an edit made to the tree while a step runs is indistinguishable
from the step's own result — do not edit the project during a run.

## Waiting runs

A `decision` step keeps the run `running` with an `awaiting` entry in
`status.json` (job, step, prompt, outcomes, deadline). It holds the job's tree
and its dependents. Step timeouts do not apply and the wait is excluded from
`wallclock`.

- Answer with `burnex decide <run> <outcome>` or in the dashboard
  (`/decisions`). The choice belongs to the human: report the prompt and the
  outcomes to the user and wait for their answer.
- With `deadline` + `on_expire`, a live process applies the default outcome
  when the deadline passes; a dead process applies nothing.
- If the process died while waiting, `decide` still records the answer and
  prints the resume command; `resume` applies it without asking again.

`on_exceed: wait` similarly leaves the run `running` with `wake_at`; it
continues by itself when the window resets.
