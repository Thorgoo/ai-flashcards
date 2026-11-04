import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getQuizState } from "./quiz-repository";

const TOPIC = "00000000-0000-0000-0000-0000000000a1";
const CLAIMED_AT = "2026-11-04T12:00:00.000Z";

// Answers the quiz read of getQuizState with a claim that has no questions yet.
function client(): SupabaseClient {
  const row = { id: "q1", status: "generating", claimed_at: CLAIMED_AT, completed_at: null };
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
    }),
  } as unknown as SupabaseClient;
}

describe("getQuizState claim expiry", () => {
  beforeEach(() => {
    // Only the clock is fake, so the client's promises still resolve.
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a claim 89 s old as a quiz being generated", async () => {
    vi.setSystemTime(Date.parse(CLAIMED_AT) + 89_000);
    expect(await getQuizState(client(), TOPIC)).toEqual({
      quiz: { id: "q1", status: "generating", total: 0, answered: 0, completedAt: null },
      question: null,
      results: null,
      review: null,
    });
  });

  it("reads a claim 91 s old as no quiz", async () => {
    vi.setSystemTime(Date.parse(CLAIMED_AT) + 91_000);
    expect(await getQuizState(client(), TOPIC)).toBeNull();
  });
});
