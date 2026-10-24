<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Quiz diagnostyczny z wynikiem per podtemat

- **Plan**: context/changes/diagnostic-quiz-by-subtopic/plan.md
- **Scope**: Full plan
- **Reviewed phases**: 1, 2, 3
- **Date**: 2026-10-24
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 4 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

Automated gates (2026-10-24, commit e877295 on main):

- `npm run lint`, `npx astro check`, `npm test` (53 passed) and `npm run build` all pass.
- CI `ci` and `smoke` succeeded on e877295.

Plan drift:

- No MISSING or DRIFT items.
- The approved deviations hold together:
  - revoke plus `security definer`;
  - a message instead of a redirect in `quiz.astro`;
  - `GeneratingNotice` extracted as a shared component.
- The EXTRA items strengthen the invariants:
  - FK `(quiz_id, topic_id)`;
  - `readQuizState`;
  - the start screen without `?start=1`.

## Findings

### F1 — Przerwane generowanie zużywa limit i nie zapisuje quizu

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/topics/[id]/quiz/index.ts:22-26 (and src/lib/ai/call.ts:103)
- **Detail**:
  - `callAi` first commits the `ai_calls` reservation (`begin_ai_call`), then calls the AI for up to 60 s, and only after that runs `create_quiz`.
  - Reloading or closing the tab cancels the Worker request. The reservation stays counted (`pending`), and no quiz is saved.
  - After the reload `?start=1` is already gone, so the user sees "Rozpocznij quiz" again. The next click uses up another generation.
  - Observed on production: remaining 18 after one successful quiz.
  - Criterion 3.6 ("no second generation") is met literally, but the user loses one generation.
- **Fix A**: A pending quiz state. A new migration adds `quizzes.status 'generating'|'ready'`; the row is created atomically before the AI call, and `create_quiz` fills it in. The UI polls while the status is `generating`. A stale row older than the AI timeout can be retried.
  - Strength: Closes the cause, and F2 along with it (the atomic claim replaces the check-then-act).
  - Tradeoff: New migration, a new quiz state in the API/UI/smoke tests, plus handling of stale `generating` rows. That is close to a separate change.
  - Confidence: MED — `ctx.waitUntil` alone does not cover a 60 s call (it extends only ~30 s), so the pending state is required.
  - Blind spot: The same cancellation applies to subtopic generation (`generate.ts`, S-02), which is not covered here.
- **Fix B ⭐ Recommended**: A `beforeunload` warning while `busy === "generate"`, plus an entry in the roadmap Unknowns (pending generation state for the whole AI path, S-08).
  - Strength: A few lines in `QuizRunner.tsx`. It removes the most likely cause (an impatient reload), and the cost of the miss is 1 of 20 daily generations.
  - Tradeoff: It does not protect against a lost connection or a closed browser; the real fix is deferred.
  - Confidence: HIGH — standard browser behaviour, and the AI path is shared, so a deferred fix covers S-02 too.
  - Blind spot: Mobile browsers do not always show the `beforeunload` dialog.
- **Decision**: FIXED (Fix A) — migracja 20261024064348_quiz_generation_claim (claim_quiz/release_quiz_claim, status generating|ready, TTL 90 s), POST /quiz w cfContext.waitUntil, GET /quiz, polling w QuizRunner, pgTAP + smoke; zweryfikowane na produkcji 2026-10-24: odświeżenie w trakcie generowania → postęp, quiz zapisany i widoczny po 4 s pollingu, bez drugiego generowania

### F2 — Równoległe POST /quiz zwraca 500 `save_failed` zamiast 409

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/quiz-repository.ts:64-73
- **Detail**:
  - Two concurrent requests (two tabs) both pass `readQuizState === null`, and both call the AI.
  - The losing request gets either `quiz_exists` or 23505 from `unique(topic_id)`. 23505 maps to `save_failed` (500, retryable), which suggests a pointless retry.
- **Fix**: Map 23505 to `quiz_exists` in `errorCode`, with a unit test.
- **Decision**: FIXED (przez F1) — wyścig rozstrzyga atomowy claim_quiz (on conflict), drugi request dostaje 409 quiz_generating

### F3 — Kody błędów quizu mapowane po treści komunikatu

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/lib/topics/quiz-repository.ts:63-73
- **Detail**:
  - Three reasons share P0409 and are told apart by `message.includes(...)`.
  - `repository.ts:63` maps by SQLSTATE only. Changing the wording in SQL would silently turn a 409 into a 500.
- **Fix**: Have the migration from F4 recreate the functions with `using hint = '<code>'` and switch on `error.hint` (fallback to the message for safety), or accept as is with a comment pointing to the migration.
- **Decision**: FIXED — funkcje quizu podają powód w hint, errorCode przełącza się po error.hint

### F4 — `revoke` zostawia `truncate`/`references`/`trigger` dla `authenticated`

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20261023125014_create_diagnostic_quizzes.sql:78
- **Detail**:
  - `revoke insert, update, delete` leaves the remaining default privileges in place. TRUNCATE bypasses RLS.
  - PostgREST does not expose TRUNCATE, so this is defence in depth only.
  - The neighbouring `create_ai_calls.sql:28-29` uses `revoke all` plus `grant select`.
- **Fix**: A new migration with `revoke all … from authenticated; grant select … to authenticated;` for both tables, plus a pgTAP assertion (the pushed migration is not edited).
- **Decision**: FIXED — nowa migracja: revoke all + grant select na quizzes i quiz_questions, asercja pgTAP na truncate

### F5 — Kolejność odpowiedzi i `correct_index` chronione tylko przez API

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20261023125014_create_diagnostic_quizzes.sql (answer_quiz_question)
- **Detail**: With their own JWT, a user can answer out of order through RPC and read `correct_index` before answering. Both affect only their own diagnosis. Hiding `correct_index` is explicitly listed in the plan under "What We're NOT Doing".
- **Fix**: Accept as risk; revisit if S-04 starts relying on honest answers.
- **Decision**: ACCEPTED — zgodne z „What We're NOT Doing”; wrócić, jeśli S-04 będzie polegać na uczciwych odpowiedziach

### F6 — Strony wołają pełne `getQuizState` bez obsługi błędu

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/topics/[id].astro:22, src/pages/topics/[id]/quiz.astro:19
- **Detail**:
  - The topic button needs only answered/total, but the page fetches the whole state; for a completed quiz that includes the `quiz_results` RPC.
  - A database error throws a bare 500 (the same as `getTopic` on these pages), so a quiz failure now also breaks the topic page.
- **Fix**: Skip now; consistent with how `getTopic` is already used on the same pages.
- **Decision**: FIXED — try/catch wokół getQuizState na stronie tematu (błąd quizu nie psuje widoku tematu)

### F7 — Stan „Kontynuuj quiz (x/10)” na temacie nie sprawdzony wizualnie

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: Progress 3.9
- **Detail**:
  - During the manual test, "Rozpocznij quiz diagnostyczny" and "Zobacz wynik quizu" were seen on screen.
  - "Kontynuuj" was not seen, because no quiz was left half-finished when returning to the topic page.
  - The code path exists in `TopicEditor.tsx`, and the state comes from the same `getQuizState`.
- **Fix**: Accept; check at the next quiz on a new topic.
- **Decision**: ACCEPTED — zweryfikowane na produkcji 2026-10-24: po 3 odpowiedziach temat pokazuje „Kontynuuj quiz (3/10)”
