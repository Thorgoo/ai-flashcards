<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Critical-path E2E (test-plan Phase 1)

- **Plan**: context/changes/testing-critical-path-e2e/plan.md
- **Scope**: Full plan (completed phases only; Phase 3 has pending manual rows 3.4–3.6, its files were scanned for safety as a dependency of phases 4–5)
- **Reviewed phases**: 1, 2, 4, 5, 6
- **Date**: 2026-11-01
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Notes: approved adaptations (CI e2e step moved into Phase 3, `e2e/session.spec.ts`, CI instead of local runs, break-check variant "retry sends different text") are not findings. No app code changed outside `src/lib/ai/fixtures.ts`; the fail-once seam is unreachable in production (`src/lib/ai/mode.ts:15`, `src/lib/ai/index.ts:26-38`). Gates re-run: vitest 168 passed / 1 skipped, lint clean, astro check 0 errors, CI green on 2dda55a.

## Findings

### F1 — Wrapper restore can delete the original .dev.vars

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: scripts/e2e.mjs:52-61, 79-85
- **Detail**: `restore()` removes every file in FILES that is not in `backedUp`, so it cannot tell "did not exist before" from "never reached". If backing up `.dev.vars` fails (or writing `.env` throws, e.g. EBUSY/EPERM on Windows), the finally block runs `rmSync(".dev.vars")` and deletes the developer's untouched original, which holds the real secrets.
- **Fix**: Track a `written` set and in `restore()` remove only files that were written by the wrapper and not backed up.
- **Decision**: FIXED

### F2 — No local-host guard before destructive service-role operations

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: e2e/support/supabase.ts:8-16 (used by e2e/auth.setup.ts:18-25 and e2e/critical-path.spec.ts seed)
- **Detail**: `npm run e2e` is safe (URL from `supabase status`), but `npx playwright test` in a shell with hosted SUPABASE_URL and a service-role key exported would delete/recreate `e2e@example.com` and update flashcards on that project. The header says "local Supabase only" but nothing enforces it. `scripts/smoke-topics.mjs:13-18` has the same pre-existing gap (out of this change's scope).
- **Fix**: In `supabaseEnv()`, throw unless the SUPABASE_URL hostname is `localhost` or `127.0.0.1` (same rule as `src/lib/ai/mode.ts:15`).
- **Decision**: FIXED

### F3 — Windows shell spawn: Ctrl+C kills cmd.exe, not Playwright

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: scripts/e2e.mjs:14-15, 65-75, 87
- **Detail**: With `shell: true` on Windows, `child.kill(signal)` kills cmd.exe; restore may then run while the preview still holds `.dev.vars` (EPERM on rename). The leftover-backup check on the next run catches it. Related: `%VAR%` inside quoted args is still expanded by cmd (developer's own argv, low risk). This is exactly what pending manual row 3.5 should exercise.
- **Fix**: Spawn `node node_modules/@playwright/test/cli.js test …` without a shell on every platform.
- **Decision**: FIXED

### F4 — Grading-failure test run alone fails with a misleading message

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: e2e/critical-path.spec.ts:85-93
- **Detail**: The second serial test reads `topicId` set by the loop test. Run alone (`-g "failed grading"`) it queries `topic_id = undefined` and fails as "picking a card of topic undefined".
- **Fix**: At the start of the test, throw "run together with the loop test (describe.serial)" when `topicId` is unset.
- **Decision**: FIXED

### F5 — Unclear failures when setup data is missing

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: scripts/smoke-topics.mjs:602; e2e/auth.setup.ts:44-47
- **Detail**: `due[1]?.id` may be undefined, making `makeOpenDue` a silent no-op and the checks fail for an unclear reason. In auth.setup the loop waits for an `auth-token` cookie but then only checks `jar.size === 0`, so a jar without the session cookie fails later at the dashboard assertion.
- **Fix**: Throw early when `due[1]` is missing, and assert an `auth-token` cookie is present after the wait.
- **Decision**: FIXED

### F6 — "Once" means once per server isolate

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/ai/fixtures.ts:62-66
- **Detail**: The fail-once Set lives per workerd isolate; a restart or a second isolate would fail the retry again. CI and local preview use one process (verified by the green smoke/e2e runs), so this is a documentation gap, not a bug.
- **Fix**: Say "once per server isolate" in the comment above `FAKE_GRADING_FAIL_ONCE`.
- **Decision**: FIXED
