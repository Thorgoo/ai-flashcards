import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "cloudflare:workers";
import { getAi } from "@/lib/ai";
import { createTokenClient } from "@/lib/supabase";
import * as core from "./flashcard-job";
import type { RepoResult } from "./repository";

// The runtime wiring of @flashcard-job.ts (the logic and its tests live there): the Workers
// queue binding, the configured AI and a Supabase client acting as the job's user.
const deps: core.FlashcardJobDeps & core.FlashcardQueueDeps = {
  createClient: createTokenClient,
  getAi,
  send: (job) => env.FLASHCARD_JOBS.send(job),
};

export function enqueueFlashcardJob(
  supabase: SupabaseClient,
  job: Omit<core.FlashcardJob, "accessToken">,
): Promise<RepoResult<null>> {
  return core.enqueueFlashcardJob(deps, supabase, job);
}

export function runFlashcardJob(body: unknown): Promise<void> {
  return core.runFlashcardJob(deps, body);
}
