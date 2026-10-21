import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callAi, type AiQuota } from "./call";
import { createLiveProvider } from "./live";

// Real call to the Anthropic API — skipped unless AI_LIVE_TEST=1 and ANTHROPIC_API_KEY are set.
const enabled = process.env.AI_LIVE_TEST === "1" && Boolean(process.env.ANTHROPIC_API_KEY);

const unlimited: AiQuota = {
  begin: () => Promise.resolve({ callId: "live-test", remaining: 1 }),
  finish: () => Promise.resolve(),
};

describe.skipIf(!enabled)("live Anthropic call", () => {
  it("returns schema-valid structured output", { timeout: 90_000 }, async () => {
    const schema = z.object({ capital: z.string(), country: z.string() });
    const started = Date.now();
    const result = await callAi(
      {
        provider: createLiveProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
        quota: unlimited,
        userId: "live-test",
      },
      {
        kind: "generation",
        task: "live-test",
        system: "Answer with the requested JSON only.",
        prompt: "What is the capital of Poland?",
        schema,
        maxTokens: 200,
      },
    );
    // eslint-disable-next-line no-console
    console.log(`live call took ${Date.now() - started} ms`, result);

    expect(result.ok).toBe(true);
  });
});
