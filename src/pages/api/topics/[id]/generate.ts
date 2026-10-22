import type { APIRoute } from "astro";
import { aiResponse, getAi } from "@/lib/ai";
import { topicErrorResponse } from "@/lib/topics/errors";
import { loadTopic, requireSession } from "@/lib/topics/http";
import { replaceSubtopics } from "@/lib/topics/repository";
import { buildSubtopicsRequest } from "@/lib/topics/subtopics-task";

// Generates (or regenerates) the whole subtopic list of a draft topic with AI.
export const POST: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  const { topic } = found;
  // Check the lock before calling AI: every call uses up the daily limit.
  if (topic.status !== "draft") return topicErrorResponse("topic_locked");

  const ai = getAi(session.supabase, session.user);
  const result = await ai.call(buildSubtopicsRequest(topic));
  if (!result.ok) return aiResponse(result, ai.mode);

  const saved = await replaceSubtopics(session.supabase, topic.id, result.data.subtopics);
  if (!saved.ok) return topicErrorResponse(saved.code);
  return aiResponse({ ok: true, data: { topic, subtopics: saved.value }, remaining: result.remaining }, ai.mode);
};
