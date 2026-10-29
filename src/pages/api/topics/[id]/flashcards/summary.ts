import type { APIRoute } from "astro";
import { loadTopic, readFlashcardSummary, requireSession } from "@/lib/topics/http";

// The topic's flashcard state without the cards' text (data: null without a batch); the
// flashcards page polls it while AI generates and then reads GET /flashcards once.
export const GET: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  const summary = await readFlashcardSummary(session.supabase, found.topic.id);
  if (summary instanceof Response) return summary;
  return Response.json({ data: summary });
};
