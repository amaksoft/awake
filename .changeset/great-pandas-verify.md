---
"@crafter/awake": patch
---

Address blind-review round two: per-user sudoers drop-ins (shared Macs no longer revoke each other), uniform setup JSON (`{configured, effective, repaired, warning}`, effective-based `--check` exit codes, `exit 3` on TTY-required), sudo stderr preserved in pmset failures, menu-bar login-shell probing via `$SHELL` with timeouts, runtime fallback for version-manager installs, busy feedback instead of silent overlap drops, CLI error-envelope parsing in the menu, SIGKILL escalation, and `bun test` coverage for the pure sudoers/duration/payload functions.
