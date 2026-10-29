import type { APIRoute } from "astro";
import { aiAcceptedResponse, currentAiMode } from "@/lib/ai";
import { topicErrorResponse } from "@/lib/topics/errors";
import { enqueueFlashcardJob } from "@/lib/topics/flashcard-generation";
import { claimNextFlashcardBatch, failFlashcardBatchClaim } from "@/lib/topics/flashcard-repository";
import { loadTopic, readFlashcardState, readJson, requireSession } from "@/lib/topics/http";
import { nextBatchInput } from "@/lib/topics/schemas";

// Starts flashcard batch `seq` (2 and later) for the subtopics not mastered yet, weakest first,
// without repeating earlier questions: claims it and queues the AI generation
// (src/lib/topics/flashcard-generation.ts), then answers 202 with the state (`generating` set).
export const POST: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const input = await readJson(context.request, nextBatchInput);
  if (input instanceof Response) return input;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;

  // All checks come before the AI call: every call uses up the daily limit. The claim
  // repeats them under a lock and refuses a generation already running elsewhere.
  const state = await readFlashcardState(session.supabase, found.topic.id);
  if (state instanceof Response) return state;
  const current = state?.current;
  if (!state || !current) return topicErrorResponse("next_batch_locked");
  // A retry after success asks for a batch that exists; that wins over the lock.
  if (input.seq <= current.seq) return topicErrorResponse("batch_exists");
  if (input.seq > current.seq + 1 || !current.unlocked) return topicErrorResponse("next_batch_locked");
  if (state.topicMastered) return topicErrorResponse("topic_mastered");
  if (state.generating) return topicErrorResponse("batch_generating");
  const claimed = await claimNextFlashcardBatch(session.supabase, found.topic.id, input.seq);
  if (!claimed.ok) return topicErrorResponse(claimed.code);

  const queued = await enqueueFlashcardJob(session.supabase, {
    kind: "next",
    topicId: found.topic.id,
    seq: input.seq,
    claimedAt: claimed.value,
    userId: session.user.id,
  });
  if (!queued.ok) {
    // Kept on the claim, so the page shows it also after a reload.
    await failFlashcardBatchClaim(session.supabase, found.topic.id, input.seq, claimed.value, queued.code);
    return topicErrorResponse(queued.code);
  }

  const next = await readFlashcardState(session.supabase, found.topic.id);
  if (next instanceof Response) return next;
  if (!next) return topicErrorResponse("save_failed");
  return aiAcceptedResponse(next, currentAiMode());
};
