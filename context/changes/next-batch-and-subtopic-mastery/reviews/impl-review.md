<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: S-07: Opanowanie podtematów i kolejna partia

- **Plan**: context/changes/next-batch-and-subtopic-mastery/plan.md
- **Scope**: Full plan (phase 4 has one open manual row, 4.5)
- **Reviewed phases**: 1, 2, 3, 4
- **Date**: 2026-10-29
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 5 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

Plan adherence notes (benign, no action): `next.ts:35-40` checks `batch_exists` before `next_batch_locked` (matches SQL; the plan's order would have answered differently from the claim); `next.ts:24` reads the body before `loadTopic` (as `study/answer.ts`); `quiz.astro` is unchanged and still correct with `state !== null`. SQL and TS agree on every edge case (empty batch, 0-card subtopic, fresh claim), and no AI call can happen on a request the claim would refuse.

## Findings

### F1 — Full flashcard state on every page load and every 2 s poll

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/flashcard-repository.ts:117-121, src/components/topics/FlashcardBatch.tsx:79-87
- **Detail**: `getFlashcardState` reads every card of the topic with all columns (incl. `explanation` ≤ 1500 chars, `answer`, `options`). It runs on the topic, study, quiz and flashcards pages and on every 2 s poll during generation (~17 polls per 33–36 s batch). The payload grows by 10 cards per batch without bound; topic/study/quiz pages only need `hasReadyBatch` and mastery counts.
- **Fix A ⭐ Recommended**: Add a light state read (batches + `subtopic_id, batch_id, stage` per card, no text columns) for the topic/study/quiz pages and for polling; fetch the full state once `generating` clears.
  - Strength: Keeps pages and polls O(cards × 3 small columns); the full read stays only where cards are rendered.
  - Tradeoff: Two read shapes of the same state to keep consistent; the island must switch from the light poll to one full fetch.
  - Confidence: MED — straightforward, but touches the repository, three pages and the island.
  - Blind spot: Not measured; at MVP sizes (a few batches) the cost may be negligible.
- **Fix B**: Record as follow-up and measure payload size after a few real batches.
  - Strength: No code now; decide on evidence.
  - Tradeoff: Cost grows silently with each batch.
  - Confidence: HIGH — MVP topics will have few batches for weeks.
  - Blind spot: Nobody owns the measurement yet.
- **Decision**: FIXED (Fix A) — getFlashcardSummary for the topic/study/quiz pages and GET /flashcards/summary for polling; full state read once the generation ends

### F2 — 4.5 not met: reload during generation loses the batch (F1 from S-04)

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Success Criteria
- **Location**: src/pages/api/topics/[id]/flashcards/next.ts:44-50 (and the batch 1 endpoint)
- **Detail**: Verified on production: a reload during batch 2 generation left `ai_calls` `pending`, used one generation and saved nothing; the claim expired after 120 s and the button became active again. `waitUntil` keeps ~30 s after disconnect while generation takes 33–36 s, so a reload almost always loses the work (batch 1 too). Accepted risk in the plan, recorded as follow-up in change.md.
- **Fix**: Open a separate change for durable generation (Cloudflare Queue or Durable Object consumer; the page keeps polling).
  - Strength: Removes the loss entirely for both batch endpoints; the claim/token model already fits a background consumer.
  - Tradeoff: New infrastructure (bindings, local testing, wrangler config) — several sessions.
  - Confidence: MED — pattern is standard, but the repo has no queue yet.
  - Blind spot: Workers plan limits for queue consumers not checked.
- **Decision**: QUEUED — separate change for durable generation, see follow-ups/review-fixes.md

### F3 — Island keeps stale state after next_batch_locked / topic_mastered

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/components/topics/FlashcardBatch.tsx:44-49
- **Detail**: `run` refreshes only on `batch_generating`/`batch_exists`; after another tab deletes cards or masters the topic, the button stays enabled and shows an error instead of the current state.
- **Fix**: Add `next_batch_locked` and `topic_mastered` to the refresh branch (show the message and refresh).
- **Decision**: FIXED — next_batch_locked / topic_mastered refresh the state and keep the message

### F4 — Existing fronts are newest-first only per batch

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/topics/[id]/flashcards/next.ts:69-74
- **Detail**: Batches are newest first, but within a batch fronts follow card position; the 30-front cut matters only after a subtopic exceeds 30 cards, and then the order within the newest batch is arbitrary.
- **Fix**: Leave as is; adjust the comment in `next.ts` to "newest batch first".
- **Decision**: FIXED — comment in next.ts

### F5 — Card deletion enabled while a next batch is polling

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/components/topics/FlashcardBatch.tsx:143,154
- **Detail**: During polling `busy` is null, so "Usuń" stays enabled. Harmless (the claim already passed), but inconsistent with the busy gating during the request itself.
- **Fix**: Disable delete while `state.generating` is set, or accept as is.
- **Decision**: FIXED — delete disabled while a next batch generates

### F6 — Small inconsistencies with neighbours

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/lib/topics/schemas.ts:81, src/lib/topics/flashcard-repository.ts:139
- **Detail**: `nextBatchInput` is not `.strict()` while `studyAnswerInput` is; the TS claim freshness uses `<= 120 s` while SQL takes over at `>= 120 s` (at exactly 120 s the API refuses without calling AI — safe).
- **Fix**: Add `.strict()` to `nextBatchInput`; use `<` in the TS freshness check.
- **Decision**: FIXED — nextBatchInput .strict() (+ test); TS claim freshness uses <

### F7 — Minor unplanned additions

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/lib/topics/flashcards-task.ts:131, scripts/smoke-topics.mjs, src/components/topics/FlashcardBatch.tsx
- **Detail**: `Math.round` on `wynik` now also applies to the batch 1 prompt (integers already, no change in output); extra smoke check `{ seq: 1 }` → 400; empty-batch message in the UI. All harmless and consistent with the plan's intent.
- **Fix**: Accept; no change.
- **Decision**: ACCEPTED — harmless additions consistent with the plan
