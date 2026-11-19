---
"@crafter/awake": patch
---

Address blind-review round five: negative login-shell probes no longer poison the cache (manual Refresh always re-probes, launch uses a probe-free quick check), post-install liveness no longer reads a stale pre-install verdict, piped JSON uses exit codes instead of `process.exit()` truncation, the sudoers install pipes bytes straight into a root-owned staging file (no user-writable tmp at all), `sudo`-vs-`pmset` failures are classified separately, and the menu reduction is a tested pure function.
