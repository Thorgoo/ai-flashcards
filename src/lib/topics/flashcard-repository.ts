import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { TopicErrorCode } from "./errors";
import { FLASHCARD_CLAIM_TTL_SECONDS, type FlashcardRow } from "./flashcards-task";
import type { RepoResult } from "./repository";
import type { ContentType } from "./schemas";

export interface FlashcardView {
  id: string;
  subtopicId: string;
  subtopicName: string;
  contentType: ContentType;
  front: string;
  answer: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  // Example sentence of a vocabulary card; null for conceptual cards.
  example: string | null;
}

// "generating": batch 1 is claimed and its AI call is still running; it has no cards yet.
export interface FlashcardState {
  batch: { id: string; status: "generating" | "ready" };
  cards: FlashcardView[];
}

// Shared with study-repository.ts, which reads the same cards for the study session.
export const CARD_COLUMNS = "id, subtopic_id, position, front, answer, options, correct_index, explanation, example";

export interface CardRow {
  id: string;
  subtopic_id: string;
  position: number;
  front: string;
  answer: string;
  options: string[];
  correct_index: number;
  explanation: string;
  example: string | null;
}

export interface SubtopicRow {
  id: string;
  name: string;
  content_type: ContentType;
  position: number;
}

export function toFlashcardView(card: CardRow, subtopic: SubtopicRow | undefined): FlashcardView {
  return {
    id: card.id,
    subtopicId: card.subtopic_id,
    subtopicName: subtopic?.name ?? "",
    contentType: subtopic?.content_type ?? "conceptual",
    front: card.front,
    answer: card.answer,
    options: card.options,
    correctIndex: card.correct_index,
    explanation: card.explanation,
    example: card.example,
  };
}

const P0409_REASONS: TopicErrorCode[] = [
  "topic_not_confirmed",
  "quiz_not_completed",
  "batch_exists",
  "batch_generating",
];

// The flashcard functions share P0409 and name the reason in the hint (migration create_flashcards).
function errorCode(error: PostgrestError): TopicErrorCode {
  const reason = P0409_REASONS.find((code) => code === error.hint);
  if (error.code === "P0409" && reason) return reason;
  // eslint-disable-next-line no-console
  console.error("[topics] flashcards database error", error);
  return "save_failed";
}

// The topic's first batch, or null without one. Throws on database errors (see
// readFlashcardState in http.ts).
export async function getFlashcardState(supabase: SupabaseClient, topicId: string): Promise<FlashcardState | null> {
  const batchResult = await supabase
    .from("flashcard_batches")
    .select("id, status, claimed_at")
    .eq("topic_id", topicId)
    .eq("seq", 1)
    .maybeSingle<{ id: string; status: "generating" | "ready"; claimed_at: string }>();
  if (batchResult.error) {
    throw new Error(`loading flashcard batch failed: ${batchResult.error.message}`);
  }
  if (!batchResult.data) {
    return null;
  }
  const batch = batchResult.data;
  if (batch.status === "generating") {
    // An abandoned claim reads as no batch: the next start takes it over.
    if (Date.now() - Date.parse(batch.claimed_at) > FLASHCARD_CLAIM_TTL_SECONDS * 1000) return null;
    return { batch: { id: batch.id, status: "generating" }, cards: [] };
  }

  const [cardsResult, subtopicsResult] = await Promise.all([
    supabase.from("flashcards").select(CARD_COLUMNS).eq("batch_id", batch.id),
    supabase.from("subtopics").select("id, name, content_type, position").eq("topic_id", topicId),
  ]);
  if (cardsResult.error) {
    throw new Error(`loading flashcards failed: ${cardsResult.error.message}`);
  }
  if (subtopicsResult.error) {
    throw new Error(`loading subtopics failed: ${subtopicsResult.error.message}`);
  }
  const subtopics = new Map((subtopicsResult.data as SubtopicRow[]).map((row) => [row.id, row]));
  const subtopicPosition = (id: string) => subtopics.get(id)?.position ?? Number.MAX_SAFE_INTEGER;

  // Grouped by subtopic in list order, then in the order the cards were generated.
  const cards = (cardsResult.data as CardRow[]).sort(
    (a, b) => subtopicPosition(a.subtopic_id) - subtopicPosition(b.subtopic_id) || a.position - b.position,
  );
  return {
    batch: { id: batch.id, status: "ready" },
    cards: cards.map((card) => toFlashcardView(card, subtopics.get(card.subtopic_id))),
  };
}

// Reserves the topic's first batch before the AI call: refuses a second batch and a
// generation already running in another request (claim_flashcard_batch). The value is the
// claim's token: release and create pass it back, so they never touch a taken-over claim.
export async function claimFlashcardBatch(supabase: SupabaseClient, topicId: string): Promise<RepoResult<string>> {
  const claim = await supabase.rpc("claim_flashcard_batch", { p_topic_id: topicId });
  return claim.error ? { ok: false, code: errorCode(claim.error) } : { ok: true, value: claim.data as string };
}

// Drops an unfinished claim after a failed AI call or save, so the batch can start again.
export async function releaseFlashcardBatchClaim(
  supabase: SupabaseClient,
  topicId: string,
  claimedAt: string,
): Promise<void> {
  const { error } = await supabase.rpc("release_flashcard_batch_claim", {
    p_topic_id: topicId,
    p_claimed_at: claimedAt,
  });
  if (error) {
    // The claim expires on its own (FLASHCARD_CLAIM_TTL_SECONDS); the original error matters more.
    // eslint-disable-next-line no-console
    console.error("[topics] releasing flashcard claim failed", error);
  }
}

// Atomic: the batch is marked ready with all 10 cards, or nothing is saved (create_flashcard_batch).
export async function createFlashcardBatch(
  supabase: SupabaseClient,
  topicId: string,
  rows: FlashcardRow[],
  claimedAt: string,
): Promise<RepoResult<null>> {
  const { error } = await supabase.rpc("create_flashcard_batch", {
    p_topic_id: topicId,
    p_cards: rows,
    p_claimed_at: claimedAt,
  });
  return error ? { ok: false, code: errorCode(error) } : { ok: true, value: null };
}

// Deletes a card for good (FR-012). RLS hides other accounts' cards, so they read as not found.
export async function deleteFlashcard(
  supabase: SupabaseClient,
  topicId: string,
  cardId: string,
): Promise<RepoResult<null>> {
  const { data, error } = await supabase
    .from("flashcards")
    .delete()
    .eq("id", cardId)
    .eq("topic_id", topicId)
    .select("id");
  if (error) {
    return { ok: false, code: errorCode(error) };
  }
  return data.length === 0 ? { ok: false, code: "flashcard_not_found" } : { ok: true, value: null };
}
