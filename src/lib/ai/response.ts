import { aiErrorStatus, type AiResult } from "./errors";
import type { AiMode } from "./mode";

function aiHeaders(mode: AiMode): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (mode === "fake") {
    headers.set("X-AI-Mode", "fake");
  }
  return headers;
}

// Turns an AI result into the JSON response shape every AI endpoint shares.
export function aiResponse(result: AiResult<unknown>, mode: AiMode): Response {
  const headers = aiHeaders(mode);
  if (result.ok) {
    return new Response(JSON.stringify({ data: result.data, remaining: result.remaining }), { status: 200, headers });
  }
  return new Response(JSON.stringify({ error: result.error }), { status: aiErrorStatus(result.error.code), headers });
}

// An AI call queued to run in the background (202): the current state, without `remaining`
// (the call has not started yet).
export function aiAcceptedResponse(data: unknown, mode: AiMode): Response {
  return new Response(JSON.stringify({ data }), { status: 202, headers: aiHeaders(mode) });
}
