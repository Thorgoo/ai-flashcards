import type { FlashcardSubtopic } from "./flashcards-task";
import type { ContentType } from "./schemas";

// Mastery rules of the next flashcard batches (S-07). Keep them in sync with
// claim_next_flashcard_batch (migration next_flashcard_batches): a subtopic is mastered when
// it has at least one card and every card is 'mastered'; the next batch unlocks at 80% of the
// latest ready batch's existing cards (mastered * 5 >= total * 4, so an empty batch passes).
// Mastery counts flashcards only, never the quiz.

export interface SubtopicMastery {
  id: string;
  name: string;
  contentType: ContentType;
  total: number;
  mastered: number;
  isMastered: boolean;
}

export interface BatchProgress {
  total: number;
  mastered: number;
  // Mastered cards needed to unlock the next batch.
  required: number;
  unlocked: boolean;
}

// One entry per subtopic, in the order given (the list order).
export function subtopicMastery(
  subtopics: { id: string; name: string; contentType: ContentType }[],
  cards: { subtopicId: string; mastered: boolean }[],
): SubtopicMastery[] {
  return subtopics.map((subtopic) => {
    const own = cards.filter((card) => card.subtopicId === subtopic.id);
    const total = own.length;
    const mastered = own.filter((card) => card.mastered).length;
    return {
      id: subtopic.id,
      name: subtopic.name,
      contentType: subtopic.contentType,
      total,
      mastered,
      isMastered: total >= 1 && mastered === total,
    };
  });
}

// Progress of the latest ready batch, from its existing (not deleted) cards.
export function batchProgress(cards: { mastered: boolean }[]): BatchProgress {
  const total = cards.length;
  const mastered = cards.filter((card) => card.mastered).length;
  return { total, mastered, required: Math.ceil((total * 4) / 5), unlocked: mastered * 5 >= total * 4 };
}

export function masteryPercent(mastery: { total: number; mastered: number }): number {
  return mastery.total === 0 ? 0 : Math.round((mastery.mastered / mastery.total) * 100);
}

// The subtopics of the next batch: unmastered only, weakest first — by mastery percent, then
// by the quiz result (none counts as 0), then by list position. `percent` is the mastery
// percent, which the batch allocation and the prompt use.
export function nextBatchSubtopics(mastery: SubtopicMastery[], quizPercents: Map<string, number>): FlashcardSubtopic[] {
  return mastery
    .map((subtopic, position) => ({ subtopic, position, percent: masteryPercent(subtopic) }))
    .filter(({ subtopic }) => !subtopic.isMastered)
    .sort(
      (a, b) =>
        a.percent - b.percent ||
        (quizPercents.get(a.subtopic.id) ?? 0) - (quizPercents.get(b.subtopic.id) ?? 0) ||
        a.position - b.position,
    )
    .map(({ subtopic, percent }) => ({
      id: subtopic.id,
      name: subtopic.name,
      contentType: subtopic.contentType,
      percent,
    }));
}
