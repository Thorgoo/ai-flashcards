import { AiProviderError, type AiProvider, type AiProviderErrorCode, type AiProviderRequest } from "./call";
import { logAiError } from "./errors";

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
    async complete(request) {
      const fixture = fixtures[request.task];
      if (fixture === undefined) {
        // Never a success, whatever the schema accepts.
        logAiError(`no fake fixture for task ${request.task}`);
        return { output: undefined, stopReason: "missing_fixture" };
      }
      try {
        return { output: await fixture(request), stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
      } catch (error) {
        if (error instanceof FakeAiFailure) {
          if (error.code === "ai_invalid_output") {
            return { output: undefined, stopReason: "max_tokens" };
          }
          throw new AiProviderError(error.code);
        }
        throw error;
      }
    },
  };
}
