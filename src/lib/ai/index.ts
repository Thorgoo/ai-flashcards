import type { SupabaseClient, User } from "@supabase/supabase-js";
import { AI_MODE, ANTHROPIC_API_KEY, SUPABASE_URL } from "astro:env/server";
import { callAi, type AiProvider, type AiRequest } from "./call";
import { aiError, logAiError, type AiResult } from "./errors";
import { createFakeProvider } from "./fake";
import { fakeFixtures } from "./fixtures";
import { createLiveProvider } from "./live";
import { resolveAiMode, type AiMode } from "./mode";
import { createSupabaseQuota } from "./quota";

export interface Ai {
  mode: AiMode;
  call<T>(request: AiRequest<T>): Promise<AiResult<T>>;
}

// The mode AI calls run in; an invalid configuration reads as live, as getAi answers it.
export function currentAiMode(): AiMode {
  const mode = resolveAiMode(AI_MODE, SUPABASE_URL);
  return mode === "invalid" ? "live" : mode;
}

// Entry point for every AI call in the app: wires the configured provider and the
// account's daily limit around callAi. Only the user's id is read, so the queue consumer
// (no session cookies) passes { id } from the job.
export function getAi(supabase: SupabaseClient, user: Pick<User, "id"> | null): Ai {
  const mode = resolveAiMode(AI_MODE, SUPABASE_URL);
  if (mode === "invalid") {
    logAiError(`AI_MODE=${AI_MODE} needs a local Supabase (localhost or 127.0.0.1)`);
    return { mode: "live", call: () => Promise.resolve(aiError("ai_not_configured")) };
  }
  // A missing key would fail every call after the daily limit is charged, with no log.
  if (mode === "live" && !ANTHROPIC_API_KEY) {
    logAiError("ANTHROPIC_API_KEY is not set");
    return { mode, call: () => Promise.resolve(aiError("ai_not_configured")) };
  }

  const provider: AiProvider =
    mode === "fake" ? createFakeProvider(fakeFixtures) : createLiveProvider({ apiKey: ANTHROPIC_API_KEY });
  const deps = { provider, quota: createSupabaseQuota(supabase), userId: user?.id ?? null };
  return { mode, call: (request) => callAi(deps, request) };
}

export { aiAcceptedResponse, aiResponse } from "./response";
export type { AiError, AiErrorCode, AiResult } from "./errors";
export type { AiKind, AiRequest } from "./call";
