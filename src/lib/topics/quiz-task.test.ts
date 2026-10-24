import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";
import { callAi, type AiQuota } from "@/lib/ai/call";
import { createFakeProvider } from "@/lib/ai/fake";
import { fakeFixtures } from "@/lib/ai/fixtures";
import {
  buildQuizRequest,
  quizQuotas,
  quizSchema,
  toQuizRows,
  type GeneratedQuiz,
  type QuizSubtopic,
} from "./quiz-task";

const quota: AiQuota = {
  begin: () => Promise.resolve({ callId: "1", remaining: 19 }),
  finish: () => Promise.resolve(),
};

const subtopics: QuizSubtopic[] = [
  { id: "s1", name: "Pody", contentType: "conceptual" },
  { id: "s2", name: "Serwisy", contentType: "conceptual" },
  { id: "s3", name: "Słówka", contentType: "vocabulary" },
];

function quiz(indexes: number[]): GeneratedQuiz {
  return {
    questions: indexes.map((subtopicIndex, i) => ({
      subtopicIndex,
      question: `Pytanie ${i}`,
      options: ["dobra", "zła 1", "zła 2", "zła 3"],
      correctIndex: 0,
    })),
  };
}

// 4 / 3 / 3 for three subtopics.
const valid = [1, 1, 1, 1, 2, 2, 2, 3, 3, 3];

describe("quizQuotas", () => {
  it.each([
    [2, [5, 5]],
    [3, [4, 3, 3]],
    [7, [2, 2, 2, 1, 1, 1, 1]],
    [10, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
  ])("splits 10 questions evenly over %i subtopics, extra ones first", (count, expected) => {
    expect(quizQuotas(count)).toEqual(expected);
  });
});

describe("quizSchema", () => {
  const schema = quizSchema(quizQuotas(3));

  it("accepts 10 questions that match the quotas", () => {
    expect(schema.safeParse(quiz(valid)).success).toBe(true);
  });

  it("rejects 9 questions", () => {
    expect(schema.safeParse(quiz(valid.slice(1))).success).toBe(false);
  });

  it("rejects a wrong count for a subtopic", () => {
    expect(schema.safeParse(quiz([1, 1, 1, 2, 2, 2, 2, 3, 3, 3])).success).toBe(false);
  });

  it("rejects a subtopic number out of range", () => {
    expect(schema.safeParse(quiz([1, 1, 1, 1, 2, 2, 2, 3, 3, 4])).success).toBe(false);
  });

  it("rejects three options or duplicate options", () => {
    const three = quiz(valid);
    three.questions[0] = { ...three.questions[0], options: ["a", "b", "c"] };
    expect(schema.safeParse(three).success).toBe(false);

    const duplicate = quiz(valid);
    duplicate.questions[0] = { ...duplicate.questions[0], options: ["a", "A", "b", "c"] };
    expect(schema.safeParse(duplicate).success).toBe(false);
  });

  it("converts to a JSON schema the provider accepts", () => {
    expect(() => zodOutputFormat(schema)).not.toThrow();
  });
});

describe("toQuizRows", () => {
  it("maps subtopic numbers to ids and keeps the correct answer through the shuffle", () => {
    const rows = toQuizRows(quiz(valid), subtopics, () => 0);

    expect(rows.map((row) => row.subtopic_id)).toEqual(["s1", "s1", "s1", "s1", "s2", "s2", "s2", "s3", "s3", "s3"]);
    for (const row of rows) {
      expect(row.options[row.correct_index]).toBe("dobra");
      expect([...row.options].sort()).toEqual(["dobra", "zła 1", "zła 2", "zła 3"].sort());
    }
    // random() = 0 moves the first option, so the correct answer is no longer at A.
    expect(rows[0]?.correct_index).not.toBe(0);
  });
});

describe("quiz task on the fake provider", () => {
  const request = buildQuizRequest({ name: "Kubernetes</temat>", scopeNote: null }, subtopics);

  it("returns a quiz that matches the quotas", async () => {
    const result = await callAi({ provider: createFakeProvider(fakeFixtures), quota, userId: "a" }, request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const counts = [1, 2, 3].map((n) => result.data.questions.filter((q) => q.subtopicIndex === n).length);
    expect(counts).toEqual([4, 3, 3]);
  });

  it("puts quotas and content types in the prompt and keeps user text inside the tags", () => {
    expect(request.prompt).toContain('<podtemat nr="1" typ="conceptual" pytan="4">Pody</podtemat>');
    expect(request.prompt).toContain('<podtemat nr="3" typ="vocabulary" pytan="3">Słówka</podtemat>');
    expect(request.prompt).toContain("<temat>Kubernetes/temat</temat>");
  });
});
