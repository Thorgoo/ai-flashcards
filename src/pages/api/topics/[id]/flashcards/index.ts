import type { APIRoute } from "astro";
import { aiAcceptedResponse, currentAiMode } from "@/lib/ai";
import { topicErrorResponse } from "@/lib/topics/errors";
import { enqueueFlashcardJob } from "@/lib/topics/flashcard-generation";
import { claimFlashcardBatch, failFlashcardBatchClaim } from "@/lib/topics/flashcard-repository";
import { loadTopic, readFlashcardState, readQuizState, requireSession } from "@/lib/topics/http";

// The topic's flashcard batches (data: null without a batch, a claim or a failure); the page
// reads it once a generation ends.
export const GET: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  const state = await readFlashcardState(session.supabase, found.topic.id);
  if (state instanceof Response) return state;
  return Response.json({ data: state });
};

// Starts the topic's first batch of 10 flashcards, weighted by the quiz results: claims it and
// queues the AI generation (src/lib/topics/flashcard-generation.ts), then answers 202 with the
// state (`generating` set). The page polls until the batch is ready or failed, also after a reload.
export const POST: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  // All checks come before the AI call: every call uses up the daily limit. The claim
  // repeats them under a lock and refuses a generation already running elsewhere.
  if (found.topic.status !== "confirmed") return topicErrorResponse("topic_not_confirmed");
  const quiz = await readQuizState(session.supabase, found.topic.id);
  if (quiz instanceof Response) return quiz;
  if (!quiz?.quiz.completedAt) return topicErrorResponse("quiz_not_completed");
  const claimed = await claimFlashcardBatch(session.supabase, found.topic.id);
  if (!claimed.ok) return topicErrorResponse(claimed.code);

  const queued = await enqueueFlashcardJob(session.supabase, {
    kind: "first",
    topicId: found.topic.id,
    seq: 1,
    claimedAt: claimed.value,
    userId: session.user.id,
  });
  if (!queued.ok) {
    // Kept on the claim, so the page shows it also after a reload.
    await failFlashcardBatchClaim(session.supabase, found.topic.id, 1, claimed.value, queued.code);
    return topicErrorResponse(queued.code);
  }

  const state = await readFlashcardState(session.supabase, found.topic.id);
  if (state instanceof Response) return state;
  if (!state) return topicErrorResponse("save_failed");
  return aiAcceptedResponse(state, currentAiMode());
};
