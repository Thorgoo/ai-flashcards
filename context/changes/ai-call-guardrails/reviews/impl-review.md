<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Ai call guardrails

- **Plan**: context/changes/ai-call-guardrails/plan.md
- **Scope**: Full plan
- **Reviewed phases**: 1, 2, 3
- **Date**: 2026-10-18
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 3 observations

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | PASS    |
| Scope Discipline    | PASS    |
| Safety & Quality    | WARNING |
| Architecture        | PASS    |
| Pattern Consistency | WARNING |
| Success Criteria    | WARNING |

Phase 2 was reviewed and triaged separately in `reviews/impl-review-phase-2.md` (6 fixes, commit 27e4dde). This review checks phases 1 and 3 in depth, plus whether 27e4dde broke the phase 1/3 contracts (it did not).

Success criteria evidence: CI on PR #20 at 69904db passes `ci` (lint, `npm test` 26 tests, `astro check`, build), `smoke` (pgTAP: `account_isolation`, `ai_calls`, `rls_guard`; app in `AI_MODE=fake`) and Workers Builds. The break check on PR #21 (limit 21) turned `ai_calls.test.sql` red. Manual 2.5 was run live (1336 ms) and manual 3.3 was confirmed by the user.

Confirmed sound in the SQL:

- `search_path = ''` is set and every reference is qualified.
- `auth.uid()` reads the caller's JWT claims under security definer.
- The functions take no user id, so one account cannot act for another.
- The counter cannot go down: no delete grant, and `kind`/`called_on` cannot change.
- The advisory lock plus READ COMMITTED make count+insert race-free.
- The Warsaw date is DST-correct.
- The migration is additive.

## Findings

### F1 — RPC inputs are unbounded and unvalidated

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20261018092416_create_ai_calls.sql:7-17, :33, :77-104
- **Detail**: Any signed-in user can call `begin_ai_call` / `finish_ai_call` directly through PostgREST (JWT + public key).
  - `p_task`, `p_model` and `p_error_code` have no length limit, so arbitrarily large strings can be stored in up to 120 rows a day.
  - `finish_ai_call` accepts negative or absurd `latency_ms`/token values, and the owner can finish their own pending row first with made-up data; the server's later finish is then a silent no-op.
  - This affects only the log, not the limit. The migration has not been pushed or merged yet.
- **Fix**: Add check constraints in the same migration (not yet on `main` or pushed): `length(task) <= 100`, `length(model) <= 100`, `length(error_code) <= 50`, and `latency_ms`, `input_tokens`, `output_tokens` `>= 0`. Add a pgTAP assertion that an oversized `p_task` is rejected.
  - Strength: Bounds what one account can write and keeps the log trustworthy; the constraints protect the data even if the functions change later.
  - Tradeoff: A slice with a task name over 100 characters would need a migration (unlikely).
  - Confidence: HIGH — standard check constraints; the migration is not on `main` or pushed, so it can be edited in place.
  - Blind spot: Owner-forged finish data stays possible within the bounds (accepted: it affects only that user's own log).
- **Decision**: FIXED (check constraints on task/model ≤ 100, error_code ≤ 50, latency/tokens ≥ 0 in the unpushed migration; pgTAP test for an oversized task, plan(12))

### F2 — The RLS guard exemption for ai_calls skips every check

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/tests/database/rls_guard.test.sql:10-14, :62
- **Detail**: `ai_calls` only needs to waive "no policy for every command" (it has select only, by design). Because the exception list holds table names, a later migration could disable RLS on `ai_calls`, add a `using (true)` policy or grant `anon`, and the guard would still pass.
- **Fix**: Turn the exceptions into `(table_name, reason)` pairs, so a row waives one named check: `('ai_calls', 'no policy for every command')`. Filter violations by both columns, and keep the guard's self-test passing.
  - Strength: The exemption becomes as narrow as its justification; every other check keeps protecting `ai_calls`.
  - Tradeoff: The guard SQL changes again (it was last hardened in F-01); a few lines.
  - Confidence: HIGH — a small change to the view's filter, covered by the existing self-test plus CI.
  - Blind spot: The views/matviews branch also has to filter by `(name, reason)`.
- **Decision**: FIXED (exceptions are `(table_name, reason)` pairs filtered after the union; `ai_calls` waives only "no policy for every command"; self-test proves a waiver covers one check; `supabase/AGENTS.md` wording updated)

### F3 — The anon test could pass for the wrong reason

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: supabase/tests/database/ai_calls.test.sql:93-101
- **Detail**: When the `anon` check runs, account A's JWT claims are still set. If they were cleared, the function's own "not signed in" error (also 42501) would make `throws_ok` pass even if `anon` had EXECUTE.
- **Fix**: Assert `not has_function_privilege('anon', 'public.begin_ai_call(text, text, text)', 'execute')` (and the same for `finish_ai_call`) instead of relying on the error code.
- **Decision**: FIXED (`has_function_privilege` assertions for `anon` on both functions instead of `throws_ok` 42501; plan(13))

### F4 — quota.ts has never run against real PostgREST

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: src/lib/ai/quota.ts:13-24
- **Detail**: Nothing calls `getAi` yet (by plan: no endpoints in F-02), so these assumptions are unverified until the first slice: that `returns table` arrives as an array, and that `P0429` appears in `error.code` (PostgREST answers HTTP 400).
- **Fix**: Note it in `change.md` Notes as a check for S-02's first end-to-end test (fake mode, `quota_exceeded` path).
- **Decision**: FIXED (note in `change.md` Notes as a check for the first S-02 E2E test)

### F5 — README's live-test command is bash-only

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: README.md (section "AI calls", Tests)
- **Detail**: `AI_LIVE_TEST=1 ANTHROPIC_API_KEY=… npx vitest …` fails in PowerShell (this happened during manual 2.5), and `npx` can be blocked by the execution policy there.
- **Fix**: Add the PowerShell form: `$env:AI_LIVE_TEST="1"; $env:ANTHROPIC_API_KEY="…"; npx.cmd vitest run src/lib/ai/live.integration.test.ts`.
- **Decision**: FIXED (PowerShell form with `$env:` and `npx.cmd` added to the README)

## Triage summary

- **Fixed**: F1, F2, F3, F4, F5
- **Note**: The SQL changes (F1–F3) need the CI `Database tests` step to verify them (no Docker locally).
