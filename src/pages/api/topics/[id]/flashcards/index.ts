import type { APIRoute } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { aiResponse, getAi } from "@/lib/ai";
import { topicErrorResponse } from "@/lib/topics/errors";
import {
  claimFlashcardBatch,
  createFlashcardBatch,
  releaseFlashcardBatchClaim,
} from "@/lib/topics/flashcard-repository";
import { buildFlashcardsRequest, toFlashcardRows, type FlashcardSubtopic } from "@/lib/topics/flashcards-task";
import { loadTopic, readFlashcardState, readQuizState, requireSession } from "@/lib/topics/http";
import type { QuizState } from "@/lib/topics/quiz-repository";
import type { TopicWithSubtopics } from "@/lib/topics/repository";

// The topic's first flashcard batch (data: null without one); the page polls it while generating.
export const GET: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  const state = await readFlashcardState(session.supabase, found.topic.id);
  if (state instanceof Response) return state;
  return Response.json({ data: state });
};

// Generates the topic's first batch of 10 flashcards with AI, weighted by the quiz results.
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

  // A reload or a closed tab cancels the request; waitUntil lets the paid-for generation
  // finish and be saved, and the reloaded page polls GET until it is ready.
  const work = generateFlashcards(session.supabase, session.user, found, quiz);
  // The adapter types cfContext as ExecutionContext, which this project's types do not
  // include; it is absent outside the Workers runtime.
  const cf = context.locals.cfContext as { waitUntil(promise: Promise<unknown>): void } | undefined;
  cf?.waitUntil(work);
  return await work;
};

async function generateFlashcards(
  supabase: SupabaseClient,
  user: User,
  found: TopicWithSubtopics,
  quiz: QuizState,
): Promise<Response> {
  const { topic } = found;
  // Subtopics come in list order; one without a quiz result counts as 0%.
  const percents = new Map((quiz.results ?? []).map((row) => [row.subtopicId, row.percent]));
  const subtopics: FlashcardSubtopic[] = found.subtopics.map((subtopic) => ({
    id: subtopic.id,
    name: subtopic.name,
    contentType: subtopic.contentType,
    percent: percents.get(subtopic.id) ?? 0,
  }));

  const ai = getAi(supabase, user);
  const result = await ai.call(buildFlashcardsRequest(topic, subtopics));
  if (!result.ok) {
    await releaseFlashcardBatchClaim(supabase, topic.id);
    return aiResponse(result, ai.mode);
  }

  const created = await createFlashcardBatch(supabase, topic.id, toFlashcardRows(result.data, subtopics));
  if (!created.ok) {
    await releaseFlashcardBatchClaim(supabase, topic.id);
    return topicErrorResponse(created.code);
  }

  const state = await readFlashcardState(supabase, topic.id);
  if (state instanceof Response) return state;
  if (!state) return topicErrorResponse("save_failed");
  return aiResponse({ ok: true, data: state, remaining: result.remaining }, ai.mode);
}
