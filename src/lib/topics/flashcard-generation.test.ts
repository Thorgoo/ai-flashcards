import { describe, expect, it, vi } from "vitest";

// The module queues through the Workers runtime and reads astro:env; neither exists in Node.
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("astro:env/server", () => ({}));

const { flashcardJob } = await import("./flashcard-generation");

const valid = {
  kind: "next",
  topicId: "6f1c2a1e-8a0b-4c1d-9e2f-3a4b5c6d7e8f",
  seq: 2,
  claimedAt: "2026-10-29T12:00:00.123456+00:00",
  userId: "0b6c1f5a-2d3e-4f5a-8b9c-0d1e2f3a4b5c",
  accessToken: "token",
};

describe("flashcardJob", () => {
  it("accepts a valid message", () => {
    expect(flashcardJob.safeParse(valid).success).toBe(true);
    expect(flashcardJob.safeParse({ ...valid, kind: "first", seq: 1 }).success).toBe(true);
  });

  it("rejects a message without the access token", () => {
    const { accessToken: _, ...rest } = valid;
    expect(flashcardJob.safeParse(rest).success).toBe(false);
    expect(flashcardJob.safeParse({ ...valid, accessToken: "" }).success).toBe(false);
  });

  it("rejects a malformed topic or user id", () => {
    expect(flashcardJob.safeParse({ ...valid, topicId: "not-a-uuid" }).success).toBe(false);
    expect(flashcardJob.safeParse({ ...valid, userId: "1" }).success).toBe(false);
  });

  it("rejects batch number 0 and an unknown kind", () => {
    expect(flashcardJob.safeParse({ ...valid, seq: 0 }).success).toBe(false);
    expect(flashcardJob.safeParse({ ...valid, kind: "other" }).success).toBe(false);
  });
});
