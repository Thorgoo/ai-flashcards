import type { APIRoute } from "astro";
import { topicErrorResponse } from "@/lib/topics/errors";
import { loadTopic, requireSession, topicState } from "@/lib/topics/http";
import { confirmTopic } from "@/lib/topics/repository";

// Confirms the subtopic list; after this it can never change.
export const POST: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  if (found.topic.status !== "draft") return topicErrorResponse("topic_locked");

  const confirmed = await confirmTopic(session.supabase, found.topic.id);
  if (!confirmed.ok) return topicErrorResponse(confirmed.code);
  return topicState(session.supabase, found.topic.id);
};
