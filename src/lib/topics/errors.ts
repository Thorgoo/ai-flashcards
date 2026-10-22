export type TopicErrorCode =
  | "validation_failed"
  | "unauthenticated"
  | "not_found"
  | "topic_locked"
  | "duplicate_subtopic"
  | "subtopic_count"
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
  save_failed: { message: "Nie udało się zapisać zmian. Spróbuj ponownie.", retryable: true, status: 500 },
};

export function topicErrorResponse(code: TopicErrorCode): Response {
  const { message, retryable, status } = errors[code];
  return Response.json({ error: { code, message, retryable } }, { status });
}
