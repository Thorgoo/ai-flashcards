import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { batchError, getFlashcardSummary, hasFlashcards } from "./flashcard-repository";

const TOPIC = "00000000-0000-0000-0000-0000000000a1";
const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 121_000).toISOString();
const YESTERDAY = new Date(Date.now() - 24 * 3600_000).toISOString();

interface Batch {
  id: string;
  seq: number;
  status: "generating" | "ready" | "failed";
  claimed_at: string;
  error_code: string | null;
}

interface Card {
  batch_id: string;
  subtopic_id: string;
  stage: string;
}

// Answers the three reads of getFlashcardSummary (batches, cards, subtopics) from fixed rows.
function client(batches: Batch[], cards: Card[] = []): SupabaseClient {
  const tables: Record<string, unknown[]> = {
    flashcard_batches: batches,
    flashcards: cards,
    subtopics: [{ id: "s1", name: "S1", content_type: "conceptual", position: 0 }],
  };
  return {
    from: (table: string) => ({
      select: () => ({ eq: () => Promise.resolve({ data: tables[table], error: null }) }),
    }),
  } as unknown as SupabaseClient;
}

describe("batchError", () => {
  it("reads an AI error code with its message and retry flag", () => {
    expect(batchError("ai_timeout")).toEqual({
      code: "ai_timeout",
      message: "AI nie odpowiedziało na czas. Spróbuj ponownie.",
      retryable: true,
    });
    expect(batchError("quota_exceeded")).toMatchObject({ code: "quota_exceeded", retryable: false });
  });

  it("reads a topic error code", () => {
    expect(batchError("save_failed")).toEqual({
      code: "save_failed",
      message: "Nie udało się zapisać zmian. Spróbuj ponownie.",
      retryable: true,
    });
  });

  it.each([["something_else"], ["toString"], [null]])("reads an unknown code %s as save_failed", (code) => {
    expect(batchError(code)).toMatchObject({ code: "save_failed", retryable: true });
  });
});

describe("getFlashcardSummary failures", () => {
  it("returns null without any batch", async () => {
    expect(await getFlashcardSummary(client([]), TOPIC)).toBeNull();
  });

  it("shows a failed batch 1 alone as a state with its error", async () => {
    const summary = await getFlashcardSummary(
      client([{ id: "b1", seq: 1, status: "failed", claimed_at: NOW, error_code: "ai_invalid_output" }]),
      TOPIC,
    );
    expect(summary).toMatchObject({
      readyBatches: 0,
      generating: null,
      current: null,
      failed: { seq: 1, error: { code: "ai_invalid_output", retryable: true } },
    });
    expect(hasFlashcards(summary)).toBe(false);
  });

  it("hides an older failure behind a fresh claim", async () => {
    const summary = await getFlashcardSummary(
      client([
        { id: "b1", seq: 1, status: "ready", claimed_at: OLD, error_code: null },
        { id: "b2", seq: 2, status: "failed", claimed_at: OLD, error_code: "ai_timeout" },
        { id: "b3", seq: 3, status: "generating", claimed_at: NOW, error_code: null },
      ]),
      TOPIC,
    );
    expect(summary).toMatchObject({ generating: { seq: 3 }, failed: null });
  });

  it("shows the failure of the batch after the latest ready one", async () => {
    const summary = await getFlashcardSummary(
      client([
        { id: "b1", seq: 1, status: "ready", claimed_at: OLD, error_code: null },
        { id: "b2", seq: 2, status: "failed", claimed_at: OLD, error_code: "quota_exceeded" },
      ]),
      TOPIC,
    );
    expect(summary).toMatchObject({
      readyBatches: 1,
      failed: { seq: 2, error: { code: "quota_exceeded", retryable: false } },
    });
  });

  it("ignores a failure below the latest ready batch", async () => {
    const summary = await getFlashcardSummary(
      client([
        { id: "b1", seq: 1, status: "failed", claimed_at: OLD, error_code: "ai_timeout" },
        { id: "b2", seq: 2, status: "ready", claimed_at: OLD, error_code: null },
      ]),
      TOPIC,
    );
    expect(summary).toMatchObject({ readyBatches: 1, failed: null });
  });

  it("hides a failed next batch once the topic is mastered", async () => {
    const summary = await getFlashcardSummary(
      client(
        [
          { id: "b1", seq: 1, status: "ready", claimed_at: OLD, error_code: null },
          { id: "b2", seq: 2, status: "failed", claimed_at: NOW, error_code: "ai_timeout" },
        ],
        [{ batch_id: "b1", subtopic_id: "s1", stage: "mastered" }],
      ),
      TOPIC,
    );
    expect(summary).toMatchObject({ topicMastered: true, failed: null });
  });

  it("hides a failed next batch while that batch is locked", async () => {
    const summary = await getFlashcardSummary(
      client(
        [
          { id: "b1", seq: 1, status: "ready", claimed_at: OLD, error_code: null },
          { id: "b2", seq: 2, status: "failed", claimed_at: NOW, error_code: "ai_timeout" },
        ],
        [{ batch_id: "b1", subtopic_id: "s1", stage: "learning" }],
      ),
      TOPIC,
    );
    expect(summary).toMatchObject({ current: { unlocked: false }, failed: null });
  });

  it("drops a non-retryable failure from an earlier day", async () => {
    const summary = await getFlashcardSummary(
      client([{ id: "b1", seq: 1, status: "failed", claimed_at: YESTERDAY, error_code: "quota_exceeded" }]),
      TOPIC,
    );
    expect(summary).toBeNull();
  });

  it("keeps a retryable failure from an earlier day", async () => {
    const summary = await getFlashcardSummary(
      client([{ id: "b1", seq: 1, status: "failed", claimed_at: YESTERDAY, error_code: "ai_timeout" }]),
      TOPIC,
    );
    expect(summary).toMatchObject({ failed: { seq: 1, error: { code: "ai_timeout" } } });
  });
});
