import type { APIRoute } from "astro";
import { aiResponse, getAi } from "@/lib/ai";
import { topicErrorResponse } from "@/lib/topics/errors";
import { loadTopic, readQuizState, requireSession } from "@/lib/topics/http";
import { createQuiz } from "@/lib/topics/quiz-repository";
import { buildQuizRequest, toQuizRows } from "@/lib/topics/quiz-task";

// Generates the topic's diagnostic quiz with AI. A topic gets exactly one quiz.
export const POST: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  const { topic, subtopics } = found;
  // Both checks come before the AI call: every call uses up the daily limit.
  if (topic.status !== "confirmed") return topicErrorResponse("topic_not_confirmed");
  const existing = await readQuizState(session.supabase, topic.id);
  if (existing instanceof Response) return existing;
  if (existing) return topicErrorResponse("quiz_exists");

  const ai = getAi(session.supabase, session.user);
  const result = await ai.call(buildQuizRequest(topic, subtopics));
  if (!result.ok) return aiResponse(result, ai.mode);

  const created = await createQuiz(session.supabase, topic.id, toQuizRows(result.data, subtopics));
  if (!created.ok) return topicErrorResponse(created.code);

  const state = await readQuizState(session.supabase, topic.id);
  if (state instanceof Response) return state;
  if (!state) return topicErrorResponse("save_failed");
  return aiResponse({ ok: true, data: state, remaining: result.remaining }, ai.mode);
};
