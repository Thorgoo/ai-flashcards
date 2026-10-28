import type { APIRoute } from "astro";
import { loadTopic, readStudySession, requireSession } from "@/lib/topics/http";

// The cards due today in the multiple-choice format; the client keeps the session's queue.
// Unlike the page, no topic/quiz/batch preconditions: without a ready batch the queue is empty.
export const GET: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  const state = await readStudySession(session.supabase, found.topic.id);
  if (state instanceof Response) return state;
  return Response.json({ data: state });
};
