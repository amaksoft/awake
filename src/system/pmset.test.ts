import { describe, expect, test } from "bun:test";
import { setSleepDisabled } from "./pmset.js";
import type { ExecResult } from "../utils/exec.js";

function stubExec(stdout: string, stderr: string, code: number) {
  return async (_cmd: string, _args: string[]): Promise<ExecResult> => ({
    stdout,
    stderr,
    code,
  });
}

describe("setSleepDisabled", () => {
  test("success does not throw", async () => {
    await setSleepDisabled(true, stubExec("", "", 0), false);
  });

  test("sudo refusal with a rule installed points at repair (exit 3)", async () => {
    const run = stubExec("", "sudo: a password is required", 1);
    const err = await setSleepDisabled(true, run, true).catch((e) => e);
    expect(err.code).toBe("setup_required");
    expect(err.exitCode).toBe(3);
    expect(String(err.message)).toContain("sudo: a password is required");
  });

  test("sudo refusal without a rule points at setup", async () => {
    const run = stubExec("", "sudo: a password is required", 1);
    const err = await setSleepDisabled(true, run, false).catch((e) => e);
    expect(err.code).toBe("setup_required");
  });

  test("pmset's own failure is not misreported as a setup problem", async () => {
    const run = stubExec("", "pmset: Error 0xe00002c1", 1);
    const err = await setSleepDisabled(false, run, true).catch((e) => e);
    expect(err.code).toBe("pmset_failed");
    expect(err.exitCode).toBe(1);
    expect(String(err.message)).toContain("pmset:");
  });
});
