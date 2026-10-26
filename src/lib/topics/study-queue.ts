// The study session's queue of card ids, kept on the client: a correct answer takes the
// card off, a wrong one sends it to the end, so it comes back in the same session. Pure and
// immutable; every step returns a new queue.
export type StudyQueue = readonly string[];

export function createQueue(cardIds: readonly string[]): StudyQueue {
  return [...cardIds];
}

// The card to show now, or null when the session is done.
export function current(queue: StudyQueue): string | null {
  return queue[0] ?? null;
}

export function answered(queue: StudyQueue, correct: boolean): StudyQueue {
  if (queue.length === 0) return queue;
  const [first, ...rest] = queue;
  return correct ? rest : [...rest, first];
}

// Removes a card deleted in the meantime (the API answered flashcard_not_found).
export function drop(queue: StudyQueue, cardId: string): StudyQueue {
  return queue.filter((id) => id !== cardId);
}

export function isDone(queue: StudyQueue): boolean {
  return queue.length === 0;
}
