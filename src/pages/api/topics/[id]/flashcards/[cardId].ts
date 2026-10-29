import type { APIRoute } from "astro";
import { topicErrorResponse } from "@/lib/topics/errors";
import { deleteFlashcard } from "@/lib/topics/flashcard-repository";
import { loadTopic, readFlashcardState, requireSession } from "@/lib/topics/http";
import { isUuid } from "@/lib/topics/schemas";

// Deletes a flashcard for good and returns the topic's full flashcard state.
export const DELETE: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  const cardId = context.params.cardId;
  if (!isUuid(cardId)) return topicErrorResponse("flashcard_not_found");

  const deleted = await deleteFlashcard(session.supabase, found.topic.id, cardId);
  if (!deleted.ok) return topicErrorResponse(deleted.code);

  const state = await readFlashcardState(session.supabase, found.topic.id);
  if (state instanceof Response) return state;
  return Response.json({ data: state });
};
