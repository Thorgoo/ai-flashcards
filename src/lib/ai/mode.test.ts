import { describe, expect, it } from "vitest";
import { resolveAiMode } from "./mode";

describe("resolveAiMode", () => {
  it("defaults to live", () => {
    expect(resolveAiMode(undefined, "https://abc.supabase.co")).toBe("live");
    expect(resolveAiMode("live", "https://abc.supabase.co")).toBe("live");
  });

  it("allows fake only with a local Supabase", () => {
    expect(resolveAiMode("fake", "http://127.0.0.1:54321")).toBe("fake");
    expect(resolveAiMode("fake", "http://localhost:54321")).toBe("fake");
    expect(resolveAiMode("fake", "https://pwpweophvhfbtrhfogpl.supabase.co")).toBe("invalid");
    expect(resolveAiMode("fake", undefined)).toBe("invalid");
  });

  it("does not mistake look-alike or malformed URLs for a local Supabase", () => {
    expect(resolveAiMode("fake", "http://LOCALHOST:54321")).toBe("fake");
    expect(resolveAiMode("fake", "http://localhost.evil.com")).toBe("invalid");
    expect(resolveAiMode("fake", "http://127.0.0.1@evil.com")).toBe("invalid");
    expect(resolveAiMode("fake", "not a url")).toBe("invalid");
  });
});
