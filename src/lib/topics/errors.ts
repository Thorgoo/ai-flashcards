export type TopicErrorCode =
  | "validation_failed"
  | "unauthenticated"
  | "not_found"
  | "topic_locked"
  | "duplicate_subtopic"
  | "subtopic_count"
  | "topic_not_confirmed"
  | "quiz_exists"
  | "quiz_generating"
  | "question_locked"
  | "quiz_not_completed"
  | "batch_exists"
  | "batch_generating"
  | "flashcard_not_found"
  | "card_not_due"
  | "attempt_conflict"
  | "save_failed";

// Same shape as AiError (src/lib/ai/errors.ts), so the client handles one error format.
const errors: Record<TopicErrorCode, { message: string; retryable: boolean; status: number }> = {
  validation_failed: { message: "Sprawdź wprowadzone dane.", retryable: false, status: 400 },
  unauthenticated: { message: "Zaloguj się, aby kontynuować.", retryable: false, status: 401 },
  not_found: { message: "Nie znaleziono tematu.", retryable: false, status: 404 },
  topic_locked: {
    message: "Lista podtematów jest już zatwierdzona i nie można jej zmienić.",
    retryable: false,
    status: 409,
  },
  duplicate_subtopic: { message: "Taki podtemat już jest na liście.", retryable: false, status: 409 },
  subtopic_count: { message: "Temat musi mieć od 2 do 10 podtematów.", retryable: false, status: 422 },
  topic_not_confirmed: { message: "Najpierw zatwierdź listę podtematów.", retryable: false, status: 409 },
  quiz_exists: { message: "Ten temat ma już quiz diagnostyczny.", retryable: false, status: 409 },
  quiz_generating: { message: "Quiz jest właśnie przygotowywany.", retryable: false, status: 409 },
  question_locked: { message: "To pytanie ma już odpowiedź.", retryable: false, status: 409 },
  quiz_not_completed: { message: "Najpierw ukończ quiz diagnostyczny.", retryable: false, status: 409 },
  batch_exists: { message: "Ten temat ma już pierwszą partię fiszek.", retryable: false, status: 409 },
  batch_generating: { message: "Fiszki są właśnie przygotowywane.", retryable: false, status: 409 },
  flashcard_not_found: { message: "Nie znaleziono fiszki.", retryable: false, status: 404 },
  card_not_due: { message: "Ta fiszka nie czeka już na powtórkę.", retryable: false, status: 409 },
  attempt_conflict: {
    message: "Tej odpowiedzi nie da się zapisać dla tej fiszki. Odśwież stronę.",
    retryable: false,
    status: 409,
  },
  save_failed: { message: "Nie udało się zapisać zmian. Spróbuj ponownie.", retryable: true, status: 500 },
};

export function topicErrorResponse(code: TopicErrorCode): Response {
  const { message, retryable, status } = errors[code];
  return Response.json({ error: { code, message, retryable } }, { status });
}
