// The error shape every topic and AI endpoint returns (src/lib/topics/errors.ts, src/lib/ai/errors.ts).
export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
}

export type ApiResult<T> = { ok: true; data: T; remaining?: number } | { ok: false; error: ApiError };

const NETWORK_ERROR: ApiError = {
  code: "network",
  message: "Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.",
  retryable: true,
};

export async function callApi<T>(path: string, method: string, body?: unknown): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  try {
    const json = (await response.json()) as { data?: T; remaining?: number; error?: ApiError };
    if (response.ok && json.data !== undefined) {
      return { ok: true, data: json.data, remaining: json.remaining };
    }
    return { ok: false, error: json.error ?? NETWORK_ERROR };
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
}
