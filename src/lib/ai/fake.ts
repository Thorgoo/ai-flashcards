import { AiProviderError, type AiProvider, type AiProviderErrorCode, type AiProviderRequest } from "./call";

export type FakeFixture = (request: AiProviderRequest) => unknown;

export class FakeAiFailure extends Error {
  constructor(readonly code: AiProviderErrorCode | "ai_invalid_output") {
    super(`fake AI failure: ${code}`);
  }
}

// Canned responses keyed by task. A fixture may throw FakeAiFailure to make the
// caller see a specific AI error; limits and validation still apply as in live mode.
export function createFakeProvider(fixtures: Partial<Record<string, FakeFixture>>): AiProvider {
  return {
    complete(request) {
      const fixture = fixtures[request.task];
      if (fixture === undefined) {
        return Promise.resolve({
          output: undefined,
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      }
      try {
        return Promise.resolve({
          output: fixture(request),
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      } catch (error) {
        if (error instanceof FakeAiFailure) {
          if (error.code === "ai_invalid_output") {
            return Promise.resolve({ output: undefined, stopReason: "max_tokens" });
          }
          return Promise.reject(new AiProviderError(error.code));
        }
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
