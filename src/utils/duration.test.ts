import { describe, expect, test } from "bun:test";
import { formatDuration, parseDuration } from "./duration.js";

describe("parseDuration", () => {
  test("minutes / hours / combos", () => {
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration("90s")).toBe(90);
  });

  test("bare number means minutes", () => {
    expect(parseDuration("45")).toBe(2700);
  });

  test("rejects garbage, zero, and >7d", () => {
    expect(() => parseDuration("soon")).toThrow();
    expect(() => parseDuration("0m")).toThrow();
    expect(() => parseDuration("8d")).toThrow();
  });
});

describe("formatDuration", () => {
  test("renders h/m/s compactly", () => {
    expect(formatDuration(5400)).toBe("1h 30m");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(0)).toBe("0s");
  });
});
