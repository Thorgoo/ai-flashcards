import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { aiError, logAiError, type AiErrorCode, type AiResult } from "./errors";

export type AiKind = "generation" | "grading";

export const DEFAULT_MODEL = "claude-sonnet-5-5";

const DEFAULT_TIMEOUT_MS: Record<AiKind, number> = { generation: 60_000, grading: 20_000 };

export interface AiProviderRequest {
  task: string;
  model: string;
  system: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  timeoutMs: number;
}

export interface AiProviderResponse {
  output: unknown;
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AiProvider {
  complete(request: AiProviderRequest): Promise<AiProviderResponse>;
}

export type AiProviderErrorCode = "ai_timeout" | "ai_unavailable" | "ai_not_configured";

export class AiProviderError extends Error {
  constructor(
    readonly code: AiProviderErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface AiCallOutcome {
  status: "ok" | "failed";
  errorCode: AiErrorCode | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AiQuota {
  begin(kind: AiKind, task: string, model: string): Promise<{ callId: string; remaining: number }>;
  finish(callId: string, outcome: AiCallOutcome): Promise<void>;
}

export class AiQuotaExceeded extends Error {
  constructor() {
    super("ai_quota_exceeded");
  }
}

export interface AiRequest<T> {
  kind: AiKind;
  task: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  timeoutMs?: number;
  model?: string;
}

export interface AiDeps {
  provider: AiProvider;
  quota: AiQuota;
  userId: string | null;
}

// The only path to an AI provider: limit first (before any cost), then the call,
// then shape validation, then the outcome is recorded. Never retries — every call
// uses up the daily limit, so retrying is the user's decision.
export async function callAi<T>(deps: AiDeps, request: AiRequest<T>): Promise<AiResult<T>> {
  if (deps.userId === null) {
    return aiError("unauthenticated");
  }

  const model = request.model ?? DEFAULT_MODEL;
  let reservation: { callId: string; remaining: number };
  try {
    reservation = await deps.quota.begin(request.kind, request.task, model);
  } catch (error) {
    if (error instanceof AiQuotaExceeded) {
      return aiError("quota_exceeded");
    }
    logAiError("could not reserve an AI call", error);
    return aiError("ai_unavailable");
  }

  const started = Date.now();
  let errorCode: AiErrorCode | null = null;
  let data: T | undefined;
  let usage: AiProviderResponse["usage"];
  try {
    const response = await deps.provider.complete({
      task: request.task,
      model,
      system: request.system,
      prompt: request.prompt,
      jsonSchema: zodOutputFormat(request.schema).schema,
      maxTokens: request.maxTokens,
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS[request.kind],
    });
    usage = response.usage;
    // Structured outputs do not hold when the model stops early, and they cannot
    // express every constraint (e.g. exact item counts), so the schema decides.
    const parsed = response.stopReason === "end_turn" ? request.schema.safeParse(response.output) : null;
    if (parsed?.success) {
      data = parsed.data;
    } else {
      errorCode = "ai_invalid_output";
      logAiError(
        `invalid output for task ${request.task}`,
        parsed?.error.issues ?? `stop_reason ${response.stopReason}`,
      );
    }
  } catch (error) {
    if (error instanceof AiProviderError) {
      errorCode = error.code;
    } else {
      errorCode = "ai_unavailable";
      logAiError(`provider failed for task ${request.task}`, error);
    }
  }

  try {
    await deps.quota.finish(reservation.callId, {
      status: errorCode === null ? "ok" : "failed",
      errorCode,
      latencyMs: Date.now() - started,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
    });
  } catch (error) {
    // The result already exists; a lost log entry must not turn it into an error.
    logAiError("could not record the AI call outcome", error);
  }

  if (errorCode !== null) {
    return aiError(errorCode);
  }
  return { ok: true, data: data as T, remaining: reservation.remaining };
}
