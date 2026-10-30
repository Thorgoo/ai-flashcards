<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Durable flashcard generation

- **Plan**: context/changes/durable-flashcard-generation/plan.md
- **Scope**: Full plan
- **Reviewed phases**: 1, 2, 3
- **Date**: 2026-10-29
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 4 warnings, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

Success Criteria: automated checks pass (npm test 122 passed, lint, astro check 0 errors, build, CI green on PRs #43–#45); manual rows 1.7, 2.8, 3.3 left open by user decision.

## Findings

### F1 — Claim TTL leaves ~25 s headroom over the 90 s AI timeout

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/flashcards-task.ts:13, :156, :187; src/lib/topics/flashcard-generation.ts:108
- **Detail**: Queue latency + pre-reads + AI (≤90 s) + save must finish within the 120 s claim TTL. Past 120 s the page reads the claim as gone (empty state / enabled button, no message); a new click takes the claim over and the first job's create fails with batch_not_claimed, wasting one generation. The consumer checks only the token, not the claim's age. Observed on production: 38 s wall, so the gap matters only for slow AI calls.
- **Fix A ⭐ Recommended**: Raise the TTL to 180 s (new migration for both claim functions + FLASHCARD_CLAIM_TTL_SECONDS)
  - Strength: One constant, covers 90 s AI + queue + reads with a wide margin; the claim/TTL sync comment already names both places.
  - Tradeoff: A truly abandoned claim blocks a retry for 3 min instead of 2.
  - Confidence: HIGH — the consumer never throws, so abandoned claims are rare now.
  - Blind spot: Queue delivery latency under load not measured.
- **Fix B**: Re-stamp claimed_at when the consumer starts (new RPC) and skip the AI call when the claim is older than TTL − AI timeout
  - Strength: Ties the TTL to actual consumer start, no global constant change.
  - Tradeoff: Changes the token mid-flight (create must use the new one) — more moving parts and pgTAP.
  - Confidence: MED — token re-stamping touches the idempotency guarantee.
  - Blind spot: Interaction with a click arriving during re-stamp.
- **Decision**: FIXED (Fix A) — migration 20261029203000_flashcard_claim_ttl_180, FLASHCARD_CLAIM_TTL_SECONDS = 180, pgTAP aged to 181 s + a 121 s claim still blocks

### F2 — A stored failure never expires

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/flashcard-repository.ts:219-225; src/components/topics/FlashcardBatch.tsx:91-102
- **Detail**: A failed row shows until a new claim of that seq takes it over. A failed next batch on a topic that later becomes mastered keeps showing "Spróbuj ponownie" (which then answers topic_mastered); a stored quota_exceeded ("try tomorrow") is still shown on later days.
- **Fix**: Hide `failed` in the summary when the topic is mastered or the next batch is locked, and show non-retryable failures only on the day they happened (Europe/Warsaw; claimed_at as the failure day).
  - Strength: The alert only appears when the action it offers can still succeed.
  - Tradeoff: Adds a date rule to the summary; claimed_at as failure time is approximate (≤90 s off).
  - Confidence: MED — study-day.ts already has the Warsaw-day helper.
  - Blind spot: Whether users want to see yesterday's failure at all.
- **Decision**: FIXED — `visibleFailure` in flashcard-repository.ts (hidden when mastered or locked; non-retryable only on its Warsaw day) + 4 tests

### F3 — Queued job + failed state read gives a false error

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/topics/[id]/flashcards/index.ts:52-54; next.ts:105-107
- **Detail**: After FLASHCARD_JOBS.send succeeds, a failing readFlashcardState returns 500 save_failed while the job runs; the page shows an error and does not poll.
- **Fix**: In FlashcardBatch, call refresh() after any POST error (not only STALE_CODES), so a running claim starts the polling.
- **Decision**: FIXED — FlashcardBatch refreshes after a failed generate/next and shows no error while the claim is generating

### F4 — Consumer logic has no unit tests; module breaks the deps-injection convention

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Pattern Consistency
- **Location**: src/lib/topics/flashcard-generation.ts:2-5, :74-154; src/lib/topics/flashcard-generation.test.ts:4-5; vitest.config.ts:5
- **Detail**: vitest.config.ts says modules under test take config as arguments (like callAi's deps). The new module imports `env` from cloudflare:workers and getAi directly, so its test mocks both and covers only the zod schema. Skip-if-not-ours, never-throw and fail-marking are covered only by CI smoke (success path).
- **Fix**: Make runFlashcardJob take `{ createClient, getAi }` deps (enqueue takes `send`), keep thin wrappers for worker.ts/endpoints, and add Vitest cases on the fake provider: taken-over claim skips AI, AI failure marks the code, thrown error marks save_failed and does not throw.
  - Strength: Matches callAi's pattern and vitest.config.ts; covers the failure paths smoke cannot reach.
  - Tradeoff: Small refactor of a module that is live on production.
  - Confidence: HIGH — same shape as call.ts / call.test.ts.
  - Blind spot: None significant.
- **Decision**: FIXED — logic moved to flashcard-job.ts with injected deps (flashcard-generation.ts wires runtime); flashcard-job.test.ts covers success, taken-over claim, AI failure, thrown error, invalid body, enqueue refresh/send failure (kind "first" only)

### F5 — Failures that cannot be stored are only a console.error

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/flashcard-generation.ts:82-85, :96-101
- **Detail**: Invalid/expired token or missing Supabase config: the fail RPC cannot run, the claim expires silently and the page shows the empty state.
- **Fix**: Give these logs a fixed tag (e.g. `[flashcard-job:unmarked]`) and note it in infrastructure.md as the thing to watch in Workers Logs.
- **Decision**: FIXED — `[flashcard-job:unmarked]` log tag (failFlashcardBatchClaim now returns whether it stored the failure) + infrastructure.md note

### F6 — release*Claim TS helpers are dead code

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/lib/topics/flashcard-repository.ts:288, :354
- **Detail**: No caller in src since Phase 2. Only the SQL functions are needed (rollback Worker).
- **Fix**: Delete both TS wrappers; drop the SQL functions in a later contract migration.
- **Decision**: FIXED — releaseFlashcardBatchClaim / releaseNextFlashcardBatchClaim TS wrappers removed; SQL functions kept for rollback

### F7 — First repository test that hand-mocks SupabaseClient

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/lib/topics/flashcard-repository.test.ts:18-29
- **Detail**: Neighbouring tests (mastery, study-queue) test pure functions; this one stubs the client to reach the fresh/failed selection.
- **Fix**: Extract the ready/fresh/failed selection into a pure function over batch rows and test it directly.
- **Decision**: SKIPPED

### F8 — User access token at rest in queue messages

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/flashcard-generation.ts:63
- **Detail**: Accepted by design (plan decision); the token is never logged and expires in ~1 h, messages are acked. A future DLQ or message logging would expose it.
- **Fix**: Add one line to src/lib/ai/AGENTS.md: never log queue message bodies or add a DLQ without redacting accessToken.
- **Decision**: FIXED — rule added to src/lib/ai/AGENTS.md
