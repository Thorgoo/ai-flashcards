import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AiQuotaExceeded, callAi, type AiCallOutcome, type AiProvider, type AiQuota, type AiRequest } from "./call";
import { createFakeProvider, FakeAiFailure, type FakeFixture } from "./fake";

const schema = z.object({ answer: z.string() });

const request: AiRequest<z.infer<typeof schema>> = {
  kind: "generation",
  task: "probe",
  system: "system",
  prompt: "prompt",
  schema,
  maxTokens: 100,
};

function memoryQuota(options: { limit?: number; finishFails?: boolean } = {}) {
  const limit = options.limit ?? 20;
  const calls: { kind: string; outcome?: AiCallOutcome }[] = [];
  const quota: AiQuota = {
    begin(kind) {
      if (calls.length >= limit) {
        return Promise.reject(new AiQuotaExceeded());
      }
      calls.push({ kind });
      return Promise.resolve({ callId: String(calls.length - 1), remaining: limit - calls.length });
    },
    finish(callId, outcome) {
      if (options.finishFails) {
        return Promise.reject(new Error("db down"));
      }
      const call = calls.at(Number(callId));
      if (call) call.outcome = outcome;
      return Promise.resolve();
    },
  };
  return { quota, calls };
}

function fake(fixture: FakeFixture) {
  return createFakeProvider({ probe: fixture });
}

describe("callAi", () => {
  it("returns validated data and the remaining limit", async () => {
    const { quota, calls } = memoryQuota();
    const result = await callAi({ provider: fake(() => ({ answer: "42" })), quota, userId: "a" }, request);

    expect(result).toEqual({ ok: true, data: { answer: "42" }, remaining: 19 });
    expect(calls[0]?.outcome?.status).toBe("ok");
  });

  it("refuses an anonymous caller without touching the limit", async () => {
    const { quota, calls } = memoryQuota();
    const result = await callAi({ provider: fake(() => ({ answer: "42" })), quota, userId: null }, request);

    expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated", retryable: false } });
    expect(calls).toHaveLength(0);
  });

  it("does not call the provider when the daily limit is used up", async () => {
    const { quota } = memoryQuota({ limit: 0 });
    let providerCalls = 0;
    const provider: AiProvider = {
      complete() {
        providerCalls++;
        return Promise.resolve({ output: { answer: "42" }, stopReason: "end_turn" });
      },
    };
    const result = await callAi({ provider, quota, userId: "a" }, request);

    expect(result).toMatchObject({ ok: false, error: { code: "quota_exceeded", retryable: false } });
    expect(providerCalls).toBe(0);
  });

  it("treats output cut off by max_tokens as invalid even if it parses", async () => {
    const { quota, calls } = memoryQuota();
    const provider: AiProvider = {
      complete: () => Promise.resolve({ output: { answer: "42" }, stopReason: "max_tokens" }),
    };
    const result = await callAi({ provider, quota, userId: "a" }, request);

    expect(result).toMatchObject({ ok: false, error: { code: "ai_invalid_output", retryable: true } });
    expect(calls[0]?.outcome).toMatchObject({ status: "failed", errorCode: "ai_invalid_output" });
  });

  it("rejects output of the wrong shape", async () => {
    const { quota } = memoryQuota();
    const result = await callAi({ provider: fake(() => ({ answer: 42 })), quota, userId: "a" }, request);

    expect(result).toMatchObject({ ok: false, error: { code: "ai_invalid_output" } });
  });

  it("passes provider errors through as retryable and still counts the call", async () => {
    const { quota, calls } = memoryQuota();
    const provider = fake(() => {
      throw new FakeAiFailure("ai_timeout");
    });
    const result = await callAi({ provider, quota, userId: "a" }, request);

    expect(result).toMatchObject({ ok: false, error: { code: "ai_timeout", retryable: true } });
    expect(calls[0]?.outcome).toMatchObject({ status: "failed", errorCode: "ai_timeout" });
  });

  it("keeps a successful result when recording the outcome fails", async () => {
    const { quota } = memoryQuota({ finishFails: true });
    const result = await callAi({ provider: fake(() => ({ answer: "42" })), quota, userId: "a" }, request);

    expect(result).toMatchObject({ ok: true, data: { answer: "42" } });
  });

  it("sends the provider a JSON schema derived from the zod schema", async () => {
    const { quota } = memoryQuota();
    let sent: Record<string, unknown> | undefined;
    const provider: AiProvider = {
      complete(providerRequest) {
        sent = providerRequest.jsonSchema;
        return Promise.resolve({ output: { answer: "42" }, stopReason: "end_turn" });
      },
    };
    await callAi({ provider, quota, userId: "a" }, request);

    expect(sent).toMatchObject({ type: "object", properties: { answer: { type: "string" } } });
  });
});
