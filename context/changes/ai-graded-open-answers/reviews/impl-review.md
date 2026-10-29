<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: S-06 — Odpowiedzi otwarte oceniane przez AI i opanowanie

- **Plan**: context/changes/ai-graded-open-answers/plan.md
- **Scope**: Full plan
- **Reviewed phases**: 1, 2, 3
- **Date**: 2026-10-29
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Success criteria: `npm test` 90 passed / 1 skipped, `npm run lint` clean, `npm run build` OK, CI on main green (1d9284b, f6d1ead; pgTAP and smoke in the `smoke` job). Manual 1.5, 2.5, 3.4–3.7 run on production in the test topic (3.7: continuing A/B/C/D after the limit is confirmed in code only — the test topic had no due A/B/C/D cards).

## Findings

### F1 — Uzasadnienia AI w rodzaju męskim

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/grading-task.ts:27
- **Detail**: Prompt każe zwracać się do użytkownika, ale nie prosi o formy neutralne płciowo; na produkcji AI pisało „opisałeś”, „ujęłeś”. Fixtura fake jest neutralna („Trafnie oddajesz…”), więc testy i smoke tego nie wychwycą.
- **Fix**: Dodać do opisu `feedback` w system prompcie zdanie: unikaj form czasu przeszłego zależnych od płci; pisz w czasie teraźniejszym („oddajesz”, „brakuje”) albo bezosobowo o odpowiedzi („Odpowiedź trafnie ujmuje…”).
- **Decision**: FIXED — prompt asks for gender-neutral forms (present tense or about the answer)

### F2 — `asData` usuwa `<` i `>` z treści oceny

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/subtopics-task.ts:34 (used by src/lib/topics/grading-task.ts)
- **Detail**: Ucieczka działa (nie da się zamknąć tagu `<odpowiedz_uzytkownika>`, wynik ograniczony przez zod do boolean + 500 znaków, renderowany jako tekst React). Ale usunięcie `<`/`>` zmienia wzorcową odpowiedź i tekst użytkownika dla fiszek z kodem lub matematyką (`List<String>`, `a < b`), co może zniekształcić ocenę. Te same zachowanie mają zadania generowania.
- **Fix**: Zamieniać `<`/`>` na `&lt;`/`&gt;` w `asData` zamiast je usuwać (jedno miejsce dla wszystkich zadań), z testem na tekst z `<`.
  - Strength: Zachowuje znaczenie treści technicznych i nadal uniemożliwia fałszowanie tagów.
  - Tradeoff: Zmienia prompt także generowania podtematów i fiszek; model widzi encje zamiast znaków.
  - Confidence: MED — modele dobrze czytają encje HTML, ale nie zmierzyliśmy wpływu na jakość ocen.
  - Blind spot: Nie wiemy, ile tematów użytkownika zawiera kod/matematykę.
- **Decision**: FIXED (grading only, per triage) — grading prompt escapes &, <, > as entities via asEscapedData; generation keeps asData; test covers List<String> & a < b; break-check went red

### F3 — Dwie karty przeglądarki mogą zużyć dwie oceny jednej fiszki

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/topics/[id]/study/answer.ts:37-45
- **Detail**: Odczyt wstępny i wywołanie AI nie są atomowe. Dwie karty z różnymi `attemptId` przechodzą preflight i obie zużywają ocenę; druga kończy się `card_not_due` i klient pomija fiszkę z komunikatem. Wynik poprawny, koszt jednej oceny — zgodne z planem („akceptowalne”).
- **Fix**: Bez zmiany kodu; ewentualnie jedno zdanie w `src/lib/topics/AGENTS.md`, że równoległe karty mogą zużyć dwie oceny.
- **Decision**: SKIPPED — accepted by the plan

### F4 — `readOpenAttempt`: trzy zapytania i cichy fallback typu treści

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/study-repository.ts:186
- **Detail**: Próba i fiszka czytane równolegle, potem osobno `content_type` podtematu; `?? "conceptual"` ukrywa brak wiersza podtematu.
- **Fix**: Pobrać `content_type` przez osadzony select (`subtopics(content_type)`) w zapytaniu fiszki.
- **Decision**: SKIPPED
