import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { EarnedBadge } from "@/lib/badges/catalog";
import { getAttemptBadges } from "@/lib/badges/repository";
import type { TopicErrorCode } from "./errors";
import {
  CARD_COLUMNS,
  toFlashcardView,
  type CardRow,
  type FlashcardView,
  type SubtopicRow,
} from "./flashcard-repository";
import type { RepoResult } from "./repository";
import type { ContentType } from "./schemas";
import { warsawToday } from "./study-day";

// A due card with its format: "choice" (A/B/C/D) or "open" (own words, graded by AI), and
// for the open format how many correct answers in a row it has (two make it mastered).
export type StudyCard = FlashcardView & { stage: "choice" | "open"; openStreak: 0 | 1 };

// The cards due today in both formats, in study order. The queue itself is the client's
// (study-queue.ts): a wrong A/B/C/D card comes back in the same session.
export interface StudySession {
  cards: StudyCard[];
  today: string;
}

export interface ChoiceResult {
  correct: boolean;
  correctIndex: number;
  stage: "choice" | "open";
  // The badges this answer earned (the same on a retry of the attempt); empty when none.
  badges: EarnedBadge[];
}

export interface OpenResult {
  correct: boolean;
  // The AI's one-sentence justification.
  feedback: string;
  stage: "open" | "mastered";
  openStreak: 0 | 1;
  // As in ChoiceResult.
  badges: EarnedBadge[];
}

// What the open-answer endpoint does before any AI call: return a stored result (a retried
// attempt), or grade the answer against this card.
export type OpenPreflight =
  | { kind: "replay"; result: OpenResult }
  | { kind: "grade"; card: { front: string; answer: string; explanation: string; contentType: ContentType } };

interface OpenRow {
  correct: boolean;
  feedback: string;
  stage: "open" | "mastered" | null;
  open_streak: 0 | 1 | null;
}

interface ChoiceRow {
  correct: boolean;
  correct_index: number | null;
  stage: "choice" | "open" | null;
  due_on: string | null;
}

type StudyCardRow = CardRow & { due_on: string; stage: "choice" | "open"; open_streak: 0 | 1 };

// The stages a study session shows; a mastered card never comes back.
const STUDY_STAGES = ["choice", "open"];

const P0409_REASONS: TopicErrorCode[] = ["flashcard_not_found", "card_not_due", "attempt_conflict"];

// answer_flashcard_choice and answer_flashcard_open name the reason in the hint.
function errorCode(error: PostgrestError): TopicErrorCode {
  const reason = P0409_REASONS.find((code) => code === error.hint);
  if (error.code === "P0409" && reason) return reason;
  if (error.code === "P0422") return "validation_failed";
  // eslint-disable-next-line no-console
  console.error("[topics] study database error", error);
  return "save_failed";
}

// The badges the database awarded to the attempt (sync_badges, from the answer trigger), read
// after every save and replay. A failed read is save_failed: the answer is stored, and the
// client's retry of the same attempt replays it.
async function attemptBadges(supabase: SupabaseClient, attemptId: string): Promise<RepoResult<EarnedBadge[]>> {
  try {
    return { ok: true, value: await getAttemptBadges(supabase, attemptId) };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[topics] reading attempt badges failed", error);
    return { ok: false, code: "save_failed" };
  }
}

// Cards of every batch of the topic in the 'choice' or 'open' stage and due by today, oldest
// due first, then in subtopic list order and generation order. Throws on database errors (see
// readStudySession in http.ts).
export async function getStudySession(supabase: SupabaseClient, topicId: string): Promise<StudySession> {
  const today = warsawToday();
  const [cardsResult, subtopicsResult] = await Promise.all([
    supabase
      .from("flashcards")
      .select(`${CARD_COLUMNS}, due_on, stage, open_streak`)
      .eq("topic_id", topicId)
      .in("stage", STUDY_STAGES)
      .lte("due_on", today),
    supabase.from("subtopics").select("id, name, content_type, position").eq("topic_id", topicId),
  ]);
  if (cardsResult.error) {
    throw new Error(`loading due flashcards failed: ${cardsResult.error.message}`);
  }
  if (subtopicsResult.error) {
    throw new Error(`loading subtopics failed: ${subtopicsResult.error.message}`);
  }
  const subtopics = new Map((subtopicsResult.data as SubtopicRow[]).map((row) => [row.id, row]));
  const subtopicPosition = (id: string) => subtopics.get(id)?.position ?? Number.MAX_SAFE_INTEGER;

  // due_on is YYYY-MM-DD, so it sorts as a string.
  const cards = (cardsResult.data as unknown as StudyCardRow[]).sort(
    (a, b) =>
      a.due_on.localeCompare(b.due_on) ||
      subtopicPosition(a.subtopic_id) - subtopicPosition(b.subtopic_id) ||
      a.position - b.position,
  );
  return {
    cards: cards.map((card) => ({
      ...toFlashcardView(card, subtopics.get(card.subtopic_id)),
      stage: card.stage,
      openStreak: card.open_streak,
    })),
    today,
  };
}

// The number of cards due today in both formats. Throws on database errors.
export async function countDueCards(supabase: SupabaseClient, topicId: string): Promise<number> {
  const { count, error } = await supabase
    .from("flashcards")
    .select("id", { count: "exact", head: true })
    .eq("topic_id", topicId)
    .in("stage", STUDY_STAGES)
    .lte("due_on", warsawToday());
  if (error) {
    throw new Error(`counting due flashcards failed: ${error.message}`);
  }
  return count ?? 0;
}

// Whether the card belongs to the topic. RLS hides other accounts' cards, so they read as not found.
export async function findTopicFlashcard(
  supabase: SupabaseClient,
  topicId: string,
  cardId: string,
): Promise<RepoResult<null>> {
  const { data, error } = await supabase
    .from("flashcards")
    .select("id")
    .eq("id", cardId)
    .eq("topic_id", topicId)
    .maybeSingle();
  if (error) {
    return { ok: false, code: errorCode(error) };
  }
  return data ? { ok: true, value: null } : { ok: false, code: "flashcard_not_found" };
}

// Records the A/B/C/D answer `answer` (0-3) and applies the transition (answer_flashcard_choice).
// A retry with the same attemptId returns the stored result and changes nothing.
export async function answerFlashcardChoice(
  supabase: SupabaseClient,
  cardId: string,
  answer: number,
  attemptId: string,
): Promise<RepoResult<ChoiceResult>> {
  const result = await supabase.rpc("answer_flashcard_choice", {
    p_flashcard_id: cardId,
    p_answer: answer,
    p_attempt_id: attemptId,
  });
  if (result.error) {
    return { ok: false, code: errorCode(result.error) };
  }
  const row = result.data as ChoiceRow;
  // A replayed attempt whose card was deleted since has no card state left.
  if (row.correct_index === null || row.stage === null) {
    return { ok: false, code: "flashcard_not_found" };
  }
  const badges = await attemptBadges(supabase, attemptId);
  if (!badges.ok) return badges;
  return {
    ok: true,
    value: { correct: row.correct, correctIndex: row.correct_index, stage: row.stage, badges: badges.value },
  };
}

interface OpenCardRow {
  subtopic_id: string;
  front: string;
  answer: string;
  explanation: string;
  stage: "choice" | "open" | "mastered";
  open_streak: 0 | 1;
  due_on: string;
}

// The open-answer checks that must pass before the AI call (every call uses up the daily
// grading limit), read as the user through RLS. A stored attempt is returned as it is, so a
// retry after a lost response costs no second grading. answer_flashcard_open repeats every
// check under a lock; this read only keeps doomed requests away from the AI.
export async function readOpenAttempt(
  supabase: SupabaseClient,
  topicId: string,
  cardId: string,
  attemptId: string,
): Promise<RepoResult<OpenPreflight>> {
  const [attemptResult, cardResult] = await Promise.all([
    supabase
      .from("flashcard_answers")
      .select("flashcard_id, format, correct, feedback")
      .eq("id", attemptId)
      .maybeSingle<{ flashcard_id: string | null; format: string; correct: boolean; feedback: string | null }>(),
    supabase
      .from("flashcards")
      .select("subtopic_id, front, answer, explanation, stage, open_streak, due_on")
      .eq("id", cardId)
      .eq("topic_id", topicId)
      .maybeSingle<OpenCardRow>(),
  ]);
  if (attemptResult.error) return { ok: false, code: errorCode(attemptResult.error) };
  if (cardResult.error) return { ok: false, code: errorCode(cardResult.error) };
  const attempt = attemptResult.data;
  const card = cardResult.data;

  // Same order as the function: an attempt of another card or of the other format conflicts.
  if (attempt && ((attempt.flashcard_id !== null && attempt.flashcard_id !== cardId) || attempt.format !== "open")) {
    return { ok: false, code: "attempt_conflict" };
  }
  // Also a replay whose card was deleted since: no card state left, as in answerFlashcardChoice.
  if (!card) return { ok: false, code: "flashcard_not_found" };
  if (attempt) {
    // An open answer always has feedback and leaves the card open or mastered (the checks).
    if (card.stage === "choice" || attempt.feedback === null) return { ok: false, code: "attempt_conflict" };
    const badges = await attemptBadges(supabase, attemptId);
    if (!badges.ok) return badges;
    const result: OpenResult = {
      correct: attempt.correct,
      feedback: attempt.feedback,
      stage: card.stage,
      openStreak: card.open_streak,
      badges: badges.value,
    };
    return { ok: true, value: { kind: "replay", result } };
  }
  if (card.stage !== "open" || card.due_on > warsawToday()) return { ok: false, code: "card_not_due" };

  const subtopic = await supabase
    .from("subtopics")
    .select("content_type")
    .eq("id", card.subtopic_id)
    .maybeSingle<{ content_type: ContentType }>();
  if (subtopic.error) return { ok: false, code: errorCode(subtopic.error) };
  return {
    ok: true,
    value: {
      kind: "grade",
      card: {
        front: card.front,
        answer: card.answer,
        explanation: card.explanation,
        contentType: subtopic.data?.content_type ?? "conceptual",
      },
    },
  };
}

// Records the graded open answer and applies the transition (answer_flashcard_open). The
// verdict comes from the AI via this server; the function trusts it (see the migration).
// A retry with the same attemptId returns the stored result and changes nothing.
export async function answerFlashcardOpen(
  supabase: SupabaseClient,
  cardId: string,
  attemptId: string,
  answerText: string,
  grading: { correct: boolean; feedback: string },
): Promise<RepoResult<OpenResult>> {
  const result = await supabase.rpc("answer_flashcard_open", {
    p_flashcard_id: cardId,
    p_attempt_id: attemptId,
    p_answer_text: answerText,
    p_correct: grading.correct,
    p_feedback: grading.feedback,
  });
  if (result.error) {
    return { ok: false, code: errorCode(result.error) };
  }
  const row = result.data as OpenRow;
  // A replayed attempt whose card was deleted since has no card state left.
  if (row.stage === null || row.open_streak === null) {
    return { ok: false, code: "flashcard_not_found" };
  }
  const badges = await attemptBadges(supabase, attemptId);
  if (!badges.ok) return badges;
  return {
    ok: true,
    value: {
      correct: row.correct,
      feedback: row.feedback,
      stage: row.stage,
      openStreak: row.open_streak,
      badges: badges.value,
    },
  };
}
