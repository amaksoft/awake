import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { CLIError } from "../utils/errors.js";
import { exec, spawnInteractive, spawnInteractiveWithInput } from "../utils/exec.js";

// The user being set up for. Under `sudo awake setup` (muscle memory for
// /etc edits) userInfo() is root, which would install a useless root-only
// rule - so prefer the invoking user via SUDO_USER when present.
function invokingUser(): string {
  if (typeof process.geteuid === "function" && process.geteuid() === 0) {
    const su = process.env.SUDO_USER;
    if (su && su !== "root") return su;
  }
  return userInfo().username;
}
// Per-user drop-in: a shared machine's second `awake setup` must not revoke
// the first user's rule (last-writer-wins on a single file would).
function safeUsername(): string {
  return invokingUser().replace(/[^A-Za-z0-9_-]/g, "_");
}
export const SUDOERS_FILE = `/etc/sudoers.d/awake-${safeUsername()}`;
// Pre-per-user installs wrote here; still honored for existence/uninstall.
const LEGACY_SUDOERS_FILE = "/etc/sudoers.d/awake";
// Deterministic artifact of the old root-misinstall (setup run under sudo
// before SUDO_USER handling); cleaned up on uninstall.
const STRAY_ROOT_FILE = "/etc/sudoers.d/awake-root";
const SUDO = "/usr/bin/sudo";
const VISUDO = "/usr/sbin/visudo";
const PMSET = "/usr/bin/pmset";
// Absolute paths everywhere a root shell is involved: sudo may run under a
// restrictive secure_path, and PATH inside `sh -c` is not ours to trust.
const GREP = "/usr/bin/grep";
const MKDIR = "/bin/mkdir";
const CHMOD = "/bin/chmod";
const CP = "/bin/cp";
const RM = "/bin/rm";
const CAT = "/bin/cat";
const MKTEMP = "/usr/bin/mktemp";
const INSTALL = "/usr/bin/install";
const TRUE = "/usr/bin/true";
const TEE = "/usr/bin/tee";

export function sudoersRule(): string {
  const user = invokingUser();
  return `${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 1, ${PMSET} -a disablesleep 0\n`;
}

// The file itself is root-only readable, but /etc/sudoers.d allows stat, so
// existence is a cheap "did you run awake setup" signal - never proof the
// rule is live (see checkRuleEffective). Covers the legacy shared path too.
export function isSudoersConfigured(): boolean {
  return existsSync(SUDOERS_FILE) || existsSync(LEGACY_SUDOERS_FILE);
}

const INCLUDEDIR_LINE = "#includedir /private/etc/sudoers.d";
// /etc symlinks to /private/etc, so '#includedir /etc/sudoers.d' reads the
// same directory - accept either spelling, append the canonical one.
const INCLUDEDIR_PATTERN = "^#includedir /(private/)?etc/sudoers\\.d";

// Stock macOS ships neither /etc/sudoers.d nor the #includedir line that
// makes sudo read it - a drop-in file alone is silently ignored. Idempotent:
// returns true only when the line was actually appended.
// The pre-edit backup uses mktemp (unique, 0600, root-owned): a fixed /tmp
// path would let a pre-planted symlink redirect a root `cp` at an
// arbitrary file, and would race concurrent runs.
// Pure script builder (exported for tests): no I/O, no sudo, just text.
// Exit codes: 0 line already present, 1 line appended, 9 validation failed
// (main file restored from backup first).
export function buildEnsureIncludedirScript(): string {
  return [
    "set -e",
    `bak="$(${MKTEMP} /tmp/sudoers.awake.XXXXXX)"`,
    `trap '${RM} -f "$bak"' EXIT`,
    `${CP} -p /etc/sudoers "$bak"`,
    `${GREP} -Eq '${INCLUDEDIR_PATTERN}' /etc/sudoers && ADDED=0 || { printf '\\n${INCLUDEDIR_LINE}\\n' >> /etc/sudoers; ADDED=1; }`,
    `if ${VISUDO} -c; then trap - EXIT; ${RM} -f "$bak"; else ${CP} -p "$bak" /etc/sudoers; exit 9; fi`,
    "exit $ADDED",
  ].join("; ");
}

async function ensureSudoersIncludedir(): Promise<boolean> {
  const script = buildEnsureIncludedirScript();
  const code = await spawnInteractive(SUDO, ["/bin/sh", "-c", script]);
  if (code === 9) {
    throw new CLIError(
      "Adding the sudoers include line failed validation - /etc/sudoers was restored from backup.",
      { code: "sudoers_invalid" },
    );
  }
  if (code !== 0 && code !== 1) {
    throw new CLIError("Could not update /etc/sudoers to include sudoers.d.", {
      code: "sudoers_install_failed",
      hint: "make sure your account is an administrator",
    });
  }
  return code === 1;
}

export type ExecFn = typeof exec;

// Short-lived cache: the menu polls status every 15s, and a passwordless
// sudo write 4x/minute is noisy on audited machines. Only the default
// runner is cached (test stubs bypass it); callers that just mutated state
// pass fresh=true. 60s TTL: the grant only changes via setup/repair.
let effCache: { v: boolean; at: number } | null = null;
const EFF_TTL_MS = 60_000;

export function clearEffectiveCache(): void {
  effCache = null;
}

// Is our rule actually live? Re-asserts the CURRENT switch position via the
// grant itself: NOPASSWD covers exactly these two pmset commands, so
// success proves the grant and failure proves it doesn't - with no state
// change either way (the value written is the value just read).
// Needs no sudo timestamp, never prompts (`-n`), never touches the
// filesystem: safe in scripts, agents, and GUI contexts, on fresh boot.
// The write is gated on a recognizable `pmset -g` dump: on recent macOS
// the SleepDisabled line only appears while the override is active, so a
// healthy dump without it means "off" - but a failed/truncated dump must
// report not-live WITHOUT writing, so a broken pmset can never silently
// cancel an active keep-awake session.
// A concurrent flip between the read and the write can only rewrite the
// just-observed value - benign for a probe.
export async function checkRuleEffective(run: ExecFn = exec, fresh = false): Promise<boolean> {
  if (!fresh && run === exec && effCache && Date.now() - effCache.at < EFF_TTL_MS) {
    return effCache.v;
  }
  const cur = await run(PMSET, ["-g"], { allowFailure: true });
  const dump = cur.stdout ?? "";
  if (cur.code !== 0 || !/System-wide power settings/.test(dump)) return false;
  const on = /SleepDisabled\s+1/.test(dump);
  const r = await run(SUDO, ["-n", PMSET, "-a", "disablesleep", on ? "1" : "0"], {
    allowFailure: true,
  });
  const v = r.code === 0;
  if (run === exec) effCache = { v, at: Date.now() };
  return v;
}

async function warnIfNotEffective(): Promise<string | null> {
  const eff = await checkRuleEffective();
  return eff
    ? null
    : "Installed, but sudo does not honor the rule yet - re-run `awake setup`, then test with `awake on 30m` and `awake off`.";
}

export interface SetupInstallResult {
  repaired: boolean;
  warning: string | null;
}

// Pure (exported for tests): did this install actually change anything?
export function computeRepaired(args: {
  lineAdded: boolean;
  oldContent: string | null;
  previouslyExisted: boolean;
  newContent: string;
}): boolean {
  const contentChanged =
    args.oldContent === null
      ? !args.previouslyExisted
      : args.oldContent.trim() !== args.newContent.trim();
  return args.lineAdded || contentChanged;
}

export async function installSudoersRule(): Promise<SetupInstallResult> {
  // The grant is about to change: any cached verdict is stale by definition.
  clearEffectiveCache();
  const previouslyExisted = isSudoersConfigured();
  const rule = sudoersRule();
  // Per-process staging in the root-owned directory. The rule bytes travel
  // from this process straight into root's hands via a pipe - no
  // attacker-writable file is ever validated-then-installed, so no
  // same-UID swap between check and use is possible. (tee echoes the rule;
  // that is the audit trail, not a leak: it is the exact grant installed.)
  const staging = `/etc/sudoers.d/.awake.pending.${process.pid}`;

  // Interactive sudo first: prompts once and establishes the timestamp
  // for the root-readable steps below.
  const lineAdded = await ensureSudoersIncludedir();

  // Snapshot the old rule (current path, else legacy) while the timestamp
  // is fresh, so the caller learns whether anything actually changed.
  const readIfPresent = async (p: string): Promise<string | null> => {
    const r = await exec(SUDO, ["-n", CAT, p], { allowFailure: true });
    return r.code === 0 ? r.stdout : null;
  };
  const oldContent = previouslyExisted
    ? ((await readIfPresent(SUDOERS_FILE)) ?? (await readIfPresent(LEGACY_SUDOERS_FILE)))
    : null;

  // /etc/sudoers.d does not exist on stock macOS — files cannot be placed
  // there without the parent dir. Create it first (interactive: sudo
  // prompts for the password once).
  let code = await spawnInteractive(SUDO, [MKDIR, "-p", "/etc/sudoers.d"]);
  if (code !== 0) {
    throw new CLIError("Could not create /etc/sudoers.d.", {
      code: "sudoers_install_failed",
      hint: "make sure your account is an administrator",
    });
  }
  code = await spawnInteractive(SUDO, [CHMOD, "0755", "/etc/sudoers.d"]);
  if (code !== 0) {
    throw new CLIError("Could not set permissions on /etc/sudoers.d.", {
      code: "sudoers_install_failed",
      hint: "make sure your account is an administrator",
    });
  }

  // Pipe the rule bytes straight into the root-owned staging file.
  // Interactive: sudo prompts for the user's password in the terminal.
  code = await spawnInteractiveWithInput(SUDO, [TEE, staging], rule);
  if (code !== 0) {
    throw new CLIError("Could not stage the sudoers rule.", {
      code: "sudoers_install_failed",
      hint: "make sure your account is an administrator",
    });
  }
  // Validate the exact bytes root will install - staging is root-owned,
  // so nothing else could have altered them after the pipe.
  code = await spawnInteractive(SUDO, [VISUDO, "-cf", staging]);
  if (code !== 0) {
    await spawnInteractive(SUDO, [RM, "-f", staging]);
    throw new CLIError("Staged sudoers rule failed validation.", {
      code: "sudoers_invalid",
    });
  }
  code = await spawnInteractive(SUDO, [
    INSTALL,
    "-o",
    "root",
    "-g",
    "wheel",
    "-m",
    "0440",
    staging,
    SUDOERS_FILE,
  ]);
  await spawnInteractive(SUDO, [RM, "-f", staging]);
  if (code !== 0) {
    throw new CLIError("Could not install the sudoers rule.", {
      code: "sudoers_install_failed",
      hint: "make sure your account is an administrator",
    });
  }

  if (!isSudoersConfigured()) {
    throw new CLIError("Sudoers rule was installed but verification failed.", {
      code: "sudoers_verify_failed",
    });
  }

  // Syntax-check the file in place (needs root to read) and confirm sudo
  // actually grants the rule - file presence alone proved meaningless.
  const installed = await spawnInteractive(SUDO, [VISUDO, "-cf", SUDOERS_FILE]);
  if (installed !== 0) {
    throw new CLIError("Installed sudoers rule failed validation in place.", {
      code: "sudoers_invalid",
    });
  }
  const repaired = computeRepaired({
    lineAdded,
    oldContent,
    previouslyExisted,
    newContent: sudoersRule(),
  });
  return { repaired, warning: await warnIfNotEffective() };
}

// True when a cached sudo timestamp lets `sudo -n` succeed without
// prompting. Lets non-interactive flows attempt what they can and fail
// with a clear tty_required instead of hanging on a password prompt.
export async function hasSudoTimestamp(run: ExecFn = exec): Promise<boolean> {
  const t = await run(SUDO, ["-n", TRUE], { allowFailure: true });
  return t.code === 0;
}

export async function uninstallSudoersRule(): Promise<void> {
  clearEffectiveCache();
  // Remove the drop-in file, any legacy shared one, and the deterministic
  // stray from pre-SUDO_USER installs run under sudo. The #includedir line
  // in /etc/sudoers is intentionally left in place (harmless).
  for (const file of [SUDOERS_FILE, LEGACY_SUDOERS_FILE, STRAY_ROOT_FILE]) {
    const code = await spawnInteractive(SUDO, [RM, "-f", file]);
    if (code !== 0) {
      throw new CLIError(`Could not remove the sudoers rule (${file}).`, {
        code: "sudoers_uninstall_failed",
      });
    }
  }
}
