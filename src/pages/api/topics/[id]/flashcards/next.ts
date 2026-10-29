import type { APIRoute } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { aiResponse, getAi } from "@/lib/ai";
import { topicErrorResponse } from "@/lib/topics/errors";
import {
  claimNextFlashcardBatch,
  createNextFlashcardBatch,
  releaseNextFlashcardBatchClaim,
  type FlashcardState,
} from "@/lib/topics/flashcard-repository";
import { buildNextFlashcardsRequest, toFlashcardRows } from "@/lib/topics/flashcards-task";
import { loadTopic, readFlashcardState, readJson, readQuizState, requireSession } from "@/lib/topics/http";
import { nextBatchSubtopics } from "@/lib/topics/mastery";
import type { QuizState } from "@/lib/topics/quiz-repository";
import type { TopicWithSubtopics } from "@/lib/topics/repository";
import { nextBatchInput } from "@/lib/topics/schemas";

// Generates flashcard batch `seq` (2 and later) with AI for the subtopics not mastered yet,
// weakest first, without repeating earlier questions.
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
  const quiz = await readQuizState(session.supabase, found.topic.id);
  if (quiz instanceof Response) return quiz;
  const claimed = await claimNextFlashcardBatch(session.supabase, found.topic.id, input.seq);
  if (!claimed.ok) return topicErrorResponse(claimed.code);

  // As POST /flashcards: waitUntil lets the paid-for generation finish and be saved after a
  // reload or a closed tab, and the reloaded page polls GET /flashcards until it is ready.
  const work = generateNextBatch(session.supabase, session.user, found, state, quiz, input.seq, claimed.value);
  // The adapter types cfContext as ExecutionContext, which this project's types do not
  // include; it is absent outside the Workers runtime.
  const cf = context.locals.cfContext as { waitUntil(promise: Promise<unknown>): void } | undefined;
  cf?.waitUntil(work);
  return await work;
};

async function generateNextBatch(
  supabase: SupabaseClient,
  user: User,
  found: TopicWithSubtopics,
  state: FlashcardState,
  quiz: QuizState | null,
  seq: number,
  claimedAt: string,
): Promise<Response> {
  const { topic } = found;
  // The quiz result only breaks ties between equal mastery; none counts as 0%.
  const quizPercents = new Map((quiz?.results ?? []).map((row) => [row.subtopicId, row.percent]));
  const subtopics = nextBatchSubtopics(state.subtopics, quizPercents);
  // Batches are newest first, so each subtopic's questions are too.
  const existingFronts = new Map<string, string[]>();
  for (const card of state.batches.flatMap((batch) => batch.cards)) {
    const fronts = existingFronts.get(card.subtopicId);
    if (fronts) fronts.push(card.front);
    else existingFronts.set(card.subtopicId, [card.front]);
  }

  const ai = getAi(supabase, user);
  const result = await ai.call(buildNextFlashcardsRequest(topic, subtopics, existingFronts, seq));
  if (!result.ok) {
    await releaseNextFlashcardBatchClaim(supabase, topic.id, seq, claimedAt);
    return aiResponse(result, ai.mode);
  }

  const rows = toFlashcardRows(result.data, subtopics);
  const created = await createNextFlashcardBatch(supabase, topic.id, seq, rows, claimedAt);
  if (!created.ok) {
    await releaseNextFlashcardBatchClaim(supabase, topic.id, seq, claimedAt);
    return topicErrorResponse(created.code);
  }

  const next = await readFlashcardState(supabase, topic.id);
  if (next instanceof Response) return next;
  if (!next) return topicErrorResponse("save_failed");
  return aiResponse({ ok: true, data: next, remaining: result.remaining }, ai.mode);
}
