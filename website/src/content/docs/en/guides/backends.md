---
title: Connect Codex and Cursor
description: Agent backends other than Claude are connected with a plugin in the user configuration.
---

Claude Code is built in. The other backends ship in the burnex package as plugins and are connected with one line in the **global** configuration — once per machine.

## Codex

1. Install the [Codex CLI](https://github.com/openai/codex) and sign in: `codex login`.
2. Connect the plugin:

   ```yaml
   # ~/.burnex/config.yml
   plugins:
     - burnex/backends/codex
   ```

3. Verify:

   ```bash
   burnex config | grep codex
   ```

   Expect a `backends.codex.*` entry with source `plugin:codex`.

A step selects Codex with `agent: codex`. Codex permissions are sandbox modes: `permissions: { mode: read-only | workspace-write | danger-full-access }`.

## Cursor

```yaml
# ~/.burnex/config.yml
plugins:
  - burnex/backends/codex
  - burnex/backends/cursor
```

The step uses `agent: cursor-agent`. Cursor gets structured output through the response text: the schema goes into the prompt, and the engine checks the last JSON block. The adapter was written from the Cursor CLI documentation and hasn't been tested live yet.

`burnex/backends/copilot` and `burnex/backends/antigravity` are connected the same way.

## Models by tier

To keep the pipeline independent of model names, assign tiers for each backend:

```yaml
# ~/.burnex/config.yml
backends:
  claude:
    model_tiers: { max: opus, deep: opus, balance: sonnet }
  codex:
    model_tiers: { max: gpt-6-astra, deep: gpt-6-sol, balance: gpt-5.6-terra }
defaults:
  agent: claude
```

Steps write `model_tier: deep` — and get that tier's model on any backend. The same can be configured in the web UI on the "Agents" page.

:::caution
Declare a plugin in one place only. The same backend name coming from two declarations (for example, in the global and the project configuration) is an error: burnex reports that the backend name `codex` is already taken.
:::

## In the Reference

[Plugins](/burnex/en/reference/plugins/): [Codex](/burnex/en/reference/plugins/#второй-бэкенд-codex), [Cursor](/burnex/en/reference/plugins/#третий-бэкенд-cursor), [Copilot](/burnex/en/reference/plugins/#четвёртый-бэкенд-copilot), [Antigravity](/burnex/en/reference/plugins/#пятый-бэкенд-antigravity); [backend capabilities](/burnex/en/reference/config/#возможности-бэкендов).
