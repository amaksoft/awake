---
"@crafter/awake": patch
---

Address blind-review round three: replace the timestamp-gated liveness probe with a grant-direct re-assert of the current switch position (no timestamp needed, no null state, works on fresh boot), accept both `/etc` and `/private/etc` includedir spellings, stage the sudoers install through a root-owned path, per-user drop-ins with legacy fallback, uninstall TTY/timestamp gate, uniform setup JSON with exit-3 TTY errors, stderr-preserving pmset failures, cached login-shell probes, busy feedback instead of silent overlap drops, CLI error-envelope parsing in the menu, and XCTest coverage for the new CLIResolver.
