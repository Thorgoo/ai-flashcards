export type AiErrorCode =
  "unauthenticated" | "quota_exceeded" | "ai_timeout" | "ai_unavailable" | "ai_invalid_output" | "ai_not_configured";

export interface AiError {
  code: AiErrorCode;
  message: string;
  retryable: boolean;
}

export type AiResult<T> = { ok: true; data: T; remaining: number } | { ok: false; error: AiError };

const errors: Record<AiErrorCode, { message: string; retryable: boolean; status: number }> = {
  unauthenticated: { message: "Zaloguj się, aby kontynuować.", retryable: false, status: 401 },
  quota_exceeded: {
    message: "Wykorzystano dzisiejszy limit wywołań AI. Spróbuj ponownie jutro.",
    retryable: false,
    status: 429,
  },
  ai_timeout: { message: "AI nie odpowiedziało na czas. Spróbuj ponownie.", retryable: true, status: 504 },
  ai_unavailable: { message: "Usługa AI jest chwilowo niedostępna. Spróbuj ponownie.", retryable: true, status: 503 },
  ai_invalid_output: { message: "AI zwróciło niepoprawną odpowiedź. Spróbuj ponownie.", retryable: true, status: 502 },
  ai_not_configured: { message: "Usługa AI nie jest skonfigurowana.", retryable: false, status: 503 },
};

export function aiError(code: AiErrorCode): { ok: false; error: AiError } {
  const { message, retryable } = errors[code];
  return { ok: false, error: { code, message, retryable } };
}

export function aiErrorStatus(code: AiErrorCode): number {
  return errors[code].status;
}

// Single place for AI diagnostics in Workers Logs; the durable record is the ai_calls row.
export function logAiError(message: string, detail?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[ai] ${message}`, detail ?? "");
}
