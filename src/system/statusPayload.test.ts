import { describe, expect, test } from "bun:test";
import { buildStatusPayload } from "./statusPayload.js";

const battery = { percent: 80, on_ac: true, charging: false };

describe("buildStatusPayload", () => {
  test("timed session carries until + remaining", () => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    const p = buildStatusPayload(true, { enabled_at: new Date().toISOString(), until }, battery, true, true);
    expect(p.enabled).toBe(true);
    expect(p.managed).toBe(true);
    expect(p.forever).toBe(false);
    expect(p.until).toBe(until);
    expect(p.remaining_seconds).toBeGreaterThan(3500);
    expect(p.sudoers_configured).toBe(true);
    expect(p.sudoers_effective).toBe(true);
  });

  test("forever session and unmanaged/external states", () => {
    const f = buildStatusPayload(true, { enabled_at: new Date().toISOString(), until: null }, battery, true, null);
    expect(f.forever).toBe(true);
    expect(f.remaining_seconds).toBe(null);

    const ext = buildStatusPayload(true, null, battery, false, false);
    expect(ext.managed).toBe(false);
    expect(ext.sudoers_effective).toBe(false);
  });

  test("off state", () => {
    const p = buildStatusPayload(false, null, battery, true, true);
    expect(p.enabled).toBe(false);
    expect(p.managed).toBe(false);
  });
});
