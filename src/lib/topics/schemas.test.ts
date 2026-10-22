import { describe, expect, it } from "vitest";
import { addSubtopicInput, createTopicInput, updateSubtopicInput } from "./schemas";

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
