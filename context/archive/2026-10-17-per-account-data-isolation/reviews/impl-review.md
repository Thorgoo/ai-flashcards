<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Per account data isolation

- **Plan**: context/changes/per-account-data-isolation/plan.md
- **Scope**: Full plan
- **Reviewed phases**: 1, 2, 3
- **Date**: 2026-10-18
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 5 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

Success criteria evidence: `npm run lint`, `npm run build` and `npx prettier --check supabase/AGENTS.md` pass locally (2026-10-18). PR #18 checks `ci`, `smoke` and Workers Builds pass. Manual 2.3 is evidenced by PR #19 (`tmp/f01-break-check`, closed), where `smoke` failed.

## Findings

### F1 — Function EXECUTE revoke from anon has no effect

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20261017065708_revoke_anon_default_privileges.sql:7
- **Detail**: Postgres grants EXECUTE on every new function to `PUBLIC` by default, and `anon` inherits it through `PUBLIC`. Revoking only from `anon` therefore leaves every future `public` function callable by `anon` through PostgREST `/rpc`, including SECURITY DEFINER ones. Tables and sequences are not affected, because they have no `PUBLIC` default. Both the migration comment and `supabase/AGENTS.md:8` ("anon has no default privileges") claim more than the migration does. The migration has not been pushed to production or merged to `main` yet.
- **Fix A ⭐ Recommended**: In the same migration (not yet pushed), add `revoke execute on functions from public` plus an explicit `grant execute on functions to authenticated, service_role` in default privileges, and add a pgTAP assertion that `anon` cannot execute a test function.
  - Strength: Closes the gap at the source and keeps "anon gets nothing" true. Editing is safe because `db push` has not run.
  - Tradeoff: Every future function needs an explicit grant if another role needs it. A small mental model change.
  - Confidence: HIGH — documented Postgres behaviour for function default privileges.
  - Blind spot: Not verified in CI yet; extensions installed into `public` later could interact.
- **Fix B**: Leave the migration and narrow the wording in the comment and AGENTS.md: functions must `revoke execute ... from public, anon` explicitly.
  - Strength: No schema change. Functions arrive only in later slices anyway.
  - Tradeoff: Relies on a rule being remembered, which is exactly what this foundation tries to avoid.
  - Confidence: MED — works only if every future function follows the rule.
  - Blind spot: The guard does not check functions, so a mistake would not be caught.
- **Decision**: FIXED via Fix A (corrected: global `revoke execute on functions from public` without IN SCHEMA, because a per-schema revoke cannot remove a global default; plus 2 pgTAP assertions)

### F2 — Guard checks that a policy exists, not what it enforces

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/tests/database/rls_guard.test.sql:27
- **Detail**: Each of these would pass the guard: a single `using (true)` policy, a policy for `anon`/`public`, a SELECT-only policy, or a `user_id text` column with no foreign key. `supabase/AGENTS.md:6` presents the guard as enforcing the owned-table pattern, which it does only in part. The plan asked for "at least one policy", so the code matches the plan; the gap is in the plan.
- **Fix A ⭐ Recommended**: Tighten the guard with three checks: every policy's `pg_get_expr(polqual/polwithcheck)` references `user_id`; `polroles` contains only `authenticated`; all four commands (or `ALL`) are covered; `user_id` is `uuid not null`.
  - Strength: Turns the guard into a real check of the pattern AGENTS.md describes, before S-02 adds the first tables.
  - Tradeoff: More SQL in the guard. Regex on `pg_get_expr` is heuristic.
  - Confidence: MED — the checks are simple, but the matching would only be proven by F3's self-test.
  - Blind spot: Policies built from helper functions would need an exception.
- **Fix B**: Narrow the AGENTS.md wording to what the guard actually checks and rely on the isolation test assertions for each table.
  - Strength: No new code.
  - Tradeoff: The guard stays weak, and the per-table isolation assertions depend on discipline.
  - Confidence: HIGH — wording-only change.
  - Blind spot: None significant.
- **Decision**: FIXED via Fix A (guard checks uuid not null user_id, a policy for every command, roles = authenticated only, and that each USING/WITH CHECK references auth.uid() and user_id; AGENTS.md:6 wording updated)

### F3 — Guard is never shown to catch a bad table

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: supabase/tests/database/rls_guard.test.sql:12
- **Detail**: No migration creates a table, and `account_isolation.test.sql` rolls back its probe table. So in CI the guard always runs against an empty `public` and passes. A logic bug (wrong `relkind`, inverted `failed`) would go unnoticed until S-02. The break check in PR #19 exercised the isolation test, not the guard.
- **Fix**: In the guard's transaction, create a deliberately broken table, assert the query returns its reasons, then roll back to a savepoint before the real `is_empty`.
- **Decision**: FIXED (guard query moved to a temporary view; a self-test in a savepoint checks two broken tables and one correct table with `set_eq`; plan(2))

### F4 — Guard ignores views and materialized views

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/tests/database/rls_guard.test.sql:30
- **Detail**: `relkind in ('r', 'p')` skips views (`v`) and materialized views (`m`). A view in `public` owned by `postgres` runs with its owner's rights, so it bypasses RLS on the tables under it unless it sets `security_invoker = true`. `authenticated` gets SELECT on it through default privileges, which leaks data across accounts.
- **Fix**: Add `v`/`m` to the guard: a view fails without `security_invoker=true` in `reloptions`, and a materialized view always fails unless it is exempted.
- **Decision**: FIXED (views without security_invoker and materialized views in `public` are violations; self-test covers definer view, invoker view, matview)

### F5 — supabase/CLAUDE.md is gitignored and not committed

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: .gitignore:38
- **Detail**: Plan Phase 3 item 2 adds `supabase/CLAUDE.md` with `@AGENTS.md`. The file exists locally, but the root pattern `CLAUDE.md` (meant for local course materials) also matches `supabase/CLAUDE.md`, so it is not in the diff. Other clones and Claude Code sessions there will not load the supabase guide.
- **Fix**: Change `CLAUDE.md` to `/CLAUDE.md` in `.gitignore` (or add `!supabase/CLAUDE.md`) and commit the file.
- **Decision**: FIXED (`.gitignore` pattern anchored to `/CLAUDE.md`; supabase/CLAUDE.md now tracked)

### F6 — README and AGENTS.md disagree on when a migration is frozen

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: supabase/AGENTS.md:12, README.md:165
- **Detail**: README says "never edit a migration that has already been pushed"; AGENTS.md says "already on `main`". The plan uses "pushed".
- **Fix**: Use one wording in both: "already on `main` or pushed".
- **Decision**: FIXED (both say "already on `main` or pushed")

## Triage summary

- **Fixed**: F1 (Fix A, corrected), F2 (Fix A), F3, F4, F5, F6
- **Note**: The SQL changes (F1–F4) could not run locally (no Docker); they are verified by the `Database tests` step in CI on PR #18.
