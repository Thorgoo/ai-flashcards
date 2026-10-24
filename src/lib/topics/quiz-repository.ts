import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { TopicErrorCode } from "./errors";
import { QUIZ_CLAIM_TTL_SECONDS, type QuizRow } from "./quiz-task";
import type { RepoResult } from "./repository";
import type { ContentType } from "./schemas";

// The current question never carries its correct answer: the client sees it only in
// `review`, once the quiz is completed.
export interface QuizQuestionView {
  id: string;
  position: number;
  prompt: string;
  options: string[];
  subtopicName: string;
}

export interface QuizSubtopicResult {
  subtopicId: string;
  name: string;
  contentType: ContentType;
  asked: number;
  correct: number;
  dontKnow: number;
  percent: number;
}

export interface QuizReviewItem {
  position: number;
  prompt: string;
  options: string[];
  subtopicName: string;
  // -1 is "I don't know".
  answer: number;
  correctIndex: number;
}

// "generating": the quiz is claimed and its AI call is still running; it has no questions yet.
export interface QuizState {
  quiz: { id: string; status: "generating" | "ready"; total: number; answered: number; completedAt: string | null };
  question: QuizQuestionView | null;
  results: QuizSubtopicResult[] | null;
  review: QuizReviewItem[] | null;
}

interface QuestionRow {
  id: string;
  position: number;
  prompt: string;
  options: string[];
  answer: number | null;
  correct_index: number;
  subtopic_id: string;
}

interface ResultRow {
  subtopic_id: string;
  name: string;
  content_type: ContentType;
  asked: number;
  correct: number;
  dont_know: number;
}

const P0409_REASONS: TopicErrorCode[] = ["topic_not_confirmed", "quiz_exists", "quiz_generating", "question_locked"];

// The quiz functions share P0409 and name the reason in the hint (migration quiz_generation_claim).
function errorCode(error: PostgrestError): TopicErrorCode {
  const reason = P0409_REASONS.find((code) => code === error.hint);
  if (error.code === "P0409" && reason) return reason;
  // eslint-disable-next-line no-console
  console.error("[topics] quiz database error", error);
  return "save_failed";
}

// Null when the topic has no quiz yet. Throws on database errors (see readQuizState in http.ts).
export async function getQuizState(supabase: SupabaseClient, topicId: string): Promise<QuizState | null> {
  const quizResult = await supabase
    .from("quizzes")
    .select("id, status, claimed_at, completed_at")
    .eq("topic_id", topicId)
    .maybeSingle<{ id: string; status: "generating" | "ready"; claimed_at: string; completed_at: string | null }>();
  if (quizResult.error) {
    throw new Error(`loading quiz failed: ${quizResult.error.message}`);
  }
  if (!quizResult.data) {
    return null;
  }
  const quiz = quizResult.data;
  if (quiz.status === "generating") {
    // An abandoned claim reads as no quiz: the next start takes it over.
    if (Date.now() - Date.parse(quiz.claimed_at) > QUIZ_CLAIM_TTL_SECONDS * 1000) return null;
    return {
      quiz: { id: quiz.id, status: "generating", total: 0, answered: 0, completedAt: null },
      question: null,
      results: null,
      review: null,
    };
  }

  const [questionsResult, subtopicsResult] = await Promise.all([
    supabase
      .from("quiz_questions")
      .select("id, position, prompt, options, answer, correct_index, subtopic_id")
      .eq("quiz_id", quiz.id)
      .order("position"),
    supabase.from("subtopics").select("id, name").eq("topic_id", topicId),
  ]);
  if (questionsResult.error) {
    throw new Error(`loading quiz questions failed: ${questionsResult.error.message}`);
  }
  if (subtopicsResult.error) {
    throw new Error(`loading subtopics failed: ${subtopicsResult.error.message}`);
  }
  const questions = questionsResult.data as QuestionRow[];
  const names = new Map((subtopicsResult.data as { id: string; name: string }[]).map((row) => [row.id, row.name]));
  const subtopicName = (id: string) => names.get(id) ?? "";

  const answered = questions.filter((question) => question.answer !== null).length;
  const state: QuizState = {
    quiz: { id: quiz.id, status: "ready", total: questions.length, answered, completedAt: quiz.completed_at },
    question: null,
    results: null,
    review: null,
  };

  if (quiz.completed_at === null) {
    const next = questions.find((question) => question.answer === null);
    state.question = next
      ? {
          id: next.id,
          position: next.position,
          prompt: next.prompt,
          options: next.options,
          subtopicName: subtopicName(next.subtopic_id),
        }
      : null;
    return state;
  }

  const resultsResult = await supabase.rpc("quiz_results", { p_quiz_id: quiz.id });
  if (resultsResult.error) {
    throw new Error(`loading quiz results failed: ${resultsResult.error.message}`);
  }
  state.results = (resultsResult.data as ResultRow[]).map((row) => ({
    subtopicId: row.subtopic_id,
    name: row.name,
    contentType: row.content_type,
    asked: row.asked,
    correct: row.correct,
    dontKnow: row.dont_know,
    percent: row.asked === 0 ? 0 : Math.round((100 * row.correct) / row.asked),
  }));
  state.review = questions.map((question) => ({
    position: question.position,
    prompt: question.prompt,
    options: question.options,
    subtopicName: subtopicName(question.subtopic_id),
    answer: question.answer ?? -1,
    correctIndex: question.correct_index,
  }));
  return state;
}

// Reserves the topic's quiz before the AI call: refuses a second quiz and a generation
// already running in another request (claim_quiz).
export async function claimQuiz(supabase: SupabaseClient, topicId: string): Promise<RepoResult<null>> {
  const { error } = await supabase.rpc("claim_quiz", { p_topic_id: topicId });
  return error ? { ok: false, code: errorCode(error) } : { ok: true, value: null };
}

// Drops an unfinished claim after a failed AI call or save, so the quiz can start again.
export async function releaseQuizClaim(supabase: SupabaseClient, topicId: string): Promise<void> {
  const { error } = await supabase.rpc("release_quiz_claim", { p_topic_id: topicId });
  if (error) {
    // The claim expires on its own (QUIZ_CLAIM_TTL_SECONDS); the original error matters more.
    // eslint-disable-next-line no-console
    console.error("[topics] releasing quiz claim failed", error);
  }
}

// Atomic: the quiz and all 10 questions are saved, or nothing is (create_quiz).
export async function createQuiz(
  supabase: SupabaseClient,
  topicId: string,
  rows: QuizRow[],
): Promise<RepoResult<null>> {
  const { error } = await supabase.rpc("create_quiz", { p_topic_id: topicId, p_questions: rows });
  return error ? { ok: false, code: errorCode(error) } : { ok: true, value: null };
}

// `answer` is 0-3, or -1 for "I don't know". Answers are final.
export async function answerQuestion(
  supabase: SupabaseClient,
  questionId: string,
  answer: number,
): Promise<RepoResult<null>> {
  const { error } = await supabase.rpc("answer_quiz_question", { p_question_id: questionId, p_answer: answer });
  return error ? { ok: false, code: errorCode(error) } : { ok: true, value: null };
}
