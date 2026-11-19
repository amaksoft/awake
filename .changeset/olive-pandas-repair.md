---
"@crafter/awake": patch
---

Harden `awake setup` and the menu-bar app based on stock-macOS findings: use a `mktemp` backup (no fixed /tmp path) and absolute tool paths when editing sudoers, probe rule liveness before mutating (healthy re-runs are no-ops again, `--check` documented as existence-only, new passwordless `--verify`), surface setup JSON honestly (`already_configured` / `repaired` / `warning`), resolve the CLI via `AWAKE_CLI`/`cliPath`/login PATH (not just bun+Homebrew), and poll every 15s with overlap guard, CLI timeout, and visible errors.
