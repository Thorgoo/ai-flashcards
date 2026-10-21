import Anthropic, {
  APIError,
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import { AiProviderError, type AiProvider } from "./call";
import { logAiError } from "./errors";

export function createLiveProvider(options: { apiKey: string | undefined; fetch?: typeof fetch }): AiProvider {
  const { apiKey } = options;
  if (!apiKey) {
    return {
      complete() {
        return Promise.reject(new AiProviderError("ai_not_configured", "ANTHROPIC_API_KEY is not set"));
      },
    };
  }

  // maxRetries: 0 — each request is one row in ai_calls; SDK retries would be unaccounted calls.
  const client = new Anthropic({ apiKey, maxRetries: 0, fetch: options.fetch });

  return {
    async complete(request) {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: [{ role: "user", content: request.prompt }],
            output_config: { effort: request.effort, format: { type: "json_schema", schema: request.jsonSchema } },
          },
          { timeout: request.timeoutMs },
        );
      } catch (error) {
        throw toProviderError(error);
      }

      const text = message.content.find((block) => block.type === "text")?.text;
      let output: unknown;
      try {
        output = text === undefined ? undefined : JSON.parse(text);
      } catch {
        output = undefined;
      }
      return {
        output,
        stopReason: message.stop_reason ?? "unknown",
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      };
    },
  };
}

function toProviderError(error: unknown): AiProviderError {
  if (error instanceof APIConnectionTimeoutError) {
    return new AiProviderError("ai_timeout");
  }
  // Rejected key or a request the API can't accept (schema, model): retrying won't help.
  if (
    error instanceof AuthenticationError ||
    error instanceof PermissionDeniedError ||
    error instanceof BadRequestError ||
    error instanceof NotFoundError ||
    error instanceof UnprocessableEntityError
  ) {
    logAiError(`provider rejected the request (${error.status})`, {
      message: error.message,
      requestID: error.requestID,
    });
    return new AiProviderError("ai_not_configured");
  }
  if (error instanceof APIError) {
    logAiError(`provider request failed (${error.status ?? "no status"})`, {
      message: error.message,
      requestID: error.requestID,
    });
  } else {
    logAiError("provider request failed", error instanceof Error ? error.message : String(error));
  }
  return new AiProviderError("ai_unavailable");
}
