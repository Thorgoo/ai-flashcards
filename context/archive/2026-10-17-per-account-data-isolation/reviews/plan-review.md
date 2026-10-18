<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Per account data isolation

- **Plan**: context/changes/per-account-data-isolation/plan.md
- **Mode**: Deep (inline)
- **Date**: 2026-10-17
- **Verdict**: SOUND
- **Findings**: 0 critical 1 warning 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

## Grounding
5/5 paths ✓, 4/4 symbols ✓, brief↔plan ✓, Progress↔Phase 8/8 ✓ (lessons.md / contract-surfaces.md: absent)

## Findings

### F1 — Dummy GitHub env is scoped to the start step only

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 — #3 CI
- **Detail**: Dummy SUPABASE_AUTH_EXTERNAL_GITHUB_* vars are set only on "Start local Supabase" (ci.yml:42-43); `supabase test db` re-reads config.toml with `env(...)` and is unverified without them.
- **Fix**: Move the two dummy vars to job-level `env:` of `smoke`.
- **Decision**: FIXED

### F2 — "update/delete touch 0 rows" has no assertable form

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — #1 test izolacji
- **Detail**: Data-modifying CTEs are not allowed inside scalar subqueries, so a row-count assertion cannot be written as planned.
- **Fix**: B runs update/delete via `lives_ok`; then A asserts the row still exists with its original value.
- **Decision**: FIXED

### F3 — Manual criterion 2.3 has an "or" escape hatch

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — Manual Verification
- **Detail**: The criterion could pass without ever seeing the isolation test fail; with no local DB, a red CI run is the only proof.
- **Fix**: Temporary commit removing the select policy's condition must turn CI red, then be reverted before merge.
- **Decision**: FIXED
