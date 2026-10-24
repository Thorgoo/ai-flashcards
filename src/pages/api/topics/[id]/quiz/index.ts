import type { APIRoute } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { aiResponse, getAi } from "@/lib/ai";
import { topicErrorResponse } from "@/lib/topics/errors";
import { loadTopic, readQuizState, requireSession } from "@/lib/topics/http";
import { claimQuiz, createQuiz, releaseQuizClaim } from "@/lib/topics/quiz-repository";
import { buildQuizRequest, toQuizRows } from "@/lib/topics/quiz-task";
import type { TopicWithSubtopics } from "@/lib/topics/repository";

// The topic's quiz state (data: null without a quiz); the quiz page polls it while generating.
export const GET: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  const state = await readQuizState(session.supabase, found.topic.id);
  if (state instanceof Response) return state;
  return Response.json({ data: state });
};

// Generates the topic's diagnostic quiz with AI. A topic gets exactly one quiz.
export const POST: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  // Both checks come before the AI call: every call uses up the daily limit. The claim
  // also refuses a generation already running in another request or tab.
  if (found.topic.status !== "confirmed") return topicErrorResponse("topic_not_confirmed");
  const claimed = await claimQuiz(session.supabase, found.topic.id);
  if (!claimed.ok) return topicErrorResponse(claimed.code);

  // A reload or a closed tab cancels the request; waitUntil lets the paid-for generation
  // finish and be saved, and the reloaded page polls GET until it is ready.
  const work = generateQuiz(session.supabase, session.user, found);
  // The adapter types cfContext as ExecutionContext, which this project's types do not
  // include; it is absent outside the Workers runtime.
  const cf = context.locals.cfContext as { waitUntil(promise: Promise<unknown>): void } | undefined;
  cf?.waitUntil(work);
  return await work;
};

async function generateQuiz(supabase: SupabaseClient, user: User, found: TopicWithSubtopics): Promise<Response> {
  const { topic, subtopics } = found;
  const ai = getAi(supabase, user);
  const result = await ai.call(buildQuizRequest(topic, subtopics));
  if (!result.ok) {
    await releaseQuizClaim(supabase, topic.id);
    return aiResponse(result, ai.mode);
  }

  const created = await createQuiz(supabase, topic.id, toQuizRows(result.data, subtopics));
  if (!created.ok) {
    await releaseQuizClaim(supabase, topic.id);
    return topicErrorResponse(created.code);
  }

  const state = await readQuizState(supabase, topic.id);
  if (state instanceof Response) return state;
  if (!state) return topicErrorResponse("save_failed");
  return aiResponse({ ok: true, data: state, remaining: result.remaining }, ai.mode);
}
