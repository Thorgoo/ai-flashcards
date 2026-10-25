# S-04: Pierwsza partia fiszek ze słabych podtematów — plan implementacji

## Overview

Po ukończeniu quizu diagnostycznego użytkownik jednym kliknięciem dostaje partię 10 fiszek wygenerowanych przez AI, rozdzielonych między podtematy według słabości z quizu (każdy podtemat ≥ 1, także ten ze 100%), w kształcie zależnym od typu treści (`conceptual` / `vocabulary`), z rozszerzonym wyjaśnieniem „czytaj więcej” zapisanym razem z fiszką. Partię przegląda na nowej stronie `/topics/[id]/flashcards` i usuwa niechciane fiszki. Realizuje FR-011, FR-012, FR-013, FR-028 i część FR-020 (100% nie jest pomijane). To gwiazda przewodnia roadmapy (`context/foundation/roadmap.md:152-162`).

## Current State Analysis

- Wejście rankingu: `quiz_results(p_quiz_id)` liczy `asked/correct/dont_know` per podtemat przy odczycie (`supabase/migrations/20261023125014_create_diagnostic_quizzes.sql:174-205`), `percent` liczy `getQuizState` (`src/lib/topics/quiz-repository.ts:144-152`). „Nie wiem” = błędna. Quiz ukończony ⇔ `quizzes.completed_at IS NOT NULL`.
- Wzorzec generowania z S-03: `claim_quiz` → AI → `create_quiz` (jedna transakcja) → `release_quiz_claim` przy błędzie; `waitUntil` + polling GET (`src/pages/api/topics/[id]/quiz/index.ts`, `supabase/migrations/20261024064348_quiz_generation_claim.sql:124-242`). Powstał po incydencie z produkcji (S-03 impl-review F1).
- Zadanie AI: `quizSchema(quotas)` z `superRefine` na kwoty, `toQuizRows` z wstrzykiwalnym `random` (`src/lib/topics/quiz-task.ts:22-52, 105-126`); fixture sterowany tagami promptu (`src/lib/ai/fixtures.ts:25-37`). `AiRequest.timeoutMs` istnieje (`src/lib/ai/call.ts:124`).
- Brak czegokolwiek dla fiszek w `src/` i `supabase/` (research §Summary).
- Pełne ustalenia: `context/changes/first-weak-subtopic-batch/research.md`.

## Desired End State

Na zatwierdzonym temacie z ukończonym quizem ekran wyniku quizu i strona tematu pokazują „Wygeneruj fiszki”. Kliknięcie otwiera `/topics/[id]/flashcards?start=1`, które generuje partię nr 1 (jedno wywołanie AI, 1 z 20 dziennych generowań) z widocznym postępem; przeładowanie strony w trakcie nie zużywa drugiego generowania i kończy się pokazaniem partii po odpytywaniu. Gotowa partia ma dokładnie 10 fiszek w podziale z reguły rozdziału, pogrupowanych po podtematach; każda pokazuje przód, 4 opcje z zaznaczoną poprawną, wzorcową odpowiedź, przykładowe zdanie (słownikowe) i rozwijane „Czytaj więcej”. Usunięcie fiszki po potwierdzeniu znika ją trwale. Drugie generowanie pierwszej partii jest odrzucane. Konto B nie widzi ani nie usuwa fiszek konta A.

Weryfikacja: pgTAP (`flashcards.test.sql`, rozszerzony `account_isolation.test.sql`, `rls_guard.test.sql`), Vitest (`flashcards-task.test.ts`), rozszerzony `scripts/smoke-topics.mjs` w CI oraz testy ręczne na podglądzie z prawdziwym AI.

### Key Discoveries:

- Kwoty dla quizu dają każdemu podtematowi ≥ 1 pytanie przy 2–10 podtematach (`src/lib/topics/quiz-task.ts:14-18`), więc każdy podtemat ma wynik; `quiz_results` robi jednak `join ... group by` od pytań (`...125014...sql:201-203`) — lista podtematów do rozdziału pochodzi z `subtopics`, brak wyniku = 0%.
- Błędy funkcji quizu: P0409/P0422 z przyczyną w `hint`, mapowane w TS (`quiz-repository.ts:64-73`) — fiszki robią to samo.
- `authenticated` tylko czyta quizy; zapisy wyłącznie przez RPC `SECURITY DEFINER` (`...064348...sql:15-16`).
- `rls_guard.test.sql` wymaga polityki per komenda i `user_id` na każdej tabeli; `account_isolation.test.sql` ma `plan(27)`.
- Smoke: pętla limitu dziennego zaczyna od 4, bo wcześniej są 3 generowania (`scripts/smoke-topics.mjs:234-236`).
- `Confirmation` jest lokalny w `src/components/topics/TopicEditor.tsx:321-342`; portal wymaga `PORTAL_THEME` (`TopicEditor.tsx:42`). Brak komponentu collapsible w `src/components/ui`.

## What We're NOT Doing

- Kolejne partie (numer > 1), próg 80% i opanowanie podtematów — S-07. Schemat przewiduje `seq`, ale RPC S-04 obsługują wyłącznie partię nr 1.
- Sesja nauki, harmonogram, stan fiszki (A/B/C/D → otwarta) — S-05; ocena odpowiedzi otwartej — S-06.
- Ponowne wygenerowanie pierwszej partii (również gdy użytkownik usunie wszystkie fiszki) — świadomie poza zakresem; kolejną partię da S-07.
- Edycja treści fiszki — FR-012 mówi tylko o usuwaniu.
- Miękkie usuwanie i licznik historyczny opanowanych (FR-026) — S-10 utrzyma własny stan.
- Streaming, `AbortSignal`, `beforeunload`, zmiany w `src/lib/ai/*` — budżet ustawia samo zadanie (`timeoutMs`, `maxTokens`).
- Claim dla generowania podtematów (ślepa plamka z S-03 F1) i blokada `scope_note` po zatwierdzeniu (S-02 F4 → S-08).
- Ochrona przed odczytem `correct_index` quizu przez PostgREST (S-03 F5) — skutek dotyczy wyłącznie danych własnego konta; akceptowane dalej.
- Playwright — test z perspektywy użytkownika pozostaje API-level smoke.

## Implementation Approach

Kopia wzorca quizu warstwa po warstwie: baza z niezmiennikami (claim, rozmiar partii, przynależność podtematu do tematu, zapis tylko przez RPC) → czysta logika domeny i zadanie AI testowalne bez sieci → endpointy z `waitUntil` i pollingiem → UI. Reguła rozdziału jest czystą funkcją TS, żeby była deterministyczna, testowana jednostkowo i podawana modelowi jako obowiązkowe kwoty (jak `pytan` w quizie), a `superRefine` odrzuca wynik z innym rozdziałem.

**Reguła rozdziału (decyzja z planowania):** wejście = podtematy tematu w kolejności `position` z `percent` z quizu (brak wyniku = 0). Każdy dostaje 1. Pozostałe `R = 10 − n` dzielone proporcjonalnie do wagi `w = 100 − percent` metodą największych reszt (podłoga udziałów, potem po jednej dla największych części ułamkowych; remis reszt → niższa `position`). Gdy suma wag = 0 (wszystkie 100%), `R` dzielone równo jak `quizQuotas` (różnica ≤ 1, nadwyżka dla pierwszych pozycji). Przykład: A 0%, B 33%, C 50%, D 100% → A4 B3 C2 D1; 10 podtematów → po 1; A 0%, D 100% → A9 D1.

## Critical Implementation Details

- **Budżet czasu:** zadanie ustawia `timeoutMs: 90_000` i `maxTokens: 8000`; TTL claimu partii = 120 s (> timeout) i ta sama stała musi być w TS (`getFlashcardState` traktuje starszy claim jak brak partii) oraz w SQL (`claim_flashcard_batch` przejmuje starszy). Rozjazd tych liczb przywraca błąd z S-03 F1.
- **Kolejność w POST:** sprawdzenie zatwierdzenia i ukończenia quizu → claim → AI. Claim w SQL ponownie sprawdza oba warunki pod blokadą, bo stan mógł się zmienić między odczytem a claimem.

## Phase 1: Baza fiszek

### Overview

Tabele partii i fiszek z izolacją kont, zapis wyłącznie przez RPC w jednej transakcji, usuwanie fiszki przez RLS.

### Changes Required:

#### 1. Migracja

**File**: `supabase/migrations/<timestamp>_create_flashcards.sql` (przez `npx supabase migration new create_flashcards`)

**Intent**: Dodać `flashcard_batches` i `flashcards` wg wzorca `quizzes` / `quiz_questions` oraz trzy funkcje generowania; zablokować bezpośrednie zapisy poza usuwaniem fiszki.

**Contract**:
- `flashcard_batches`: `id`, `user_id` (default `auth.uid()`, cascade), `topic_id`, `seq int check (seq >= 1)`, `status text check in ('generating','ready') default 'generating'`, `claimed_at timestamptz default now()`, `created_at`; `unique (topic_id, seq)`, `unique (id, topic_id)`; FK `(topic_id, user_id)` → `topics (id, user_id)` on delete cascade; indeks na `user_id`.
- `flashcards`: `id`, `user_id`, `topic_id`, `batch_id`, `subtopic_id`, `position int check (position between 0 and 9)`, `front` (1–300 znaków), `answer` (1–600), `options text[]` (dokładnie 4), `correct_index` (0–3), `explanation` (1–1500), `example` (null lub 1–300), `created_at`; FK `(batch_id, topic_id)` → `flashcard_batches (id, topic_id)` on delete cascade, `(subtopic_id, topic_id)` → `subtopics (id, topic_id)`, `(topic_id, user_id)` → `topics (id, user_id)`; `unique (batch_id, position)`; indeksy na `user_id` i `batch_id`. Limity długości identyczne z zod w fazie 2.
- RLS na obu, po jednej polityce na komendę `to authenticated` z `(select auth.uid()) = user_id`. `revoke all ... from authenticated`, `grant select` na obu, dodatkowo `grant delete on flashcards`.
- `claim_flashcard_batch(p_topic_id uuid) returns void` — `SECURITY DEFINER`, `set search_path = ''`, jawne `auth.uid()`: temat własny `FOR SHARE` i `confirmed` (inaczej P0409 `topic_not_confirmed`), quiz tematu z `completed_at` (inaczej P0409 `quiz_not_completed`); `insert ... seq = 1 ... on conflict (topic_id, seq) do nothing`; przy konflikcie wiersz `FOR UPDATE`: `ready` → P0409 `batch_exists`, `generating` młodszy niż 120 s → P0409 `batch_generating`, starszy → `claimed_at = now()` (przejęcie).
- `release_flashcard_batch_claim(p_topic_id uuid) returns void` — usuwa własną partię nr 1 tylko w stanie `generating`.
- `create_flashcard_batch(p_topic_id uuid, p_cards jsonb) returns void` — temat `FOR SHARE`; `jsonb_array_length = 10` (inaczej P0422 `batch_size`); partia nr 1 własna `FOR UPDATE`: `ready` → P0409 `batch_exists`, brak → P0409 `batch_not_claimed`; przełącza na `ready` i wstawia wszystkie fiszki jednym `insert ... select from jsonb_array_elements with ordinality` (`position = ordinality - 1`). Pola elementu: `subtopic_id, front, answer, options, correct_index, explanation, example`.
- Wszystkie trzy: `revoke execute ... from public`, `grant execute ... to authenticated`.

#### 2. Testy bazy

**File**: `supabase/tests/database/flashcards.test.sql` (nowy), `supabase/tests/database/account_isolation.test.sql`

**Intent**: Udowodnić niezmienniki w SQL, bo API nie jest jedyną drogą zapisu (PostgREST).

**Contract**: `flashcards.test.sql` sprawdza: claim na szkicu → `topic_not_confirmed`; claim przed ukończeniem quizu → `quiz_not_completed`; drugi claim → `batch_generating`; claim z `claimed_at` cofniętym o > 120 s jest przejmowany; `create_flashcard_batch` z 9 elementami → `batch_size`; z podtematem innego tematu → błąd FK; poprawny create → partia `ready` i 10 fiszek z `position` 0–9; claim po `ready` → `batch_exists`; `release` nie usuwa partii `ready`; `authenticated` nie może `insert`/`update` w obu tabelach (42501); usunięcie własnej fiszki działa. `account_isolation.test.sql` dokłada dla obu tabel: B nie widzi wierszy A, `delete` B na fiszce A nic nie usuwa, `insert` B → 42501, A nadal ma swoje wiersze; licznik `plan(...)` podbity.

### Success Criteria:

#### Automated Verification:

- CI `smoke` → `Database tests` przechodzi z nowym `flashcards.test.sql` i rozszerzonym `account_isolation.test.sql`
- `rls_guard.test.sql` przechodzi bez nowych wpisów w `rls_guard_exceptions`
- `npm run lint` przechodzi

#### Manual Verification:

- Migracja wypchnięta `db push` na produkcyjne Supabase przed merge, bez błędów

**Implementation Note**: Po zielonym CI tej fazy zatrzymaj się na potwierdzenie ręcznego `db push`, zanim ruszysz dalej.

---

## Phase 2: Domena i zadanie AI

### Overview

Czysta logika rozdziału, zadanie AI fiszek (schemat, prompt, mapowanie na wiersze), fixture fake i repozytorium stanu partii.

### Changes Required:

#### 1. Zadanie fiszek

**File**: `src/lib/topics/flashcards-task.ts` (nowy)

**Intent**: Odpowiednik `quiz-task.ts` dla fiszek: reguła rozdziału, schemat z kwotami i wymaganiami per typ treści, prompt, mapowanie z tasowaniem opcji.

**Contract**:
- Stałe: `FLASHCARDS_TASK = "flashcards"`, `BATCH_SIZE = 10`, `FLASHCARD_CLAIM_TTL_SECONDS = 120` (komentarz z odwołaniem do `claim_flashcard_batch`).
- `batchAllocation(percents: number[]): number[]` — wejście w kolejności `position`, wyjście sumuje się do 10; reguła z „Implementation Approach”.
- `flashcardsSchema(subtopics: { quota: number; contentType: ContentType }[])` — `cards` o długości 10; element: `subtopicIndex` (1..n), `front` (≤ 300), `correctOption` (≤ 200), `wrongOptions` (dokładnie 3, ≤ 200), `answer` (≤ 600), `explanation` (≤ 1500), `example` (string ≤ 300 lub null); `superRefine`: liczba fiszek per podtemat = kwota, 4 opcje różne bez względu na wielkość liter, `example` niepuste dla `vocabulary` i null dla `conceptual`.
- Prompt systemowy po polsku. `conceptual`: `front` = pytanie wymagające odpowiedzi w 2–3 zdaniach; `correctOption` = krótka poprawna odpowiedź do A/B/C/D; `wrongOptions` = wiarygodne, jednoznacznie błędne; `answer` = wzorcowa odpowiedź w 2–3 zdaniach. `vocabulary`: `front` = słowo/zwrot w języku tematu; `correctOption` = tłumaczenie; `wrongOptions` = 3 błędne tłumaczenia; `example` = przykładowe zdanie w języku tematu; `answer` = tłumaczenie + przykładowe zdanie (wzorzec odpowiedzi „znaczenie + własne zdanie” dla S-06). `explanation` = rozszerzone wyjaśnienie pojęcia (≤ 1500 znaków). Słabszym podtematom (niższy `wynik`) fiszki z podstaw. Klauzula o danych w znacznikach jak w quizie.
- `buildFlashcardsRequest(topic, subtopics: FlashcardSubtopic[])` — `FlashcardSubtopic = { id, name, contentType, percent }`; prompt z `<temat>`, `<notatka>` i `<podtemat nr typ fiszek wynik>` przez `asData`; `kind: "generation"`, `maxTokens: 8000`, `timeoutMs: 90_000`.
- `toFlashcardRows(generated, subtopics, random = Math.random): FlashcardRow[]` — mapuje `subtopicIndex` na id, składa 4 opcje (poprawna + 3 błędne), tasuje i ustawia `correct_index`; `FlashcardRow` = pola elementu `p_cards` z fazy 1.

#### 2. Fixture fake

**File**: `src/lib/ai/fixtures.ts`

**Intent**: Fixture `FLASHCARDS_TASK` wyprowadzony z tagów `<podtemat nr typ fiszek>`, więc zawsze spełnia kwoty i reguły typu.

**Contract**: wpis `[FLASHCARDS_TASK]` w `fakeFixtures`; dla `vocabulary` wypełnia `example`, dla `conceptual` daje `null`.

#### 3. Repozytorium

**File**: `src/lib/topics/flashcard-repository.ts` (nowy), `src/lib/topics/http.ts`

**Intent**: Odczyt stanu partii i wrappery RPC w stylu `quiz-repository.ts`; mapowanie błędów po `hint`.

**Contract**:
- `FlashcardView = { id, subtopicId, subtopicName, contentType, front, answer, options, correctIndex, explanation, example }`; `FlashcardState = { batch: { id, status: "generating" | "ready" }, cards: FlashcardView[] }`.
- `getFlashcardState(supabase, topicId): Promise<FlashcardState | null>` — partia nr 1; brak → null; `generating` starszy niż TTL → null; `generating` → puste `cards`; `ready` → fiszki posortowane po `position` podtematu, potem `position` fiszki. Rzuca przy błędzie bazy.
- `claimFlashcardBatch`, `releaseFlashcardBatchClaim` (loguje i połyka błąd), `createFlashcardBatch(supabase, topicId, rows)`, `deleteFlashcard(supabase, topicId, cardId)` — `RepoResult<null>`; usunięcie 0 wierszy → `flashcard_not_found`. P0409 hinty: `topic_not_confirmed`, `quiz_not_completed`, `batch_exists`, `batch_generating`; reszta → `save_failed` z logiem.
- `http.ts`: `readFlashcardState(supabase, topicId)` analogicznie do `readQuizState`.

#### 4. Testy jednostkowe

**File**: `src/lib/topics/flashcards-task.test.ts` (nowy)

**Intent**: Deterministyczne sprawdzenie reguły rozdziału, schematu, promptu i mapowania bez sieci.

**Contract**: `batchAllocation`: `[0,33,50,100]` → `[4,3,2,1]`; 10 × dowolne → po 1; `[0,100]` → `[9,1]`; `[100,100,100]` → `[4,3,3]`; remis reszt rozstrzyga niższa pozycja; suma zawsze 10. Schemat: odrzuca złą kwotę, powtórzone opcje, brak `example` dla `vocabulary`, `example` dla `conceptual`; `zodOutputFormat(schema)` nie rzuca. `toFlashcardRows` z wstrzykniętym `random`: poprawna opcja trafia pod `correct_index`. End-to-end `callAi` z `createFakeProvider(fakeFixtures)` zwraca poprawną partię dla tematu mieszanego.

### Success Criteria:

#### Automated Verification:

- `npm test` przechodzi z nowym `flashcards-task.test.ts`
- `npm run lint` przechodzi
- `npm run build` przechodzi

---

## Phase 3: API

### Overview

Endpointy generowania (z claimem, `waitUntil`, pollingiem) i usuwania, nowe kody błędów, rozszerzony smoke.

### Changes Required:

#### 1. Kody błędów

**File**: `src/lib/topics/errors.ts`

**Intent**: Dodać kody bez zmiany kształtu.

**Contract**: `quiz_not_completed` (409, „Najpierw ukończ quiz diagnostyczny.”), `batch_exists` (409, „Ten temat ma już pierwszą partię fiszek.”), `batch_generating` (409, „Fiszki są właśnie przygotowywane.”), `flashcard_not_found` (404, „Nie znaleziono fiszki.”); wszystkie `retryable: false`.

#### 2. Generowanie i stan

**File**: `src/pages/api/topics/[id]/flashcards/index.ts` (nowy)

**Intent**: Kopia przepływu `quiz/index.ts` dla partii nr 1.

**Contract**: `GET` → `{ data: FlashcardState | null }`. `POST` → `requireSession` → `loadTopic` → `topic_not_confirmed` jeśli szkic → `readQuizState`; brak `completedAt` → `quiz_not_completed` → `claimFlashcardBatch` → praca w `cfContext.waitUntil` i `await`: `buildFlashcardsRequest` z podtematami w kolejności `position` i `percent` z `results` (brak = 0) → `ai.call` → `toFlashcardRows` → `createFlashcardBatch` → `readFlashcardState` → `aiResponse({ ok, data: state, remaining })`; błąd AI lub zapisu → `releaseFlashcardBatchClaim`.

#### 3. Usuwanie

**File**: `src/pages/api/topics/[id]/flashcards/[cardId].ts` (nowy)

**Intent**: Twarde usunięcie fiszki i odpowiedź pełnym stanem partii.

**Contract**: `DELETE` → `requireSession` → `loadTopic` → `isUuid(cardId)` (inaczej `flashcard_not_found`) → `deleteFlashcard` → `{ data: FlashcardState | null }`.

#### 4. Smoke

**File**: `scripts/smoke-topics.mjs`

**Intent**: Test z perspektywy użytkownika na fake AI dla nowego przepływu.

**Contract**: `POST /flashcards` przed ukończeniem quizu → 409 `quiz_not_completed`; po ukończeniu → 200, `X-AI-Mode: fake`, 10 fiszek, każdy podtemat ≥ 1, liczby per podtemat równe `batchAllocation` policzonej z wyników quizu zwróconych przez API (reguła przepisana w skrypcie lub zaimportowana — implementujący wybiera prostsze); drugi `POST` → 409 `batch_exists`; `DELETE` jednej → 9 fiszek; ponowny `DELETE` tej samej → 404 `flashcard_not_found`; konto B: `GET` fiszek tematu A → 404. Pętla limitu dziennego startuje od 5 zamiast 4.

### Success Criteria:

#### Automated Verification:

- `npm test`, `npm run lint`, `npm run build` przechodzą
- CI `smoke` (z `smoke-topics.mjs`) przechodzi z nowymi krokami fiszek

---

## Phase 4: UI

### Overview

Strona fiszek z auto-startem, postępem, listą, „czytaj więcej” i usuwaniem; wejścia z ekranu wyniku quizu i strony tematu.

### Changes Required:

#### 1. Wspólne potwierdzenie i collapsible

**File**: `src/components/topics/Confirmation.tsx` (nowy, wyjęty z `TopicEditor.tsx:321-342`), `src/components/topics/TopicEditor.tsx`, `src/components/ui/collapsible.tsx` (z rejestru shadcn)

**Intent**: Ponowne użycie istniejącego dialogu potwierdzenia bez zmiany zachowania edytora; dodać brakujący komponent do „czytaj więcej” (poprawić import `cn` jak w S-03).

**Contract**: `Confirmation` eksportowany z tym samym API co dziś; `TopicEditor` importuje go zamiast lokalnej definicji.

#### 2. Strona i wyspa

**File**: `src/pages/topics/[id]/flashcards.astro` (nowy), `src/components/topics/FlashcardBatch.tsx` (nowy), `src/components/topics/api.ts`

**Intent**: Strona renderowana po stronie serwera wg `quiz.astro`; wyspa wg `QuizRunner.tsx` (auto-start `?start=1` usuwany przed wywołaniem, `GeneratingNotice`, polling GET co 2 s przy `generating` i przy `batch_generating`, `Alert` z „Spróbuj ponownie” przy `retryable`).

**Contract**:
- Strona: 404 dla obcego/nieistniejącego tematu; temat niezatwierdzony lub quiz nieukończony → komunikat z linkiem do tematu (jak szkic w `quiz.astro`); odczyt stanu w try/catch; wrapper `dark bg-background`, `max-w-2xl p-4`, `Topbar`.
- Wyspa, stan `null` → przycisk „Wygeneruj fiszki”; `ready` → fiszki pogrupowane po podtemacie z odznaką typu (`labels.ts`); fiszka: przód, 4 opcje z wyróżnioną poprawną, wzorcowa odpowiedź, przykładowe zdanie dla `vocabulary`, „Czytaj więcej” (collapsible) z wyjaśnieniem, „Usuń” → `Confirmation` → `DELETE` → render zwróconego stanu; pusta gotowa partia → komunikat „Ta partia nie ma już fiszek.”.
- Kolory wyłącznie z tokenów `src/styles/global.css` (nowy kolor = nowy token); komponenty z `src/components/ui`.

#### 3. Wejścia

**File**: `src/components/topics/QuizRunner.tsx`, `src/pages/topics/[id]/quiz.astro`, `src/pages/topics/[id].astro`, `src/components/topics/TopicEditor.tsx`

**Intent**: CTA do fiszek po ukończeniu quizu.

**Contract**: Ekran wyniku quizu i strona tematu (quiz ukończony) pokazują „Wygeneruj fiszki” → `/topics/[id]/flashcards?start=1`, a gdy partia istnieje — „Zobacz fiszki” → `/topics/[id]/flashcards`. Strony serwerowe przekazują wyspom informację o istnieniu partii (odczyt w try/catch).

### Success Criteria:

#### Automated Verification:

- `npm test`, `npm run lint`, `npm run build` przechodzą
- CI `smoke` przechodzi

#### Manual Verification:

- Na podglądzie z prawdziwym AI: quiz → „Wygeneruj fiszki” → 10 fiszek w podziale z reguły rozdziału; zanotuj `latency_ms` i `output_tokens` z `ai_calls` (próg: < 75 s, bez `ai_invalid_output` z powodu `max_tokens`)
- Temat językowy: fiszki słownikowe mają słowo, 4 tłumaczenia, przykładowe zdanie; pojęciowe — pytanie na 2–3 zdania
- „Czytaj więcej” rozwija wyjaśnienie bez żadnego żądania sieciowego
- Przeładowanie strony w trakcie generowania kończy się pokazaniem partii po odpytywaniu, a `remaining` spada o 1
- Usunięcie fiszki po potwierdzeniu znika ją także po przeładowaniu; anulowanie nic nie zmienia
- Strona fiszek używalna na telefonie (szerokość ~375 px), bez poziomego przewijania
- Edytor podtematów nadal potwierdza usuwanie jak przed wyjęciem `Confirmation`

**Implementation Note**: Jeśli pomiar przekroczy próg, zatrzymaj się i wróć do decyzji o budżecie (długość wyjaśnienia, `maxTokens`, timeout/TTL) przed merge.

---

## Testing Strategy

### Unit Tests:

- `batchAllocation`: przykłady z planu, suma 10, remisy, wszystkie 100%.
- Schemat: kwoty, unikalność opcji, reguła `example` per typ, konwersja do JSON schema.
- `toFlashcardRows`: tasowanie z wstrzykniętym `random`, mapowanie podtematów.

### Integration Tests:

- pgTAP: niezmienniki RPC, uprawnienia, izolacja kont.
- Smoke: pełny przepływ quiz → fiszki → usuwanie na fake AI, odmowy 409/404, licznik limitu.

### Manual Testing Steps:

1. Utwórz temat techniczny, zatwierdź, rozwiąż quiz z różnymi wynikami, wygeneruj fiszki — porównaj podział z regułą.
2. Powtórz dla tematu językowego (podtematy `vocabulary`).
3. Przeładuj stronę w trakcie generowania.
4. Usuń jedną fiszkę, anuluj usunięcie drugiej.
5. Sprawdź widok na telefonie.

## Performance Considerations

Jedno wywołanie ~4–5 tys. tokenów wyjścia; `maxTokens: 8000`, `timeoutMs: 90_000`, TTL claimu 120 s. Walidacja zod partii to kilka–kilkanaście KB (koszt pomijalny wg `context/archive/2026-10-18-ai-call-guardrails/plan.md:301`). Ryzyko 1102 na planie Free (`context/foundation/infrastructure.md:62`) — mitygacja z infrastructure: przejście na Workers Paid przy pierwszym wystąpieniu. `waitUntil` przedłuża pracę po rozłączeniu o ok. 30 s — przy dłuższym generowaniu zamknięta karta może zużyć limit bez zapisu; claim wygasa po 120 s i pozwala zacząć od nowa.

## Migration Notes

Migracja tylko rozszerzająca (dwie nowe tabele, trzy funkcje); nie dotyka istniejących tabel. `db push` ręcznie przed merge. Wycofanie aplikacji nie wymaga cofania migracji.

## References

- Research: `context/changes/first-weak-subtopic-batch/research.md`
- Wzorzec claim/create: `supabase/migrations/20261024064348_quiz_generation_claim.sql:124-242`
- Wzorzec endpointu: `src/pages/api/topics/[id]/quiz/index.ts:23-64`
- Wzorzec zadania AI: `src/lib/topics/quiz-task.ts:14-126`
- Wzorzec repozytorium: `src/lib/topics/quiz-repository.ts:64-189`
- Wzorzec wyspy: `src/components/topics/QuizRunner.tsx:21-108`
- S-03 impl-review F1: `context/archive/2026-10-22-diagnostic-quiz-by-subtopic/reviews/impl-review.md:41-63`
- Wymagania: `context/foundation/prd.md:73, 89-94, 107, 129`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Baza fiszek

#### Automated

- [x] 1.1 CI `smoke` → `Database tests` przechodzi z nowym `flashcards.test.sql` i rozszerzonym `account_isolation.test.sql` — ef13c98
- [x] 1.2 `rls_guard.test.sql` przechodzi bez nowych wpisów w `rls_guard_exceptions` — ef13c98
- [x] 1.3 `npm run lint` przechodzi — ef13c98

#### Manual

- [ ] 1.4 Migracja wypchnięta `db push` na produkcyjne Supabase przed merge, bez błędów

### Phase 2: Domena i zadanie AI

#### Automated

- [x] 2.1 `npm test` przechodzi z nowym `flashcards-task.test.ts` — 066a0e0
- [x] 2.2 `npm run lint` przechodzi — 066a0e0
- [x] 2.3 `npm run build` przechodzi — 066a0e0

### Phase 3: API

#### Automated

- [x] 3.1 `npm test`, `npm run lint`, `npm run build` przechodzą — c6831ca
- [x] 3.2 CI `smoke` (z `smoke-topics.mjs`) przechodzi z nowymi krokami fiszek — c6831ca

### Phase 4: UI

#### Automated

- [x] 4.1 `npm test`, `npm run lint`, `npm run build` przechodzą
- [ ] 4.2 CI `smoke` przechodzi

#### Manual

- [ ] 4.3 Na podglądzie z prawdziwym AI: quiz → „Wygeneruj fiszki” → 10 fiszek w podziale z reguły rozdziału; zanotuj `latency_ms` i `output_tokens` z `ai_calls` (próg: < 75 s, bez `ai_invalid_output` z powodu `max_tokens`)
- [ ] 4.4 Temat językowy: fiszki słownikowe mają słowo, 4 tłumaczenia, przykładowe zdanie; pojęciowe — pytanie na 2–3 zdania
- [ ] 4.5 „Czytaj więcej” rozwija wyjaśnienie bez żadnego żądania sieciowego
- [ ] 4.6 Przeładowanie strony w trakcie generowania kończy się pokazaniem partii po odpytywaniu, a `remaining` spada o 1
- [ ] 4.7 Usunięcie fiszki po potwierdzeniu znika ją także po przeładowaniu; anulowanie nic nie zmienia
- [ ] 4.8 Strona fiszek używalna na telefonie (szerokość ~375 px), bez poziomego przewijania
- [ ] 4.9 Edytor podtematów nadal potwierdza usuwanie jak przed wyjęciem `Confirmation`
