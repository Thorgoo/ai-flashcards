import { describe, expect, it } from "vitest";
import { dueLabel, lastSessionLabel, streakHint, streakLabel } from "./labels";

describe("dueLabel", () => {
  it.each([
    [0, "Do powtórki: 0"],
    [7, "Do powtórki: 7"],
  ])("%i → %s", (count, expected) => {
    expect(dueLabel(count)).toBe(expected);
  });
});

describe("lastSessionLabel", () => {
  it("formats the day without shifting it", () => {
    expect(lastSessionLabel("2026-01-05")).toBe("Ostatnia sesja: 05.01.2026");
    expect(lastSessionLabel("2025-12-31")).toBe("Ostatnia sesja: 31.12.2025");
  });

  it("shows a dash when the topic was never studied", () => {
    expect(lastSessionLabel(null)).toBe("Ostatnia sesja: —");
  });
});

describe("streakLabel", () => {
  it.each([
    [0, "Seria: 0 dni"],
    [1, "Seria: 1 dzień"],
    [2, "Seria: 2 dni"],
    [5, "Seria: 5 dni"],
    [22, "Seria: 22 dni"],
  ])("%i → %s", (days, expected) => {
    expect(streakLabel(days)).toBe(expected);
  });
});

describe("streakHint", () => {
  it("invites the first answer when there is no streak", () => {
    expect(streakHint({ days: 0, studiedToday: false })).toBe("Odpowiedz na fiszkę, aby zacząć serię");
  });

  it("asks to study today to keep a streak alive", () => {
    expect(streakHint({ days: 3, studiedToday: false })).toBe("Ucz się dziś, aby utrzymać serię");
  });

  it("shows no hint once the account studied today", () => {
    expect(streakHint({ days: 1, studiedToday: true })).toBeNull();
  });
});
