import { describe, expect, it } from "vitest";
import { AiProviderError, type AiProviderRequest } from "./call";
import { createLiveProvider } from "./live";

const request: AiProviderRequest = {
  task: "probe",
  model: "claude-sonnet-5-5",
  system: "system",
  prompt: "prompt",
  jsonSchema: { type: "object", properties: { answer: { type: "string" } }, additionalProperties: false },
  maxTokens: 100,
  timeoutMs: 1_000,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function message(text: string, stopReason = "end_turn") {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 7 },
  };
}

// A fetch stub that answers every request with the given response and counts requests.
function stubFetch(respond: (init: RequestInit | undefined) => Promise<Response>) {
  const stub = {
    requests: 0,
    fetch: ((_url: unknown, init?: RequestInit) => {
      stub.requests++;
      return respond(init);
    }) as typeof fetch,
  };
  return stub;
}

async function providerError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AiProviderError) return error.code;
    throw error;
  }
  throw new Error("expected the provider to fail");
}

describe("createLiveProvider", () => {
  it("returns parsed structured output, stop reason and usage", async () => {
    const stub = stubFetch(() => Promise.resolve(json(200, message('{"answer":"42"}'))));
    const response = await createLiveProvider({ apiKey: "key", fetch: stub.fetch }).complete(request);

    expect(response).toEqual({
      output: { answer: "42" },
      stopReason: "end_turn",
      usage: { inputTokens: 11, outputTokens: 7 },
    });
  });

  it("sends the JSON schema and low effort in output_config", async () => {
    let body: Record<string, unknown> = {};
    const stub = stubFetch((init) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Promise.resolve(json(200, message('{"answer":"42"}')));
    });
    await createLiveProvider({ apiKey: "key", fetch: stub.fetch }).complete(request);

    expect(body.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: request.jsonSchema } });
  });

  it("maps server errors to ai_unavailable without retrying", async () => {
    for (const status of [500, 529]) {
      const stub = stubFetch(() =>
        Promise.resolve(json(status, { type: "error", error: { type: "api_error", message: "boom" } })),
      );
      const code = await providerError(createLiveProvider({ apiKey: "key", fetch: stub.fetch }).complete(request));

      expect(code).toBe("ai_unavailable");
      expect(stub.requests).toBe(1);
    }
  });

  it("maps a rejected API key to ai_not_configured", async () => {
    const stub = stubFetch(() =>
      Promise.resolve(json(401, { type: "error", error: { type: "authentication_error", message: "bad key" } })),
    );

    expect(await providerError(createLiveProvider({ apiKey: "key", fetch: stub.fetch }).complete(request))).toBe(
      "ai_not_configured",
    );
  });

  it("maps a request that outlives its timeout to ai_timeout", async () => {
    const stub = stubFetch(
      (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const code = await providerError(
      createLiveProvider({ apiKey: "key", fetch: stub.fetch }).complete({ ...request, timeoutMs: 20 }),
    );

    expect(code).toBe("ai_timeout");
    expect(stub.requests).toBe(1);
  });

  it("fails as not configured without an API key", async () => {
    expect(await providerError(createLiveProvider({ apiKey: undefined }).complete(request))).toBe("ai_not_configured");
  });

  it("returns undefined output when the text is not JSON", async () => {
    const stub = stubFetch(() => Promise.resolve(json(200, message("not json", "max_tokens"))));
    const response = await createLiveProvider({ apiKey: "key", fetch: stub.fetch }).complete(request);

    expect(response).toMatchObject({ output: undefined, stopReason: "max_tokens" });
  });
});
