import type { APIRoute } from "astro";
import { topicErrorResponse } from "@/lib/topics/errors";
import { loadTopic, readJson, readQuizState, requireSession } from "@/lib/topics/http";
import { answerQuestion } from "@/lib/topics/quiz-repository";
import { quizAnswerInput } from "@/lib/topics/schemas";

// Records the answer to the quiz's current question and returns the next state; the last
// answer returns the results and the review.
export const POST: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const input = await readJson(context.request, quizAnswerInput);
  if (input instanceof Response) return input;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;

  const state = await readQuizState(session.supabase, found.topic.id);
  if (state instanceof Response) return state;
  if (!state) return topicErrorResponse("not_found");
  // Questions are answered in order; anything else is already answered or not current.
  if (state.question?.id !== input.questionId) return topicErrorResponse("question_locked");

  const answered = await answerQuestion(
    session.supabase,
    input.questionId,
    input.answer === "dont_know" ? -1 : input.answer,
  );
  if (!answered.ok) return topicErrorResponse(answered.code);

  const next = await readQuizState(session.supabase, found.topic.id);
  if (next instanceof Response) return next;
  return next ? Response.json({ data: next }) : topicErrorResponse("save_failed");
};
