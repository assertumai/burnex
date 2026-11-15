---
title: Migrating from stepcast
description: The project was renamed from Stepcast to Burnex — what to change in your project.
---

The engine's former name is Stepcast. For one release, the old names are read alongside the new ones, and the engine warns where it found them.

## Find references

```bash
burnex migrate-stepcast [path]
```

prints the file, the line, what was found, and what to replace it with, and exits with an error as long as there are findings. It doesn't edit anything itself.

## What to rename

| Before | After |
|---|---|
| `stepcast` command | `burnex` |
| `.stepcast/`, `stepcast.yml` | `.burnex/`, `burnex.yml` (`git mv .stepcast .burnex`) |
| `~/.stepcast` | `~/.burnex` — moved automatically by `install.sh`, `burnex up`, or `burnex update` |
| `STEPCAST_*` | `BURNEX_*` |
| `stepcast/<subpath>`, `stepcast:<name>` | `burnex/<subpath>`, `burnex:<name>` |
| `@stepcast/slots`, `@stepcast/ui` | `@burnex/slots`, `@burnex/ui` |
| autostart agent `ai.stepcast.daemon` | `ai.burnex.daemon` |

An `npm` install record written before the rename names the package `stepcast` — fix the `package` field in `~/.burnex/install.json`.

Details — [Release process, "Migrating from stepcast"](https://github.com/assertumai/burnex/blob/main/docs/release.md#переход-со-stepcast).
