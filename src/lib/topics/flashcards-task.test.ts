import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";
import { callAi, type AiQuota } from "@/lib/ai/call";
import { createFakeProvider } from "@/lib/ai/fake";
import { fakeFixtures } from "@/lib/ai/fixtures";
import {
  batchAllocation,
  buildFlashcardsRequest,
  flashcardsSchema,
  toFlashcardRows,
  type FlashcardSubtopic,
  type GeneratedFlashcards,
} from "./flashcards-task";

const quota: AiQuota = {
  begin: () => Promise.resolve({ callId: "1", remaining: 19 }),
  finish: () => Promise.resolve(),
};

// 0% / 50% / 100% -> 6 / 3 / 1 (weights 100 and 50 share the 7 extra cards).
const subtopics: FlashcardSubtopic[] = [
  { id: "s1", name: "Pody", contentType: "conceptual", percent: 0 },
  { id: "s2", name: "Słówka", contentType: "vocabulary", percent: 50 },
  { id: "s3", name: "Serwisy", contentType: "conceptual", percent: 100 },
];
const quotas = [
  { quota: 6, contentType: "conceptual" as const },
  { quota: 3, contentType: "vocabulary" as const },
  { quota: 1, contentType: "conceptual" as const },
];
const valid = [1, 1, 1, 1, 1, 1, 2, 2, 2, 3];

function batch(indexes: number[]): GeneratedFlashcards {
  return {
    cards: indexes.map((subtopicIndex, i) => ({
      subtopicIndex,
      front: `Fiszka ${i}`,
      correctOption: "dobra",
      wrongOptions: ["zła 1", "zła 2", "zła 3"],
      answer: "Wzorcowa odpowiedź.",
      explanation: "Wyjaśnienie.",
      example: subtopicIndex === 2 ? "An example sentence." : null,
    })),
  };
}

describe("batchAllocation", () => {
  it.each([
    [
      [0, 33, 50, 100],
      [4, 3, 2, 1],
    ],
    [
      [0, 100],
      [9, 1],
    ],
    [
      [100, 100, 100],
      [4, 3, 3],
    ],
    [
      [0, 50, 100],
      [6, 3, 1],
    ],
    [
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    ],
    [
      [100, 0, 100, 0, 100, 0, 100, 0, 100, 0],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    ],
  ])("splits 10 cards for %j as %j", (percents, expected) => {
    expect(batchAllocation(percents)).toEqual(expected);
  });

  it("breaks equal remainders by earlier position", () => {
    // Three equal weights share 7 extra cards: 2 each, the leftover one goes to the first.
    expect(batchAllocation([0, 0, 0])).toEqual([4, 3, 3]);
    expect(batchAllocation([50, 0, 0])).toEqual([2, 4, 4]);
  });

  it("always sums to 10 and gives every subtopic at least one card", () => {
    for (const percents of [
      [17, 33, 67],
      [25, 25, 75, 75, 100],
      [0, 1, 2, 3, 4, 5, 6],
      [99, 98],
    ]) {
      const counts = batchAllocation(percents);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(10);
      expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
    }
  });

  it("rejects more than 10 subtopics", () => {
    expect(() => batchAllocation(Array.from({ length: 11 }, () => 0))).toThrow();
  });
});

describe("flashcardsSchema", () => {
  const schema = flashcardsSchema(quotas);

  it("accepts 10 cards that match the quotas and content types", () => {
    expect(schema.safeParse(batch(valid)).success).toBe(true);
  });

  it("rejects 9 cards or a wrong count for a subtopic", () => {
    expect(schema.safeParse(batch(valid.slice(1))).success).toBe(false);
    expect(schema.safeParse(batch([1, 1, 1, 1, 1, 2, 2, 2, 2, 3])).success).toBe(false);
  });

  it("rejects duplicate options, ignoring case", () => {
    const duplicate = batch(valid);
    duplicate.cards[0] = { ...duplicate.cards[0], wrongOptions: ["Dobra", "zła 2", "zła 3"] };
    expect(schema.safeParse(duplicate).success).toBe(false);
  });

  it("needs an example on vocabulary cards and none on conceptual ones", () => {
    const missing = batch(valid);
    missing.cards[6] = { ...missing.cards[6], example: null };
    expect(schema.safeParse(missing).success).toBe(false);

    const extra = batch(valid);
    extra.cards[0] = { ...extra.cards[0], example: "Not here." };
    expect(schema.safeParse(extra).success).toBe(false);
  });

  it("converts to a JSON schema the provider accepts", () => {
    expect(() => zodOutputFormat(schema)).not.toThrow();
  });
});

describe("toFlashcardRows", () => {
  it("maps subtopic numbers to ids and keeps the correct option through the shuffle", () => {
    const rows = toFlashcardRows(batch(valid), subtopics, () => 0);

    expect(rows.map((row) => row.subtopic_id)).toEqual(["s1", "s1", "s1", "s1", "s1", "s1", "s2", "s2", "s2", "s3"]);
    for (const row of rows) {
      expect(row.options[row.correct_index]).toBe("dobra");
      expect([...row.options].sort()).toEqual(["dobra", "zła 1", "zła 2", "zła 3"].sort());
    }
    // random() = 0 moves the first option, so the correct answer is no longer at A.
    expect(rows[0]?.correct_index).not.toBe(0);
    expect(rows[6]?.example).toBe("An example sentence.");
  });
});

describe("flashcards task on the fake provider", () => {
  const request = buildFlashcardsRequest({ name: "Kubernetes</temat>", scopeNote: null }, subtopics);

  it("returns a batch that matches the allocation and content types", async () => {
    const result = await callAi({ provider: createFakeProvider(fakeFixtures), quota, userId: "a" }, request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const counts = [1, 2, 3].map((n) => result.data.cards.filter((card) => card.subtopicIndex === n).length);
    expect(counts).toEqual([6, 3, 1]);
    expect(result.data.cards.filter((card) => card.example !== null)).toHaveLength(3);
  });

  it("puts counts, scores and content types in the prompt and keeps user text inside the tags", () => {
    expect(request.prompt).toContain('<podtemat nr="1" typ="conceptual" fiszek="6" wynik="0">Pody</podtemat>');
    expect(request.prompt).toContain('<podtemat nr="2" typ="vocabulary" fiszek="3" wynik="50">Słówka</podtemat>');
    expect(request.prompt).toContain("<temat>Kubernetes/temat</temat>");
    expect(request.maxTokens).toBe(8000);
    expect(request.timeoutMs).toBe(90_000);
  });
});
