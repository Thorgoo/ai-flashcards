import { describe, expect, it } from "vitest";
import { warsawToday } from "./study-day";

describe("warsawToday", () => {
  it("turns the day at midnight Warsaw time, not UTC", () => {
    // Winter (UTC+1): midnight in Warsaw is 23:00 UTC.
    expect(warsawToday(new Date("2026-01-14T22:59:59Z"))).toBe("2026-01-14");
    expect(warsawToday(new Date("2026-01-14T23:00:00Z"))).toBe("2026-01-15");
    // Summer (UTC+2): midnight in Warsaw is 22:00 UTC.
    expect(warsawToday(new Date("2026-07-14T21:59:59Z"))).toBe("2026-07-14");
    expect(warsawToday(new Date("2026-07-14T22:00:00Z"))).toBe("2026-07-15");
  });

  it("keeps the date across the DST switches", () => {
    // 2026-03-29 01:00 UTC: clocks go 02:00 -> 03:00; 2026-10-25 01:00 UTC: 03:00 -> 02:00.
    expect(warsawToday(new Date("2026-03-29T00:30:00Z"))).toBe("2026-03-29");
    expect(warsawToday(new Date("2026-03-29T21:59:59Z"))).toBe("2026-03-29");
    expect(warsawToday(new Date("2026-03-29T22:00:00Z"))).toBe("2026-03-30");
    expect(warsawToday(new Date("2026-10-25T01:30:00Z"))).toBe("2026-10-25");
    expect(warsawToday(new Date("2026-10-25T22:59:59Z"))).toBe("2026-10-25");
    expect(warsawToday(new Date("2026-10-25T23:00:00Z"))).toBe("2026-10-26");
  });

  it("crosses the year boundary", () => {
    expect(warsawToday(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
  });
});
