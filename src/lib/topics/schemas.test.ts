import { describe, expect, it } from "vitest";
import { addSubtopicInput, createTopicInput, nextBatchInput, studyAnswerInput, updateSubtopicInput } from "./schemas";

describe("createTopicInput", () => {
  it("trims the name and turns an empty scope note into null", () => {
    expect(createTopicInput.parse({ name: "  Spring  ", scopeNote: "   " })).toEqual({
      name: "Spring",
      scopeNote: null,
    });
    expect(createTopicInput.parse({ name: "Spring" })).toEqual({ name: "Spring", scopeNote: null });
  });

  it("keeps a scope note", () => {
    expect(createTopicInput.parse({ name: "Spring", scopeNote: " Boot 3 " }).scopeNote).toBe("Boot 3");
  });

  it("rejects an empty or too long name and a too long note", () => {
    expect(createTopicInput.safeParse({ name: "   " }).success).toBe(false);
    expect(createTopicInput.safeParse({ name: "x".repeat(101) }).success).toBe(false);
    expect(createTopicInput.safeParse({ name: "x".repeat(100) }).success).toBe(true);
    expect(createTopicInput.safeParse({ name: "Spring", scopeNote: "x".repeat(501) }).success).toBe(false);
  });
});

describe("subtopic inputs", () => {
  it("requires a known content type when adding", () => {
    expect(addSubtopicInput.safeParse({ name: "Beany", contentType: "conceptual" }).success).toBe(true);
    expect(addSubtopicInput.safeParse({ name: "Beany", contentType: "poem" }).success).toBe(false);
    expect(addSubtopicInput.safeParse({ name: " ", contentType: "conceptual" }).success).toBe(false);
  });

  it("requires at least one field when updating", () => {
    expect(updateSubtopicInput.safeParse({}).success).toBe(false);
    expect(updateSubtopicInput.safeParse({ contentType: "vocabulary" }).success).toBe(true);
    expect(updateSubtopicInput.safeParse({ name: "Nowa nazwa" }).success).toBe(true);
  });
});

describe("studyAnswerInput", () => {
  const cardId = "5b0c8f7e-2f4a-4c1e-9d3b-1a2b3c4d5e6f";
  const attemptId = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";

  it("accepts an option 0-3 with uuids", () => {
    expect(studyAnswerInput.safeParse({ format: "choice", cardId, answer: 3, attemptId }).success).toBe(true);
  });

  it("rejects other answers, a missing attempt id and malformed ids", () => {
    const choice = { format: "choice", cardId, attemptId };
    expect(studyAnswerInput.safeParse({ ...choice, answer: 4 }).success).toBe(false);
    expect(studyAnswerInput.safeParse({ ...choice, answer: "dont_know" }).success).toBe(false);
    expect(studyAnswerInput.safeParse({ format: "choice", cardId, answer: 0 }).success).toBe(false);
    expect(studyAnswerInput.safeParse({ ...choice, cardId: "x", answer: 0 }).success).toBe(false);
  });

  it("needs the format", () => {
    expect(studyAnswerInput.safeParse({ cardId, answer: 0, attemptId }).success).toBe(false);
    expect(studyAnswerInput.safeParse({ cardId, answerText: "Odpowiedź", attemptId }).success).toBe(false);
  });

  it("accepts an open answer of 1-2000 characters, trimmed", () => {
    const open = { format: "open", cardId, attemptId };
    expect(studyAnswerInput.parse({ ...open, answerText: "  Pod to grupa kontenerów.  " })).toEqual({
      ...open,
      answerText: "Pod to grupa kontenerów.",
    });
    expect(studyAnswerInput.safeParse({ ...open, answerText: "x".repeat(2000) }).success).toBe(true);
  });

  it("rejects an empty or too long open answer and fields of the other format", () => {
    const open = { format: "open", cardId, attemptId };
    expect(studyAnswerInput.safeParse({ ...open, answerText: "   " }).success).toBe(false);
    expect(studyAnswerInput.safeParse({ ...open, answerText: "x".repeat(2001) }).success).toBe(false);
    expect(studyAnswerInput.safeParse({ ...open, answer: 0 }).success).toBe(false);
    expect(
      studyAnswerInput.safeParse({ format: "choice", cardId, answer: 0, answerText: "Odpowiedź", attemptId }).success,
    ).toBe(false);
  });
});

describe("nextBatchInput", () => {
  it("accepts a batch number from 2", () => {
    expect(nextBatchInput.parse({ seq: 2 })).toEqual({ seq: 2 });
    expect(nextBatchInput.safeParse({ seq: 7 }).success).toBe(true);
  });

  it("rejects batch 1, fractions, strings and a missing number", () => {
    expect(nextBatchInput.safeParse({ seq: 1 }).success).toBe(false);
    expect(nextBatchInput.safeParse({ seq: 2.5 }).success).toBe(false);
    expect(nextBatchInput.safeParse({ seq: "2" }).success).toBe(false);
    expect(nextBatchInput.safeParse({}).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(nextBatchInput.safeParse({ seq: 2, topicId: "x" }).success).toBe(false);
  });
});
