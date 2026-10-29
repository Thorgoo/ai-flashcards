import { describe, expect, it } from "vitest";
import { batchAllocation } from "./flashcards-task";
import { batchProgress, masteryPercent, nextBatchSubtopics, subtopicMastery } from "./mastery";

function cards(mastered: number, total: number) {
  return Array.from({ length: total }, (_, i) => ({ mastered: i < mastered }));
}

describe("batchProgress", () => {
  // The threshold cases of claim_next_flashcard_batch's pgTAP test.
  it.each([
    [8, 10, true, 8],
    [7, 10, false, 8],
    [6, 7, true, 6],
    [5, 7, false, 6],
    [0, 0, true, 0],
  ])("%i of %i mastered: unlocked %s, %i required", (mastered, total, unlocked, required) => {
    expect(batchProgress(cards(mastered, total))).toEqual({ total, mastered, required, unlocked });
  });
});

describe("subtopicMastery", () => {
  const list = [
    { id: "a", name: "A", contentType: "conceptual" as const },
    { id: "b", name: "B", contentType: "vocabulary" as const },
    { id: "c", name: "C", contentType: "conceptual" as const },
  ];

  it("counts cards per subtopic in list order; a subtopic without cards is not mastered", () => {
    const result = subtopicMastery(list, [
      { subtopicId: "b", mastered: true },
      { subtopicId: "a", mastered: true },
      { subtopicId: "a", mastered: true },
      { subtopicId: "b", mastered: false },
    ]);

    expect(result).toEqual([
      { id: "a", name: "A", contentType: "conceptual", total: 2, mastered: 2, isMastered: true },
      { id: "b", name: "B", contentType: "vocabulary", total: 2, mastered: 1, isMastered: false },
      { id: "c", name: "C", contentType: "conceptual", total: 0, mastered: 0, isMastered: false },
    ]);
  });
});

describe("masteryPercent", () => {
  it("rounds and reads no cards as 0", () => {
    expect(masteryPercent({ total: 3, mastered: 1 })).toBe(33);
    expect(masteryPercent({ total: 3, mastered: 2 })).toBe(67);
    expect(masteryPercent({ total: 0, mastered: 0 })).toBe(0);
  });
});

describe("nextBatchSubtopics", () => {
  // A 4/4 (mastered), B 1/3, C 0/2, D no cards.
  const mastery = subtopicMastery(
    [
      { id: "a", name: "A", contentType: "conceptual" },
      { id: "b", name: "B", contentType: "conceptual" },
      { id: "c", name: "C", contentType: "conceptual" },
      { id: "d", name: "D", contentType: "vocabulary" },
    ],
    [
      ...cards(4, 4).map((card) => ({ ...card, subtopicId: "a" })),
      ...cards(1, 3).map((card) => ({ ...card, subtopicId: "b" })),
      ...cards(0, 2).map((card) => ({ ...card, subtopicId: "c" })),
    ],
  );

  it("skips mastered subtopics and puts the weakest first, ties by quiz result", () => {
    // C and D tie at 0% mastered; D has no quiz result (0), C scored 40.
    const next = nextBatchSubtopics(mastery, new Map([["c", 40]]));

    expect(next).toEqual([
      { id: "d", name: "D", contentType: "vocabulary", percent: 0 },
      { id: "c", name: "C", contentType: "conceptual", percent: 0 },
      { id: "b", name: "B", contentType: "conceptual", percent: 33 },
    ]);
    expect(batchAllocation(next.map((subtopic) => subtopic.percent))).toEqual([4, 3, 3]);
  });

  it("breaks a tie on both percents by list position", () => {
    const next = nextBatchSubtopics(mastery, new Map([["d", 40]]));

    expect(next.map((subtopic) => subtopic.id)).toEqual(["c", "d", "b"]);
  });

  it("returns nothing when every subtopic is mastered", () => {
    expect(nextBatchSubtopics(mastery.slice(0, 1), new Map())).toEqual([]);
  });
});
