---
"@crafter/awake": patch
---

Address blind-review round four: gate the liveness probe on a recognizable `pmset -g` dump (never write on unparseable output, single `SleepDisabled 0` and missing-line quiescent states re-assert 0), cache the probe 60s to avoid passwordless sudo writes on every 15s poll, refuse `sudo awake setup` mis-installs via SUDO_USER, per-process sudoers staging, sudo-vs-pmset failure classification, status-call stderr capture, menu loading state, unified --check/--verify probe, and pure-function tests for the new setup state machine.
