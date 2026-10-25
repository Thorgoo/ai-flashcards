<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: S-04 Pierwsza partia fiszek ze słabych podtematów

- **Plan**: context/changes/first-weak-subtopic-batch/plan.md
- **Scope**: Full plan
- **Reviewed phases**: 1, 2, 3, 4
- **Date**: 2026-10-25
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 5 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

Bramki: `npm test` (70 passed, 1 skipped), `npm run lint`, `npm run build` — PASS lokalnie na `efd27d0`; CI `ci`, `smoke` (pgTAP 150 testów + smoke), Workers Builds — success na `ae35467`. Wszystkie elementy planu MATCH; `src/components/topics/api.ts` nie wymagał zmiany (`FlashcardBatch` używa `callApi` bez modyfikacji). Dodatki poza planem (indeks `subtopic_id`, licznik „Fiszki w partii”, akapit wstępu, przycisk quizu `outline` po ukończeniu) mieszczą się w planowanej powierzchni.

## Findings

### F1 — waitUntil kończy pracę ~30 s po rozłączeniu, generowanie trwa do 90 s

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/topics/[id]/flashcards/index.ts:43-50
- **Detail**: Po zamknięciu karty lub przeładowaniu Workers daje pracy w `waitUntil` ok. 30 s (ryzyko opisane w planie, „Performance Considerations”). Pomiar z produkcji: 26,8 s i 35,0 s; w teście 4.6 przeładowanie nastąpiło ~5 s po starcie, a zapis ~30 s później — na samej granicy. Przy dłuższym generowaniu AI zużyje limit, zapis się nie wykona, a strona po 120 s pokaże znowu „Wygeneruj fiszki”. Quiz ma ten sam wzorzec (timeout 60 s).
- **Fix A ⭐ Recommended**: Zaakceptować ryzyko i obserwować `ai_calls` (status `ok` bez partii `ready` = utracona praca); wrócić do tematu przy S-07, które doda kolejne generowania
  - Strength: Plan świadomie to zaakceptował; dwa pomiary mieszczą się w oknie, a utrata kosztuje 1 z 20 generowań, nie dane.
  - Tradeoff: Rzadka utrata generowania pozostaje możliwa.
  - Confidence: MED — granica 30 s nie jest potwierdzona w logach Workers.
  - Blind spot: Rozkład czasów dla tematów z dłuższymi wyjaśnieniami.
- **Fix B**: Przenieść generowanie do Cloudflare Queue lub Durable Object
  - Strength: Usuwa zależność od połączenia klienta całkowicie.
  - Tradeoff: Nowa infrastruktura i zmiana wzorca wspólnego z quizem.
  - Confidence: MED — wymaga osobnego planu.
  - Blind spot: Dostępność Queues na obecnym planie Workers.
- **Decision**: ACCEPTED via Fix A — ryzyko akceptowane; obserwacja `ai_calls` i powrót przy S-07 (follow-ups/review-fixes.md)

### F2 — Claim bez tokenu: release/create nie odróżnia właściciela od przejmującego

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20261024095230_create_flashcards.sql:144-152
- **Detail**: Jeśli żądanie A przeżyje TTL 120 s, a B przejmie claim, późniejszy `release` A usuwa claim B (B dostaje `save_failed`), albo `create` A wypełnia claim B (B dostaje `batch_exists`, UI odświeża). Duplikatów nie ma (`unique(topic_id, seq)` + `FOR UPDATE`). Mało prawdopodobne, bo timeout AI 90 s < TTL 120 s; quiz ma ten sam projekt.
- **Fix**: Nowa migracja: `claim_flashcard_batch` zwraca `claimed_at`, a `release`/`create` wymagają go jako tokenu (to samo dla quizu).
  - Strength: Zamyka całą klasę wyścigów po przejęciu.
  - Tradeoff: Zmiana sygnatur trzech funkcji i wywołań w TS; dotyczy też quizu.
  - Confidence: HIGH — wzorzec optymistycznej blokady.
  - Blind spot: None significant.
- **Decision**: FIXED — migracja `20261025182503_claim_tokens_and_option_nulls.sql`: claim zwraca `claimed_at`, release/create przyjmują go jako token (fiszki i quiz; null = dawne zachowanie dla starszego Workera)

### F3 — CHECK na `options` przepuszcza elementy NULL

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20261024095230_create_flashcards.sql:46-52
- **Detail**: `char_length(btrim(NULL)) between 1 and 200` daje NULL, który CHECK akceptuje; bezpośrednie wywołanie `create_flashcard_batch` przez PostgREST może zapisać `[null, ...]` we własnych wierszach. `quiz_questions` ma tę samą lukę.
- **Fix**: W kolejnej migracji dodać `array_position(options, null) is null` do obu tabel.
- **Decision**: FIXED — ta sama migracja: `array_position(options, null) is null` na `flashcards` i `quiz_questions`

### F4 — Luki w pgTAP: release obcego claimu

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/tests/database/flashcards.test.sql
- **Detail**: Brak asercji, że konto B wywołujące `release_flashcard_batch_claim` na claimie `generating` konta A go nie usuwa (funkcja jest poprawna, test go nie pilnuje). Quiz ma tę samą lukę.
- **Fix**: Dodać asercję do `flashcards.test.sql` przy następnej zmianie bazy fiszek.
- **Decision**: FIXED — `flashcards.test.sql`: release konta B nie usuwa claimu A; dodatkowo testy tokenu i opcji null (także `quizzes.test.sql`)

### F5 — Wyjaśnienia „czytaj więcej” krótsze niż zakłada „rozszerzone”

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/flashcards-task.ts (prompt systemowy)
- **Detail**: W partii słownikowej z produkcji najdłuższe `explanation` ma 280 znaków przy limicie 1500. Działa, ale odbiega od zamiaru FR-013 („rozszerzone wyjaśnienie”). Dłuższe wyjaśnienia wydłużą generowanie (patrz F1).
- **Fix**: Doprecyzować w prompcie docelową długość (np. 400–900 znaków) i ponownie zmierzyć czas w `ai_calls`.
- **Decision**: FIXED — prompt: „zwykle 400–700 znaków, nigdy ponad 1500”; ponowny pomiar czasu po wdrożeniu (follow-ups/review-fixes.md)

### F6 — Kryterium 4.9 opisywało zachowanie, którego nie było

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/first-weak-subtopic-batch/plan.md (Phase 4, Manual 4.9)
- **Detail**: Plan mówi „edytor podtematów nadal potwierdza usuwanie”, ale usuwanie podtematu nigdy nie miało potwierdzenia — `Confirmation` obsługuje „Wygeneruj ponownie” i „Zatwierdź listę”. Sprawdzono faktyczne dialogi (adnotacja w `change.md`); to błąd sformułowania planu, nie implementacji.
- **Fix**: Brak zmiany w kodzie; adnotacja w `change.md` wystarcza.
- **Decision**: FIXED — bez zmiany kodu; adnotacja w `change.md` opisuje faktycznie sprawdzone dialogi
