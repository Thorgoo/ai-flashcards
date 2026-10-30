import { describe, expect, it } from "vitest";
import { dueLabel, lastSessionLabel } from "./labels";

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
