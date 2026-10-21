<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Ai call guardrails

- **Plan**: context/changes/ai-call-guardrails/plan.md
- **Scope**: Phase 2 of 3
- **Reviewed phases**: 2
- **Date**: 2026-10-18
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 4 observations

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | WARNING |
| Scope Discipline    | PASS    |
| Safety & Quality    | WARNING |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | WARNING |

Success criteria evidence: `npm test` (17 passed, 1 skipped), `npm run lint`, `npx astro check` (0 errors) and `npm run build` pass at a156de3. Manual 2.5 was run with a real key: `✓ returns schema-valid structured output`, 1336 ms. Break checks: removing the `stop_reason` check and `maxRetries: 2` both turned tests red. The Phase 1 RPC contract (`begin_ai_call` / `finish_ai_call`) matches `quota.ts`.

## Findings

### F1 — Permanent failures are reported as retryable and use up the limit

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/ai/call.ts:108, src/lib/ai/call.ts:115, src/lib/ai/live.ts:66
- **Detail**: Three failures that a retry cannot fix end up as `retryable: true`, and every retry reserves another call:
  - (a) `zodOutputFormat(schema)` runs after `begin()`, so a schema the converter rejects (`z.date()`, transforms, `z.unknown()`) costs a call and returns `ai_unavailable`.
  - (b) HTTP 400/404/422 from the API (bad schema, unknown model) map to `ai_unavailable`.
  - (c) `stop_reason: "refusal"` maps to `ai_invalid_output`.
- **Fix A ⭐ Recommended**: Use existing codes. Build the JSON schema before `begin()`; if conversion fails, return `ai_not_configured` without reserving a call. Map 400/404/422 to `ai_not_configured`. Keep `refusal` as `ai_invalid_output` but log it separately.
  - Strength: The `AiErrorCode` contract stays the same; developer errors no longer cost the user's limit and show "not configured" rather than "try again".
  - Tradeoff: A refusal still shows "try again" (rare for these prompts).
  - Confidence: HIGH — the conversion and SDK error classes were checked in sdk 0.135.0.
  - Blind spot: Which 4xx cases the API returns for content problems has not been verified.
- **Fix B**: Same as A, plus a new non-retryable code `ai_refused` with its own message.
  - Strength: The user sees an accurate message for a refusal.
  - Tradeoff: The error contract grows before any slice needs it.
  - Confidence: MED — how often refusals happen for these tasks is unknown.
  - Blind spot: S-02 prompts don't exist yet.
- **Decision**: FIXED via Fix A (schema converted before `begin()`, failure → `ai_not_configured` without a reservation; 400/404/422 → `ai_not_configured`; refusal logged separately; 2 tests added)

### F2 — Effort is hardcoded, not overridable per call

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/lib/ai/live.ts:33
- **Detail**: The plan says effort defaults to the lowest level "z możliwością nadpisania per wywołanie". `effort: "low"` is hardcoded, and neither `AiRequest` nor `AiProviderRequest` has an effort field, so S-02 could not raise it for quiz or flashcard quality.
- **Fix**: Add `effort?: "low" | "medium" | "high"` to `AiRequest` and `AiProviderRequest` (default `"low"` in `callAi`), pass it through in `live.ts`, and extend the `output_config` test.
- **Decision**: FIXED (`effort?: "low" | "medium" | "high"` in `AiRequest`, default `"low"` in `callAi`, passed through in `live.ts`; tests check the default and an override)

### F3 — Fake provider: a missing fixture relies on the schema, and async fixtures are not awaited

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/ai/fake.ts:17
- **Detail**: A missing fixture returns `output: undefined` with `end_turn`, so it becomes `ai_invalid_output` only when the schema rejects `undefined`; an optional schema would "succeed". A fixture that returns a Promise is passed through without being awaited.
- **Fix**: For a missing fixture, return `stopReason: "missing_fixture"` and log the task name; `await` the fixture result.
- **Decision**: FIXED (missing fixture → `stopReason: "missing_fixture"` + log; fixtures awaited; tests for a missing fixture with an optional schema, an async fixture and `FakeAiFailure("ai_invalid_output")`)

### F4 — Logs include SUPABASE_URL and whole provider error objects

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/ai/index.ts:21, src/lib/ai/live.ts:66
- **Detail**: There is no key leak: SDK `APIError` carries only response headers. But the `AI_MODE` guard logs the full `SUPABASE_URL` (declared `access: "secret"`), and provider errors are logged as whole objects.
- **Fix**: Log only the hostname in `index.ts`, and log `error.message` plus `requestID` in `live.ts`.
- **Decision**: FIXED (the `AI_MODE` guard no longer logs `SUPABASE_URL`; provider errors are logged as `{ message, requestID }`)

### F5 — Test gaps for handled branches

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: src/lib/ai/live.test.ts, src/lib/ai/mode.test.ts, src/lib/ai/call.test.ts
- **Detail**: These branches are handled in code but not tested: 403, 429 and connection errors in `live.ts`; `refusal`; a generic `begin()` failure → `ai_unavailable`; `FakeAiFailure("ai_invalid_output")`; and `resolveAiMode` edge cases (`localhost.evil.com`, uppercase host, an unparsable URL).
- **Fix**: Add these cases to the existing test files (together with the F1/F3 changes).
- **Decision**: FIXED (tests for 403, 429, a network failure, refusal, a failing `begin()` and `resolveAiMode` edge cases; 26 tests in total)

### F6 — Observed live latency is not recorded

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/ai-call-guardrails/change.md
- **Detail**: Manual 2.5 says "note the observed latency"; the run measured 1336 ms (small prompt, effort low), but nothing in the change records it.
- **Fix**: Add a line to `change.md` `## Notes`: live test 2026-10-18, Sonnet 5.5, 1336 ms for a tiny schema call.
- **Decision**: FIXED (latency recorded in `change.md` Notes)

## Triage summary

- **Fixed**: F1 (Fix A), F2, F3, F4, F5, F6
