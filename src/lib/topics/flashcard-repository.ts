import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { TopicErrorCode } from "./errors";
import { FLASHCARD_CLAIM_TTL_SECONDS, type FlashcardRow } from "./flashcards-task";
import { batchProgress, subtopicMastery, type BatchProgress, type SubtopicMastery } from "./mastery";
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
  // The card reached the 'mastered' stage (S-06); mastery is counted from cards only.
  mastered: boolean;
}

export interface FlashcardBatchView {
  id: string;
  seq: number;
  cards: FlashcardView[];
}

export interface FlashcardState {
  // Ready batches, newest first.
  batches: FlashcardBatchView[];
  // A batch claimed and still being generated (its AI call is running); it has no cards yet.
  generating: { seq: number } | null;
  // Progress of the newest ready batch toward unlocking the next one.
  current: ({ seq: number } & BatchProgress) | null;
  // Every subtopic of the topic, in list order.
  subtopics: SubtopicMastery[];
  topicMastered: boolean;
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

interface BatchRow {
  id: string;
  seq: number;
  status: "generating" | "ready";
  claimed_at: string;
}

type StateCardRow = CardRow & { batch_id: string; stage: string };

// `stage` is read where the query selects it; without it the card counts as not mastered.
export function toFlashcardView(card: CardRow & { stage?: string }, subtopic: SubtopicRow | undefined): FlashcardView {
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
    mastered: card.stage === "mastered",
  };
}

// Whether the topic has at least one ready batch (pages: study, "Ucz się").
export function hasReadyBatch(state: FlashcardState | null): boolean {
  return (state?.batches.length ?? 0) > 0;
}

const P0409_REASONS: TopicErrorCode[] = [
  "topic_not_confirmed",
  "quiz_not_completed",
  "batch_exists",
  "batch_generating",
  "next_batch_locked",
  "topic_mastered",
];

// The flashcard functions share P0409 and name the reason in the hint (migrations
// create_flashcards, next_flashcard_batches). batch_not_claimed is not the user's doing.
function errorCode(error: PostgrestError): TopicErrorCode {
  const reason = P0409_REASONS.find((code) => code === error.hint);
  if (error.code === "P0409" && reason) return reason;
  // eslint-disable-next-line no-console
  console.error("[topics] flashcards database error", error);
  return "save_failed";
}

// All batches of the topic, or null without a ready batch or a fresh claim. Throws on
// database errors (see readFlashcardState in http.ts).
export async function getFlashcardState(supabase: SupabaseClient, topicId: string): Promise<FlashcardState | null> {
  const [batchesResult, cardsResult, subtopicsResult] = await Promise.all([
    supabase.from("flashcard_batches").select("id, seq, status, claimed_at").eq("topic_id", topicId),
    supabase.from("flashcards").select(`${CARD_COLUMNS}, batch_id, stage`).eq("topic_id", topicId),
    supabase.from("subtopics").select("id, name, content_type, position").eq("topic_id", topicId),
  ]);
  if (batchesResult.error) {
    throw new Error(`loading flashcard batches failed: ${batchesResult.error.message}`);
  }
  if (cardsResult.error) {
    throw new Error(`loading flashcards failed: ${cardsResult.error.message}`);
  }
  if (subtopicsResult.error) {
    throw new Error(`loading subtopics failed: ${subtopicsResult.error.message}`);
  }

  const batchRows = batchesResult.data as BatchRow[];
  const ready = batchRows.filter((batch) => batch.status === "ready").sort((a, b) => b.seq - a.seq);
  // An abandoned claim reads as no batch: the next start takes it over.
  const fresh = batchRows
    .filter(
      (batch) =>
        batch.status === "generating" &&
        Date.now() - Date.parse(batch.claimed_at) <= FLASHCARD_CLAIM_TTL_SECONDS * 1000,
    )
    .sort((a, b) => b.seq - a.seq)
    .at(0);
  if (ready.length === 0 && !fresh) {
    return null;
  }

  const subtopicRows = (subtopicsResult.data as SubtopicRow[]).sort((a, b) => a.position - b.position);
  const subtopics = new Map(subtopicRows.map((row) => [row.id, row]));
  const subtopicPosition = (id: string) => subtopics.get(id)?.position ?? Number.MAX_SAFE_INTEGER;

  // Grouped by subtopic in list order, then in the order the cards were generated.
  const cardRows = (cardsResult.data as unknown as StateCardRow[]).sort(
    (a, b) => subtopicPosition(a.subtopic_id) - subtopicPosition(b.subtopic_id) || a.position - b.position,
  );
  const cardsByBatch = new Map<string, FlashcardView[]>();
  for (const card of cardRows) {
    const view = toFlashcardView(card, subtopics.get(card.subtopic_id));
    const list = cardsByBatch.get(card.batch_id);
    if (list) list.push(view);
    else cardsByBatch.set(card.batch_id, [view]);
  }

  const batches = ready.map((batch) => ({ id: batch.id, seq: batch.seq, cards: cardsByBatch.get(batch.id) ?? [] }));
  const mastery = subtopicMastery(
    subtopicRows.map((row) => ({ id: row.id, name: row.name, contentType: row.content_type })),
    batches.flatMap((batch) => batch.cards),
  );
  const latest = batches.at(0);
  return {
    batches,
    generating: fresh ? { seq: fresh.seq } : null,
    current: latest ? { seq: latest.seq, ...batchProgress(latest.cards) } : null,
    subtopics: mastery,
    // As claim_next_flashcard_batch: no subtopic left without cards or with an unmastered card.
    topicMastered: mastery.every((subtopic) => subtopic.isMastered),
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

// Reserves batch `seq` (2 and later) before the AI call. claim_next_flashcard_batch repeats the
// unlock and mastery checks under a lock; the value is the claim's token, as in claimFlashcardBatch.
export async function claimNextFlashcardBatch(
  supabase: SupabaseClient,
  topicId: string,
  seq: number,
): Promise<RepoResult<string>> {
  const claim = await supabase.rpc("claim_next_flashcard_batch", { p_topic_id: topicId, p_seq: seq });
  return claim.error ? { ok: false, code: errorCode(claim.error) } : { ok: true, value: claim.data as string };
}

// Drops the unfinished claim of batch `seq` named by its token, so the batch can start again.
export async function releaseNextFlashcardBatchClaim(
  supabase: SupabaseClient,
  topicId: string,
  seq: number,
  claimedAt: string,
): Promise<void> {
  const { error } = await supabase.rpc("release_next_flashcard_batch_claim", {
    p_topic_id: topicId,
    p_seq: seq,
    p_claimed_at: claimedAt,
  });
  if (error) {
    // The claim expires on its own (FLASHCARD_CLAIM_TTL_SECONDS); the original error matters more.
    // eslint-disable-next-line no-console
    console.error("[topics] releasing next flashcard claim failed", error);
  }
}

// Atomic: batch `seq` is marked ready with all 10 cards, or nothing is saved (create_next_flashcard_batch).
export async function createNextFlashcardBatch(
  supabase: SupabaseClient,
  topicId: string,
  seq: number,
  rows: FlashcardRow[],
  claimedAt: string,
): Promise<RepoResult<null>> {
  const { error } = await supabase.rpc("create_next_flashcard_batch", {
    p_topic_id: topicId,
    p_seq: seq,
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
