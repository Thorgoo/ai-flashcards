import type { APIRoute } from "astro";
import { topicErrorResponse } from "@/lib/topics/errors";
import { loadTopic, readJson, requireSession } from "@/lib/topics/http";
import { studyAnswerInput } from "@/lib/topics/schemas";
import { answerFlashcardChoice, findTopicFlashcard } from "@/lib/topics/study-repository";

// Records one A/B/C/D answer and returns its result. Unlike other mutations it does not
// return the full state: the queue is the client's, since a wrong card comes back in the
// same session.
export const POST: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const input = await readJson(context.request, studyAnswerInput);
  if (input instanceof Response) return input;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  // The function checks only the owner; a card of another topic is not found on this route.
  const inTopic = await findTopicFlashcard(session.supabase, found.topic.id, input.cardId);
  if (!inTopic.ok) return topicErrorResponse(inTopic.code);

  const result = await answerFlashcardChoice(session.supabase, input.cardId, input.answer, input.attemptId);
  return result.ok ? Response.json({ data: result.value }) : topicErrorResponse(result.code);
};
