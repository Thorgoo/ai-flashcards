import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";
import { callAi, type AiQuota } from "@/lib/ai/call";
import { createFakeProvider, type FakeFixture } from "@/lib/ai/fake";
import { fakeFixtures } from "@/lib/ai/fixtures";
import { buildSubtopicsRequest, SUBTOPICS_TASK, subtopicsSchema } from "./subtopics-task";

const quota: AiQuota = {
  begin: () => Promise.resolve({ callId: "1", remaining: 19 }),
  finish: () => Promise.resolve(),
};

function items(count: number) {
  return Array.from({ length: count }, (_, i) => ({ name: `Podtemat ${i + 1}`, contentType: "conceptual" }));
}

describe("subtopicsSchema", () => {
  it("accepts 4 to 8 subtopics", () => {
    expect(subtopicsSchema.safeParse({ subtopics: items(4) }).success).toBe(true);
    expect(subtopicsSchema.safeParse({ subtopics: items(8) }).success).toBe(true);
  });

  it("rejects fewer than 4 or more than 8 subtopics", () => {
    expect(subtopicsSchema.safeParse({ subtopics: items(3) }).success).toBe(false);
    expect(subtopicsSchema.safeParse({ subtopics: items(9) }).success).toBe(false);
  });

  it("rejects duplicate names, ignoring case", () => {
    const list = [...items(3), { name: "podtemat 1", contentType: "vocabulary" }];
    expect(subtopicsSchema.safeParse({ subtopics: list }).success).toBe(false);
  });

  it("rejects an unknown content type", () => {
    const list = [...items(3), { name: "Inny", contentType: "poem" }];
    expect(subtopicsSchema.safeParse({ subtopics: list }).success).toBe(false);
  });

  it("converts to a JSON schema the provider accepts", () => {
    expect(() => zodOutputFormat(subtopicsSchema)).not.toThrow();
  });
});

describe("subtopics task on the fake provider", () => {
  const request = buildSubtopicsRequest({ name: "angielski", scopeNote: "słówka podróżnicze" });

  it("returns a valid list with both content types for a language topic", async () => {
    const result = await callAi({ provider: createFakeProvider(fakeFixtures), quota, userId: "a" }, request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.subtopics).toHaveLength(5);
    expect(new Set(result.data.subtopics.map((s) => s.contentType))).toEqual(new Set(["conceptual", "vocabulary"]));
    expect(result.data.subtopics[0]?.name).toContain("angielski");
  });

  it("puts the topic and note in the prompt as data", () => {
    expect(request.prompt).toBe("<temat>angielski</temat>\n<notatka>słówka podróżnicze</notatka>");
    expect(buildSubtopicsRequest({ name: "Spring", scopeNote: null }).prompt).toContain("<notatka>brak</notatka>");
  });

  it("treats a list of the wrong size as invalid output", async () => {
    const tooShort: FakeFixture = () => ({ subtopics: items(2) });
    const provider = createFakeProvider({ [SUBTOPICS_TASK]: tooShort });
    const result = await callAi({ provider, quota, userId: "a" }, request);

    expect(result).toMatchObject({ ok: false, error: { code: "ai_invalid_output", retryable: true } });
  });
});
