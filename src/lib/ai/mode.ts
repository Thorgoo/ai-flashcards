export type AiMode = "live" | "fake";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

// Fake responses are only allowed against a local Supabase, so a misconfigured
// deployment can never serve canned AI output to real accounts.
export function resolveAiMode(mode: string | undefined, supabaseUrl: string | undefined): AiMode | "invalid" {
  if (mode === undefined || mode === "live") {
    return "live";
  }
  if (mode !== "fake") {
    return "invalid";
  }
  try {
    return supabaseUrl !== undefined && LOCAL_HOSTS.has(new URL(supabaseUrl).hostname) ? "fake" : "invalid";
  } catch {
    return "invalid";
  }
}
