import { describe, expect, test } from "bun:test";
import { resolveSetupAction, type SetupInputs } from "./setup.js";

const base: SetupInputs = {
  check: false,
  verify: false,
  uninstall: false,
  configured: false,
  effective: false,
  isTTY: true,
  hasTimestamp: false,
};

describe("resolveSetupAction", () => {
  test("uninstall wins over probes, gated on terminal-or-timestamp", () => {
    expect(resolveSetupAction({ ...base, uninstall: true, check: true, isTTY: true }).kind).toBe("uninstall");
    expect(resolveSetupAction({ ...base, uninstall: true, isTTY: false, hasTimestamp: true }).kind).toBe("uninstall");
    expect(resolveSetupAction({ ...base, uninstall: true, isTTY: false }).kind).toBe("uninstall-needs-tty");
  });

  test("--check and --verify are the same probe", () => {
    expect(resolveSetupAction({ ...base, check: true }).kind).toBe("probe");
    expect(resolveSetupAction({ ...base, verify: true }).kind).toBe("probe");
    expect(resolveSetupAction({ ...base, check: true, verify: true }).kind).toBe("probe");
  });

  test("healthy install is a no-op", () => {
    expect(
      resolveSetupAction({ ...base, configured: true, effective: true }).kind,
    ).toBe("noop");
  });

  test("broken install needs a terminal for repair", () => {
    const tty = resolveSetupAction({ ...base, configured: true, effective: false, isTTY: true });
    expect(tty).toEqual({ kind: "install", repair: true });
    expect(
      resolveSetupAction({ ...base, configured: true, effective: false, isTTY: false }).kind,
    ).toBe("needs-tty");
  });

  test("fresh install needs a terminal, flagged as new (not a repair)", () => {
    const tty = resolveSetupAction({ ...base, isTTY: true });
    expect(tty).toEqual({ kind: "install", repair: false });
    expect(resolveSetupAction({ ...base, isTTY: false }).kind).toBe("needs-tty");
  });
});
