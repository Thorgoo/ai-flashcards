# Retry and claim integrity tests — Implementation Plan

## Overview

Etap 2 z `context/foundation/test-plan.md` dla ryzyk #1, #2 i #7. Research nie znalazł błędu, który realizowałby któreś z nich, więc plan zabezpiecza istniejące gwarancje przed regresją. Oczekiwane wartości pochodzą z PRD (`prd.md:129` FR-028, `prd.md:139-140` limity), a nie z bieżącego kodu. Kod produkcyjny zmienia się tylko w fixture fake AI.

## Current State Analysis

- **Limit:** `begin_ai_call` bierze blokadę, liczy wiersze dnia bez filtra po statusie, odmawia kodem `P0429` i wstawia wiersz (`supabase/migrations/20261018092416_create_ai_calls.sql:56-68`). Testy są tylko sekwencyjne (`supabase/tests/database/ai_calls.test.sql:17-31`, `scripts/smoke-topics.mjs:775-792`).
- **Rezerwacje SQL:** przejęcia są pokryte, ale brakuje prób tuż poniżej TTL: quiz (`quizzes.test.sql:179-188`), pierwsza partia (121 s i 181 s, `flashcards.test.sql:183-204`), kolejna partia (tylko 181 s, `flashcard_next.test.sql:96-106`).
- **Odczyt TS:** `getQuizState` nie ma testów (`src/lib/topics/quiz-repository.ts:89-91`). Odczyt fiszek ma testy tylko dla `failed`, bez wygasłego `generating` (`src/lib/topics/flashcard-repository.ts:210-215`).
- **Trasy:** nikt nie sprawdza ponowienia po błędzie generowania ani przejęcia przez HTTP. Fake AI wymusza błąd tylko dla oceny (`src/lib/ai/fixtures.ts:65-75`).

## Desired End State

Każda z poniższych regresji czerwieni CI, co potwierdza zapisana próba celowego zepsucia:

- obciążenie limitu inne niż jedno na próbę modelu, obciążenie przy odmowie przed AI albo wynik częściowy,
- przejęcie rezerwacji przed TTL lub brak przejęcia po TTL, także gdy SQL i TS rozjadą się co do TTL,
- przekroczenie limitu 20/100 przy równoległych wywołaniach.

Weryfikacja: job `smoke` jest zielony z nowym krokiem, a §6 planu testów opisuje dostarczone wzorce.

### Key Discoveries:

- Wszystkie cztery zadania generowania mają w prompcie `<temat>` (`subtopics-task.ts:46`, `quiz-task.ts:85`, `flashcards-task.ts:140`), więc znacznik w nazwie tematu wymusi błąd każdego z nich.
- 14 obciążeń scenariusza #1 mieści się w limicie 20 na jednym świeżym koncie.
- `flashcards.test.sql` ma asercje bez filtra po temacie (`:177`, `:216`, `:232`). Dokładanie tam nowego tematu by je zepsuło, więc sekwencje dostają osobny plik.
- `replace_subtopics` blokuje wiersz tematu przez `for update` (`20261022163613_create_topics_and_subtopics.sql:126`), więc równoległe zapisy powinny się szeregować. Tego też nikt nie sprawdzał w działaniu.
- `next.ts:32` odmawia na podstawie odczytu TS, zanim wywoła `claim_next_flashcard_batch`, więc rozjazd TTL ma tam inny skutek niż na trasie pierwszej partii.
- `.github/workflows/ci.yml:3-7` uruchamia CI tylko na push do `main` i na PR do `main`, więc próby zepsucia w CI wymagają szkicu PR.
- `PGRST_DB_POOL` nie jest ustawione w lokalnym kontenerze PostgREST (sprawdzono 2026-11-04). Domyślna wielkość puli nie została zweryfikowana w działaniu, więc rozstrzyga ją dopiero próba z fazy 5.

## What We're NOT Doing

- **Bez zmiany semantyki powtórki podtematów** (decyzja użytkownika 2026-11-04): każde wywołanie dla tematu `draft` płaci i zastępuje listę. Test tylko to przypina.
- Bez zmian w §1–§5 planu testów (zamrożone do `--refresh`). §4 dalej mówi o 2 skryptach smoke, co odnotowuje notatka w §6.5. Status w §3 aktualizuje `/10x-test-plan`.
- Bez asercji dokładnie na równości TTL (równo 90 s i równo 180 s). Wymagania jej nie definiują, a SQL i TS porównują inaczej, więc taki test tylko kopiowałby kod.
- Bez testu podwójnego doręczenia z Cloudflare Queues, sprawdzania `waitUntil` w dokumentacji Cloudflare oraz równoległego `claim_quiz` / `claim_flashcard_batch`. To ryzyka poza #7, zgłoszone w researchu.
- Bez testu północy w strefie `Europe/Warsaw`: nie ma zegara do sterowania, a poprzedni dzień jest już pokryty (`ai_calls.test.sql:51-69`).
- Bez stałego kroku CI z funkcją pozbawioną blokady (decyzja użytkownika): próba jest jednorazowa, a jej wynik zapisany.
- Bez powielania sekwencyjnej odmowy 21. wywołania i porzuconych tokenów, które już są pokryte.

## Implementation Approach

Każda warstwa dowodzi tylko tego, czego niższa nie może:

| Warstwa           | Dowodzi                                                             | Nie dowodzi                          |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------ |
| pgTAP             | ścisłych granic TTL (zamrożone `now()`), reguł liczenia, atomowości | kolejności na trasie, współbieżności |
| vitest            | ścisłych granic odczytu TS (sztuczny zegar)                         | zgodności z bazą                     |
| skrypt HTTP       | kolejności wywołań na trasie, zgodności SQL i TS z marginesem czasu | ścisłych granic                      |
| skrypt równoległy | szczelności blokady, także przez trasę                              | reguł pojedynczego wywołania         |

Testy używają dosłownych wartości 20, 100, 90 i 180 oraz liczb obciążeń z PRD. Nie importują stałych z testowanego kodu.

Każda nowa grupa testów przechodzi jedną próbę celowego zepsucia. Próby CI idą przez szkic PR z gałęzi tymczasowej, który zamykamy bez merge'a, razem z usunięciem gałęzi.

## Critical Implementation Details

- **Margines czasu przez HTTP.** Zegar biegnie między cofnięciem `claimed_at` a odpowiedzią trasy, więc przez HTTP używamy 80 s i 95 s (quiz) oraz 170 s i 185 s (fiszki). Granice ±1 s zostają w pgTAP i vitest.
- **Stan „Worker zabity" tworzą prawdziwe funkcje.** Skrypt woła `begin_ai_call` i `claim_*` jako użytkownik, bez dokończenia. Nie wstawia ręcznie wiersza `generating`, żeby test nie kopiował kształtu danych.
- **Znacznik działa na parę zadanie + temat.** Kolejna zmiana nazwy tematu daje nowy klucz. Licznik żyje w izolacie serwera, jak `failedOnce`, więc nazwy tematów muszą mieć losowy sufiks.

---

## Phase 1: Reguły bazy w pgTAP

### Overview

Najtańszy dowód: ścisłe granice TTL i reguły liczenia limitu na jednym połączeniu.

### Test contract:

| Zachowanie                                                                                       | Wykrywana regresja                                          | Źródło                                                                                                                                                   | Brzeg / błąd                                                                                                           | Unikany antywzorzec                                                |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| #2: próba przed TTL nie przejmuje rezerwacji, po TTL przejmuje (quiz, pierwsza i kolejna partia) | Zmiana TTL lub warunku w migracji                           | research „Co już pokrywają testy"; PRD nie definiuje TTL, więc wyrocznią są 90 s i 180 s przyjęte we wskazówkach tego etapu, zapisane w teście dosłownie | 89 s i 91 s, 179 s i 181 s; po odmowie `claimed_at` się nie zmienia                                                    | Czekanie na prawdziwy czas                                         |
| #1: porażka, porażka, sukces = 3 wiersze i 1 komplet (quiz, pierwsza partia)                     | Zwrot limitu, usuwanie wierszy, resztki po nieudanej próbie | `prd.md:129`, `prd.md:139`; research „Reguła obciążania limitu"                                                                                          | Nieudany zapis w środku (`null` w opcji) nie zostawia pytań ani kart; odmowa rezerwacji po sukcesie nie dodaje wiersza | Liczba wierszy wzięta z kodu                                       |
| #7: wiersze `failed` i `pending` liczą się do limitu; odmowa nie dodaje wiersza                  | Filtr po statusie w `count(*)`                              | `prd.md:139` („niezależny od liczby błędów"); research „Czego nie sprawdzono"                                                                            | 10 `failed` + 9 `pending`: 20. przechodzi z `remaining` 0, 21. odmawia, wierszy 20                                     | Sprawdzanie samego kodu błędu bez stanu tabeli                     |
| #7: limit ocen to 100                                                                            | Zmiana limitu lub rodzaju                                   | `prd.md:140`; research „Czego nie sprawdzono"                                                                                                            | 99 użytych: setne przechodzi, 101. odmawia                                                                             | Sekwencyjny test udający współbieżność (ten dowodzi tylko granicy) |

Uczciwy zakres: sekwencja SQL sama woła `begin_ai_call`, więc dowodzi reguł bazy, a nie tego, że trasa woła funkcje we właściwej kolejności. To dowodzi faza 3.

### Changes Required:

#### 1. Granice TTL

**File**: `supabase/tests/database/quizzes.test.sql`, `flashcards.test.sql`, `flashcard_next.test.sql`

**Intent**: Dodać próby tuż poniżej i tuż powyżej TTL w istniejącym przebiegu, żeby użyć gotowych danych i wzorca cofania czasu.

**Contract**: Quiz przed `:179`: 89 s daje `quiz_generating` i niezmieniony `claimed_at`, 91 s daje przejęcie. Pierwsza partia między `:193` a `:195`: 179 s daje `batch_generating`. Kolejna partia przed `:96`: 179 s daje `batch_generating`. Istniejące kroki zostają. Aktualizacja `plan(N)` w każdym pliku.

#### 2. Sekwencje ponowień

**File**: `supabase/tests/database/retry_charges.test.sql` (nowy)

**Intent**: Zapisać regułę „jedna próba modelu = jedno obciążenie" obok reguły „komplet albo nic", na własnych danych, żeby nie ruszać asercji bez filtra po temacie.

**Contract**: Własne konto i tematy. Quiz: `begin_ai_call` + `release_quiz_claim` dwa razy, potem `begin_ai_call` + `create_quiz`. Pierwsza partia na temacie z ukończonym quizem: `begin_ai_call` + `fail_flashcard_batch_claim` dwa razy (ponowna rezerwacja od razu, bez TTL), potem zapis. Dla obu: 3 wiersze `ai_calls` tego konta, 1 komplet (10 pytań lub 10 kart). Następna rezerwacja odmawia (`quiz_exists`, `batch_exists`) i liczba wierszy pozostaje 3.

#### 3. Reguły limitu

**File**: `supabase/tests/database/ai_calls.test.sql`

**Intent**: Domknąć luki z researchu: statusy liczone do limitu, brak wiersza po odmowie, limit ocen.

**Contract**: Dwa nowe konta, wiersze seedowane po `reset role` z datą `(now() at time zone 'Europe/Warsaw')::date`. Aktualizacja `plan(13)`.

### Success Criteria:

#### Automated Verification:

- Testy bazy przechodzą lokalnie: `npm run db:test`
- Próba zepsucia A w szkicu PR (tymczasowa migracja: TTL 120 s i 240 s oraz `count(*)` z filtrem `status <> 'failed'`) czerwieni krok `Database tests` na nowych asercjach TTL i liczenia
- Migracja tymczasowa nie trafia do gałęzi zmiany; szkic PR zamknięty, gałąź usunięta

#### Manual Verification:

- Przegląd: każda oczekiwana liczba w nowych asercjach da się wyprowadzić z PRD lub §2 planu testów, bez czytania migracji

---

## Phase 2: Odczyt wygasłej rezerwacji w vitest

### Overview

Pierwszy test `getQuizState` i ścisłe granice odczytu fiszek. Decyduje to o tym, czy UI pokaże „trwa generowanie", czy pozwoli ponowić.

### Test contract:

| Zachowanie                                                                       | Wykrywana regresja                                 | Źródło                                                          | Brzeg / błąd                                          | Unikany antywzorzec                                                  |
| -------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| #2: quiz `generating` w TTL jest widoczny, po TTL czyta się jak brak quizu       | Zmiana stałej TS, odwrócony warunek                | research, wiersz „Odczyt TS"; `quiz-repository.ts:89-91`        | 89 s i 91 s                                           | Import `QUIZ_CLAIM_TTL_SECONDS` do testu (zawsze zgodny sam ze sobą) |
| #2: fiszki `generating` w TTL są widoczne, po TTL znikają, partie gotowe zostają | Jak wyżej; wygasła rezerwacja ukrywa gotową partię | research, wiersz „Odczyt TS"; `flashcard-repository.ts:210-215` | 179 s i 181 s; wygasła rezerwacja obok gotowej partii | Czekanie na prawdziwy czas                                           |

### Changes Required:

#### 1. Test odczytu quizu

**File**: `src/lib/topics/quiz-repository.test.ts` (nowy)

**Intent**: Sprawdzić odczyt rezerwacji w `getQuizState` przez atrapę klienta i sztuczny zegar.

**Contract**: Atrapa odpowiada na `from().select().eq().maybeSingle()`. `vi.setSystemTime` ustawia chwilę względem `claimed_at`. Dosłowne wartości 89 i 91.

#### 2. Test odczytu fiszek

**File**: `src/lib/topics/flashcard-repository.test.ts`

**Intent**: Dodać granice do `getFlashcardSummary`, używając istniejącej atrapy `client`.

**Contract**: Nowy `describe` ze sztucznym zegarem, 179 s i 181 s. Stałe modułu (`NOW`, `OLD`) bez zmian.

### Success Criteria:

#### Automated Verification:

- Testy jednostkowe przechodzą: `npm test`
- Lint przechodzi: `npm run lint`
- Próba zepsucia B lokalnie: `QUIZ_CLAIM_TTL_SECONDS` = 120 i `FLASHCARD_CLAIM_TTL_SECONDS` = 240 czerwienią nowe testy; zmiana cofnięta przed commitem

---

## Phase 3: Znacznik błędu i ponowienia przez HTTP

### Overview

Dowód kolejności na trasie dla #1, razem z infrastrukturą skryptu, z której korzystają fazy 4 i 5.

### Test contract:

| Zachowanie                                                                                        | Wykrywana regresja                                                                           | Źródło                                                                                               | Brzeg / błąd                                                                                    | Unikany antywzorzec                                                            |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| #1: dla każdego z 4 rodzajów porażka, porażka, sukces = 3 obciążenia i 1 komplet                  | Brak zwolnienia rezerwacji po błędzie, nowe ponowienia w kodzie, obciążenie po stronie trasy | `prd.md:129,139`; research „Ścieżki zapisu i ponowienia"                                             | Każda porażka: błąd `ai_unavailable`, `retryable`, 0 wyników (dla fiszek stan błędu z pollingu) | Asercja samego statusu 200 („200 przy ponowieniu = brak duplikatu")            |
| #1: nieudana regeneracja nie rusza listy                                                          | Zapis przed wynikiem modelu                                                                  | `prd.md:129`; research „Zachowanie przy porażce modelu"                                              | Lista po błędzie identyczna jak przed nim, +1 obciążenie                                        | Sprawdzenie samego błędu bez stanu bazy                                        |
| #1: powtórka podtematów dla `draft` płaci i zastępuje całą listę, a po potwierdzeniu odmawia za 0 | Zmiana semantyki bez decyzji                                                                 | decyzja użytkownika 2026-11-04; `archive/2026-10-22-topic-with-confirmed-subtopics/plan-brief.md:22` | Edycja listy znika po regeneracji, `topic_locked` = 0 obciążeń                                  | Traktowanie tej semantyki jako bezwzględnego wymogu PRD (to przypięta decyzja) |
| #1: powtórka po sukcesie odrzucona przed AI = 0 obciążeń                                          | Przeniesienie wywołania AI przed rezerwację                                                  | `prd.md:139`; research, kolumna „Powtórka po udanym zapisie"                                         | `quiz_exists`, `batch_exists` (partia 1 i 2)                                                    | Liczba wierszy wzięta z kodu                                                   |

Licznik końcowy scenariusza: 3 (podtematy) + 1 (nieudana regeneracja) + 1 (udana regeneracja) + 3 + 3 + 3 = **14**.

### Changes Required:

#### 1. Znacznik w fixture

**File**: `src/lib/ai/fixtures.ts`

**Intent**: Wymuszać dwa błędy generowania na parę zadanie + temat, według wzorca `FAKE_GRADING_FAIL_ONCE`. Działa tylko przez `AI_MODE=fake`.

**Contract**: `export const FAKE_GENERATION_FAIL_TWICE = "[fake-ai-fail-twice]"`. Sprawdzany w wartości tagu `<temat>`, a nie w całym prompcie, bo podtematy dziedziczą nazwę tematu. Dotyczy `SUBTOPICS_TASK`, `QUIZ_TASK`, `FLASHCARDS_TASK`, `NEXT_FLASHCARDS_TASK`. Rzuca `FakeAiFailure("ai_unavailable")`. Ocena bez zmian.

#### 2. Wspólne helpery

**File**: `scripts/smoke-support.mjs` (nowy), `scripts/smoke-topics.mjs`

**Intent**: Nie kopiować logowania i klienta HTTP do nowego skryptu.

**Contract**: Eksporty: klient service-role, `signIn(email)` zwracające też klienta użytkownika (dla RPC w fazach 4–5), `api`, `check`, `describe`, `waitForBatch`, `generationCalls`, licznik porażek. `smoke-topics.mjs` tylko przechodzi na te importy; kroki i liczniki bez zmian.

#### 3. Nowy skrypt

**File**: `scripts/smoke-retry-claim.mjs` (nowy), `package.json`

**Intent**: Scenariusz #1 na świeżym koncie `smoke-retry@example.com`, bez wpływu na licznik generowań w `smoke-topics.mjs`.

**Contract**: Skrypt `npm run smoke:retry`. Kopia znacznika z komentarzem „keep in step", jak w `smoke-topics.mjs:52-54`. Kolejność: podtematy (porażka, porażka, sukces), zmiana nazwy na drugi znacznik i nieudana regeneracja, powrót do pierwszej nazwy, edycja podtematu, udana regeneracja, potwierdzenie, odmowa `topic_locked`, quiz (3 próby, odmowa, ukończenie odpowiedziami), pierwsza partia (3 próby, odmowa), oznaczenie 80% kart przez service-role, partia 2 (3 próby, odmowa). Konta usuwane w `finally`.

#### 4. CI i dokumentacja

**File**: `.github/workflows/ci.yml`, `src/lib/topics/AGENTS.md`

**Intent**: Uruchamiać skrypt w jobie `smoke` i uprzedzić o osobnych kontach.

**Contract**: W `ci.yml:60` do `ALLOWED_EMAILS` dochodzą `smoke-retry@`, `smoke-claim@`, `smoke-burst@example.com`. Nowy krok po smoke, przed E2E, ze zmiennymi jak `smoke:topics`; serwer preview działa już z poprzedniego kroku (`ci.yml:74-75`). W sekcji Testing `AGENTS.md` jedno zdanie: scenariusze wielu obciążeń idą do `smoke-retry-claim.mjs` na własnych kontach.

### Success Criteria:

#### Automated Verification:

- Lint i typy przechodzą: `npm run lint`, `npx astro check`
- Testy jednostkowe przechodzą: `npm test`
- Job `smoke` w PR jest zielony, razem z niezmienionym `smoke:topics` i nowym krokiem
- Próba zepsucia C w szkicu PR (usunięcie `releaseQuizClaim` przy błędzie AI w `src/pages/api/topics/[id]/quiz/index.ts:55`) czerwieni krok ponowienia quizu

#### Manual Verification:

- Po merge'u, w Chrome na prod: temat testowy o nazwie z `[fake-ai-fail-twice]` generuje podtematy od razu, co dowodzi, że znacznik nie działa w trybie live

---

## Phase 4: Przejęcie rezerwacji przez trasę

### Overview

Dowód, że wygasła rezerwacja nie blokuje tras, a SQL i TS zgadzają się co do TTL.

### Test contract:

| Zachowanie                                                                                 | Wykrywana regresja                                                    | Źródło                                                                                   | Brzeg / błąd                                                            | Unikany antywzorzec                    |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| #2: przed TTL `POST` odmawia za 0 obciążeń, `GET` pokazuje generowanie                     | Przejęcie zbyt wcześnie, płatność przy odmowie                        | research „Cykl życia rezerwacji"; §2 planu testów                                        | 80 s (quiz), 170 s (fiszki); kody `quiz_generating`, `batch_generating` | Czekanie na prawdziwy czas             |
| #2: po TTL `GET` nie pokazuje generowania, `POST` przejmuje i daje komplet za 1 obciążenie | Osierocona rezerwacja blokuje ponowienie; rozjazd TTL między SQL a TS | research „Najtańsza warstwa"; research „Architecture Insights" (stałe zapisane dwa razy) | 95 s, 185 s; partia 2, gdzie `next.ts:32` odmawia już na odczycie TS    | Asercja samego statusu bez stanu bazy  |
| #1 + #2: przerwana próba zostaje wierszem `pending` i liczy się do limitu                  | Sprzątanie lub zwrot limitu po przerwaniu                             | `prd.md:139`; research „Wiersz `pending`"                                                | 1 wiersz `pending` na każdą przerwaną próbę po przejęciu                | „Porażka nie powinna kosztować limitu" |

Licznik końcowy na koncie `smoke-claim@example.com`: 1 (podtematy) + 2 + 2 + 2 (przerwana próba i przejęcie dla każdego z 3 rodzajów) = **7**.

### Changes Required:

#### 1. Scenariusze przejęcia

**File**: `scripts/smoke-retry-claim.mjs`

**Intent**: Odtworzyć zabity proces prawdziwymi funkcjami i przejść granicę TTL cofaniem `claimed_at`.

**Contract**: Dla quizu, pierwszej i drugiej partii po kolei: klient użytkownika woła `begin_ai_call` oraz `claim_quiz` / `claim_flashcard_batch` / `claim_next_flashcard_batch`, service-role cofa `claimed_at`, a potem skrypt wykonuje kontrole z tabeli. Podtematy pomijamy, bo nie mają rezerwacji.

### Success Criteria:

#### Automated Verification:

- Job `smoke` w PR jest zielony z krokami przejęcia
- Próba zepsucia D w szkicu PR (`QUIZ_CLAIM_TTL_SECONDS` = 300) czerwieni krok `GET` po 95 s

---

## Phase 5: Dowód równoległości

### Overview

Jedyna warstwa, która widzi działanie blokady. Główny dowód to RPC, a strzał w trasę sprawdza koszt end-to-end.

### Test contract:

| Zachowanie                                                                                                                | Wykrywana regresja                                            | Źródło                                         | Brzeg / błąd                                                  | Unikany antywzorzec                                    |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| #7: z 40 równoległych wywołań dokładnie 20 przechodzi, 20 dostaje `P0429`, wartości `remaining` to dokładnie 0–19         | Usunięcie lub osłabienie blokady, licznik w TS                | `prd.md:139`; research „Limit i współbieżność" | Każdy inny błąd niż `P0429` to porażka; 20 wierszy `ai_calls` | Test sekwencyjny udający współbieżność                 |
| #7: od stanu 19 użytych z 10 równoległych przechodzi dokładnie 1                                                          | Wyścig przy samej granicy (przypadek z komentarza w migracji) | `20261018092416_create_ai_calls.sql:54-55`     | 20 wierszy po rundzie                                         | Test, który nie pada po usunięciu blokady              |
| #7: od stanu 99 ocen z 10 równoległych przechodzi dokładnie 1                                                             | Blokada działająca tylko dla generowania                      | `prd.md:140`                                   | 100 wierszy po rundzie                                        | Jak wyżej                                              |
| #7 + #1: z 25 równoległych `POST /generate` 20 przechodzi, 5 dostaje 429 `quota_exceeded`, a lista jest jedna i kompletna | Trasa omija limit; równoległe zapisy mieszają listy           | `prd.md:129,139`; research, pytanie 3          | Dokładnie 5 podtematów, pozycje 0–4, 20 wierszy               | Luźna asercja „co najwyżej 20" ukrywająca błędy zapisu |

Strażnik: zanim pierwsze żądanie się zakończy, wszystkie muszą być już wystartowane (licznik startów równy N), więc przepisanie na sekwencyjną pętlę czerwieni test.

### Changes Required:

#### 1. Rundy RPC

**File**: `scripts/smoke-retry-claim.mjs`

**Intent**: Sprawdzić blokadę prawdziwymi równoległymi połączeniami na świeżych kontach.

**Contract**: 5 rund, każda z nowym kontem `smoke-limit-<uuid>@example.com` (bez wpisu w `ALLOWED_EMAILS`, bo RPC omija aplikację). Stan startowy seedowany przez service-role z datą w strefie Warsaw. Skrypt wypisuje wynik każdej rundy osobno, żeby próba zepsucia pokazała, ile rund wykryło przekroczenie.

#### 2. Strzał w trasę

**File**: `scripts/smoke-retry-claim.mjs`

**Intent**: Sprawdzić koszt i spójność listy przez prawdziwą trasę na koncie `smoke-burst@example.com`.

**Contract**: Jeden temat `draft` bez znacznika, 25 równoległych `POST /generate`, potem odczyt wierszy i listy przez service-role. Jeśli pojawi się inny status niż 200 lub 429, to prawdziwe znalezisko: zatrzymać się i zgłosić, a nie rozluźniać asercję.

### Success Criteria:

#### Automated Verification:

- Job `smoke` w PR jest zielony ze wszystkimi rundami
- Próba zepsucia E w szkicu PR (tymczasowa migracja: `begin_ai_call` bez `pg_advisory_xact_lock`) czerwieni kroki RPC i wykrywa przekroczenie w co najmniej 2 z 5 rund
- Wynik próby E dla strzału w trasę jest zapisany: jeśli nie pada, komentarz w skrypcie opisuje ten krok jako kontrolę kosztu, a nie dowód współbieżności

#### Manual Verification:

- Jeśli próba E wykrywa przekroczenie w mniej niż 2 rundach mimo zwiększenia liczby wywołań, użytkownik dostaje raport i decyduje przed merge'em, bo test nie jest wtedy dowodem współbieżności

---

## Phase 6: Aktualizacja §6 planu testów

### Overview

Zapisanie dostarczonych wzorców, żeby kolejne etapy z nich korzystały. Grounding: wyłącznie kod z tego etapu; bez nowych wytycznych o narzędziach AI (narzędzia z §4 sprawdzone 2026-11-01).

### Changes Required:

#### 1. Cookbook

**File**: `context/foundation/test-plan.md`

**Intent**: Zastąpić placeholder i dopisać wzorce z tego etapu. Tylko §6 i data „Last updated".

**Contract**:

- §6.2: wzorzec cofania `claimed_at` (`reset role`, `update`, `set local role`), zamrożone `now()`, granice ±1 s, sekwencje w osobnym pliku. Placeholder Phase 3 zostaje.
- Nowa §6.6 „Adding a retry or parallel proof": `scripts/smoke-retry-claim.mjs`, znacznik `[fake-ai-fail-twice]` z losowym sufiksem, własne konto i wpis w `ALLOWED_EMAILS`, margines czasu przez HTTP, strażnik startów, wymóg próby z usuniętą blokadą.
- §6.5: notatka „Phase 2" z datą i wynikami prób A–E (w tym liczba rund z próby E) oraz informacją, że §4 jest nieaktualne co do liczby skryptów do `--refresh`.

### Success Criteria:

#### Automated Verification:

- W §6.2 nie ma już `TBD` dla etapu 2: `grep -n "Phase 2 (wzorzec" context/foundation/test-plan.md` nic nie zwraca
- §1–§5 bez zmian: `git diff` pliku dotyka tylko §6 i wiersza „Last updated"

#### Manual Verification:

- Osoba czytająca §6 potrafi dopisać kolejny dowód równoległości bez czytania tego planu

---

## Testing Strategy

### Unit Tests:

- Granice odczytu rezerwacji w TS (faza 2).

### Integration Tests:

- pgTAP: granice TTL, sekwencje obciążeń, reguły limitu (faza 1).
- HTTP na fake AI: ponowienia i przejęcia (fazy 3–4).
- Skrypt równoległy: RPC i trasa (faza 5).

### Manual Testing Steps:

1. Przejrzeć wyrocznie względem PRD (faza 1).
2. Po merge'u sprawdzić na prod, że znacznik jest bezczynny (faza 3).
3. Ocenić raport, jeśli próba E wykryje mniej niż 2 rundy (faza 5).

## Performance Considerations

Krok smoke trwa dziś 18 s, a job około 3,5 min (run `41903121181`). Fake AI odpowiada od razu; polling fiszek ma krok 500 ms, a nowy skrypt ma około 12 pollingów. To wyraźnie mniej niż minuta dodatkowego czasu CI.

## Migration Notes

Bez migracji. Tymczasowe migracje z prób A i E nigdy nie trafiają do gałęzi zmiany ani do `main`.

## References

- Research: `context/changes/testing-retry-and-claim/research.md`
- Wymagania: `context/foundation/prd.md:129`, `:139`, `:140`
- Plan testów: `context/foundation/test-plan.md` §2, §6
- Wzorzec cofania czasu: `supabase/tests/database/quizzes.test.sql:179-199`
- Wzorzec znacznika: `src/lib/ai/fixtures.ts:62-75`, `scripts/smoke-topics.mjs:52-54`, `:600-640`
- Limit: `supabase/migrations/20261018092416_create_ai_calls.sql:33-73`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Reguły bazy w pgTAP

#### Automated

- [x] 1.1 Testy bazy przechodzą lokalnie: `npm run db:test` — ab1c48f
- [x] 1.2 Próba zepsucia A w szkicu PR (tymczasowa migracja: TTL 120 s i 240 s oraz `count(*)` z filtrem `status <> 'failed'`) czerwieni krok `Database tests` na nowych asercjach TTL i liczenia — ab1c48f
- [x] 1.3 Migracja tymczasowa nie trafia do gałęzi zmiany; szkic PR zamknięty, gałąź usunięta — ab1c48f

#### Manual

- [x] 1.4 Przegląd: każda oczekiwana liczba w nowych asercjach da się wyprowadzić z PRD lub §2 planu testów, bez czytania migracji — ab1c48f

### Phase 2: Odczyt wygasłej rezerwacji w vitest

#### Automated

- [ ] 2.1 Testy jednostkowe przechodzą: `npm test`
- [ ] 2.2 Lint przechodzi: `npm run lint`
- [ ] 2.3 Próba zepsucia B lokalnie: `QUIZ_CLAIM_TTL_SECONDS` = 120 i `FLASHCARD_CLAIM_TTL_SECONDS` = 240 czerwienią nowe testy; zmiana cofnięta przed commitem

### Phase 3: Znacznik błędu i ponowienia przez HTTP

#### Automated

- [ ] 3.1 Lint i typy przechodzą: `npm run lint`, `npx astro check`
- [ ] 3.2 Testy jednostkowe przechodzą: `npm test`
- [ ] 3.3 Job `smoke` w PR jest zielony, razem z niezmienionym `smoke:topics` i nowym krokiem
- [ ] 3.4 Próba zepsucia C w szkicu PR (usunięcie `releaseQuizClaim` przy błędzie AI w `src/pages/api/topics/[id]/quiz/index.ts:55`) czerwieni krok ponowienia quizu

#### Manual

- [ ] 3.5 Po merge'u, w Chrome na prod: temat testowy o nazwie z `[fake-ai-fail-twice]` generuje podtematy od razu, co dowodzi, że znacznik nie działa w trybie live

### Phase 4: Przejęcie rezerwacji przez trasę

#### Automated

- [ ] 4.1 Job `smoke` w PR jest zielony z krokami przejęcia
- [ ] 4.2 Próba zepsucia D w szkicu PR (`QUIZ_CLAIM_TTL_SECONDS` = 300) czerwieni krok `GET` po 95 s

### Phase 5: Dowód równoległości

#### Automated

- [ ] 5.1 Job `smoke` w PR jest zielony ze wszystkimi rundami
- [ ] 5.2 Próba zepsucia E w szkicu PR (tymczasowa migracja: `begin_ai_call` bez `pg_advisory_xact_lock`) czerwieni kroki RPC i wykrywa przekroczenie w co najmniej 2 z 5 rund
- [ ] 5.3 Wynik próby E dla strzału w trasę jest zapisany: jeśli nie pada, komentarz w skrypcie opisuje ten krok jako kontrolę kosztu, a nie dowód współbieżności

#### Manual

- [ ] 5.4 Jeśli próba E wykrywa przekroczenie w mniej niż 2 rundach mimo zwiększenia liczby wywołań, użytkownik dostaje raport i decyduje przed merge'em, bo test nie jest wtedy dowodem współbieżności

### Phase 6: Aktualizacja §6 planu testów

#### Automated

- [ ] 6.1 W §6.2 nie ma już `TBD` dla etapu 2: `grep -n "Phase 2 (wzorzec" context/foundation/test-plan.md` nic nie zwraca
- [ ] 6.2 §1–§5 bez zmian: `git diff` pliku dotyka tylko §6 i wiersza „Last updated"

#### Manual

- [ ] 6.3 Osoba czytająca §6 potrafi dopisać kolejny dowód równoległości bez czytania tego planu
