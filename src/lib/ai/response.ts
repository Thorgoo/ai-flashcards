import { aiErrorStatus, type AiResult } from "./errors";
import type { AiMode } from "./mode";

// Turns an AI result into the JSON response shape every AI endpoint shares.
export function aiResponse(result: AiResult<unknown>, mode: AiMode): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (mode === "fake") {
    headers.set("X-AI-Mode", "fake");
  }
  if (result.ok) {
    return new Response(JSON.stringify({ data: result.data, remaining: result.remaining }), { status: 200, headers });
  }
  return new Response(JSON.stringify({ error: result.error }), { status: aiErrorStatus(result.error.code), headers });
}
