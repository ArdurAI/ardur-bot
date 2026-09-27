import { describe, expect, it } from "vitest";
import { formatAbsoluteCommandTime, formatCommandTime } from "./command-time.js";

describe("formatCommandTime", () => {
  const fixedNow = new Date(2026, 8, 24, 14, 30);
  const locale = "en-US";

  it("formats today as time only", () => {
    const todayIso = new Date(2026, 8, 24, 9, 15).toISOString();
    expect(formatCommandTime(todayIso, fixedNow, locale)).toBe("9:15 AM");
  });

  it("formats another day in the same year as short date and time", () => {
    const anotherDayIso = new Date(2026, 8, 20, 9, 15).toISOString();
    expect(formatCommandTime(anotherDayIso, fixedNow, locale)).toBe("Sep 20, 9:15 AM");
  });

  it("formats another year with the year included", () => {
    const otherYearIso = new Date(2025, 8, 20, 9, 15).toISOString();
    expect(formatCommandTime(otherYearIso, fixedNow, locale)).toBe("Sep 20, 2025, 9:15 AM");
  });

  it("returns null for null, undefined, empty string, and unparseable garbage", () => {
    expect(formatCommandTime(null, fixedNow, locale)).toBeNull();
    expect(formatCommandTime(undefined, fixedNow, locale)).toBeNull();
    expect(formatCommandTime("", fixedNow, locale)).toBeNull();
    expect(formatCommandTime("garbage", fixedNow, locale)).toBeNull();
    expect(formatCommandTime("2026-99-99T99:99:99Z", fixedNow, locale)).toBeNull();
  });
});

describe("formatAbsoluteCommandTime", () => {
  it("formats valid date with dateStyle medium and timeStyle short", () => {
    const iso = new Date(2026, 8, 24, 9, 15).toISOString();
    expect(formatAbsoluteCommandTime(iso, "en-US")).toBe("Sep 24, 2026, 9:15 AM");
  });

  it("formats with specified locale", () => {
    const iso = new Date(2026, 8, 24, 9, 15).toISOString();
    expect(formatAbsoluteCommandTime(iso, "de-DE")).toBe("24.09.2026, 09:15");
  });

  it("returns undefined for null, undefined, empty string, and unparseable garbage", () => {
    expect(formatAbsoluteCommandTime(null, "en-US")).toBeUndefined();
    expect(formatAbsoluteCommandTime(undefined, "en-US")).toBeUndefined();
    expect(formatAbsoluteCommandTime("", "en-US")).toBeUndefined();
    expect(formatAbsoluteCommandTime("garbage", "en-US")).toBeUndefined();
    expect(formatAbsoluteCommandTime("2026-99-99T99:99:99Z", "en-US")).toBeUndefined();
  });
});
