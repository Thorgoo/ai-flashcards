# Durable flashcard generation Implementation Plan

## Overview

Flashcard generation (batch 1 via `POST /flashcards`, batches 2+ via `POST /flashcards/next`) moves out of the request into a Cloudflare Queue consumer, so a reload or a closed tab no longer loses the batch and the generation it already charged. A failed generation is stored on the batch row (`failed` + `error_code`), so the page shows the real reason — also after a reload — instead of silently returning to the "Wygeneruj" button.

## Current State Analysis

- Both endpoints claim the batch, then run AI + save under `ctx.waitUntil` and `return await work` (`src/pages/api/topics/[id]/flashcards/index.ts:40-50`, `next.ts:131-141`). Cloudflare stops `waitUntil` ~30 s after the client disconnects; generation takes 33–36 s (`context/archive/2026-10-29-next-batch-and-subtopic-mastery/change.md:16`). Result on a reload: `ai_calls` row stays `pending` (one generation used), nothing saved, claim expires after 120 s. Confirmed on production for batch 2 (S-07 F2).
- The claim/token RPCs already separate "reserve" from "do the work": `claim_*` returns `claimed_at`, `create_*` refuses a taken-over or ready batch (`supabase/migrations/20261025182503_claim_tokens_and_option_nulls.sql:23-160`, `20261029141252_next_flashcard_batches.sql:15-189`).
- `release_*` deletes the `generating` row on failure (`…141252:99-107`); `flashcard_batches.status` allows only `generating | ready` (`20261024095230_create_flashcards.sql:14`). A failure leaves no trace the page can show after a reload.
- All 8 RPCs read the user from `auth.uid()` and are granted to `authenticated` only; the only server client is cookie-based (`src/lib/supabase.ts:5-9`).
- `getAi(supabase, user)` uses `user` only for `userId` (`src/lib/ai/index.ts:32`). `src/lib/ai/AGENTS.md` forbids automatic retries: every call uses up the daily limit at `begin_ai_call`.
- The client already fits an async model: `callApi` treats any 2xx with `data` as success (`src/components/topics/api.ts:28-30`); `FlashcardBatch` polls `/summary` every 2 s while `state.generating` is set and refreshes once it clears (`FlashcardBatch.tsx:64-67,92-100`). It does not use `remaining` for flashcards.
- `wrangler.jsonc` uses the default adapter entry, no queues; the adapter keeps a custom `main` and exports `handle` from `@astrojs/cloudflare/handler` (research: `node_modules/@astrojs/cloudflare/dist/wrangler.js:36`, `package.json:31`).
- `scripts/smoke-topics.mjs:306-323` (and `:532-550` for batch 2) expects POST to answer 200 with `data`, `remaining` and `X-AI-Mode`, and fires a second POST right away expecting `batch_exists`.

## Desired End State

- `POST /flashcards` and `POST /flashcards/next` validate, claim, enqueue a job and answer **202** with the current `FlashcardState` (`generating` set). A queue consumer in the same Worker does AI + save with the user's access token.
- Reloading or closing the tab at any point during generation ends with the batch saved; the reopened page shows it after polling.
- A failed generation (AI timeout, invalid output, daily limit, save error) marks the claim `failed` with its code; the page shows the matching Polish message from `errors.ts` with "Spróbuj ponownie" when retryable, also after a reload. A new claim takes over a failed row.
- No automatic retries anywhere; quota still counted at `begin_ai_call`.
- Verify: CI green (lint, vitest, `astro check`, build, pgTAP, smoke with fake AI through the local queue); on production a reload and a closed tab during batch 1 and batch 2 both end with a saved batch and one `ai_calls` row `ok`.

### Key Discoveries:

- Claim token = `claimed_at`; reusing it as the job identity makes the consumer idempotent against takeovers (`create_*` raises `batch_not_claimed`).
- `claim_next_flashcard_batch` checks the 120 s TTL before deciding a row is reclaimable (`…141252:79-88`); a `failed` row must be reclaimable regardless of age, or a retry within 120 s would read `batch_generating`.
- `readStateRows` returns `null` state when there is no ready batch and no fresh claim (`flashcard-repository.ts:208-212`); a failed batch 1 must make the state non-null so the page can show the error.
- Error messages live server-side (`src/lib/ai/errors.ts:12`, `src/lib/topics/errors.ts:57`); the stored code is turned into `{ code, message, retryable }` on the server, as every other API error.

## What We're NOT Doing

- Quiz generation (`quiz/index.ts`) and subtopic generation stay on their current path — no recorded latency > 30 s.
- No automatic retries (`max_retries: 0`), no "count quota on success" migration.
- No service-role RPC variants; the consumer acts as the user with the forwarded JWT.
- No Durable Objects or Workflows; no plan upgrade (unless Phase 3 shows the consumer exceeding Free CPU — then it is a separate decision).
- No dropping of the old `release_*` RPCs (the previous Worker version uses them during rollout/rollback).
- No changes to archived S-07 files; closing its criterion 4.5 is recorded in this change.

## Implementation Approach

Phase 1 adds the durable failure state on its own, wired into today's synchronous endpoints, so it ships and is verified before the queue exists. Phase 2 adds the custom Worker entry, the queue and the consumer, moves the generation functions out of the endpoints into a shared module, and switches POST to 202. Phase 3 verifies on production (reload, closed tab, consumer CPU on the current plan) and updates the docs.

## Critical Implementation Details

- **Timing & lifecycle** — The consumer must never throw: with `max_retries: 0` a thrown error just drops the message and leaves the claim to expire silently. Catch everything, mark the claim `failed`, ack. Before calling AI the consumer re-reads the batch row and skips (ack, no AI call, no quota) when it is no longer `generating` with the message's `claimed_at`.
- **Timing & lifecycle** — The forwarded access token must outlive the job: in the request, refresh the session when the token expires within 5 minutes before enqueueing. If the token still fails in the consumer (401), the claim cannot be marked failed (RPCs need `auth.uid()`); it expires after 120 s as today — log it.
- **State sequencing** — Production Supabase must have the Phase 1 migration before the Phase 1 code deploys, and the `flashcard-generation` queue must exist on the Cloudflare account before Phase 2 merges (Workers Builds deploys on merge and fails on a missing queue).

## Phase 1: Durable batch failure state

### Overview

A failed generation is stored on the batch row instead of being deleted, exposed in flashcard state/summary as an API-shaped error, and shown on the page. The current synchronous endpoints switch from release to fail.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/<timestamp>_flashcard_batch_failures.sql`

**Intent**: Let a claim end as `failed` with a reason, and let the next claim take it over at once.

**Contract**:
- `flashcard_batches.status` check becomes `('generating', 'ready', 'failed')`; new column `error_code text check (length(error_code) <= 50)`, null except on `failed`.
- New `fail_flashcard_batch_claim(p_topic_id uuid, p_seq integer, p_claimed_at timestamptz, p_error_code text) returns void`, `security definer`, `search_path = ''`: sets `status = 'failed', error_code = p_error_code` only where `topic_id`, `seq`, `user_id = auth.uid()`, `status = 'generating'` and `claimed_at = p_claimed_at` match; no-op otherwise. Covers batch 1 and 2+. Grant to `authenticated` only (revoke from `public`), as the existing functions.
- `create or replace` of `claim_flashcard_batch` and `claim_next_flashcard_batch`: on the conflict path a `failed` row is taken over regardless of `claimed_at` (`status = 'generating'`, `error_code = null`, `claimed_at = now()`), checked **before** the 120 s TTL test. Everything else unchanged (keep the header comment's sync note with `FLASHCARD_CLAIM_TTL_SECONDS`).
- `create or replace` of `create_flashcard_batch` and `create_next_flashcard_batch`: a row that is not `generating` (i.e. `failed`) raises `batch_not_claimed`.
- `release_*` functions untouched.
- Grep the other migrations for `flashcard_batches` status assumptions (study queue, deletes) and confirm `failed` rows are ignored wherever only `ready` batches are meant.

#### 2. pgTAP tests

**File**: `supabase/tests/database/flashcards.test.sql`, `supabase/tests/database/flashcard_next.test.sql`

**Intent**: Pin the new state transitions.

**Contract**: fail with the right token sets `failed` + code; wrong token / other account / ready batch is a no-op; claim of a failed row within 120 s succeeds and clears `error_code`; create on a failed row raises `batch_not_claimed`; status check rejects other values.

#### 3. Repository and state

**File**: `src/lib/topics/flashcard-repository.ts`

**Intent**: Mark failures and expose the latest one in state/summary.

**Contract**:
- `failFlashcardBatchClaim(supabase, topicId, seq, claimedAt, code: string): Promise<void>` — logs on RPC error like the release helpers. Release helpers stay exported until Phase 2 removes their callers.
- `BatchRow.status` gains `"failed"`; `readStateRows` selects `error_code`.
- `FlashcardSummary` (and so `FlashcardState`) gains `failed: { seq: number; error: { code: string; message: string; retryable: boolean } } | null` — the newest `failed` row whose `seq` is above the latest ready seq, only when there is no fresh claim. `summarize` returns non-null when there is a ready batch, a fresh claim **or** a failed row.
- The stored code maps to `{ code, message, retryable }` through the existing tables in `src/lib/ai/errors.ts` and `src/lib/topics/errors.ts` (export a lookup from each if none exists); an unknown code maps to `save_failed`.
- Check every caller that treats a non-null `FlashcardState`/`FlashcardSummary` as "has batches" (topic page, study pages, `hasReadyBatch`) still behaves with a failed-only state.

#### 4. Endpoints (still synchronous)

**File**: `src/pages/api/topics/[id]/flashcards/index.ts`, `src/pages/api/topics/[id]/flashcards/next.ts`

**Intent**: Failures mark the claim instead of deleting it.

**Contract**: each `release*Claim` call becomes `failFlashcardBatchClaim(…, seq, claimedAt, code)` with the AI error code or the `create_*` error code (`batch_not_claimed` needs no mark — the row is not ours). Responses unchanged.

#### 5. Page

**File**: `src/components/topics/FlashcardBatch.tsx`

**Intent**: Show a stored failure like a request error.

**Contract**: when there is no local `error`, nothing is generating and `state.failed` is set, render the same destructive `Alert` with `state.failed.error.message`; "Spróbuj ponownie" (when `retryable`) calls `generate()` for seq 1 or `generateNext(seq)` otherwise. A successful claim replaces the state, so the alert disappears. Use existing `ui` components only.

### Success Criteria:

#### Automated Verification:

- Migration applies on a reset local database: `npm run db:reset`
- pgTAP passes: `npm run db:test`
- Unit tests pass: `npm test`
- Lint and types pass: `npm run lint` and `npx astro check`
- Smoke passes locally against `npm run preview` with `AI_MODE=fake`: `npm run smoke:topics`

#### Manual Verification:

- Migration applied to production Supabase before the Phase 1 merge
- Forced AI failure shows the message, survives reload, retry generates the batch (locally: fake provider fixture throwing `FakeAiFailure`)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Queue consumer and async endpoints

### Overview

A custom Worker entry exports the Astro handler plus a `queue()` consumer. POST endpoints claim, enqueue and answer 202; the consumer runs the generation with the user's access token.

### Changes Required:

#### 1. Worker entry and bindings

**File**: `src/worker.ts`, `wrangler.jsonc`

**Intent**: One Worker serves Astro and consumes the generation queue.

**Contract**:
- `src/worker.ts`: `export default { fetch: handle, queue }`, `handle` from `@astrojs/cloudflare/handler`; `queue(batch)` passes each message body to `runFlashcardJob` and acks it (never throws).
- `wrangler.jsonc`: `main: "./src/worker.ts"`; `queues.producers: [{ binding: "FLASHCARD_JOBS", queue: "flashcard-generation" }]`; `queues.consumers: [{ queue: "flashcard-generation", max_batch_size: 1, max_retries: 0 }]`. If the `previews` section accepts queues, give previews their own queue as with `SESSION`; otherwise leave a comment that previews share the production queue (previews cannot sign in, so they never enqueue).
- Type `FLASHCARD_JOBS` for `import { env } from "cloudflare:workers"` the way the project types other bindings.

#### 2. Token client and AI entry

**File**: `src/lib/supabase.ts`, `src/lib/ai/index.ts`

**Intent**: The consumer acts as the user without cookies.

**Contract**: `createTokenClient(accessToken: string): SupabaseClient | null` — `@supabase/supabase-js` client with `Authorization: Bearer <token>`, no session persistence or auto-refresh. `getAi`'s second parameter widens to `Pick<User, "id"> | null`.

#### 3. Generation module

**File**: `src/lib/topics/flashcard-generation.ts` (new)

**Intent**: Single home for enqueueing and running a flashcard job; the endpoint files keep only validation, claim and response.

**Contract**:
- `flashcardJob` zod schema: `{ kind: "first" | "next", topicId: uuid, seq: int ≥ 1, claimedAt: string, userId: uuid, accessToken: string }`.
- `enqueueFlashcardJob(supabase, job without accessToken): Promise<RepoResult<null>>` — takes the access token from `supabase.auth.getSession()`, calls `refreshSession()` when it expires within 5 minutes, sends to `FLASHCARD_JOBS`. On failure the caller marks the claim `failed` with `save_failed` and returns that error.
- `runFlashcardJob(body: unknown): Promise<void>` — parse (invalid → log, return); token client; skip if the batch row is no longer `generating` with this `claimedAt`; load topic, quiz state and (for `next`) flashcard state; build the request with the logic now in `generateFlashcards` / `generateNextBatch` (subtopic percents, `nextBatchSubtopics`, existing fronts); `getAi(client, { id: userId }).call(…)`; `toFlashcardRows` + `create*`; on any failure `failFlashcardBatchClaim` with the code; outer `try/catch` marks `save_failed`. Never throws.

#### 4. Endpoints

**File**: `src/pages/api/topics/[id]/flashcards/index.ts`, `src/pages/api/topics/[id]/flashcards/next.ts`

**Intent**: Claim, enqueue, answer at once.

**Contract**: all existing checks and the claim unchanged; then `enqueueFlashcardJob`; then `202` with `{ data: FlashcardState }` read after the claim (`generating` set) and the `X-AI-Mode` header from the resolved mode. The `waitUntil` code and the in-file generation functions are removed. Errors keep the existing `topicErrorResponse` shape.

#### 5. Client

**File**: `src/components/topics/FlashcardBatch.tsx`

**Intent**: The 202 state starts the existing polling.

**Contract**: no structural change expected — `run` stores the returned state, the polling effect starts because `generating` is set and `busy` is null. Update the comments that describe `waitUntil`.

#### 6. Tests and smoke

**File**: `src/lib/topics/flashcard-generation.test.ts`, `scripts/smoke-topics.mjs`

**Intent**: Cover the job contract and the async API end to end through the local queue.

**Contract**:
- Vitest: job schema accepts a valid message and rejects missing token / bad uuid / seq 0; the stored-code → error-body mapping (including unknown → `save_failed`).
- Smoke: POST batch 1 and batch 2 expect `202`, `X-AI-Mode: fake` and `data.generating`; a `waitForBatch` helper polls `/summary` until `generating` is null (bounded timeout), then reads `GET /flashcards` for the existing card/allocation checks. The `remaining` assertions become an equivalent check on the user's `ai_calls` count through the service-key client the script already uses. The "only one first batch" check runs after the wait.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- Lint and types pass: `npm run lint` and `npx astro check`
- Build succeeds with the custom entry: `npm run build`
- pgTAP passes: `npm run db:test`
- Smoke passes against `npm run preview` with fake AI through the local queue: `npm run smoke:topics`
- CI is green on the PR

#### Manual Verification:

- Queue `flashcard-generation` exists on the Cloudflare account before merge (`npx wrangler queues create flashcard-generation`)
- Locally the flashcards page generates batch 1 and batch 2 through the queue (`npm run preview`, fake AI)
- The Workers Builds preview build for the PR still succeeds

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Production verification and close-out

### Overview

Confirm on production that reloads and closed tabs no longer lose batches and that the consumer fits the current Workers plan, then record the new architecture.

### Changes Required:

#### 1. Docs and rules

**File**: `context/foundation/infrastructure.md`, `src/lib/ai/AGENTS.md`

**Intent**: Record the queue and the background-call rule where the next agent will look.

**Contract**: `infrastructure.md` — the `flashcard-generation` queue, its limits on the current plan and the consumer CPU observed in Phase 3; `src/lib/ai/AGENTS.md` — one rule: an AI call that can exceed 30 s runs in the queue consumer with the user's forwarded token, never under `waitUntil`; `max_retries` stays 0.

#### 2. Change notes

**File**: `context/changes/durable-flashcard-generation/change.md`

**Intent**: Record that S-07 manual criterion 4.5 (reload part) and follow-up F2 are closed by this change, with the production evidence.

**Contract**: `## Notes` entry only.

### Success Criteria:

#### Automated Verification:

- Lint passes after the doc edits: `npm run lint`

#### Manual Verification:

- Production reload during batch 1 ends with the batch saved and one `ai_calls` row `ok` (test topic; reload ~5 s after "Wygeneruj fiszki")
- Production closed tab during batch 2 ends with the batch saved and one `ai_calls` row `ok` (close right after starting, reopen after ~60 s)
- Consumer logs show no CPU-limit errors; CPU per invocation recorded in `infrastructure.md`
- Quiz and study flows still work on production

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- Job message schema (valid, missing token, bad uuid, seq < 1)
- Stored error code → `{ code, message, retryable }`, unknown → `save_failed`
- `summarize`: failed-only batch 1 gives non-null state with `failed`; a fresh claim hides an older failure; a failure below the latest ready seq is ignored

### Integration Tests:

- pgTAP: fail/claim/create transitions and account isolation for `fail_flashcard_batch_claim`
- Smoke (CI, fake AI): batch 1 and batch 2 through the local queue with 202 + polling

### Manual Testing Steps:

1. Local forced AI failure → message survives reload → retry succeeds
2. Production reload during batch 1 → batch saved
3. Production closed tab during batch 2 → batch saved
4. Workers logs: consumer CPU under the plan limit

## Performance Considerations

POST now answers in well under a second (claim + enqueue + one state read). The consumer's wall-clock is the AI call (≤ 90 s timeout) inside the 15 min consumer limit. Its CPU is the same work today's request does (zod parse, row mapping) — the open question is only whether Free counts consumer CPU at 10 ms; Phase 3 measures it.

## Migration Notes

- Apply the Phase 1 migration to production before deploying Phase 1. The previous Worker version keeps working with it: it still calls `release_*` and ignores `failed` rows.
- Rollback of Phase 2 = redeploy the previous Worker version; messages already in the queue are lost and their claims expire after 120 s (the current behaviour).

## References

- Related research: `context/changes/durable-flashcard-generation/research.md`
- Origin: `context/archive/2026-10-29-next-batch-and-subtopic-mastery/follow-ups/review-fixes.md` (F2)
- Claim/token pattern: `supabase/migrations/20261029141252_next_flashcard_batches.sql:15-189`
- Current endpoints: `src/pages/api/topics/[id]/flashcards/index.ts:28-88`, `next.ts:108-184`
- Polling contract: `src/components/topics/FlashcardBatch.tsx:64-100`
- AI rules: `src/lib/ai/AGENTS.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Durable batch failure state

#### Automated

- [x] 1.1 Migration applies on a reset local database: `npm run db:reset` — 5a1c6a6
- [x] 1.2 pgTAP passes: `npm run db:test` — 5a1c6a6
- [x] 1.3 Unit tests pass: `npm test` — 5a1c6a6
- [x] 1.4 Lint and types pass: `npm run lint` and `npx astro check` — 5a1c6a6
- [x] 1.5 Smoke passes locally against `npm run preview` with `AI_MODE=fake`: `npm run smoke:topics` — 5a1c6a6

#### Manual

- [x] 1.6 Migration applied to production Supabase before the Phase 1 merge — 5a1c6a6
- [ ] 1.7 Forced AI failure shows the message, survives reload, retry generates the batch

### Phase 2: Queue consumer and async endpoints

#### Automated

- [x] 2.1 Unit tests pass: `npm test` — b5d8a00
- [x] 2.2 Lint and types pass: `npm run lint` and `npx astro check` — b5d8a00
- [x] 2.3 Build succeeds with the custom entry: `npm run build` — b5d8a00
- [x] 2.4 pgTAP passes: `npm run db:test` — b5d8a00
- [x] 2.5 Smoke passes against `npm run preview` with fake AI through the local queue: `npm run smoke:topics` — b5d8a00
- [x] 2.6 CI is green on the PR — b5d8a00

#### Manual

- [x] 2.7 Queue `flashcard-generation` exists on the Cloudflare account before merge — b5d8a00
- [ ] 2.8 Locally the flashcards page generates batch 1 and batch 2 through the queue
- [x] 2.9 The Workers Builds preview build for the PR still succeeds — b5d8a00

### Phase 3: Production verification and close-out

#### Automated

- [x] 3.1 Lint passes after the doc edits: `npm run lint` — b5bc49b

#### Manual

- [x] 3.2 Production reload during batch 1 ends with the batch saved and one `ai_calls` row `ok` — b5bc49b
- [ ] 3.3 Production closed tab during batch 2 ends with the batch saved and one `ai_calls` row `ok`
- [x] 3.4 Consumer logs show no CPU-limit errors; CPU per invocation recorded in `infrastructure.md` — b5bc49b
- [x] 3.5 Quiz and study flows still work on production — b5bc49b
