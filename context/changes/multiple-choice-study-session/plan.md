# S-05: Sesja nauki w formacie A/B/C/D — plan implementacji

## Overview

Użytkownik rozpoczyna sesję nauki tematu i dostaje kolejkę zaległych, nieopanowanych fiszek w formacie A/B/C/D. Wynik wyboru widzi natychmiast (< 300 ms), a serwer zapisuje odpowiedź i przestawia fiszkę wg tabeli z PRD § Business Logic: źle → wraca w tej samej sesji (na koniec kolejki), dobrze → format otwarty 0/2, wraca następnego dnia. Sesja jest w pełni używalna na telefonie. Realizuje FR-014 i część FR-015 (przejście A/B/C/D → otwarta; sam format otwarty to S-06). Wprowadza harmonogram i dziennik odpowiedzi, na których opierają się S-06, S-08 i S-09 (`context/foundation/roadmap.md:164-175`).

## Current State Analysis

- `flashcards` ma tylko treść fiszki i `correct_index`; brak stanu nauki i historii odpowiedzi (`supabase/migrations/20261024095230_create_flashcards.sql:38-66`). `authenticated` ma wyłącznie `select` i `delete` na `flashcards` (`...095230...sql:84-87`) — każdy zapis musi iść przez funkcję `security definer`.
- Wzorzec funkcji z odpowiedzią: `answer_quiz_question` — blokada wiersza nadrzędnego, odmowa jako P0409 z przyczyną w `hint` (`supabase/migrations/20261023125014_create_diagnostic_quizzes.sql:137-170`); mapowanie hintów na `TopicErrorCode` w repozytorium (`src/lib/topics/flashcard-repository.ts:46-60`).
- Granica dnia jest rozstrzygnięta: data kalendarzowa w Europe/Warsaw, jedna strefa dla wszystkich kont (`roadmap.md:261`, `supabase/migrations/20261018092416_create_ai_calls.sql` — `(now() at time zone 'Europe/Warsaw')::date`).
- `FlashcardView` już wysyła klientowi `correctIndex`, `answer`, `explanation`, `example` (`src/lib/topics/flashcard-repository.ts:7-19`) — przegląd partii z S-04 pokazuje poprawną opcję, więc natychmiastowe sprawdzenie po stronie klienta nie ujawnia niczego nowego. Opcje zostały przetasowane przy generowaniu (`src/lib/topics/flashcards-task.ts:145-168`).
- Kolejność fiszek: po pozycji podtematu, potem `position` (`flashcard-repository.ts:96-100`).
- Wejścia do fiszek: przycisk „Zobacz fiszki” na stronie tematu (`src/components/topics/TopicEditor.tsx:313-319`), strona `/topics/[id]/flashcards` (`src/pages/topics/[id]/flashcards.astro`).
- Kształt błędów i klient: `topicErrorResponse` (`src/lib/topics/errors.ts`), `callApi` (`src/components/topics/api.ts`); wzorzec endpointu z walidacją zod i stanem: `src/pages/api/topics/[id]/quiz/answer.ts`.
- Tokeny: `src/styles/global.css` ma `--primary`, `--destructive`, brak tokenu „poprawnie/sukces”.
- Brak `context/foundation/lessons.md`; reguły obszarów: `src/lib/topics/AGENTS.md`, `supabase/AGENTS.md` (owned-table pattern, rozszerzanie `account_isolation.test.sql`, `rls_guard`, migracje tylko dodawane, testy DB tylko w CI).

## Desired End State

Na temacie z gotową partią strona tematu i strona fiszek pokazują przycisk „Ucz się (N)”, gdzie N to liczba fiszek A/B/C/D z `due_on ≤ dziś (Warszawa)`. Strona `/topics/[id]/study` pokazuje po jednej fiszce: przód, 4 duże przyciski A–D. Po wyborze od razu widać poprawną opcję (i wybraną błędną), wzorcową odpowiedź, przykładowe zdanie (słownikowe) i „Czytaj więcej”; „Dalej” jest aktywne po potwierdzeniu zapisu przez serwer. Błędna fiszka wraca na koniec kolejki; sesja kończy się, gdy każda fiszka z kolejki dostała poprawną odpowiedź. Ekran końcowy pokazuje liczbę przerobionych fiszek i liczbę fiszek czekających na format otwarty. Po poprawnej odpowiedzi fiszka ma `stage = 'open'`, `open_streak = 0`, `due_on = jutro` i nie pojawia się w sesji S-05. Każda odpowiedź (także błędna) jest jednym wierszem `flashcard_answers`; ponowienie tego samego żądania nie tworzy drugiego wiersza. Konto B nie widzi ani nie zmienia stanu ani dziennika konta A.

Weryfikacja: pgTAP (`flashcard_study.test.sql`, rozszerzone `account_isolation.test.sql`, `rls_guard.test.sql`), Vitest (`study-queue.test.ts`, `study-day.test.ts`), rozszerzony `scripts/smoke-topics.mjs` w CI oraz testy ręczne na telefonie.

### Key Discoveries:

- Fiszki istniejące na produkcji muszą dostać stan przez wartości domyślne kolumn (`stage = 'choice'`, `due_on` = dziś w Warszawie) — migracja jest wyłącznie rozszerzająca (`supabase/AGENTS.md`, „expand, then contract”).
- `answer_quiz_question` odmawia ponownej odpowiedzi; tu ponowienie po błędzie sieci jest normalnym przypadkiem (zapis w tle), więc potrzebna jest idempotencja po identyfikatorze próby, a nie odmowa.
- Usunięcie fiszki (FR-012) nie może kasować historii nauki, z której S-09 policzy serię dni — dziennik trzyma `topic_id` i traci tylko odwołanie do fiszki.

## What We're NOT Doing

- Formatu otwartego, oceny AI, licznika 1/2 → opanowana (S-06). Fiszki `stage = 'open'` są w S-05 tylko liczone („czekają na format otwarty”), nigdy pokazywane.
- Ekranu głównego, daty ostatniej sesji per temat (S-08) i serii dni (S-09) — dziennik odpowiedzi je umożliwia, ale ich nie pokazujemy.
- Osobnej tabeli/stanu „sesji” po stronie serwera: sesja to kolejka w kliencie; zamknięcie karty kończy sesję, a błędne fiszki pozostają zaległe na dziś.
- Dodatkowej reguły „błąd dziś blokuje awans”: poprawna odpowiedź A/B/C/D po wcześniejszym błędzie w tej samej sesji też przestawia fiszkę na otwartą 0/2 (dosłownie tabela z PRD).
- Opcji „nie wiem” w sesji (jest tylko w quizie, FR-009) i ponownego tasowania opcji przy każdej sesji.
- SM-2 i kontrolnych powtórek opanowanych fiszek (PRD § Non-Goals).
- Testów e2e w przeglądarce (Moduł 3, Lekcja 4).

## Implementation Approach

Stan nauki żyje w kolumnach `flashcards`, a historia w nowej tabeli `flashcard_answers` (tylko do odczytu dla właściciela). Jedyna ścieżka zapisu to `answer_flashcard_choice(p_flashcard_id, p_answer, p_attempt_id)`: pod blokadą fiszki sprawdza, że jest w formacie A/B/C/D i zaległa, liczy poprawność z `correct_index` w bazie (nie ufa klientowi), stosuje przejście z tabeli i dopisuje wiersz dziennika — w jednej transakcji. API dostarcza kolejkę zaległych fiszek (`GET /study`) i przyjmuje odpowiedź (`POST /study/answer`). Kolejka i ponowne wstawianie błędnych fiszek to czysty moduł TS testowany Vitest; wyspa React pokazuje wynik natychmiast z `correctIndex`, a zapis idzie w tle i blokuje „Dalej” do potwierdzenia.

## Critical Implementation Details

- **Idempotencja ponowień** — klient generuje `attemptId` (`crypto.randomUUID()`) raz na kliknięcie odpowiedzi i używa go przy każdym ponowieniu zapisu. `flashcard_answers.id = p_attempt_id`; jeśli wiersz o tym id już istnieje dla wywołującego, funkcja zwraca zapisany wynik bez zmiany stanu. Bez tego ponowienie po utraconej odpowiedzi HTTP trafiłoby na `card_not_due` (fiszka już przeszła na otwartą) albo zdublowało błędną odpowiedź w dzienniku. Sprawdzenie istniejącej próby musi być przed sprawdzeniem `stage`/`due_on`.
- **Kolejność stanu w kliencie** — wynik (podświetlenie) pokazujemy od razu, ale przesunięcie kolejki (`requeue` przy błędzie / zdjęcie przy sukcesie) wykonujemy dopiero po potwierdzeniu zapisu, na podstawie `correct` z odpowiedzi serwera; gdy serwer i klient się różnią (np. nieaktualny `correctIndex`), wygrywa serwer, a UI pokazuje wynik serwera.
- **Data „dziś”** — SQL liczy ją jak `begin_ai_call`; TS (`warsawToday()`) tylko do filtrowania odczytów. Na granicy północy obie mogą się różnić o jedno żądanie — dopuszczalne, bo zapis i tak rozstrzyga funkcja w bazie.

## Phase 1: Schemat i funkcja odpowiedzi

### Overview

Migracja dodająca stan nauki, dziennik odpowiedzi i funkcję przejścia A/B/C/D, z testami pgTAP.

### Changes Required:

#### 1. Migracja

**File**: `supabase/migrations/<timestamp>_flashcard_study_state.sql` (przez `npx supabase migration new flashcard_study_state`)

**Intent**: Dać każdej fiszce stan harmonogramu i zapisywać każdą odpowiedź, tak by S-06/S-08/S-09 mogły z nich korzystać bez kolejnej zmiany kształtu.

**Contract**:
- `flashcards` + kolumny: `stage text not null default 'choice' check (stage in ('choice','open','mastered'))`, `open_streak smallint not null default 0 check (open_streak between 0 and 1)`, `due_on date not null default ((now() at time zone 'Europe/Warsaw')::date)`, `mastered_at timestamptz` (null do S-06). Indeks `(topic_id, stage, due_on)` pod zapytanie zaległych.
- Nowa tabela `flashcard_answers` w owned-table pattern (`supabase/AGENTS.md`): `id uuid primary key` (bez domyślnej — to `attempt_id`), `user_id` z domyślnym `auth.uid()`, `topic_id uuid not null` z FK `(topic_id, user_id) → topics on delete cascade`, `flashcard_id uuid` (nullable) z FK → `flashcards(id) on delete set null`, `format text not null check (format in ('choice','open'))`, `chosen_index smallint check (chosen_index between 0 and 3)`, `correct boolean not null`, `answered_at timestamptz not null default now()`, `answered_on date not null` (Warszawa). Indeksy `user_id`, `(topic_id, answered_on)`. RLS + cztery polityki właściciela; `revoke all` i `grant select` dla `authenticated`.
- `answer_flashcard_choice(p_flashcard_id uuid, p_answer smallint, p_attempt_id uuid) returns jsonb` — `security definer`, `set search_path = ''`, `revoke ... from public`, `grant ... to authenticated`. Kolejność: (1) istniejący `flashcard_answers.id = p_attempt_id` wywołującego → zwróć jego wynik; (2) `select ... for update` fiszki wywołującego, brak → `flashcard_not_found` (P0409, hint); (3) `stage <> 'choice' or due_on > today` → `card_not_due`; (4) `p_answer` spoza 0–3 → `validation_failed` (P0422); (5) poprawna: `stage = 'open'`, `open_streak = 0`, `due_on = today + 1`; błędna: bez zmian; (6) insert dziennika. Zwraca `{ "correct": bool, "correct_index": int, "stage": text, "due_on": date }`.
- Komentarz nagłówkowy w stylu istniejących migracji (co, dlaczego, jakie hinty).

#### 2. Testy pgTAP

**File**: `supabase/tests/database/flashcard_study.test.sql` (nowy), `supabase/tests/database/account_isolation.test.sql`

**Intent**: Udowodnić tabelę przejść, idempotencję, odmowy i izolację na poziomie bazy.

**Contract**: nowe fiszki mają `stage='choice'`, `due_on=dziś`; poprawna → `open/0/jutro` + 1 wiersz dziennika `correct=true`; błędna → stan bez zmian + wiersz `correct=false`; ta sama `p_attempt_id` drugi raz → ten sam wynik, nadal 1 wiersz; odpowiedź na fiszkę `open` lub z `due_on` w przyszłości → `card_not_due`; nieistniejąca/obca → `flashcard_not_found`; `authenticated` nie może `insert/update` w `flashcard_answers` ani `update` w `flashcards`; usunięcie fiszki zostawia wiersz dziennika z `flashcard_id is null`. W `account_isolation.test.sql`: konto B nie widzi dziennika A, nie może go zmienić/usunąć, nie może wstawić jako A i nie może odpowiedzieć na fiszkę A. `rls_guard.test.sql` przechodzi bez wyjątków dla nowej tabeli.

### Success Criteria:

#### Automated Verification:

- Migracja i testy bazy przechodzą w CI (`smoke` → `Database tests`: `npm run db:reset && npm run db:test`)
- `flashcard_study.test.sql` pokrywa przejścia, idempotencję, `card_not_due`, `flashcard_not_found` i `on delete set null`
- `account_isolation.test.sql` i `rls_guard.test.sql` obejmują `flashcard_answers` i przechodzą
- Lint przechodzi: `npm run lint`

#### Manual Verification:

- Przegląd migracji: wyłącznie rozszerzająca (istniejące fiszki dostają `choice` i dzisiejsze `due_on`), brak `grant` dla `anon`/`public`

**Implementation Note**: Po tej fazie i zielonym CI zatrzymaj się na ręczne potwierdzenie przed fazą 2.

---

## Phase 2: API sesji i kolejka

### Overview

Odczyt kolejki zaległych fiszek, zapis odpowiedzi przez funkcję z fazy 1, czysty moduł kolejki z testami i rozszerzony smoke.

### Changes Required:

#### 1. Dzień i kolejka

**File**: `src/lib/topics/study-day.ts`, `src/lib/topics/study-queue.ts` (+ `*.test.ts`)

**Intent**: Jedno miejsce na „dziś w Warszawie” po stronie TS i czysta logika kolejki sesji, testowalna bez UI.

**Contract**: `warsawToday(now?: Date): string` (`YYYY-MM-DD`, przez `Intl.DateTimeFormat` z `timeZone: 'Europe/Warsaw'`). Kolejka: `createQueue(cardIds)`, `current(queue)`, `answered(queue, correct)` — poprawna zdejmuje fiszkę z kolejki, błędna przesuwa ją na koniec; `drop(queue, cardId)` dla fiszki usuniętej w międzyczasie; `isDone(queue)`. Testy: kolejność, błąd na ostatniej fiszce wraca od razu, błąd → potem poprawna kończy sesję, `drop`, przejście DST/północ dla `warsawToday`.

#### 2. Repozytorium

**File**: `src/lib/topics/study-repository.ts`, `src/lib/topics/errors.ts`, `src/lib/topics/schemas.ts`, `src/lib/topics/http.ts`

**Intent**: Odczyt stanu sesji i zapis odpowiedzi w konwencjach `flashcard-repository.ts`.

**Contract**:
- `getStudySession(supabase, topicId): Promise<StudySession>` — `{ cards: FlashcardView[]; waitingOpen: number; today: string }`; `cards` = fiszki tematu (wszystkie partie) z `stage='choice' and due_on <= today`, posortowane po `due_on`, pozycji podtematu, `position`; `waitingOpen` = liczba `stage='open'`. Rzuca przy błędzie bazy (wrapper `readStudySession` w `http.ts`, jak `readFlashcardState`).
- `countDueCards(supabase, topicId): Promise<number>` — dla przycisków „Ucz się (N)”.
- `answerFlashcardChoice(supabase, cardId, answer, attemptId): Promise<RepoResult<ChoiceResult>>` — `ChoiceResult = { correct: boolean; correctIndex: number; stage: "choice" | "open" }`; hinty `card_not_due`, `flashcard_not_found` mapowane jak w `flashcard-repository.ts`.
- `TopicErrorCode` + `card_not_due` (409, „Ta fiszka nie czeka już na powtórkę.”, `retryable: false`).
- `studyAnswerInput` (zod): `{ cardId: uuid, answer: 0|1|2|3, attemptId: uuid }`.
- Ponowne użycie mapowania wiersza na `FlashcardView` z `flashcard-repository.ts` (wydzielić wspólną funkcję zamiast kopiować).

#### 3. Endpointy

**File**: `src/pages/api/topics/[id]/study/index.ts`, `src/pages/api/topics/[id]/study/answer.ts`

**Intent**: GET zwraca stan sesji; POST zapisuje jedną odpowiedź i zwraca jej wynik.

**Contract**: oba przez `requireSession` + `loadTopic`; GET → `{ data: StudySession }`; POST (`readJson(studyAnswerInput)`) → `{ data: ChoiceResult }` albo `topicErrorResponse(code)`. Fiszka spoza tematu z trasy → `flashcard_not_found` (filtr `topic_id` przed wywołaniem funkcji). Odstępstwo od „mutacje zwracają pełny stan”: kolejka jest stanem klienta z założenia (błędna fiszka wraca w tej samej sesji), więc POST zwraca wynik odpowiedzi, nie listę.

#### 4. Smoke

**File**: `scripts/smoke-topics.mjs`

**Intent**: Sprawdzić całą ścieżkę na prawdziwym PostgREST.

**Contract**: po wygenerowaniu partii: GET `/study` zwraca zaległe fiszki (bez usuniętej); błędna odpowiedź → `correct:false`, fiszka nadal w GET; poprawna → `correct:true`, znika z GET, `waitingOpen` rośnie o 1; ponowienie tego samego `attemptId` → ten sam wynik, bez zmiany `waitingOpen`; inna odpowiedź na tę fiszkę z nowym `attemptId` → 409 `card_not_due`; konto B → 404 na GET i POST. Licznik generowań bez zmian (sesja nie woła AI).

### Success Criteria:

#### Automated Verification:

- Testy jednostkowe przechodzą: `npm test` (`study-queue.test.ts`, `study-day.test.ts`)
- Kontrola typów i build przechodzą: `npm run build`
- Lint przechodzi: `npm run lint`
- Rozszerzony `smoke-topics.mjs` przechodzi w CI

#### Manual Verification:

- Na podglądzie gałęzi `curl`/DevTools: POST odpowiedzi wraca typowo < 300 ms, a ponowienie z tym samym `attemptId` nie dubluje wiersza w `flashcard_answers`

**Implementation Note**: Po tej fazie i zielonym CI zatrzymaj się na ręczne potwierdzenie przed fazą 3.

---

## Phase 3: UI nauki i wejścia

### Overview

Strona sesji z wyspą React, przyciski wejścia na stronie tematu i fiszek, aktualizacja przewodnika obszaru.

### Changes Required:

#### 1. Strona i wyspa

**File**: `src/pages/topics/[id]/study.astro`, `src/components/topics/StudySession.tsx`

**Intent**: Mobilna sesja A/B/C/D z natychmiastowym wynikiem i zapisem w tle.

**Contract**:
- Strona jak `flashcards.astro`: 404 dla obcego/brakującego tematu, blokady „Najpierw zatwierdź…”/„Najpierw ukończ quiz…”, brak partii → link do generowania; SSR wczytuje `getStudySession` i przekazuje `initial`.
- Wyspa: kolejka z `study-queue.ts`; ekran fiszki = nazwa podtematu, przód, licznik „pozostało N”, 4 przyciski A–D na pełną szerokość (min. 44 px wysokości, długie opcje się zawijają). Po kliknięciu: przyciski zablokowane, poprawna opcja podświetlona tokenem sukcesu, wybrana błędna — `destructive`; pod spodem wzorcowa odpowiedź, przykładowe zdanie (słownikowe) i „Czytaj więcej” (`Collapsible`). Zapis: `callApi` POST z `attemptId`; w trakcie „Zapisuję…”, „Dalej” aktywne po sukcesie; błąd → `Alert` z „Spróbuj ponownie” (ten sam `attemptId`); `flashcard_not_found` → `drop` i dalej; `card_not_due` → zdjęcie fiszki z kolejki z krótką informacją.
- Ekran pusty (brak zaległych na start) i końcowy: „Na dziś wszystko”, liczba przerobionych fiszek, `waitingOpen` jako „N fiszek czeka na format otwarty”, link do tematu.
- Fokus przenoszony na przód nowej fiszki po „Dalej” (klawiatura/czytnik ekranu).

#### 2. Token

**File**: `src/styles/global.css`

**Intent**: Kolor „poprawnie” jako token, nie literał (reguła UI w `CLAUDE.md`).

**Contract**: `--success` / `--success-foreground` w `:root` i `.dark` oraz mapowanie w `@theme inline`.

#### 3. Wejścia

**File**: `src/pages/topics/[id].astro`, `src/components/topics/TopicEditor.tsx`, `src/pages/topics/[id]/flashcards.astro`, `src/components/topics/FlashcardBatch.tsx`

**Intent**: Przycisk „Ucz się (N)” przy istniejącej partii na stronie tematu i pod partią na stronie fiszek.

**Contract**: strony przekazują `dueCount` z `countDueCards` (błąd odczytu → przycisk bez liczby, jak `hasFlashcards`); przycisk prowadzi do `/topics/[id]/study`; przy `N = 0` nadal widoczny („Ucz się”), strona sesji pokaże ekran pusty.

#### 4. Przewodnik obszaru

**File**: `src/lib/topics/AGENTS.md`

**Intent**: Utrwalić nieoczywiste niezmienniki dla S-06/S-08/S-09.

**Contract**: krótka sekcja: stan nauki zmienia wyłącznie funkcja `answer_flashcard_choice` (S-06 doda swoją dla formatu otwartego), każda odpowiedź = wiersz `flashcard_answers` z `attemptId` jako kluczem idempotencji, „dziś” = Europe/Warsaw (`study-day.ts`), dziennik przeżywa usunięcie fiszki.

### Success Criteria:

#### Automated Verification:

- Build i typy przechodzą: `npm run build`
- Lint przechodzi: `npm run lint`
- Testy jednostkowe nadal przechodzą: `npm test`

#### Manual Verification:

- Na telefonie (podgląd gałęzi): cała sesja do ekranu końcowego bez poziomego przewijania, przyciski wygodne kciukiem, wynik widoczny od razu po dotknięciu
- Błędna fiszka wraca na koniec kolejki; po poprawnej odpowiedzi znika i zwiększa licznik „czeka na format otwarty”
- Tryb samolotowy w trakcie zapisu: komunikat z ponowieniem, po powrocie sieci „Spróbuj ponownie” zapisuje bez duplikatu
- Przycisk „Ucz się (N)” na stronie tematu i fiszek pokazuje poprawne N i prowadzi do sesji
- Ponowne wejście tego samego dnia po ukończeniu sesji pokazuje „Na dziś wszystko”

**Implementation Note**: Po tej fazie zatrzymaj się na ręczne potwierdzenie testów na telefonie.

---

## Testing Strategy

### Unit Tests:

- `study-queue.ts`: kolejność wejściowa, błąd → koniec kolejki, błąd na jedynej fiszce, błąd → poprawna kończy sesję, `drop`.
- `study-day.ts`: data w Warszawie tuż przed i po północy UTC oraz przy zmianie czasu.

### Integration Tests:

- pgTAP: tabela przejść, idempotencja `attempt_id`, odmowy, `on delete set null`, izolacja kont, `rls_guard`.
- `smoke-topics.mjs`: GET/POST sesji na prawdziwym PostgREST, ponowienie, `card_not_due`, drugie konto.

### Manual Testing Steps:

1. Wygeneruj partię, kliknij „Ucz się (10)” na stronie tematu.
2. Odpowiedz źle na pierwszą fiszkę — po „Dalej” przechodzi kolejna, a błędna wraca na końcu.
3. Odpowiedz dobrze na wszystkie — ekran końcowy z „10 fiszek czeka na format otwarty”.
4. Odśwież stronę sesji — „Na dziś wszystko”; przycisk na stronie tematu pokazuje 0.
5. Na telefonie powtórz 2–3 z wyłączeniem sieci w chwili zapisu.

## Performance Considerations

Natychmiastowe sprawdzenie nie zależy od sieci (wynik z `correctIndex` w kliencie), więc NFR < 300 ms jest spełniony niezależnie od opóźnienia Workers↔Supabase. Zapytanie kolejki korzysta z indeksu `(topic_id, stage, due_on)`; skala (kilkadziesiąt fiszek na temat) nie wymaga stronicowania.

## Migration Notes

Migracja tylko rozszerza: nowe kolumny z wartościami domyślnymi i nowa tabela. Worker sprzed tej zmiany nie czyta nowych kolumn i dalej działa (wycofanie Workera bezpieczne). Istniejące fiszki z S-04 stają się zaległe dziś. `db push` na produkcję wykonuje człowiek.

## References

- Roadmap: `context/foundation/roadmap.md:164-175` (S-05)
- PRD: `context/foundation/prd.md` — FR-014, FR-015, NFR (< 300 ms, telefon), § Business Logic (tabela harmonogramu)
- Wzorzec funkcji odpowiedzi: `supabase/migrations/20261023125014_create_diagnostic_quizzes.sql:137-170`
- Schemat fiszek: `supabase/migrations/20261024095230_create_flashcards.sql`, `supabase/migrations/20261025182503_claim_tokens_and_option_nulls.sql`
- Repozytorium i widok fiszki: `src/lib/topics/flashcard-repository.ts`
- Wzorzec endpointu: `src/pages/api/topics/[id]/quiz/answer.ts`
- Wzorzec UI: `src/components/topics/FlashcardBatch.tsx`, `src/components/topics/QuizRunner.tsx`
- Przewodniki: `src/lib/topics/AGENTS.md`, `supabase/AGENTS.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schemat i funkcja odpowiedzi

#### Automated

- [x] 1.1 Migracja i testy bazy przechodzą w CI (`smoke` → `Database tests`: `npm run db:reset && npm run db:test`) — b2f0400
- [x] 1.2 `flashcard_study.test.sql` pokrywa przejścia, idempotencję, `card_not_due`, `flashcard_not_found` i `on delete set null` — b2f0400
- [x] 1.3 `account_isolation.test.sql` i `rls_guard.test.sql` obejmują `flashcard_answers` i przechodzą — b2f0400
- [x] 1.4 Lint przechodzi: `npm run lint` — b2f0400

#### Manual

- [x] 1.5 Przegląd migracji: wyłącznie rozszerzająca (istniejące fiszki dostają `choice` i dzisiejsze `due_on`), brak `grant` dla `anon`/`public` — b2f0400

### Phase 2: API sesji i kolejka

#### Automated

- [x] 2.1 Testy jednostkowe przechodzą: `npm test` (`study-queue.test.ts`, `study-day.test.ts`)
- [x] 2.2 Kontrola typów i build przechodzą: `npm run build`
- [x] 2.3 Lint przechodzi: `npm run lint`
- [ ] 2.4 Rozszerzony `smoke-topics.mjs` przechodzi w CI

#### Manual

- [x] 2.5 Na podglądzie gałęzi `curl`/DevTools: POST odpowiedzi wraca typowo < 300 ms, a ponowienie z tym samym `attemptId` nie dubluje wiersza w `flashcard_answers`

### Phase 3: UI nauki i wejścia

#### Automated

- [ ] 3.1 Build i typy przechodzą: `npm run build`
- [ ] 3.2 Lint przechodzi: `npm run lint`
- [ ] 3.3 Testy jednostkowe nadal przechodzą: `npm test`

#### Manual

- [ ] 3.4 Na telefonie (podgląd gałęzi): cała sesja do ekranu końcowego bez poziomego przewijania, przyciski wygodne kciukiem, wynik widoczny od razu po dotknięciu
- [ ] 3.5 Błędna fiszka wraca na koniec kolejki; po poprawnej odpowiedzi znika i zwiększa licznik „czeka na format otwarty”
- [ ] 3.6 Tryb samolotowy w trakcie zapisu: komunikat z ponowieniem, po powrocie sieci „Spróbuj ponownie” zapisuje bez duplikatu
- [ ] 3.7 Przycisk „Ucz się (N)” na stronie tematu i fiszek pokazuje poprawne N i prowadzi do sesji
- [ ] 3.8 Ponowne wejście tego samego dnia po ukończeniu sesji pokazuje „Na dziś wszystko”
