# Critical-path E2E (test-plan Phase 1) Implementation Plan

## Overview

Etap 1 z `context/foundation/test-plan.md` §3: udowodnić, że pełna pętla US-01 (temat → podtematy → quiz diagnostyczny → partia fiszek → sesja nauki) działa w przeglądarce na fake AI (ryzyko #4), oraz że błąd oceny odpowiedzi otwartej w sesji nauki nie gubi wpisanego tekstu, nie zmienia stanu fiszki, pobiera dokładnie jedną ocenę z dziennego limitu, a ponowienie tym samym tekstem i `attemptId` kończy się werdyktem (ryzyko #5, w wersji skorygowanej przez research).

## Current State Analysis

- Żaden test nie uruchamia przeglądarki; brak Playwrighta w zależnościach i plikach (`research.md` § Infrastruktura). Pętlę US-01 przez HTTP przechodzi tylko `scripts/smoke-topics.mjs` (job `smoke`, `.github/workflows/ci.yml:28-72`).
- Trasa oceny wywołuje AI przed jakimkolwiek zapisem fiszki i przy błędzie wraca bez wywołania RPC (`src/pages/api/topics/[id]/study/answer.ts:44-45`). Rezerwacja limitu (`ai_calls`) powstaje przed wywołaniem providera (`src/lib/ai/call.ts:103`) i liczy się niezależnie od wyniku (`supabase/migrations/20261018092416_create_ai_calls.sql:1-3`).
- UI po błędzie zostawia tekst w polu read-only i pokazuje „Spróbuj ponownie”, które wysyła **ten sam tekst i ten sam `attemptId`** (`src/components/topics/StudySession.tsx:145,415,439,530,225-226`).
- Fake AI nie umie zasymulować błędu oceny przez HTTP: fixture oceny zwraca tylko poprawna/błędna (`src/lib/ai/fixtures.ts:64-73`), choć mechanizm `FakeAiFailure` → `AiProviderError` istnieje (`src/lib/ai/fake.ts:6-35`).
- Logowanie w UI tylko przez GitHub OAuth; smoke tworzy konto adminem i loguje hasłem do słoika ciasteczek `@supabase/ssr` (`scripts/smoke-topics.mjs:95-117`). Lokalnie provider e-mail jest wyłączony (`supabase/config.toml:202-205`); CI przełącza go `sed` (`ci.yml:44-49`).
- Lokalne `.dev.vars` wskazuje na hostowany Supabase i nie ma `AI_MODE`; tryb fake działa tylko przy lokalnym Supabase (`src/lib/ai/mode.ts:7-19`).

## Desired End State

- `npm run e2e` lokalnie (przy działającym lokalnym Supabase z włączonym providerem e-mail) buduje aplikację, uruchamia `preview` na porcie 4321 z `AI_MODE=fake`, przechodzi jeden spec z dwoma testami i przywraca `.env`/`.dev.vars` dewelopera.
- Job `smoke` w CI uruchamia ten sam spec po `smoke:topics` i publikuje raport/trace przy porażce.
- `smoke-topics.mjs` zawiera krok integracyjny ryzyka #5 z asercjami stanu bazy.
- Test-plan §5 i §6.3/§6.5 opisują nową bramkę i wzorzec e2e.

Weryfikacja: `npm test`, `npm run lint`, `npx astro check`, job `smoke` w CI zielony z krokiem e2e; celowe zepsucie (patrz Testing Strategy) czerwieni odpowiedni test.

### Key Discoveries:

- `flashcard_answers.id` = `attemptId` (`supabase/migrations/20261028200200_flashcard_open_answers.sql:62,134`) — brak wiersza odpowiedzi sprawdza się jednym zapytaniem po `id` lub `flashcard_id`.
- `ai_calls.user_id … on delete cascade` (`create_ai_calls.sql:7`) — usunięcie konta e2e zeruje jego limity.
- Kolejka sesji nauki: `due_on` → pozycja podtematu → pozycja fiszki (`context/archive/2026-10-28-ai-graded-open-answers/plan.md:19`); fiszka otwarta z `due_on` = wczoraj (Warszawa) będzie pierwsza.
- Smoke ma gotowe helpery `cardState`, `gradings`, `makeDue` (`scripts/smoke-topics.mjs:26-48`) i krok odpowiedzi otwartej (`:503-572`), który liczy `gradings` bezwzględnie (`=== 1`, `=== 0`).
- Wszystkie kroki pętli mają selektory ról/etykiet; w `src` nie ma `data-testid` (tabela w `research.md` § Ryzyko #4).

## What We're NOT Doing

- Logowanie przez GitHub OAuth w e2e (test-plan §7).
- Testy e2e dla walidacji, limitów, izolacji kont, replay — pokrywa je smoke i pgTAP.
- Edycje podtematów, regeneracja, kolejna partia, odznaki, streak w e2e.
- Przywracanie wersji roboczej z sessionStorage po odświeżeniu (zweryfikowane ręcznie w S-06) oraz UX `quota_exceeded`/`ai_not_configured`.
- Testy komponentów (jsdom/Testing Library) i testy tras w vitest.
- Automatyczne przełączanie `[auth.email] enable_signup` w `supabase/config.toml` lokalnie — wrapper tylko wykrywa i podpowiada.
- Zmiany kodu aplikacji poza fixturą fake AI.

## Implementation Approach

Od najtańszego sygnału do najdroższego: najpierw szew w fixturze z testem jednostkowym, potem integracja HTTP w istniejącym smoke (pełny dowód stanu bazy dla #5), potem infrastruktura Playwright, dwa testy w jednym pliku `test.describe.serial` (pętla → krok błędu na tym samym temacie, żeby nie płacić drugi raz za trzy generowania), na końcu CI i dokumentacja test-planu.

Fazę 3 można wykonać przez `/10x-e2e-setup`, a fazy 4–5 przez `/10x-e2e`, o ile zachowają kontrakty z tego planu; Progress jest wspólny.

## Critical Implementation Details

- **Fail-once w pamięci procesu.** Szew zapamiętuje dokładny tekst odpowiedzi w zbiorze na poziomie modułu. Dowodem, że stan przeżywa między żądaniami w `astro preview` (workerd), jest krok smoke z fazy 2; jeśli się nie potwierdzi, zatrzymaj się i wróć do planu zamiast przechodzić na `page.route`. Smoke i e2e działają w CI na tym samym serwerze — każdy tekst ze znacznikiem musi mieć losowy sufiks.
- **Hydratacja i auto-start.** Przycisk w `NewTopicForm` jest w SSR `disabled`; po `fill` czekaj na `toBeEnabled()` (z ponownym `fill` w `toPass`, jeśli React wyczyścił pole). Nie przeładowuj stron z `?generate=1`/`?start=1` — parametr znika po pierwszym renderze.

## Phase 1: Szew fail-once w fake AI

### Overview

Dać trybowi fake deterministyczny, jednorazowy błąd oceny wyzwalany treścią odpowiedzi, tak by ponowienie tym samym tekstem przeszło.

### Changes Required:

#### 1. Fixture oceny

**File**: `src/lib/ai/fixtures.ts`

**Intent**: Gdy odpowiedź użytkownika zawiera znacznik i ten dokładny tekst nie był jeszcze widziany w tym procesie, fixture zapamiętuje go i rzuca `FakeAiFailure("ai_unavailable")`; przy kolejnym wywołaniu z tym samym tekstem ocenia normalnie (reguła „poprawnie” bez zmian). Komentarz obok istniejącego opisuje, po co jest znacznik (smoke i e2e ryzyka #5).

**Contract**: eksportowana stała `FAKE_GRADING_FAIL_ONCE = "[fake-ai-fail-once]"`; zbiór tekstów na poziomie modułu; kod błędu `ai_unavailable` → HTTP 503, `retryable: true` (`src/lib/ai/errors.ts:12-23`). Bez znacznika zachowanie identyczne jak dziś.

#### 2. Test jednostkowy

**File**: `src/lib/topics/grading-task.test.ts`

**Intent**: Udowodnić przez dostawcę fake (`createFakeProvider` + fixtures) trzy przypadki: tekst ze znacznikiem → pierwsze wywołanie kończy się błędem `ai_unavailable`, drugie tym samym tekstem zwraca werdykt; inny tekst ze znacznikiem znów zawodzi raz; tekst bez znacznika nigdy nie zawodzi.

**Contract**: test przez publiczną ścieżkę `callAi`/dostawcę, nie przez prywatny zbiór; każdy przypadek z unikalnym tekstem (zbiór jest globalny dla modułu).

### Success Criteria:

#### Automated Verification:

- `npm test` przechodzi, w tym nowe przypadki fail-once w `grading-task.test.ts`
- `npm run lint` i `npx astro check` przechodzą
- Usunięcie zapamiętania tekstu (fixture zawodzi zawsze) czerwieni test „drugie wywołanie zwraca werdykt”

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Integracja ryzyka #5 w smoke-topics

### Overview

Najtańszy pełny dowód stanu bazy dla #5: HTTP na fake AI + lokalny Supabase, w istniejącym jobie CI.

- **Zachowanie**: błąd oceny → 503 `ai_unavailable`; stan fiszki (`stage`, `open_streak`, `due_on`) identyczny jak przed; brak wiersza `flashcard_answers` o `id` = `attemptId`; `gradings` +1. Ponowienie tym samym tekstem i `attemptId` → 200 z werdyktem; jeden wiersz odpowiedzi o tym `id` z `answer_text` równym wysłanemu; `gradings` +2 względem stanu wyjściowego.
- **Regresja wykrywana**: zapis fiszki lub dziennika przed oceną AI; zmiana statusu/`retryable` błędu; ponowienie odrzucane jako `attempt_conflict` po nieudanej ocenie.
- **Źródło**: `research.md` § Ryzyko #5 (kolejność zapisu, translacja błędu).
- **Przypadek brzegowy**: limit pobierany przy błędzie (+1, nie 0) — oczekiwany, nie „brak zmian”.
- **Anty-wzorzec unikany**: asercja samego statusu/komunikatu bez stanu bazy; wyrocznia skopiowana z kodu (oczekiwania pochodzą z PRD FR-028 i NFR limitu).

### Changes Required:

#### 1. Krok smoke

**File**: `scripts/smoke-topics.mjs`

**Intent**: Po istniejącej sekcji odpowiedzi otwartych (po kroku „another account cannot give an open answer”) przygotować drugą fiszkę tematu jako otwartą i zaległą kluczem service-role, a następnie wykonać opisany wyżej scenariusz. Liczniki ocen porównywać względnie (przed/po), żeby nie zależeć od wcześniejszych kroków.

**Contract**: nowy helper w stylu `makeDue` ustawiający `stage='open'`, `open_streak=0`, `due_on=today`; tekst `"<FAKE_GRADING_FAIL_ONCE> <losowy sufiks> …"` (stała zduplikowana w skrypcie z komentarzem jak przy `batchAllocation`, bo Node nie importuje TS); nazwy kroków `check(...)` po angielsku jak istniejące.

### Success Criteria:

#### Automated Verification:

- Job `smoke` w CI przechodzi z nowymi krokami „a failed grading …” i „a retried failed grading …”
- Lokalnie `npm run smoke:topics` (przy preview na fake AI i lokalnym Supabase) wypisuje nowe kroki jako PASS
- Przeniesienie wywołania `answerFlashcardOpen` przed ocenę AI w `study/answer.ts` (celowe zepsucie, niecommitowane) czerwieni krok „a failed grading leaves the card unchanged”

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Infrastruktura Playwright

### Overview

Playwright z jednym projektem przeglądarki (Chromium), projektem setup logującym stałe konto testowe i wrapperem, który bezpiecznie podmienia lokalną konfigurację env.

### Changes Required:

#### 1. Zależność i skrypty

**File**: `package.json`, `.gitignore`

**Intent**: Dodać `@playwright/test` (bieżąca stabilna wersja przypięta dokładnie przy instalacji; checked: 2026-11-01) i skrypt `"e2e": "node scripts/e2e.mjs"`. Ignorować `playwright-report/`, `test-results/`, `e2e/.auth/` i pliki kopii `.env.e2e-backup`, `.dev.vars.e2e-backup`.

**Contract**: `npm run e2e [-- <args playwright>]`.

#### 2. Konfiguracja

**File**: `playwright.config.ts`

**Intent**: `baseURL` `http://localhost:4321`; `webServer` = `npm run build && npm run preview -- --port 4321`, `reuseExistingServer` tylko w CI (tam preview już działa); projekt `setup` + projekt `chromium` z `storageState` i `dependencies: ['setup']`; trace i screenshot przy porażce; jeden worker (testy są serial i współdzielą konto).

**Contract**: katalog testów `e2e/`; `storageState` w `e2e/.auth/user.json`.

#### 3. Setup logowania

**File**: `e2e/auth.setup.ts`, `e2e/support/supabase.ts`

**Intent**: Klient service-role (z `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) usuwa istniejące konto `e2e@example.com`, tworzy je od nowa (świeże limity — kaskada `ai_calls`), loguje hasłem do słoika ciasteczek jak `signIn` w smoke i zapisuje ciasteczka do `storageState` (domena `localhost`, ścieżka `/`). Następnie otwiera `/dashboard` i sprawdza, że nie nastąpiło przekierowanie na `/auth/signin` (dowód allowlisty i formatu ciasteczek). Wspólny moduł daje też helpery bazy dla testów: `cardState`, `answerRows`, `gradings`, `warsawDate(offsetDays)`.

**Contract**: wymagane env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; e-mail `e2e@example.com` musi być w `ALLOWED_EMAILS` serwera. Przy błędzie logowania hasłem komunikat wskazuje na `[auth.email] enable_signup` w `supabase/config.toml`.

#### 4. Wrapper env

**File**: `scripts/e2e.mjs`

**Intent**: Odczytać `API_URL`/`ANON_KEY`/`SERVICE_ROLE_KEY` z `supabase status -o env`; odmówić startu, jeśli istnieje plik kopii (z instrukcją przywrócenia); skopiować `.env` i `.dev.vars` (jeśli istnieją) do plików kopii; zapisać obie wersje z lokalnym Supabase, `ALLOWED_EMAILS=e2e@example.com`, `AI_MODE=fake`; uruchomić `npx playwright test` z przekazanymi argumentami i env testów; w `finally` (oraz na SIGINT/SIGTERM) przywrócić oryginały i usunąć kopie; zwrócić kod wyjścia Playwrighta.

**Contract**: format pliku env jak w CI (`ci.yml:59`); brak kopii oryginału = po przebiegu plik e2e jest usuwany. Wrapper nie jest używany w CI.

### Success Criteria:

#### Automated Verification:

- `npm run lint` i `npx astro check` przechodzą z nowymi plikami TS
- `npm test` nadal uruchamia tylko `src/**/*.test.ts` (vitest nie zbiera `e2e/`)
- `npm run e2e` lokalnie: projekt `setup` przechodzi, a `/dashboard` otwiera się zalogowany

#### Manual Verification:

- Po `npm run e2e` pliki `.env` i `.dev.vars` mają dokładnie poprzednią treść (porównanie sumy kontrolnej), plików kopii brak
- Przerwanie `npm run e2e` Ctrl+C w trakcie builda również przywraca oryginały
- Przy istniejącym pliku kopii wrapper odmawia startu z czytelnym komunikatem

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 4: E2E pętli US-01 (ryzyko #4)

### Overview

Pierwszy test w `e2e/critical-path.spec.ts` (`test.describe.serial`).

- **Zachowanie**: zalogowany użytkownik tworzy temat, czeka na podtematy z auto-generowania, zatwierdza listę w dialogu, przechodzi quiz (10× „Nie wiem” z asercją „Pytanie N z 10” przed każdym kliknięciem), generuje partię fiszek (202 + polling), wchodzi w „Ucz się” i widzi `h1` z przodem fiszki (`/fiszka/`) oraz „Pozostało: 10”.
- **Regresja wykrywana**: zepsuta hydratacja lub auto-start (`?generate=1`, `?start=1`), zły link między krokami, niedziałający konsument kolejki, strażnik strony („Najpierw …”) zamiast wyspy, pusta sesja nauki.
- **Źródło**: `research.md` § Ryzyko #4 (tabela kroków).
- **Przypadek brzegowy**: najdłuższe oczekiwanie — partia fiszek w kolejce (limit 60 s dla nagłówka „Partia 1 (opanowane 0/10)”); na każdej stronie asercja, że nie ma `h1` „Najpierw …”.
- **Anty-wzorzec unikany**: selektory CSS (tylko `getByRole`/`getByLabel`/`getByText`, `exact` przy „Zatwierdź”, „Wygeneruj fiszki”, „Ucz się”), stałe `waitForTimeout`, przypadki pokryte przez smoke.

### Changes Required:

#### 1. Test pętli

**File**: `e2e/critical-path.spec.ts`

**Intent**: Jeden test przechodzący kroki 1–7 z tabeli researchu wyłącznie akcjami użytkownika (bez `goto` z parametrami auto-startu), zapisujący id tematu z URL do zmiennej opisu dla testu z fazy 5.

**Contract**: nazwa tematu z losowym sufiksem; asercja końcowa na nagłówku fiszki i liczniku pozostałych.

### Success Criteria:

#### Automated Verification:

- `npm run e2e` przechodzi test pętli lokalnie
- Celowe zepsucie (niecommitowane): usunięcie `history.replaceState`/auto-startu w `QuizRunner.tsx` albo zmiana linku „Ucz się” czerwieni test z czytelnym trace

#### Manual Verification:

- Trace z porażki (`npx playwright show-trace`) pokazuje krok, na którym pętla stanęła

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 5: E2E kroku błędu oceny (ryzyko #5)

### Overview

Drugi test w tym samym `describe.serial`, na temacie z fazy 4.

- **Zachowanie**: klucz service-role ustawia jedną fiszkę tematu na `stage='open'`, `open_streak=0`, `due_on` = wczoraj (Warszawa), więc jest pierwsza w kolejce. Użytkownik otwiera sesję nauki, wpisuje tekst ze znacznikiem i losowym sufiksem, klika „Sprawdź”. Po błędzie: pole „Twoja odpowiedź” ma dokładnie wpisany tekst i jest read-only, widoczne „Spróbuj ponownie”; w bazie stan fiszki bez zmian, 0 wierszy `flashcard_answers` dla fiszki, `gradings` +1. Po „Spróbuj ponownie”: widoczny werdykt i uzasadnienie; w bazie 1 wiersz odpowiedzi z `answer_text` równym wpisanemu tekstowi, `gradings` +2, stan fiszki zmieniony zgodnie z werdyktem.
- **Regresja wykrywana**: wyczyszczenie pola lub remount karty po błędzie, ukrycie ponowienia, ponowienie z innym tekstem lub nowym `attemptId` (dwa wiersze), zapis przed oceną.
- **Źródło**: `research.md` § Ryzyko #5 (UI, kolejność zapisu).
- **Przypadek brzegowy**: limit +1 przy błędzie; tekst po błędzie nie jest edytowalny.
- **Anty-wzorzec unikany**: asercja samego komunikatu bez bazy; `page.route` zamiast prawdziwego błędu serwera.

### Changes Required:

#### 1. Test kroku błędu

**File**: `e2e/critical-path.spec.ts`

**Intent**: Seed fiszki przez helpery z `e2e/support/supabase.ts`, scenariusz UI jak wyżej, asercje bazy przed i po każdym kroku.

**Contract**: znacznik importowany z `src/lib/ai/fixtures.ts` (testy Playwright są w TS) lub stała zduplikowana z komentarzem, jeśli import modułu z `astro:env` się nie rozwiąże.

### Success Criteria:

#### Automated Verification:

- `npm run e2e` przechodzi oba testy lokalnie
- Celowe zepsucie (niecommitowane): czyszczenie `text`/`attempt` w `failed()` w `StudySession.tsx` czerwieni asercję pola; generowanie nowego `attemptId` w `retry()` czerwieni asercję „1 wiersz odpowiedzi”

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 6: CI i aktualizacja test-planu

### Overview

Podpiąć e2e do joba `smoke` i zapisać wzorce w test-planie.

### Changes Required:

#### 1. Workflow

**File**: `.github/workflows/ci.yml`

**Intent**: Dodać `e2e@example.com` do `ALLOWED_EMAILS` w zapisie `.env`/`.dev.vars`; po `smoke:topics` zainstalować Chromium (`npx playwright install --with-deps chromium`) i uruchomić `npx playwright test` z `CI=true` i kluczami Supabase (preview już działa — `reuseExistingServer`); przy porażce wysłać `playwright-report/` i `test-results/` jako artefakt.

**Contract**: krok wymagany w jobie `smoke`; bez nowych sekretów.

#### 2. Test-plan

**File**: `context/foundation/test-plan.md`

**Intent**: §5 — wiersz „e2e on critical flow”: wymagane w CI od Phase 1. §6.3 — lokalizacja (`e2e/`), test referencyjny (`e2e/critical-path.spec.ts`), uruchomienie (`npm run e2e`, warunek `enable_signup`), wzorzec logowania (`e2e/auth.setup.ts`), seed przez service-role i asercje bazy, szew `[fake-ai-fail-once]`. §6.5 — notatka etapu 1. §3 status wiersza 1 aktualizuje orkiestrator (`/10x-test-plan`), nie ta faza.

**Contract**: bez kotwic `file:line` w §1–§2 (zasada #3 test-planu).

### Success Criteria:

#### Automated Verification:

- Job `smoke` na PR przechodzi z krokiem e2e
- Job `ci` (lint, vitest, `astro check`, build) przechodzi

#### Manual Verification:

- Celowo czerwony e2e na gałęzi roboczej publikuje artefakt z trace w zakładce Actions
- §5 i §6.3 test-planu opisują to, co faktycznie trafiło do repo

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- Fixture fail-once: pierwszy raz błąd, drugi raz werdykt, inny tekst znów błąd, bez znacznika bez błędu.

### Integration Tests:

- `smoke-topics.mjs`: 503 → stan fiszki bez zmian, brak wiersza, `gradings` +1 → ponowienie 200, 1 wiersz, `gradings` +2.

### E2E:

- Pętla US-01 do przodu fiszki w sesji nauki.
- Błąd oceny w UI z asercjami bazy i udanym ponowieniem.

### Manual Testing Steps:

1. `npm run e2e` lokalnie, porównać `.env`/`.dev.vars` przed i po.
2. Ctrl+C w trakcie, sprawdzić przywrócenie.
3. Celowe zepsucia z kryteriów faz 2, 4, 5 (niecommitowane) — każdy test czerwienieje.

## Performance Considerations

E2E dodaje do joba `smoke` instalację Chromium i jeden przebieg (szacunkowo kilkadziesiąt sekund do ~2 min, głównie partia fiszek w kolejce). Jeden worker, bez równoległości.

## Migration Notes

Brak migracji bazy. Zmiana fixtury działa wyłącznie w trybie fake (lokalny Supabase).

## References

- Research: `context/changes/testing-critical-path-e2e/research.md`
- Test plan: `context/foundation/test-plan.md` §2 (#4, #5), §3 Phase 1, §5, §6.3
- Wzorzec logowania hasłem: `scripts/smoke-topics.mjs:95-117`
- Wzorzec kroku odpowiedzi otwartej: `scripts/smoke-topics.mjs:503-572`
- Kontrakt oceny: `context/archive/2026-10-28-ai-graded-open-answers/plan.md:44,155,209`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Szew fail-once w fake AI

#### Automated

- [x] 1.1 `npm test` przechodzi, w tym nowe przypadki fail-once w `grading-task.test.ts` — ccb6601
- [x] 1.2 `npm run lint` i `npx astro check` przechodzą — ccb6601
- [x] 1.3 Usunięcie zapamiętania tekstu (fixture zawodzi zawsze) czerwieni test „drugie wywołanie zwraca werdykt” — ccb6601

### Phase 2: Integracja ryzyka #5 w smoke-topics

#### Automated

- [x] 2.1 Job `smoke` w CI przechodzi z nowymi krokami „a failed grading …” i „a retried failed grading …” — 83fa60a
- [x] 2.2 Lokalnie `npm run smoke:topics` (przy preview na fake AI i lokalnym Supabase) wypisuje nowe kroki jako PASS — 83fa60a
- [x] 2.3 Przeniesienie wywołania `answerFlashcardOpen` przed ocenę AI w `study/answer.ts` (celowe zepsucie, niecommitowane) czerwieni krok „a failed grading leaves the card unchanged” — 83fa60a

### Phase 3: Infrastruktura Playwright

#### Automated

- [x] 3.1 `npm run lint` i `npx astro check` przechodzą z nowymi plikami TS — 34f860f
- [x] 3.2 `npm test` nadal uruchamia tylko `src/**/*.test.ts` (vitest nie zbiera `e2e/`) — 34f860f
- [x] 3.3 `npm run e2e` lokalnie: projekt `setup` przechodzi, a `/dashboard` otwiera się zalogowany — 34f860f

#### Manual

- [ ] 3.4 Po `npm run e2e` pliki `.env` i `.dev.vars` mają dokładnie poprzednią treść (porównanie sumy kontrolnej), plików kopii brak
- [ ] 3.5 Przerwanie `npm run e2e` Ctrl+C w trakcie builda również przywraca oryginały
- [x] 3.6 Przy istniejącym pliku kopii wrapper odmawia startu z czytelnym komunikatem

### Phase 4: E2E pętli US-01 (ryzyko #4)

#### Automated

- [x] 4.1 `npm run e2e` przechodzi test pętli lokalnie — 3ec8bf8
- [x] 4.2 Celowe zepsucie (niecommitowane): usunięcie `history.replaceState`/auto-startu w `QuizRunner.tsx` albo zmiana linku „Ucz się” czerwieni test z czytelnym trace — 3ec8bf8

#### Manual

- [x] 4.3 Trace z porażki (`npx playwright show-trace`) pokazuje krok, na którym pętla stanęła — 3ec8bf8

### Phase 5: E2E kroku błędu oceny (ryzyko #5)

#### Automated

- [x] 5.1 `npm run e2e` przechodzi oba testy lokalnie — a87f27e
- [x] 5.2 Celowe zepsucie (niecommitowane): czyszczenie `text`/`attempt` w `failed()` w `StudySession.tsx` czerwieni asercję pola; generowanie nowego `attemptId` w `retry()` czerwieni asercję „1 wiersz odpowiedzi” — a87f27e

### Phase 6: CI i aktualizacja test-planu

#### Automated

- [x] 6.1 Job `smoke` na PR przechodzi z krokiem e2e — 2dda55a
- [x] 6.2 Job `ci` (lint, vitest, `astro check`, build) przechodzi — 2dda55a

#### Manual

- [x] 6.3 Celowo czerwony e2e na gałęzi roboczej publikuje artefakt z trace w zakładce Actions — 2dda55a
- [x] 6.4 §5 i §6.3 test-planu opisują to, co faktycznie trafiło do repo — 2dda55a
