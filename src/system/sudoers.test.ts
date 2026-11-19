import { describe, expect, test } from "bun:test";
import {
  buildEnsureIncludedirScript,
  checkRuleEffective,
  computeRepaired,
  sudoersRule,
} from "./sudoers.js";
import type { ExecResult } from "../utils/exec.js";

describe("buildEnsureIncludedirScript", () => {
  const script = buildEnsureIncludedirScript();

  test("backs up via mktemp, never a fixed /tmp path", () => {
    expect(script).toContain("mktemp /tmp/sudoers.awake.XXXXXX");
    expect(script).not.toContain("/tmp/sudoers.awake.bak");
  });

  test("restores from backup when visudo rejects the edit", () => {
    expect(script).toContain("visudo -c");
    expect(script).toContain("exit 9");
  });

  test("uses absolute tool paths (no bare names under sudo)", () => {
    for (const tool of ["/usr/bin/mktemp", "/bin/rm", "/bin/cp", "/usr/bin/grep", "/usr/sbin/visudo"]) {
      expect(script).toContain(tool);
    }
    expect(script).not.toMatch(/(^|; )rm /);
  });

  test("reports whether the line was appended via exit code", () => {
    expect(script).toContain("exit $ADDED");
  });
});

describe("computeRepaired", () => {
  const rule = sudoersRule();

  test("line appended counts as repair", () => {
    expect(computeRepaired({ lineAdded: true, oldContent: rule, previouslyExisted: true, newContent: rule })).toBe(true);
  });

  test("fresh install counts as repair", () => {
    expect(computeRepaired({ lineAdded: false, oldContent: null, previouslyExisted: false, newContent: rule })).toBe(true);
  });

  test("identical reinstall is not a repair", () => {
    expect(computeRepaired({ lineAdded: false, oldContent: rule, previouslyExisted: true, newContent: rule })).toBe(false);
  });

  test("whitespace-only drift is not a repair", () => {
    expect(
      computeRepaired({ lineAdded: false, oldContent: `  ${rule}  `, previouslyExisted: true, newContent: rule }),
    ).toBe(false);
  });

  test("changed rule (e.g. renamed user) is a repair", () => {
    expect(
      computeRepaired({ lineAdded: false, oldContent: "olduser ALL=(root) NOPASSWD: /bin/true\n", previouslyExisted: true, newContent: rule }),
    ).toBe(true);
  });
});

describe("sudoersRule", () => {
  test("is scoped to exactly the two disablesleep commands", () => {
    expect(sudoersRule()).toMatch(/^\S+ ALL=\(root\) NOPASSWD: \/usr\/bin\/pmset -a disablesleep 1, \/usr\/bin\/pmset -a disablesleep 0\n$/);
  });
});

describe("checkRuleEffective", () => {
  // Re-asserts the current switch position through the grant itself, so it
  // needs no sudo timestamp and never prompts. pmset output decides which
  // value gets re-asserted; the sudo exit code decides the verdict.
  const stubExec = (sudoCode: number, pmsetStdout = "") =>
    async (cmd: string, _args: string[]): Promise<ExecResult> =>
      cmd === "/usr/bin/pmset"
        ? { stdout: pmsetStdout, stderr: "", code: 0 }
        : { stdout: "", stderr: sudoCode === 0 ? "" : "sudo: a password is required", code: sudoCode };

  const HEALTHY_OFF = "System-wide power settings:\n standby              1\n sleep                0\n";
  const HEALTHY_ON = `System-wide power settings:\n SleepDisabled\t\t1\n sleep                0\n`;

  test("awake machine + grant ok -> true (re-asserts 1)", async () => {
    let asserted: string[] = [];
    const run = async (cmd: string, args: string[]): Promise<ExecResult> => {
      if (cmd === "/usr/bin/pmset" && args[0] === "-g") {
        return { stdout: HEALTHY_ON, stderr: "", code: 0 };
      }
      asserted = args;
      return { stdout: "", stderr: "", code: 0 };
    };
    expect(await checkRuleEffective(run)).toBe(true);
    expect(asserted).toEqual(["-n", "/usr/bin/pmset", "-a", "disablesleep", "1"]);
  });

  test("sleeping machine + grant ok -> true (re-asserts 0, no state change)", async () => {
    const run = stubExec(0, HEALTHY_OFF);
    expect(await checkRuleEffective(run)).toBe(true);
  });

  test("failed pmset reports not-live WITHOUT writing (never cancel a session blind)", async () => {
    let sudoCalls = 0;
    const run = async (cmd: string, args: string[]): Promise<ExecResult> => {
      if (cmd === "/usr/bin/pmset" && args[0] === "-g") {
        return { stdout: "", stderr: "boom", code: 1 };
      }
      sudoCalls += 1;
      return { stdout: "", stderr: "", code: 0 };
    };
    expect(await checkRuleEffective(run)).toBe(false);
    expect(sudoCalls).toBe(0);
  });

  test("truncated dump without the header reports not-live WITHOUT writing", async () => {
    let sudoCalls = 0;
    const run = async (cmd: string, args: string[]): Promise<ExecResult> => {
      if (cmd === "/usr/bin/pmset") {
        return { stdout: "SleepDisabled              1\n", stderr: "", code: 0 };
      }
      sudoCalls += 1;
      return { stdout: "", stderr: "", code: 0 };
    };
    expect(await checkRuleEffective(run)).toBe(false);
    expect(sudoCalls).toBe(0);
  });

  test("sudo refusal reports not-live", async () => {
    expect(await checkRuleEffective(stubExec(1, "SleepDisabled              1"))).toBe(false);
  });
});

describe("invokingUser + SUDOERS_FILE", () => {
  test("drop-in path embeds the sanitized current username", async () => {
    const mod = await import("./sudoers.js");
    const { userInfo } = await import("node:os");
    const safe = userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_");
    expect(mod.SUDOERS_FILE).toBe(`/etc/sudoers.d/awake-${safe}`);
  });
});
