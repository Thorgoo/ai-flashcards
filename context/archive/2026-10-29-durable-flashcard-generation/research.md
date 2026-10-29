---
date: 2026-10-29T17:43:37+01:00
researcher: Claude (Opus 5.5)
git_commit: 027a4f4
branch: main
repository: ai-flashcards
topic: "How to make flashcard generation survive a reload or closed tab on Cloudflare Workers"
tags: [research, codebase, flashcards, ai, cloudflare-workers, queues, durable-objects, workflows, supabase]
status: complete
last_updated: 2026-10-29
last_updated_by: Claude (Opus 5.5)
---

# Research: Durable flashcard generation

**Date**: 2026-10-29T17:43:37+01:00
**Researcher**: Claude (Opus 5.5)
**Git Commit**: 027a4f4 (local; archive commit not yet pushed)
**Branch**: main
**Repository**: ai-flashcards

## Research Question

From follow-up F2 of S-07 (`context/archive/2026-10-29-next-batch-and-subtopic-mastery/follow-ups/review-fixes.md`): a reload during flashcard generation loses the batch, because the AI call (33–36 s) runs under `ctx.waitUntil`, which Cloudflare stops ~30 s after the client disconnects. What must a background consumer (Queue / Durable Object / Workflow) reproduce from the current code, which Cloudflare mechanism fits the current plan and the Astro adapter, and what blocks or constrains each option?

## Summary

- **Every Cloudflare option outlives a 90 s Anthropic call; `waitUntil` does not.** `waitUntil` extends work by up to 30 s after the response or disconnect on both plans. Queue consumers and DO alarms get 15 min wall-clock; a Workflow step has no wall-clock limit (10 min default per-attempt timeout). All three are available on the Free plan.
- **The real constraint is CPU on Free, not wall-clock.** Workflows: 10 ms CPU per step on Free (documented). Queues: consumer CPU defaults to 30 s, but the Workers pricing page lists 10 ms per invocation on Free without a consumer exception — unverified for Free. Durable Objects: 30 s CPU per request/alarm, no separate Free figure. Parsing and validating ~10 cards of AI JSON may exceed 10 ms. Which Workers plan the project uses is not recorded anywhere in the repo.
- **Durable Objects stop Workers Builds from generating preview/version URLs**, and DO migrations apply only through `wrangler deploy`. Queues and Workflows have no such documented caveat.
- **The consumer cannot use a service-role key with the current RPCs.** All 8 RPCs in the flow (`begin_ai_call`, `finish_ai_call`, claim/release/create for batch 1 and for batches 2+) read the user from `auth.uid()` and are granted only to `authenticated`. A consumer must either forward the user's access token (JWT, ~1 h) or get new service-role variants taking `p_user_id`.
- **The Astro adapter supports a custom entry.** `wrangler.jsonc` `main` is kept by the adapter and `@astrojs/cloudflare/handler` exports `handle(request, env, ctx)`, so one Worker file can export `{ fetch: handle, queue() }` plus DO/Workflow classes. Installed adapter is 14.3.1; changelog fixes for DO exports with prerendered pages land in 14.3.1 and 14.3.2.
- **The client side already fits an async model.** The flashcards page polls `GET /flashcards/summary` every 2 s while a fresh claim exists; the claim TTL (120 s) is the only thing tying "generating" to wall-clock and would need to cover consumer latency plus retries.
- **The smoke test expects a synchronous POST** (`data` + `remaining` in the POST response); an async 202 means rewriting those checks to poll.

## Detailed Findings

### Endpoints with the same exposure

- Batch 1: `src/pages/api/topics/[id]/flashcards/index.ts:28-51` — checks → `claimFlashcardBatch` (:40) → `generateFlashcards` (:53-88: `getAi().call` → `createFlashcardBatch(…, claimedAt)`, `releaseFlashcardBatchClaim` on failure); `cf?.waitUntil(work)` (:48-49) and `return await work` (:50). Recorded latencies: 26.8 s and 35.0 s (`context/archive/2026-10-24-first-weak-subtopic-batch/reviews/impl-review.md:32`), 36 024 ms (`context/archive/2026-10-29-next-batch-and-subtopic-mastery/change.md:16`).
- Batches 2+: `src/pages/api/topics/[id]/flashcards/next.ts` — body `{seq}`; reads full flashcard state and quiz state before the claim because the prompt needs existing fronts and mastery; `waitUntil` as above. Recorded latency: 32 654 ms (same `change.md:16`).
- Quiz: `src/pages/api/topics/[id]/quiz/index.ts` uses the same claim + `waitUntil` pattern (claim TTL 90 s, generation timeout default 60 s); no latency recorded. Subtopic generation (`generate.ts:19`) and open-answer grading (`study/answer.ts:42`) call `getAi` directly without `waitUntil` or a claim. Only the two flashcard endpoints have recorded latencies above 30 s.

### AI call path and quota

- `getAi(supabase, user)` (`src/lib/ai/index.ts:18-34`) reads `AI_MODE`, `ANTHROPIC_API_KEY`, `SUPABASE_URL` from `astro:env/server` (:2); fake mode only when the Supabase host is local (`src/lib/ai/mode.ts:13-25`); fake provider picks a fixture by `request.task` (`src/lib/ai/fake.ts:14-20`); the quota wraps the **user's** Supabase client (:32).
- `callAi` (`src/lib/ai/call.ts:86-168`): `begin_ai_call` RPC (`quota.ts:12`) → provider call with `timeoutMs` (flashcards: 90 s, `flashcards-task.ts:156,187`; default generation 60 s, grading 20 s, `call.ts:11`) → zod validation → `finish_ai_call`. No retries.
- Quota is counted when the pending row is inserted, whatever the outcome (`supabase/migrations/20261018092416_create_ai_calls.sql:1-4, 33-73`): 20 generations / 100 gradings per Warsaw day; `remaining = limit - used - 1`. `finish_ai_call` updates only `where id = p_call_id and user_id = auth.uid() and status = 'pending'` (:95-102), so a row never finished stays `pending` and still counts.

### Auth dependency of a background consumer

- All 8 RPCs in the flashcard generation path are `security definer`, take the user from `auth.uid()` and raise `42501` when it is null: `begin_ai_call` / `finish_ai_call` (`20261018092416_create_ai_calls.sql:40,102`); claim/release/create for batch 1 (`20261025182503_claim_tokens_and_option_nulls.sql:23-160`, TTL 120 s at :67); the `*_next_*` trio (`20261029141252_next_flashcard_batches.sql:15-189`, TTL at :86). Grants: `authenticated` only (`…141252:187-189`, `…182503:301-306`). `ai_calls.user_id` defaults to `auth.uid()`.
- A service-role client has no `auth.uid()`, so these RPCs would fail under it. Options: (a) forward the user's access token in the message/params and build a client with `Authorization: Bearer <jwt>` (token lifetime ~1 h covers a ~36 s job, but not long retry delays); (b) add service-role RPC variants with explicit `p_user_id` (new migrations, grants to `service_role`, and the account-isolation guarantees then rest on the consumer).
- `SUPABASE_SECRET_KEY` exists in `.dev.vars` but not in the env schema (`astro.config.mjs:18-33`); no server code builds a service-role client — the only client is cookie-based (`src/lib/supabase.ts:5-9`); the key is used only by `scripts/smoke-topics.mjs:20`.

### Runtime plumbing and the Astro adapter

- Installed `@astrojs/cloudflare` 14.3.1 (`node_modules/@astrojs/cloudflare/package.json:4`). The adapter keeps a custom wrangler `main`: `main: config.main ?? "@astrojs/cloudflare/entrypoints/server"` (`dist/wrangler.js:36`); `./handler` is a public export (`package.json:31`). The default entry is `export default { fetch: handle }`.
- `locals.cfContext` is the ExecutionContext (`dist/utils/cf-helpers.js:23-26`); bindings come from `import { env } from "cloudflare:workers"` (`locals.runtime.env` throws, :30-33). The handler module initialises `astro:env` from the `cloudflare:workers` env at load (`dist/utils/handler.js:1,31`) — so `getAi`'s `astro:env` reads probably work inside `queue()`/`alarm()` when the custom entry imports the handler; untested.
- The prerender worker strips `queues` (keeps producers), `durable_objects`, `migrations`, `workflows` (`dist/index.js:137-150`), i.e. the adapter anticipates these bindings.
- Astro docs (cloudflare integration guide, v14.4.2): custom `main` file importing `handle` from `@astrojs/cloudflare/handler` and exporting extra handlers/classes; `workerEntryPoint` / `createExports()` were removed in v13.0.0. Changelog: 13.1.8 fixes `ERR_MULTIPLE_CONSUMERS` with Queues + prerendered pages; 14.3.1 fixes DO exports with prerendered pages; 14.3.2 fixes builds with `exports`-declared DOs. https://docs.astro.build/en/guides/integrations-guide/cloudflare/ , https://github.com/withastro/astro/blob/main/packages/integrations/cloudflare/CHANGELOG.md
- Current `wrangler.jsonc`: default `main`, `SESSION` KV (prod + previews), assets; no queues, DOs or workflows.

### Cloudflare options (docs checked 2026-10-29)

| | Queues | Durable Object + alarm | Workflows | `waitUntil` only (today) |
|---|---|---|---|---|
| Free plan | yes; 10 000 ops/day (~3 ops/message), 24 h retention | yes, SQLite-backed; 100k req/day, 13 000 GB-s/day | yes; 100 concurrent instances, 3-day state | yes |
| Wall-clock for a 90 s fetch | 15 min per consumer invocation | 15 min per alarm | unlimited per step (10 min default attempt timeout) | 30 s after response/disconnect → fails |
| CPU | default 30 s (up to 5 min); Free figure **unverified** (pricing lists 10 ms/invocation on Free) | 30 s default (up to 5 min); no separate Free figure | **10 ms per step on Free**; 30 s–5 min Paid | 10 ms Free |
| Retries | `max_retries` 3 default (≤100), DLQ, `delaySeconds` ≤ 24 h | hand-written (re-set alarm) | 5 per `step.do` default, exponential backoff | none |
| Astro integration | custom `main` exporting `queue()` | custom `main` exporting the class + `migrations` | custom `main` exporting the class (not in Astro docs) | none |
| Local dev | local simulation (wrangler dev, Vite plugin) | local simulation | local simulation | yes |
| Preview caveat | none documented | **no Version/Preview URLs for Workers that implement a DO**; migrations only via `wrangler deploy` | none documented (unverified) | none |

Sources: https://developers.cloudflare.com/workers/platform/limits/ (updated 2026-10-29), https://developers.cloudflare.com/workers/platform/pricing/ (2026-10-02), https://developers.cloudflare.com/queues/platform/limits/ and /pricing/ (2026-04-21), https://developers.cloudflare.com/queues/configuration/configure-queues/ (2026-04-21), https://developers.cloudflare.com/queues/configuration/javascript-apis/ (2026-07-06, same Worker may be producer and consumer), https://developers.cloudflare.com/durable-objects/platform/limits/ (2026-10-29), /pricing/ (2026-10-18), /concepts/durable-object-lifecycle/ (2026-10-15), https://developers.cloudflare.com/workflows/reference/limits/ (2026-09-21), /build/sleeping-and-retrying/ (2026-09-24), /build/trigger-workflows/ (2026-10-15), https://developers.cloudflare.com/workers/configuration/previews/ (2026-09-22), https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/ (2026-10-18), https://developers.cloudflare.com/workers/development-testing/bindings-per-env/ (2026-06-25).

Notes:
- Queues: whole batch retried if `queue()` throws; with `max_batch_size: 1` each generation is its own invocation. A retry re-calls Anthropic and starts a new `ai_calls` row (another generation used) unless the consumer is made idempotent (e.g. skip when the batch is already `ready`).
- DO: whether an outbound fetch survives the caller disconnecting is not stated explicitly; the documented robust pattern is `setAlarm(Date.now())` in the request and the work in `alarm()`. Billing is wall-clock GB-s: a 90 s call at 128 MB ≈ 11.25 GB-s, so the Free 13 000 GB-s/day covers roughly 1 100 such calls/day (derived).
- Anthropic Message Batches survive a reload but "most batches finish in less than 1 hour" — unsuitable for a 2 s poll UX (https://platform.claude.com/docs/en/build-with-claude/batch-processing). No sourced way without a new binding outlives the 30 s `waitUntil`.

### Client side

- `src/components/topics/FlashcardBatch.tsx`: `POLL_MS = 2000` (:30); while `state.generating` and not busy, polls `GET …/summary` and does one full `refresh()` when `generating` clears (:64-67, 93-94); `batch_generating`/`batch_exists` show no error (:55). `generating` = a `generating` row with claim younger than `FLASHCARD_CLAIM_TTL_SECONDS = 120` (`flashcard-repository.ts:185,215`; `flashcards-task.ts:13`); an expired claim reads as no batch.
- `QuizRunner.tsx`: drops `?start=1` before generating (:58-62), refreshes on `quiz_generating` (:43-46), polls `GET /quiz` every 2 s while generating (:74-75); quiz claim TTL 90 s (`quiz-repository.ts:89-91`).

### Tests and CI

- `.github/workflows/ci.yml`: build job (lint, vitest, `astro check`, build); smoke job starts local Supabase, runs `supabase test db`, writes `.dev.vars` with `AI_MODE=fake` (:56-60), runs `npm run build` and `npm run preview -- --port 4321` (:61-66), then `smoke` and `smoke:topics` with the service key (:70). `astro preview` runs the built Worker through `@cloudflare/vite-plugin` (workerd), so local Queue/DO/Workflow simulation should apply — not verified.
- `scripts/smoke-topics.mjs` expects POST /flashcards and POST /flashcards/next to answer synchronously with `data` and `remaining` (≈ :308-323, :532-550, e.g. `remaining === GENERATION_LIMIT - 4`).

## Code References

- `src/pages/api/topics/[id]/flashcards/index.ts:28-88` — batch 1 claim → AI → save, under `waitUntil`
- `src/pages/api/topics/[id]/flashcards/next.ts` — batches 2+, same pattern, needs state + quiz for the prompt
- `src/lib/ai/index.ts:18-34`, `src/lib/ai/call.ts:86-168`, `src/lib/ai/quota.ts:12` — AI call, quota, `astro:env`
- `supabase/migrations/20261018092416_create_ai_calls.sql:33-102` — quota counted at `begin_ai_call`; `finish_ai_call` needs `auth.uid()`
- `supabase/migrations/20261025182503_claim_tokens_and_option_nulls.sql:23-160,301-306` — batch 1 claim/token RPCs
- `supabase/migrations/20261029141252_next_flashcard_batches.sql:15-189` — batch 2+ claim/token RPCs
- `src/lib/supabase.ts:5-9` — cookie-based client only
- `node_modules/@astrojs/cloudflare/dist/wrangler.js:36`, `package.json:31` — custom `main` kept; `./handler` export
- `src/components/topics/FlashcardBatch.tsx:30,55,64-67,93-94` — polling contract
- `.github/workflows/ci.yml:56-70`, `scripts/smoke-topics.mjs:308-323,532-550` — CI start-up and synchronous POST expectations

## Architecture Insights

- The claim-before-AI + token pattern already separates "reserve" from "do the work": the request could claim and enqueue, and the consumer could call AI and `create_*` with the token. The claim TTL then has to exceed queue latency + AI time (+ retries), or the consumer must refresh the claim.
- Idempotency today rests on the claim token: `create_*` refuses a taken-over claim (`batch_not_claimed`) and a ready batch (`batch_exists`). A retried consumer can rely on that to avoid duplicates, but each retry still begins a new `ai_calls` row (quota).
- The prompt for batches 2+ is built from state read at request time (`next.ts`); a consumer can rebuild it from the database or receive it in the message (Queue message limit 128 KB; prompt worst case ~90k chars per the S-07 review).

## Historical Context (from prior changes)

- `context/archive/2026-10-18-ai-call-guardrails/plan.md:38,43`, `plan-brief.md:24` — client disconnect accepted as a named risk; no Durable Objects or KV at that time.
- `context/archive/2026-10-22-diagnostic-quiz-by-subtopic/reviews/impl-review.md:41-63` — quiz reload burned quota on production; claim + `waitUntil` + polling introduced; notes `waitUntil` ≈ 30 s.
- `context/archive/2026-10-24-first-weak-subtopic-batch/reviews/impl-review.md:26-43`, `follow-ups/review-fixes.md:3-4` — S-04 accepted watching `ai_calls` (Fix A); moving to Queue/DO (Fix B) deferred, "Queues availability on the current plan" named as a blind spot.
- `context/archive/2026-10-29-next-batch-and-subtopic-mastery/reviews/impl-review.md:45-52`, `follow-ups/review-fixes.md`, `change.md:18` — S-07 confirmed the loss on production for batch 2 and opened this change.
- `context/foundation/infrastructure.md:32,48,92-93` — Free: 10 ms CPU, 50 subrequests, `waitUntil` ≈ 30 s; suggested mitigations: count quota only on successful save, or idempotent request ID; Paid $5/mo named as the safety valve.

## Related Research

- `context/archive/2026-10-24-first-weak-subtopic-batch/research.md` (:68 flags subtopic generation as a related gap)

## Open Questions

1. **Workers plan (user decision / fact to check in the dashboard):** Free or Paid? On Free, Workflows' 10 ms CPU per step and the unverified Queues consumer CPU make Durable Objects the only option with a documented 30 s CPU budget; on Paid, Workflows or Queues are cleaner and keep preview URLs.
2. **Preview URLs vs Durable Objects:** is losing Workers Builds preview URLs acceptable? (OAuth sign-in already did not work on previews in S-07 testing, so manual checks run on production.)
3. **Auth in the consumer:** forward the user's JWT (no migration; token expiry bounds retries) or add service-role RPC variants with `p_user_id` (migrations; consumer becomes a trust boundary)?
4. **Quota on retries/failures:** keep "counted at begin" (each retry uses a generation) or change to count on success, as `infrastructure.md:93` suggests?
5. **Scope:** flashcards only (batch 1 and 2+) or also the quiz endpoint (same pattern, no recorded latency > 30 s)?
6. **API contract:** POST returns 202 + polling (smoke rewrite) or keeps a synchronous response when the client stays connected?
7. **Unverified:** Queues consumer CPU on Free; `astro:env` inside `queue()`/`alarm()`; local Queue/DO simulation under `astro preview` in CI. A small spike on a branch would settle all three.
