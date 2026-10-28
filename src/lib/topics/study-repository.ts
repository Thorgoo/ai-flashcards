import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { TopicErrorCode } from "./errors";
import {
  CARD_COLUMNS,
  toFlashcardView,
  type CardRow,
  type FlashcardView,
  type SubtopicRow,
} from "./flashcard-repository";
import type { RepoResult } from "./repository";
import { warsawToday } from "./study-day";

// The cards due in the multiple-choice format today, in study order. The queue itself is the
// client's (study-queue.ts): a wrong card comes back in the same session.
export interface StudySession {
  cards: FlashcardView[];
  // Cards already answered correctly, waiting for the open format.
  waitingOpen: number;
  today: string;
}

export interface ChoiceResult {
  correct: boolean;
  correctIndex: number;
  stage: "choice" | "open";
}

interface ChoiceRow {
  correct: boolean;
  correct_index: number | null;
  stage: "choice" | "open" | null;
  due_on: string | null;
}

type StudyCardRow = CardRow & { due_on: string };

const P0409_REASONS: TopicErrorCode[] = ["flashcard_not_found", "card_not_due"];

// answer_flashcard_choice names the reason in the hint (migration flashcard_study_state).
function errorCode(error: PostgrestError): TopicErrorCode {
  const reason = P0409_REASONS.find((code) => code === error.hint);
  if (error.code === "P0409" && reason) return reason;
  if (error.code === "P0422") return "validation_failed";
  // eslint-disable-next-line no-console
  console.error("[topics] study database error", error);
  return "save_failed";
}

// Cards of every batch of the topic in the 'choice' stage and due by today, oldest due first,
// then in subtopic list order and generation order. Throws on database errors (see
// readStudySession in http.ts).
export async function getStudySession(supabase: SupabaseClient, topicId: string): Promise<StudySession> {
  const today = warsawToday();
  const [cardsResult, waitingResult, subtopicsResult] = await Promise.all([
    supabase
      .from("flashcards")
      .select(`${CARD_COLUMNS}, due_on`)
      .eq("topic_id", topicId)
      .eq("stage", "choice")
      .lte("due_on", today),
    supabase
      .from("flashcards")
      .select("id", { count: "exact", head: true })
      .eq("topic_id", topicId)
      .eq("stage", "open"),
    supabase.from("subtopics").select("id, name, content_type, position").eq("topic_id", topicId),
  ]);
  if (cardsResult.error) {
    throw new Error(`loading due flashcards failed: ${cardsResult.error.message}`);
  }
  if (waitingResult.error) {
    throw new Error(`counting open flashcards failed: ${waitingResult.error.message}`);
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
    cards: cards.map((card) => toFlashcardView(card, subtopics.get(card.subtopic_id))),
    waitingOpen: waitingResult.count ?? 0,
    today,
  };
}

// The number of cards due in the multiple-choice format today. Throws on database errors.
export async function countDueCards(supabase: SupabaseClient, topicId: string): Promise<number> {
  const { count, error } = await supabase
    .from("flashcards")
    .select("id", { count: "exact", head: true })
    .eq("topic_id", topicId)
    .eq("stage", "choice")
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
  return { ok: true, value: { correct: row.correct, correctIndex: row.correct_index, stage: row.stage } };
}
