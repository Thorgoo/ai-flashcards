<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: S-05: Sesja nauki w formacie A/B/C/D

- **Plan**: context/changes/multiple-choice-study-session/plan.md
- **Scope**: Full plan
- **Reviewed phases**: 1, 2, 3
- **Date**: 2026-10-28
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

Notes: drift agent — every planned change MATCH; minor drift (replay of a deleted card → `flashcard_not_found`, end-screen wording) and harmless extras (`flashcard_answers_flashcard_id_idx`, `findTopicFlashcard`, `studyLabel`, extra schema/smoke cases). "What We're NOT Doing" respected. Automated: `npm test` 82 passed, `npm run lint` PASS, `npm run build` PASS, CI (ci + smoke with pgTAP 194 tests) green on PR #32/#33 and `main` (4a36bb5). Manual 3.4–3.8 verified in Chrome on production (test topic). Exposing `correctIndex` to the client is an accepted risk in the plan (Open Risks) — not a finding.

## Findings

### F1 — Study session stuck after a non-retryable save error

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/components/topics/StudySession.tsx:74 (guards at :78, :181, :245; retry only when retryable at :228)
- **Detail**: Apart from `flashcard_not_found`/`card_not_due`, every error is kept in `attempt.error`. With a non-retryable code (`unauthenticated` after the session expires, `not_found` after the topic is removed in another tab, `validation_failed`) there is no "Spróbuj ponownie", the options are locked by `attempt !== null` and "Dalej" by `!attempt.saved` — the only way out is reloading the page by hand.
- **Fix**: For a non-retryable error show a "Pomiń" action (drop the card, reset `attempt`, `step + 1`), and for `unauthenticated` a link to `/auth/signin`.
- **Decision**: FIXED (Fix now — "Pomiń" for non-retryable errors, "Zaloguj się" for unauthenticated)

### F2 — Attempt replay not bound to the card; account conflict ends in an endless retry

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20261026175218_fix_answer_flashcard_choice_replay.sql:30-38, 52-60; src/lib/topics/study-repository.ts:82-89
- **Detail**: The replay lookups filter only by `a.id = p_attempt_id and a.user_id = v_user`. The same user sending card B with card A's attempt id gets A's `correct`/`correct_index` as if they were B's, and nothing is recorded for B. An attempt id owned by another account ends in 23505 → `save_failed` (retryable), and the client's retry with the same `attemptId` will fail forever. The real client generates `crypto.randomUUID()` per click, so only a crafted or buggy client can trigger either path; neither case has a pgTAP test.
- **Fix**: In a new migration, add `and (a.flashcard_id = p_flashcard_id or a.flashcard_id is null)` to both lookups; an id taken for another card or account → `attempt_conflict` (P0409, hint) mapped to a non-retryable code; add 2 pgTAP cases.
  - Strength: Closes both paths at the source (the function), in line with "invariants live in the database" (src/lib/topics/AGENTS.md).
  - Tradeoff: Another migration and `db push` (a human step) for a scenario the app's client cannot produce.
  - Confidence: HIGH — the lookups and the 23505 mapping verified in the code.
  - Blind spot: Not checked whether S-06 (the open-format function) will want the same lookup — worth doing it once in a shared form.
- **Decision**: FIXED (Fix now — migration 20261028192001_answer_flashcard_choice_attempt_conflict.sql, attempt_conflict code, 2 pgTAP cases; needs CI + db push)

### F3 — AGENTS.md: "never cascade-delete it" contradicts the schema

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/lib/topics/AGENTS.md:15
- **Detail**: `flashcard_answers` deliberately cascades on topic/account delete (FK `(topic_id, user_id) … on delete cascade`, asserted by pgTAP); the rule only means deleting a card. A future agent might "fix" the cascade.
- **Fix**: Change to: "Deleting a card sets `flashcard_answers.flashcard_id` to null; only deleting the topic or the account removes the log."
- **Decision**: FIXED (Fix now — AGENTS.md:15 reworded)

### F4 — Unbounded session payload; topic page loads every card to read the batch status

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/study-repository.ts:96-109; src/pages/topics/[id].astro:46-47
- **Detail**: `getStudySession` returns every due card with its full texts (answer, explanation, options) without a limit — with skipped days and further batches (S-07) the SSR payload grows. The topic page calls `getFlashcardState` (all batch cards) only for `batch.status`, plus `countDueCards`.
- **Fix**: Leave until S-07 (with one batch it's ≤10 cards); then add a limit to the session and a status-only query for the topic page.
- **Decision**: ACCEPTED (deferred to S-07 — see follow-ups/review-fixes.md)

### F5 — GET /study skips the page's preconditions

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/pages/api/topics/[id]/study/index.ts:9-13 vs src/pages/topics/[id]/study.astro:21-34
- **Detail**: The page blocks the session for an unconfirmed topic, an unfinished quiz and no ready batch; the endpoint returns the session without these checks. Harmless (only the owner's data; in practice the result is empty), but the two entry points differ.
- **Fix**: Add a one-line comment to the endpoint that it deliberately has no preconditions (without a ready batch the queue is empty).
- **Decision**: FIXED (Fix now — comment in study/index.ts)
