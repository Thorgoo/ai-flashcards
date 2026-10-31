import { describe, expect, it } from "vitest";
import { badgeBoard, badgeLabel, daysLabel, type EarnedBadge } from "./catalog";

function earned(kind: EarnedBadge["kind"], threshold: number | null, extra: Partial<EarnedBadge> = {}): EarnedBadge {
  return {
    kind,
    threshold,
    topicId: null,
    topicName: null,
    topicArchived: false,
    awardedAt: "2026-10-31T10:00:00+00:00",
    ...extra,
  };
}

describe("daysLabel", () => {
  it.each([
    [1, "1 dzień"],
    [3, "3 dni"],
    [100, "100 dni"],
  ])("%i → %s", (days, expected) => {
    expect(daysLabel(days)).toBe(expected);
  });
});

describe("badgeLabel", () => {
  it.each([
    [earned("streak", 7), "Seria 7 dni"],
    [earned("streak", 1), "Seria 1 dzień"],
    [earned("mastered_cards", 50), "50 opanowanych fiszek"],
    [earned("mastered_cards", 10), "10 opanowanych fiszek"],
    [earned("mastered_cards", 2), "2 opanowane fiszki"],
    [earned("mastered_cards", 12), "12 opanowanych fiszek"],
    [earned("mastered_cards", 1), "1 opanowana fiszka"],
    [earned("topic", null, { topicId: "t1", topicName: "Kubernetes" }), "Temat opanowany: Kubernetes"],
  ])("%o → %s", (badge, expected) => {
    expect(badgeLabel(badge)).toBe(expected);
  });
});

describe("badgeBoard", () => {
  it("caps progress at the threshold and marks the thresholds reached", () => {
    const board = badgeBoard({
      streakDays: 9,
      masteredCards: 38,
      earned: [earned("streak", 3), earned("streak", 7), earned("mastered_cards", 10)],
    });
    expect(board.streak.map((row) => [row.label, row.earned, row.progress])).toEqual([
      ["Seria 3 dni", true, "3/3"],
      ["Seria 7 dni", true, "7/7"],
      ["Seria 30 dni", false, "9/30"],
      ["Seria 100 dni", false, "9/100"],
    ]);
    expect(board.masteredCards.map((row) => [row.earned, row.progress])).toEqual([
      [true, "10/10"],
      [false, "38/50"],
      [false, "38/100"],
      [false, "38/250"],
    ]);
    expect(board.streak[1].awardedAt).toBe("2026-10-31T10:00:00+00:00");
    expect(board.streak[2].awardedAt).toBeUndefined();
  });

  it("keeps an earned badge when the current state is lower", () => {
    const board = badgeBoard({ streakDays: 0, masteredCards: 0, earned: [earned("streak", 3)] });
    expect(board.streak[0]).toMatchObject({ earned: true, progress: "3/3" });
    expect(board.streak[1]).toMatchObject({ earned: false, progress: "0/7" });
  });

  it("lists only the earned topic badges, archived ones included", () => {
    const topic = earned("topic", null, { topicId: "t1", topicName: "Docker", topicArchived: true });
    const board = badgeBoard({ streakDays: 1, masteredCards: 5, earned: [earned("streak", 3), topic] });
    expect(board.topics).toEqual([topic]);
  });
});
