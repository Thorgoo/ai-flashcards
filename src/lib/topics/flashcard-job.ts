import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Ai } from "@/lib/ai";
import {
  createFlashcardBatch,
  createNextFlashcardBatch,
  failFlashcardBatchClaim,
  getFlashcardBatchClaim,
  getFlashcardState,
} from "./flashcard-repository";
import {
  buildFlashcardsRequest,
  buildNextFlashcardsRequest,
  toFlashcardRows,
  type FlashcardSubtopic,
} from "./flashcards-task";
import { nextBatchSubtopics } from "./mastery";
import { getQuizState } from "./quiz-repository";
import { getTopic, type RepoResult } from "./repository";
import { isUuid } from "./schemas";

// A flashcard generation running in the queue consumer (src/worker.ts). The claim token
// (claimedAt) is the job's identity: create_* refuses a claim taken over in the meantime.
export const flashcardJob = z.object({
  kind: z.enum(["first", "next"]),
  topicId: z.string().refine(isUuid, { message: "topicId must be a uuid" }),
  seq: z.number().int().min(1),
  claimedAt: z.string().min(1),
  userId: z.string().refine(isUuid, { message: "userId must be a uuid" }),
  // The user's Supabase access token: every RPC in the flow reads the user from auth.uid().
  accessToken: z.string().min(1),
});

export type FlashcardJob = z.infer<typeof flashcardJob>;

// The runtime pieces of a job, passed in so the logic runs without the Workers runtime or
// astro:env; @flashcard-generation.ts wires the real ones, tests pass fakes.
export interface FlashcardJobDeps {
  // A client acting as the job's user; null without Supabase configuration.
  createClient(accessToken: string): SupabaseClient | null;
  getAi(supabase: SupabaseClient, user: { id: string }): Pick<Ai, "call">;
}

export interface FlashcardQueueDeps {
  send(job: FlashcardJob): Promise<void>;
}

// The token must outlive queue latency plus the AI call (90 s timeout).
const TOKEN_MIN_LIFETIME_MS = 5 * 60 * 1000;

function logJobError(message: string, detail?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[topics] ${message}`, detail ?? "");
}

// A failure the page will never show (the claim just expires): one fixed tag to search for in
// Workers Logs (context/foundation/infrastructure.md).
function logUnmarked(message: string, detail?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[flashcard-job:unmarked] ${message}`, detail ?? "");
}

// Queues the generation of a claimed batch with the user's access token (refreshed when it
// expires within 5 minutes). On failure the caller marks the claim failed with the code.
export async function enqueueFlashcardJob(
  deps: FlashcardQueueDeps,
  supabase: SupabaseClient,
  job: Omit<FlashcardJob, "accessToken">,
): Promise<RepoResult<null>> {
  try {
    let session = (await supabase.auth.getSession()).data.session;
    if (session && (session.expires_at ?? 0) * 1000 - Date.now() < TOKEN_MIN_LIFETIME_MS) {
      const refreshed = await supabase.auth.refreshSession();
      if (refreshed.error) logJobError("refreshing the session for a flashcard job failed", refreshed.error);
      session = refreshed.data.session;
    }
    if (!session) {
      logJobError("no session to forward to a flashcard job");
      return { ok: false, code: "save_failed" };
    }
    await deps.send(flashcardJob.parse({ ...job, accessToken: session.access_token }));
    return { ok: true, value: null };
  } catch (error) {
    logJobError("queueing a flashcard job failed", error);
    return { ok: false, code: "save_failed" };
  }
}

// The queue consumer's work for one message: AI call and save as the user. Never throws — with
// max_retries 0 a thrown error would drop the message and leave the claim to expire silently;
// every failure is stored on the claim instead (failFlashcardBatchClaim), so the page shows it.
export async function runFlashcardJob(deps: FlashcardJobDeps, body: unknown): Promise<void> {
  const parsed = flashcardJob.safeParse(body);
  if (!parsed.success) {
    logJobError("invalid flashcard job", parsed.error.issues);
    return;
  }
  const job = parsed.data;
  const supabase = deps.createClient(job.accessToken);
  if (!supabase) {
    logUnmarked("flashcard job without Supabase configuration; its claim expires");
    return;
  }

  let code: string | null;
  try {
    code = await generate(deps, supabase, job);
  } catch (error) {
    logJobError("flashcard job failed", error);
    code = "save_failed";
  }
  if (code === null) return;
  try {
    // A rejected token (401) cannot mark the claim either (the RPC needs auth.uid()); the RPC
    // error is logged and the claim expires after FLASHCARD_CLAIM_TTL_SECONDS, as before.
    const marked = await failFlashcardBatchClaim(supabase, job.topicId, job.seq, job.claimedAt, code);
    if (!marked) logUnmarked(`flashcard job failed with ${code}; its claim expires`);
  } catch (error) {
    logUnmarked(`marking a flashcard job failed with ${code}; its claim expires`, error);
  }
}

// The generation of one job; the error code to store on the claim, or null when the batch was
// saved or the job no longer owns the claim.
async function generate(deps: FlashcardJobDeps, supabase: SupabaseClient, job: FlashcardJob): Promise<string | null> {
  // Taken over, saved, failed or gone: no AI call, so no generation is used up.
  const claim = await getFlashcardBatchClaim(supabase, job.topicId, job.seq);
  if (claim?.status !== "generating" || Date.parse(claim.claimedAt) !== Date.parse(job.claimedAt)) {
    return null;
  }

  const [found, quiz] = await Promise.all([getTopic(supabase, job.topicId), getQuizState(supabase, job.topicId)]);
  if (!found) return "not_found";
  const quizPercents = new Map((quiz?.results ?? []).map((row) => [row.subtopicId, row.percent]));

  let subtopics: FlashcardSubtopic[];
  let request;
  if (job.kind === "first") {
    // Subtopics come in list order; one without a quiz result counts as 0%.
    subtopics = found.subtopics.map((subtopic) => ({
      id: subtopic.id,
      name: subtopic.name,
      contentType: subtopic.contentType,
      percent: quizPercents.get(subtopic.id) ?? 0,
    }));
    request = buildFlashcardsRequest(found.topic, subtopics);
  } else {
    const state = await getFlashcardState(supabase, job.topicId);
    if (!state) return "save_failed";
    // The quiz result only breaks ties between equal mastery; none counts as 0%.
    subtopics = nextBatchSubtopics(state.subtopics, quizPercents);
    // Batches are newest first, so each subtopic's questions start with the newest batch
    // (within a batch, in the order the cards were generated).
    const existingFronts = new Map<string, string[]>();
    for (const card of state.batches.flatMap((batch) => batch.cards)) {
      const fronts = existingFronts.get(card.subtopicId);
      if (fronts) fronts.push(card.front);
      else existingFronts.set(card.subtopicId, [card.front]);
    }
    request = buildNextFlashcardsRequest(found.topic, subtopics, existingFronts, job.seq);
  }

  const result = await deps.getAi(supabase, { id: job.userId }).call(request);
  if (!result.ok) return result.error.code;

  const rows = toFlashcardRows(result.data, subtopics);
  const created =
    job.kind === "first"
      ? await createFlashcardBatch(supabase, job.topicId, rows, job.claimedAt)
      : await createNextFlashcardBatch(supabase, job.topicId, job.seq, rows, job.claimedAt);
  // batch_not_claimed: the claim was taken over; fail_flashcard_batch_claim leaves it as it is.
  return created.ok ? null : created.code;
}
