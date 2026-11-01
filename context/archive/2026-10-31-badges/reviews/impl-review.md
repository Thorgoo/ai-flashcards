<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: S-10 Odznaki

- **Plan**: context/changes/badges/plan.md
- **Scope**: Full plan
- **Reviewed phases**: 1, 2, 3
- **Date**: 2026-11-01
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 5 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — Plan text out of date on three justified deviations

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: supabase/migrations/20261031120000_badges.sql:48-80; src/components/topics/StudySession.tsx:251; src/components/topics/labels.ts:38-47
- **Detail**: Three parts of the code differ from the plan. The code is correct in each case; the plan text is now inaccurate.
  - *RLS:* the plan said to keep only `select` and list the missing write policies in `rls_guard_exceptions`. Instead, all 4 owner policies remain and writes are blocked with `revoke all` + `grant select`. This is the `quizzes` pattern, and `rls_guard.test.sql` needs no change.
  - *Session notice:* the badge notice is a separate `earned` state with its own `<Alert role="status">`, not the `notice` string, because a string cannot hold a list and a link.
  - *Labels:* `awardedLabel` and `badgeCountLabel` were added to `labels.ts`, and `daysLabel` moved to `catalog.ts`. The dependency direction was reversed and is now cleaner.
- **Fix**: Add a "Deviations" addendum to plan.md with these three items, so archived plans don't mislead future reviews.
- **Decision**: FIXED

### F2 — Streak recomputed on every answer insert

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20261031120000_badges.sql:175, 249
- **Detail**: Each `flashcard_answers` insert runs `sync_badges`, which calls `study_streak_of` inside the answer transaction. That function scans all of the account's answers. The cost grows linearly with answer history. It is acceptable at single-account scale, as the plan's Performance Considerations already state.
- **Fix**: Leave as is for the MVP and revisit if answer latency grows. A later migration could skip the streak step once all four streak badges are held, or limit the scan to the last `max threshold + 1` days.
  - Strength: No change now; the plan already accepted this cost.
  - Tradeoff: The cost keeps growing quietly with history.
  - Confidence: HIGH — the scan is bounded by one account's answers.
  - Blind spot: There is no latency metric for the answer route on prod.
- **Decision**: SKIPPED

### F3 — Dashboard computes the streak twice

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/dashboard.astro:13-15
- **Detail**: `getStudyStreak` and `getBadgeOverview` both compute the streak, because `badge_overview()` calls `study_streak()` itself. The streak tile still needs `studied_today` for its hint, which the overview does not return.
- **Fix**: Accept it. The two calls run in parallel, and removing the duplication would mean widening `badge_overview()`, which is not worth a migration.
- **Decision**: SKIPPED

### F4 — A failed badge read reports a successful save as `save_failed`

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/study-repository.ts:85-93
- **Detail**: If `getAttemptBadges` fails after the answer has been stored, the route returns `save_failed` (retryable 500), and the user sees an error for a save that worked. A retry with the same `attempt_id` replays, without grading again or duplicating anything, and the smoke test asserts this. The behaviour is deliberate and commented in the code.
- **Fix**: None; the retry path is correct and tested.
- **Decision**: SKIPPED

### F5 — Badge trigger has no exception guard

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20261031120000_badges.sql:242-257
- **Detail**: An unexpected error in `sync_badges` would roll back the user's answer. The known conflict cases are absorbed by `on conflict do nothing`, and the constraints cannot fail on these inputs, so the risk is low. This keeps the badges and the answer consistent.
- **Fix**: None; it is a deliberate consistency choice.
- **Decision**: SKIPPED

### F6 — Topbar links use color literals

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/components/Topbar.astro:10-17
- **Detail**: The new "Odznaki" link copies `text-purple-300 hover:text-purple-100` from the existing links, as the plan prescribed. This is existing debt against the CLAUDE.md UI rule (tokens only), not something this change introduced.
- **Fix**: Tokenize all Topbar links in a separate UI change (e.g. via /10x-ui).
- **Decision**: SKIPPED
