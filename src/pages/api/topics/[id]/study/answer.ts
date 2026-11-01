import type { APIRoute } from "astro";
import { aiResponse, getAi } from "@/lib/ai";
import { topicErrorResponse } from "@/lib/topics/errors";
import { buildGradingRequest } from "@/lib/topics/grading-task";
import { loadTopic, readJson, requireSession } from "@/lib/topics/http";
import { studyAnswerInput } from "@/lib/topics/schemas";
import {
  answerFlashcardChoice,
  answerFlashcardOpen,
  findTopicFlashcard,
  readOpenAttempt,
} from "@/lib/topics/study-repository";

// Records one answer and returns its result: A/B/C/D (`choice`) or the user's own words
// graded by AI (`open`). Unlike other mutations it does not return the full state: the queue
// is the client's, since a wrong A/B/C/D card comes back in the same session. Every result,
// a replayed attempt's too, carries `badges`: the ones the database awarded to this attempt.
export const POST: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const input = await readJson(context.request, studyAnswerInput);
  if (input instanceof Response) return input;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;

  if (input.format === "choice") {
    // The function checks only the owner; a card of another topic is not found on this route.
    const inTopic = await findTopicFlashcard(session.supabase, found.topic.id, input.cardId);
    if (!inTopic.ok) return topicErrorResponse(inTopic.code);

    const result = await answerFlashcardChoice(session.supabase, input.cardId, input.answer, input.attemptId);
    return result.ok ? Response.json({ data: result.value }) : topicErrorResponse(result.code);
  }

  // All checks come before the AI call: every grading uses up the daily limit. A retried
  // attempt returns its stored result without grading again.
  const preflight = await readOpenAttempt(session.supabase, found.topic.id, input.cardId, input.attemptId);
  if (!preflight.ok) return topicErrorResponse(preflight.code);
  if (preflight.value.kind === "replay") return Response.json({ data: preflight.value.result });

  // BREAK-CHECK (reverted): save before grading.
  await answerFlashcardOpen(session.supabase, input.cardId, input.attemptId, input.answerText, {
    correct: false,
    feedback: "break-check",
  });
  const ai = getAi(session.supabase, session.user);
  const grading = await ai.call(buildGradingRequest(preflight.value.card, input.answerText));
  if (!grading.ok) return aiResponse(grading, ai.mode);

  // A failed save after a successful grading is rare; the user's retry grades again.
  const saved = await answerFlashcardOpen(
    session.supabase,
    input.cardId,
    input.attemptId,
    input.answerText,
    grading.data,
  );
  if (!saved.ok) return topicErrorResponse(saved.code);
  return aiResponse({ ok: true, data: saved.value, remaining: grading.remaining }, ai.mode);
};
