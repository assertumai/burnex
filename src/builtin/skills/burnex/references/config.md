# Configuration: agents, models, limits, project facts

A pipeline says *what* happens; configuration says *with which agents, models
and limits on this machine and in this repository*. Keep machine- and
repository-specific choices out of pipeline documents so they stay portable.

Always inspect the effective values instead of assuming:

```sh
burnex config                        # every key with its source layer
burnex config --pipeline burnex.yml  # agent / model / effort of every step, and why
burnex plugins                       # which backends and predicates are loaded
```

## Layers

| File | Scope |
|---|---|
| `~/.burnex/config.yml` | the machine: backends, credentials, run store, personal agent choices |
| `.burnex/config.yml` | the project (committed): defaults, tightened limits, `project.*` facts |

Priority, weakest first: built-in → plugin defaults → home → project →
pipeline document → CLI flags. Exceptions: `env_deny`, `context.deny` and
`plugins` accumulate across layers; `limits` can only be tightened by a lower
layer, never raised.

Only the project file may declare `project.*`. Only the home file may declare
`runs.root`, `backends.*.command` and `backends.<id>.credentials`.

Units: `k` / `M` for tokens, `s` / `m` / `h` / `d` for time — case matters
(`m` minutes, `M` millions).

## Shape and built-in values

```yaml
version: 1
kind: config
agent_policy: force            # force | fallback — see below
defaults:
  agent: claude                # backend id or profile name
  session: shared
  concurrency: 1
  fail_fast: true
  step_timeout: 30m            # applies to steps without their own timeout
  stall_timeout: 5m            # silence detector (event only)
  max_wait: 6h                 # total sleep for on_exceed: wait
limits: { tokens: 20M, cost: $100, wallclock: 4h, concurrency: 8, attempts: 5, iterations: 10 }
env_deny: ["*_TOKEN", "*_SECRET", "*_PASSWORD", "*_KEY", "*_CREDENTIALS", "AWS_*", "KUBECONFIG"]
context:
  inline_threshold: 4k         # larger entries are passed as a path
  max_tokens: 120k             # cap for one step's assembled context
  note_max_tokens: 4k          # excerpt of a failed until check
  deny: ["**/.env*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/.git/**"]
plugins: [burnex/backends/codex]   # also burnex/backends/cursor, burnex/backends/copilot
```

`limits` is enforced by `burnex lint`: a pipeline whose `budget`,
`attempts.max` or `max_iterations` exceeds them is rejected, not clamped.

## Project facts (`.burnex/config.yml`)

```yaml
version: 1
kind: config
defaults: { agent: claude }
project:
  check: npm install && npm run check   # must install its own dependencies
  tools: [npm, npx, node]               # names, not permission entries
  edit_paths: [src/**, test/**, package.json]
  spec: { dir: openspec/changes, rules: .burnex/prompts/spec-rules.md, check: 'openspec validate "$SPEC_CHANGE" --strict' }
```

Pipelines read these as `${project.check}`, `${project.tools}`,
`${project.edit_paths}`, `${project.spec.*}`. Declaring them once here lets
the same jobs move to a repository on another stack by editing one file:

```yaml
until: { max_iterations: 4, check: [{ cmd: "${project.check}" }] }
permissions: { enforce: strict, allow: [Read, Edit, "Bash(${project.tools} *)"] }
expect: [{ changed_only: ["${project.edit_paths}"] }]
```

A reference to an undeclared `project.*` name is a parse error, not an empty
string. Other keys: `project.nested_repos` (repositories inside the tree),
`project.knowledge` (repository memory practice), `project.proposals`.

## Backends

```yaml
backends:
  claude:
    default_model: sonnet
    model_tiers: { max: fable, deep: opus, balance: sonnet, fast: haiku }   # string or { model, effort }
    concurrency: 2                 # simultaneous calls of this backend per run
    permissions: { mode: acceptEdits, allow: [Read, Edit, "Bash(npm *)"] }
    env: { DISABLE_AUTOUPDATER: "1" }
    user_mcp: false                # start agents without the user's own MCP servers
```

| Backend | Sessions | Structured output | `allow`/`deny`, `enforce: strict` | `permissions.mode` values |
|---|---|---|---|---|
| `claude` (built in) | yes | native | yes | Claude Code permission modes |
| `codex` (plugin) | yes | native | accepted, **not applied** | `read-only`, `workspace-write`, `danger-full-access` |
| `cursor-agent` (plugin) | — | from final text | rejected | `enabled`, `disabled` |
| `copilot` (plugin) | — | from final text | rejected; runs with allow-all | none accepted |

Consequences for authors:

- A pipeline meant to run on several backends should set permissions in
  `backends.<id>.permissions`, not on steps, and select models by
  `model_tier`.
- A backend without sessions silently runs `session: shared` as `per_step`
  (event `backend.degraded`).
- `judge`, `review` and `discuss` participants need a backend with some form
  of structured output.
- API keys in the process environment are stripped by `env_deny`; give them to
  a backend through `backends.<id>.credentials` or the CLI's own login.

## Profiles and per-user overrides

```yaml
agents:
  reviewer-strict: { backend: claude, model_tier: deep, effort: high, context: [{ text: "Be adversarial." }] }

agent_policy: fallback
pipeline_agents:
  fix-review-ship: { agent: codex, model_tier: deep }        # key = pipeline `name`
step_agents:
  fix-review-ship: { fix: { repair: { model: sonnet, effort: high } } }   # job → step id
```

- A profile name is valid wherever `agent:` is accepted, including
  `burnex run --agent <profile>`.
- `agent_policy: force` (default): the document wins; `pipeline_agents` and
  `step_agents` only fill what the document leaves unset.
  `agent_policy: fallback`: the user's entries override the document root, and
  `step_agents` overrides even the step itself.
- For a `review` / `discuss` step, `step_agents.<pipeline>.<job>.<step>` picks
  the aggregator, `…<step>/<participant>` a participant.

## Runners (for `script` steps)

```yaml
runners:
  uv: { command: [uv, run], extensions: ['.py'] }
```

Built in: `node`, `node-ts`, `python3`, `sh`. The engine never installs an
interpreter; a missing one fails the step with a terminal attempt.
