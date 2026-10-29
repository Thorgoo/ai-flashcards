# Durable flashcard generation — Plan Brief

> Full plan: `context/changes/durable-flashcard-generation/plan.md`
> Research: `context/changes/durable-flashcard-generation/research.md`

## What & Why

Reloading or closing the tab while flashcards are being generated loses the batch: the AI call (33–36 s) runs under `ctx.waitUntil`, which Cloudflare stops ~30 s after the client disconnects. The user loses one of 20 daily generations and gets nothing. Confirmed on production for batch 2 (S-07 follow-up F2); batch 1 has the same exposure.

## Starting Point

`POST /flashcards` and `POST /flashcards/next` claim the batch (token = `claimed_at`), then run AI + save under `waitUntil`. On failure the claim row is deleted, so a reloaded page cannot tell what happened. The page already polls `/summary` every 2 s while a claim is fresh. All RPCs use `auth.uid()`.

## Desired End State

POST claims, enqueues a job and answers 202 right away. A Cloudflare Queue consumer in the same Worker does AI + save as the user. A reload or a closed tab ends with the batch saved. A failed generation is stored on the batch row, and the page shows the real reason with "Spróbuj ponownie", also after a reload.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Background mechanism | Cloudflare Queue, `max_batch_size: 1` | 15 min wall-clock, available on Free, keeps preview URLs, no DO classes/migrations | Research / Plan |
| Consumer auth | Forward the user's access token in the message | No migration; RLS and account isolation work as today | Plan |
| Retries and quota | `max_retries: 0`; quota still counted at `begin_ai_call` | Matches `src/lib/ai/AGENTS.md` (only the user retries) | Plan |
| Failure visibility | `failed` status + `error_code` on `flashcard_batches`; a new claim takes it over | The page shows the specific message (e.g. daily limit) even after a reload | Plan |
| API contract | 202 with the current `FlashcardState` (`generating` set) | Staying on the page and reloading take the same polling path | Plan |
| Scope | Flashcards only (batch 1 and 2+) | The quiz has no recorded latency above 30 s | Plan |
| Consumer CPU on Free | Measured on production in Phase 3 | Today's request already does the same CPU work within the plan | Research / Plan |

## Scope

**In scope:**
- Migration: `failed` + `error_code`, `fail_flashcard_batch_claim`, claim/create updated, pgTAP
- `failed` in flashcard state/summary and on the flashcards page
- Custom Worker entry (`src/worker.ts`), queue binding, `queue()` consumer, token-based Supabase client
- Async endpoints (202), smoke rewritten to poll, docs (`infrastructure.md`, `src/lib/ai/AGENTS.md`)

**Out of scope:**
- Quiz and subtopic generation, automatic retries, count-on-success quota
- Service-role RPCs, Durable Objects, Workflows, a plan upgrade
- Removing the old `release_*` RPCs (needed for rollback)

## Architecture / Approach

Request: checks → `claim_*` (token) → `enqueueFlashcardJob` (`{kind, topicId, seq, claimedAt, userId, accessToken}`, token refreshed if it expires within 5 min) → 202 + state. Consumer: parse → skip if the claim is no longer ours → rebuild the prompt from the database → `getAi(...).call` → `create_*` with the token. Any failure goes to `fail_flashcard_batch_claim(code)`, and the consumer never throws. The page polls `/summary` and shows the batch or the stored error.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Durable batch failure state | Failures stored and shown; sync endpoints mark instead of delete | A failed-only state breaks pages that treat non-null state as "has batches" |
| 2. Queue consumer and async endpoints | Generation survives reload; 202 + polling; smoke via local queue | `astro:env` / local queue simulation inside `queue()` under `astro preview` (unverified) |
| 3. Production verification and close-out | Reload/closed-tab proof on prod; CPU measured; docs updated | Consumer exceeds Free CPU → separate decision on Paid |

**Prerequisites:** Phase 1 migration applied to production Supabase before the Phase 1 deploy; queue `flashcard-generation` created on the Cloudflare account before the Phase 2 merge.
**Estimated effort:** ~3 sessions, one per phase.

## Open Risks & Assumptions

- Queues consumer CPU on Free is not documented; the assumption is that it fits like today's request does. Phase 3 measures it.
- A token that fails in the consumer (401) cannot mark the claim failed; the claim expires after 120 s, as today.
- With `max_batch_size: 1`, delivery is assumed to be prompt enough for the 120 s claim TTL (90 s AI timeout + saves).
- Previews may share the production queue if `previews` does not accept queues; previews cannot sign in, so they never enqueue.

## Success Criteria (Summary)

- A reload or a closed tab during batch 1 or batch 2 on production ends with the batch saved and one generation used
- A failed generation shows its real reason and a retry, also after a reload
- CI green with the smoke running through the local queue
