import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { TopicErrorCode } from "./errors";
import type { QuizRow } from "./quiz-task";
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

export interface QuizState {
  quiz: { id: string; total: number; answered: number; completedAt: string | null };
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

// The create_quiz / answer_quiz_question functions name the reason in the message.
function errorCode(error: PostgrestError): TopicErrorCode {
  if (error.code === "P0409") {
    if (error.message.includes("quiz_exists")) return "quiz_exists";
    if (error.message.includes("topic_not_confirmed")) return "topic_not_confirmed";
    if (error.message.includes("question_locked")) return "question_locked";
  }
  // eslint-disable-next-line no-console
  console.error("[topics] quiz database error", error);
  return "save_failed";
}

// Null when the topic has no quiz yet. Throws on database errors (see readQuizState in http.ts).
export async function getQuizState(supabase: SupabaseClient, topicId: string): Promise<QuizState | null> {
  const quizResult = await supabase
    .from("quizzes")
    .select("id, completed_at")
    .eq("topic_id", topicId)
    .maybeSingle<{ id: string; completed_at: string | null }>();
  if (quizResult.error) {
    throw new Error(`loading quiz failed: ${quizResult.error.message}`);
  }
  if (!quizResult.data) {
    return null;
  }
  const quiz = quizResult.data;

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
    quiz: { id: quiz.id, total: questions.length, answered, completedAt: quiz.completed_at },
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
