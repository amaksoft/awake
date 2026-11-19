import { exec } from "../utils/exec.js";
import { type ExecFn, isSudoersConfigured } from "./sudoers.js";
import { CLIError, SetupRequiredError } from "../utils/errors.js";

const PMSET = "/usr/bin/pmset";
const SUDO = "/usr/bin/sudo";

// `pmset -g` only prints a SleepDisabled line when the override is active
// on recent macOS, so a missing line means sleep works normally.
export async function isSleepDisabled(): Promise<boolean> {
  const { stdout } = await exec(PMSET, ["-g"]);
  return /SleepDisabled\s+1/.test(stdout);
}

export async function setSleepDisabled(
  disabled: boolean,
  run: ExecFn = exec,
  configured: boolean = isSudoersConfigured(),
): Promise<void> {
  const result = await run(
    SUDO,
    ["-n", PMSET, "-a", "disablesleep", disabled ? "1" : "0"],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    // sudo propagates the child's exit code, so classify by stderr source:
    // lines from sudo itself ("sudo: ...") mean auth/policy failure - anything
    // else is pmset failing on its own terms, which `awake setup` cannot fix.
    const detail = result.stderr.trim().slice(0, 300);
    const sudoOwn = /^\s*sudo:/m.test(result.stderr);
    if (!sudoOwn) {
      throw new CLIError(
        `pmset failed${detail ? `: ${detail}` : ` (exit ${result.code})`} - not a setup problem.`,
        { code: "pmset_failed" },
      );
    }
    const suffix = detail ? ` (${detail})` : ` (sudo exited ${result.code})`;
    if (configured) {
      throw new CLIError(
        `The sudoers rule is installed but sudo refused the command${suffix}. Re-run \`awake setup\` to repair it (e.g. a missing #includedir line).`,
        { exitCode: 3, code: "setup_required", hint: "awake setup" },
      );
    }
    throw new SetupRequiredError();
  }
}

export interface BatteryInfo {
  percent: number | null;
  on_ac: boolean;
  charging: boolean;
}

export async function getBattery(): Promise<BatteryInfo> {
  const { stdout } = await exec(PMSET, ["-g", "batt"], { allowFailure: true });
  const percentMatch = stdout.match(/(\d+)%/);
  return {
    percent: percentMatch?.[1] ? Number(percentMatch[1]) : null,
    on_ac: stdout.includes("'AC Power'"),
    // The state token follows "NN%; " - anchor to the separator so
    // "discharging" and "not charging" don't substring-match as charging.
    charging: /;\s*(charging|finishing charge|charged)\b/.test(stdout),
  };
}
