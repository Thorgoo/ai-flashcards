import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { callAi, type AiQuota } from "@/lib/ai/call";
import { createFakeProvider, FakeAiFailure, type FakeFixture } from "@/lib/ai/fake";
import { fakeFixtures } from "@/lib/ai/fixtures";
import { enqueueFlashcardJob, flashcardJob, runFlashcardJob, type FlashcardJobDeps } from "./flashcard-job";
import { FLASHCARDS_TASK } from "./flashcards-task";

const TOPIC = "6f1c2a1e-8a0b-4c1d-9e2f-3a4b5c6d7e8f";
const CLAIMED_AT = "2026-10-29T12:00:00.123456+00:00";

const valid = {
  kind: "next",
  topicId: TOPIC,
  seq: 2,
  claimedAt: CLAIMED_AT,
  userId: "0b6c1f5a-2d3e-4f5a-8b9c-0d1e2f3a4b5c",
  accessToken: "token",
};

const firstJob = { ...valid, kind: "first", seq: 1 };

describe("flashcardJob", () => {
  it("accepts a valid message", () => {
    expect(flashcardJob.safeParse(valid).success).toBe(true);
    expect(flashcardJob.safeParse(firstJob).success).toBe(true);
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

interface Rpc {
  name: string;
  args: Record<string, unknown>;
}

// Answers the reads of a first-batch job (claim, topic with two subtopics, no quiz) from fixed
// rows and records every RPC.
function client(options: { claim?: { status: string; claimed_at: string } | null; topicFails?: boolean } = {}) {
  const tables: Record<string, unknown> = {
    flashcard_batches: options.claim === undefined ? { status: "generating", claimed_at: CLAIMED_AT } : options.claim,
    topics: {
      id: TOPIC,
      name: "Fotosynteza",
      scope_note: null,
      status: "confirmed",
      created_at: CLAIMED_AT,
      confirmed_at: CLAIMED_AT,
    },
    subtopics: [
      { id: "00000000-0000-0000-0000-0000000000b1", name: "Światło", content_type: "conceptual", position: 0 },
      { id: "00000000-0000-0000-0000-0000000000b2", name: "Chlorofil", content_type: "conceptual", position: 1 },
    ],
    quizzes: null,
  };
  const rpcs: Rpc[] = [];
  const supabase = {
    from: (table: string) => {
      const result = () =>
        Promise.resolve(
          table === "topics" && options.topicFails
            ? { data: null, error: { message: "db down" } }
            : { data: tables[table], error: null },
        );
      const query = { select: () => query, eq: () => query, order: result, maybeSingle: result };
      return query;
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
  return { supabase, rpcs };
}

// The AI wired as getAi wires it, on the fake provider and an unlimited in-memory quota.
function deps(supabase: SupabaseClient, fixture: FakeFixture = fakeFixtures[FLASHCARDS_TASK]) {
  let aiCalls = 0;
  const quota: AiQuota = {
    begin: () => Promise.resolve({ callId: String(aiCalls++), remaining: 19 }),
    finish: () => Promise.resolve(),
  };
  const provider = createFakeProvider({ [FLASHCARDS_TASK]: fixture });
  const jobDeps: FlashcardJobDeps = {
    createClient: () => supabase,
    getAi: (_, user) => ({ call: (request) => callAi({ provider, quota, userId: user.id }, request) }),
  };
  return { jobDeps, aiCalls: () => aiCalls };
}

describe("runFlashcardJob", () => {
  it("saves the batch under the job's claim token", async () => {
    const { supabase, rpcs } = client();
    const { jobDeps, aiCalls } = deps(supabase);
    await runFlashcardJob(jobDeps, firstJob);

    expect(aiCalls()).toBe(1);
    expect(rpcs.map((rpc) => rpc.name)).toEqual(["create_flashcard_batch"]);
    expect(rpcs[0]?.args).toMatchObject({ p_topic_id: TOPIC, p_claimed_at: CLAIMED_AT });
    expect(rpcs[0]?.args.p_cards).toHaveLength(10);
  });

  it.each([
    ["no longer generating", { status: "ready", claimed_at: CLAIMED_AT }],
    ["taken over by another token", { status: "generating", claimed_at: "2026-10-29T12:05:00+00:00" }],
    ["gone", null],
  ])("does nothing when the claim is %s", async (_, claim) => {
    const { supabase, rpcs } = client({ claim });
    const { jobDeps, aiCalls } = deps(supabase);
    await runFlashcardJob(jobDeps, firstJob);

    expect(aiCalls()).toBe(0);
    expect(rpcs).toHaveLength(0);
  });

  it("stores the AI error code on the claim", async () => {
    const { supabase, rpcs } = client();
    const { jobDeps } = deps(supabase, () => {
      throw new FakeAiFailure("ai_timeout");
    });
    await runFlashcardJob(jobDeps, firstJob);

    expect(rpcs).toEqual([
      {
        name: "fail_flashcard_batch_claim",
        args: { p_topic_id: TOPIC, p_seq: 1, p_claimed_at: CLAIMED_AT, p_error_code: "ai_timeout" },
      },
    ]);
  });

  it("stores save_failed on the claim after an unexpected error and resolves", async () => {
    const { supabase, rpcs } = client({ topicFails: true });
    const { jobDeps, aiCalls } = deps(supabase);
    await expect(runFlashcardJob(jobDeps, firstJob)).resolves.toBeUndefined();

    expect(aiCalls()).toBe(0);
    expect(rpcs).toEqual([
      {
        name: "fail_flashcard_batch_claim",
        args: { p_topic_id: TOPIC, p_seq: 1, p_claimed_at: CLAIMED_AT, p_error_code: "save_failed" },
      },
    ]);
  });

  it("ignores an invalid message", async () => {
    const { supabase, rpcs } = client();
    let clients = 0;
    const { jobDeps, aiCalls } = deps(supabase);
    await runFlashcardJob(
      {
        ...jobDeps,
        createClient: () => {
          clients++;
          return supabase;
        },
      },
      { ...firstJob, accessToken: "" },
    );

    expect(clients).toBe(0);
    expect(aiCalls()).toBe(0);
    expect(rpcs).toHaveLength(0);
  });
});

describe("enqueueFlashcardJob", () => {
  const job = { kind: "first" as const, topicId: TOPIC, seq: 1, claimedAt: CLAIMED_AT, userId: valid.userId };

  function auth(expiresInSeconds: number) {
    let refreshes = 0;
    const session = (token: string) =>
      ({ access_token: token, expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds }) as Session;
    const supabase = {
      auth: {
        getSession: () => Promise.resolve({ data: { session: session("old") }, error: null }),
        refreshSession: () => {
          refreshes++;
          return Promise.resolve({ data: { session: session("new") }, error: null });
        },
      },
    } as unknown as SupabaseClient;
    return { supabase, refreshes: () => refreshes };
  }

  it("forwards a token that outlives the job", async () => {
    const { supabase, refreshes } = auth(3600);
    const sent: unknown[] = [];
    const result = await enqueueFlashcardJob(
      { send: (message) => Promise.resolve(void sent.push(message)) },
      supabase,
      job,
    );

    expect(result).toEqual({ ok: true, value: null });
    expect(refreshes()).toBe(0);
    expect(sent).toEqual([{ ...job, accessToken: "old" }]);
  });

  it("refreshes a token expiring within 5 minutes", async () => {
    const { supabase, refreshes } = auth(60);
    const sent: unknown[] = [];
    await enqueueFlashcardJob({ send: (message) => Promise.resolve(void sent.push(message)) }, supabase, job);

    expect(refreshes()).toBe(1);
    expect(sent).toEqual([{ ...job, accessToken: "new" }]);
  });

  it("answers save_failed when the queue refuses the message", async () => {
    const { supabase } = auth(3600);
    const result = await enqueueFlashcardJob({ send: () => Promise.reject(new Error("queue down")) }, supabase, job);

    expect(result).toEqual({ ok: false, code: "save_failed" });
  });
});
