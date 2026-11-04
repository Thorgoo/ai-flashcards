---
date: 2026-11-04T21:36:16+01:00
researcher: Claude Opus 5.5
git_commit: 141ac3d8d593b504d8ac0260d3357f32ac271bd2
branch: main
repository: Thorgoo/ai-flashcards
topic: "Ugruntowanie etapu 2 planu testów: integralność ponowień i rezerwacji (ryzyka #1, #2, #7)"
tags: [research, testing, ai-calls, daily-limit, claims, flashcards, quiz, pgtap]
status: complete
last_updated: 2026-11-04
last_updated_by: Claude Opus 5.5
---

# Research: integralność ponowień i rezerwacji (etap 2 planu testów)

**Date**: 2026-11-04T21:36:16+01:00
**Researcher**: Claude Opus 5.5
**Git Commit**: 141ac3d8d593b504d8ac0260d3357f32ac271bd2 (kod bez lokalnych zmian; niezacommitowany jest tylko `context/foundation/test-plan.md` i ten folder)
**Branch**: main
**Repository**: Thorgoo/ai-flashcards

## Research Question

Ugruntować w kodzie etap 2 z `context/foundation/test-plan.md` („Retry and claim integrity”) dla ryzyk:

- **#1:** ponowienie generowania zapisuje wynik podwójnie albo zużywa dzienny limit, nie dając wyniku.
- **#2:** przerwane generowanie zostawia osieroconą rezerwację, która blokuje ponowienie.
- **#7:** równoległe lub powtarzane żądania przekraczają limit 20/100.

Dla każdego ryzyka: rzeczywista ścieżka awarii, istniejące testy, najtańsza użyteczna warstwa, korekty wskazówek z planu.

Niczego nie uruchamiano. Wszystkie ustalenia pochodzą z czytania kodu, także tam, gdzie opisane jest zachowanie.

## Summary

**W sprawdzonych ścieżkach nie znaleziono błędu, który realizowałby któreś z trzech ryzyk.** Etap 2 ma więc zabezpieczać istniejące gwarancje przed regresją, a nie naprawiać kod. Największe luki to:

1. **#7, współbieżność:** blokada w `begin_ai_call` wygląda na szczelną, ale żaden test nie uruchamia jej równolegle. Warstwy z planu (pgTAP, vitest) nie mogą tego udowodnić: pgTAP działa na jednym połączeniu, a vitest nie łączy się z bazą.
2. **#1, kolejność wywołań na trasie:** nikt nie sprawdza ponowienia po błędzie generowania przez HTTP. Fake AI umie wymusić błąd przez HTTP tylko dla oceny, nie dla generowania (`src/lib/ai/fixtures.ts:62-75`).
3. **#2, przejęcie po TTL:** SQL jest dobrze pokryty, ale nie ma testu odczytu wygasłej rezerwacji w TS ani testu przejęcia przez trasę.

**Trzy wskazówki z planu testów wymagają korekty** (szczegóły w „Korekty do planu testów”):

- Zużycie limitu bez wyniku jest zgodne z PRD, więc nie można go traktować jako awarii.
- #7 wymaga warstwy z prawdziwymi równoległymi połączeniami.
- #2 nie ma zegara do sterowania; testy cofają wartość kolumny `claimed_at`.

## Detailed Findings

### Reguła obciążania limitu (wyrocznia dla #1)

- PRD: limit generowań to 20 dziennie, „niezależny od liczby błędów lub ponowień” (`context/foundation/prd.md:139`). FR-028: wynik zapisany „completely or not at all” (`context/foundation/prd.md:129`).
- `callAi` pobiera limit przez `quota.begin` (`src/lib/ai/call.ts:103`) przed wywołaniem dostawcy (`src/lib/ai/call.ts:117`). Dla jednego wywołania `callAi` jest jedno `begin` i jedna próba modelu, bez ponowień (`src/lib/ai/call.ts:83-85`, `src/lib/ai/AGENTS.md`).
- `begin_ai_call` liczy wiersze dnia bez filtra po statusie (`supabase/migrations/20261018092416_create_ai_calls.sql:58-60`). Dlatego `failed` i `pending` też się liczą.
- `finish_ai_call` zmienia tylko status (`...create_ai_calls.sql:95-102`). W `src`, `scripts` i `supabase/migrations` nie znaleziono usuwania wierszy `ai_calls` ani zwrotu limitu (wyszukiwanie `delete from public.ai_calls`, `'pending'`, `cron.`).
- Decyzja jest świadoma: `context/archive/2026-10-18-ai-call-guardrails/plan-brief.md:23,28` oraz `context/foundation/infrastructure.md:63` („prevents corruption, not wasted work”).

**Oczekiwany wynik wynikający z PRD:** N prób modelu daje N obciążeń. Dwie porażki i sukces to 3 obciążenia i 1 komplet wyniku. Odrzucenie przed wywołaniem modelu to 0 obciążeń.

### Ścieżki zapisu i ponowienia (#1)

| Rodzaj          | Zapis                                                                                                              | Co blokuje drugi zapis                                                                           | Powtórka po udanym zapisie                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Podtematy       | `replace_subtopics`, jedna transakcja, zastępuje całą listę (`20261022163613_create_topics_and_subtopics.sql:119`) | Brak rezerwacji; zastąpienie jest celowe                                                         | **Nowe wywołanie modelu i obciążenie, dopóki temat jest `draft`** (`src/pages/api/topics/[id]/generate.ts:17-25`) |
| Quiz            | `create_quiz`, jedna transakcja (`20261025182503_claim_tokens_and_option_nulls.sql:231`)                           | `claim_quiz`: `on conflict (topic_id) do nothing` (`:188-191`), potem `quiz_exists` (`:200-202`) | 0 obciążeń: `claim_quiz` odmawia przed AI (`src/pages/api/topics/[id]/quiz/index.ts:32-33`)                       |
| Pierwsze fiszki | `create_flashcard_batch`, jedna transakcja (`20261029190000_flashcard_batch_failures.sql:92`)                      | `batch_exists` w `claim_flashcard_batch` (`20261029203000_flashcard_claim_ttl_180.sql:48-50`)    | 0 obciążeń (odmowa przed kolejką)                                                                                 |
| Kolejna partia  | `create_next_flashcard_batch`, jedna transakcja (`20261029190000_flashcard_batch_failures.sql:253`)                | `claim_next_flashcard_batch` (`20261029203000_flashcard_claim_ttl_180.sql:63`)                   | 0 obciążeń; `smoke-topics.mjs:702` sprawdza `batch_exists`                                                        |

Zachowanie przy porażce modelu:

- **Podtematy:** trasa kończy się przed zapisem (`generate.ts:21`), poprzednia lista zostaje.
- **Quiz:** `releaseQuizClaim` usuwa wiersz (`quiz/index.ts:54-57`), ponowienie zaczyna od nowa.
- **Fiszki:** `failFlashcardBatchClaim` ustawia `failed` (`src/lib/topics/flashcard-job.ts:116`). Kolejna rezerwacja przejmuje taki wiersz od razu, bez czekania na TTL (`20261029203000_flashcard_claim_ttl_180.sql:51-52`).

Nie znaleziono dziury w podwójnym ani częściowym zapisie w tych czterech ścieżkach. Pozostałe punkty dotyczą kosztu, nie integralności danych:

- **Podtematy, utracona odpowiedź lub równoległe żądania:** każde żądanie płaci osobno, a ostatni zapis zastępuje listę. To zgodne z decyzją `context/archive/2026-10-22-topic-with-confirmed-subtopics/plan-brief.md:22`.
- **Podwójne doręczenie komunikatu kolejki (wniosek, nie zaobserwowane):** sprawdzenie w `flashcard-job.ts:127-130` to odczyt, nie atomowa operacja, więc dwa doręczenia mogłyby dać 2 wywołania modelu przy jednym zapisie. `max_retries: 0` (`wrangler.jsonc:19`) wyklucza ponowienia po błędzie, ale nie sprawdzano gwarancji doręczenia w Cloudflare Queues.
- **`p_claimed_at = null`:** `create_quiz` pomija wtedy sprawdzenie tokenu (`20261025182503_claim_tokens_and_option_nulls.sql:269`). To ścieżka zgodności ze starszym Workerem. Obecny TS przekazuje token (`quiz/index.ts:59`, `flashcard-job.ts:169-170`), a unikalność `topic_id` i tak blokuje duplikat.

### Cykl życia rezerwacji i przerwanie (#2)

| Rodzaj                          | Rezerwacja                              | TTL                                                                                                    | Porażka                                     | Przerwanie (Worker zabity)           |
| ------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------ |
| Podtematy                       | **Brak**                                | n/d                                                                                                    | Nic nie zapisano                            | Nic nie blokuje; limit zużyty        |
| Quiz                            | `quizzes.status='generating'`           | 90 s (`20261025182503_claim_tokens_and_option_nulls.sql:203`)                                          | Usunięcie wiersza                           | Wiersz czeka do TTL, potem przejęcie |
| Pierwsze fiszki, kolejna partia | `flashcard_batches.status='generating'` | 180 s (`20261029203000_flashcard_claim_ttl_180.sql:52`, dla kolejnej partii ta sama migracja od `:63`) | `failed` z `error_code`; ponowienie od razu | Wiersz czeka do TTL, potem przejęcie |

- **Token:** jest nim `claimed_at`. Po przejęciu poprzedni właściciel nie zapisze wyniku (`quiz_not_claimed`, `20261025182503_claim_tokens_and_option_nulls.sql:269-271`). Fiszki dodatkowo sprawdzają token przed AI (`flashcard-job.ts:127-130`). Quiz nie ma takiego sprawdzenia, więc porzucony proces płaci za AI, a zatrzymuje go dopiero `create_quiz`.
- **Przed TTL:** druga próba quizu dostaje `quiz_generating` (`:203-205`), fiszek `batch_generating` (`20261029203000_flashcard_claim_ttl_180.sql:52-54`). Według raportu pracownika oba kody dają status 409, a UI przechodzi w odpytywanie zamiast pokazywać błąd (`src/components/topics/QuizRunner.tsx:43-46`, `FlashcardBatch.tsx:54-56`).
- **Odczyt w TS:** wygasła rezerwacja wygląda jak jej brak (`src/lib/topics/quiz-repository.ts:89-91`, `src/lib/topics/flashcard-repository.ts:210-214`). Obie ścieżki używają `Date.now()` bezpośrednio i nie można wstrzyknąć czasu.
- **Blokada na stałe:** nie znaleziono ścieżki, w której wiersz `generating` zostaje na zawsze. Wiersz czeka najwyżej do końca TTL, a `failed` nie blokuje ponowienia. Dotyczy to czterech funkcji rezerwacji i tras wymienionych wyżej.
- **Skąd bierze się osierocenie:**
  - Fiszki działają w kolejce, więc rozłączenie klienta ich nie przerywa. Zostają przypadki z `flashcard-job.ts:92-120` (zły komunikat, brak konfiguracji, odrzucony token) oraz zabity konsument lub utracony komunikat.
  - Quiz działa pod `waitUntil` (`quiz/index.ts:41`), a Cloudflare ucina go około 30 s po rozłączeniu (`src/lib/ai/AGENTS.md`, `context/foundation/infrastructure.md:94`; tej liczby nie sprawdzano w dokumentacji Cloudflare). Timeout generowania to 60 s (`src/lib/ai/call.ts:11`), więc połączenie dłuższe niż 30 s po rozłączeniu może osierocić rezerwację quizu.
- **Wiersz `pending` w `ai_calls`:** przerwane wywołanie zostawia go bez sprzątania i nadal liczy się do limitu (`...create_ai_calls.sql:58-60`). To wynika z tej samej reguły, nie z błędu.

### Limit i współbieżność (#7)

- `begin_ai_call` to jedyna definicja tej funkcji w migracjach (raport pracownika, wyszukiwanie). Wykonuje kolejno: `pg_advisory_xact_lock` dla pary konto i rodzaj (`...create_ai_calls.sql:56`), `count(*)` (`:58-60`), odmowę `P0429` (`:62-64`), `insert` (`:66-68`).
- **Wniosek, nie obserwacja:** to jest szczelne przy READ COMMITTED, bo blokada trwa do commitu, a kolejne zapytanie widzi już zatwierdzony wiersz. Poziomu izolacji PostgREST nie weryfikowano w działaniu.
- Doba to data w strefie `Europe/Warsaw` (`:41`).
- **Testy sekwencyjne:** `ai_calls.test.sql:17-31` (limit 20, 21. wywołanie to `P0429`), `smoke-topics.mjs:775-792` (21. generowanie przez HTTP to 429 `quota_exceeded`).
- **Brak współbieżności:** w `scripts`, `e2e` i `supabase` nie ma `Promise.all`, `Promise.allSettled` ani `dblink` (sprawdzone wyszukiwaniem). `vitest.config.ts` nie ma bazy, a `call.test.ts` używa licznika w pamięci (`src/lib/ai/call.test.ts:17-38`).
- **Czego nie sprawdzono:** limitu 100 dla oceny (brak asercji w `ai_calls.test.sql` według raportu pracownika), braku wiersza po odmowie oraz równoległego `claim_quiz` / `claim_flashcard_batch` (komentarz o oczekiwaniu: `20261025182503_claim_tokens_and_option_nulls.sql:187`).

### Co już pokrywają testy

| Obszar               | Pokryte                                                                                                                                         | Luka                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Limit (SQL)          | Sekwencyjne 20 + odmowa, osobne rodzaje, wczorajsze wiersze i inne konto, brak zapisu bezpośredniego, brak dostępu `anon` (`ai_calls.test.sql`) | Równoległość, limit 100, brak wiersza po odmowie                                                                                                                                           |
| Limit (TS)           | Błąd dostawcy się liczy, odmowa nie woła modelu (`call.test.ts:61-74,94-103`)                                                                   | Tylko licznik w pamięci                                                                                                                                                                    |
| Quiz (SQL)           | Rezerwacja, zwolnienie, przejęcie po 2 min, porzucony token, wypełnienie po przejęciu (`quizzes.test.sql:159-219`)                              | Granica TTL (brak próby tuż poniżej 90 s)                                                                                                                                                  |
| Fiszki (SQL)         | 121 s nadal trwa, 181 s przejęcie, porzucony token, `failed` ponawiane od razu, 9 lub 11 kart odrzucone (`flashcards.test.sql:174-281`)         | Pełna sekwencja z licznikiem `ai_calls`                                                                                                                                                    |
| Kolejna partia (SQL) | Przejęcie po 181 s, porzucony token, wypełnienie (`flashcard_next.test.sql:105-215`)                                                            | Próba poniżej TTL po cofnięciu czasu                                                                                                                                                       |
| Zadanie fiszek (TS)  | Zapis pod tokenem, brak AI po przejęciu, zapis kodu błędu (`flashcard-job.test.ts`)                                                             | `kind: "next"`, ścieżki „unmarked”; klient Supabase jest atrapą                                                                                                                            |
| Odczyt TS            | Wyświetlanie `failed` (`flashcard-repository.test.ts`)                                                                                          | Wygasły `generating` jako brak; `getQuizState` bez testów. Stała `OLD` = 121 s (`:7`) nie jest już wygasła przy TTL 180 s, choć według raportu pracownika nie używa się jej z `generating` |
| Trasy                | Tylko `scripts/smoke-topics.mjs` i e2e na fake AI                                                                                               | Brak błędu generowania przez HTTP; `generateQuiz` nie jest eksportowane (`quiz/index.ts:45`)                                                                                               |

### Dostępne szwy testowe

- **pgTAP:** cofanie czasu to `reset role; update ... set claimed_at = now() - interval '...'; set local role authenticated;` (`quizzes.test.sql:179-182`). `now()` jest zamrożone w transakcji, więc token porzucony podaje się jako `now() - interval` (`:191,196`).
- **Pełna sekwencja w pgTAP jest możliwa:** `begin_ai_call` + `release_quiz_claim` + ponowna rezerwacja + `create_quiz` + liczenie `ai_calls` na jednym połączeniu. Dowodzi reguł bazy, nie kolejności wywołań na trasie.
- **Vitest:** `callAi` + `createFakeProvider` z `FakeAiFailure` (`src/lib/ai/call.test.ts`, `src/lib/topics/AGENTS.md`). `@/lib/ai` wymaga `astro:env`, więc nie działa w czystym vitest.
- **HTTP na prawdziwej bazie:** `scripts/smoke-topics.mjs` ma `signIn` zakładające świeże konto (`:113-135`), klienta service-role (`:20`) i `generationCalls` (`:68-76`). Wymaga lokalnego Supabase; `src/lib/topics/AGENTS.md` opisuje ten skrypt jako „CI only”.
- **Wymuszenie błędu generowania przez HTTP: brak.** `fixtures.ts` ma znacznik tylko dla oceny (`:65,72-75`). Test przez trasę wymaga nowego szwu w fixture (wzorzec: `FAKE_GRADING_FAIL_ONCE`) i kopii znacznika w skrypcie (`smoke-topics.mjs:52-54`).

### Najtańsza warstwa dla każdego dowodu

| Dowód                                                       | Warstwa                                          | Uzasadnienie                                                      |
| ----------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| #1: porażki + sukces = N obciążeń i 1 komplet (reguły bazy) | pgTAP                                            | Deterministyczne, tanie, wyrocznia z PRD:139 i FR-028             |
| #1: powtórka po sukcesie nie płaci (quiz, fiszki, partia)   | pgTAP dla odmowy, licznik w smoke                | Odmowa pada przed `callAi`                                        |
| #1: trasa zwalnia rezerwację po błędzie, ponowienie działa  | smoke + nowy szew fixture                        | Tylko tu widać kolejność na trasie                                |
| #2: przejęcie po TTL, także granica                         | pgTAP (cofanie `claimed_at`)                     | Istniejący wzorzec; dodać próby tuż poniżej TTL                   |
| #2: wygasła rezerwacja nie blokuje trasy                    | smoke (cofnięcie przez service-role, potem POST) | Obejmuje `Date.now()` w TS i `claim_*` razem                      |
| #7: 21. odrzucone sekwencyjnie                              | Już jest                                         | Nie powielać                                                      |
| #7: równolegle dokładnie 20 przechodzi                      | Skrypt Node, `Promise.all` na świeżym koncie     | Wymaga wielu połączeń; asercja na liczbie wierszy `ai_calls` = 20 |

**Warunek dla testu #7:** skoro nic nie gwarantuje, że żądania naprawdę się nakładają, test musi przejść sprawdzenie celowym zepsuciem. Po usunięciu `pg_advisory_xact_lock` musi zacząć padać. Jeśli nie pada, nie dowodzi współbieżności. Własnej puli PostgREST nie sprawdzano; `supabase/config.toml:44-48` opisuje tylko pooler.

## Korekty do planu testów

Do przeniesienia do `context/foundation/test-plan.md` przez `/10x-test-plan` (kontrola przeniesienia po badaniu). Tutaj plan nie jest zmieniany.

1. **Ryzyko #1, druga połowa zdania.** „Zużywa dzienny limit, nie dając wyniku” jest zachowaniem wymaganym przez `prd.md:139`, a nie awarią. Awarią byłoby obciążenie inne niż jedno na próbę modelu albo obciążenie przy odmowie przed AI.
2. **Ryzyko #2, warstwa.** W kodzie nie ma zegara do sterowania: wszystkie funkcje czytają `now()`. Mechanizmem jest cofanie `claimed_at`. Pokrycie SQL już istnieje, więc wartość dodana leży w granicach TTL i w przejęciu przez trasę. Podtematy nie mają rezerwacji, więc ryzyko #2 ich nie dotyczy.
3. **Ryzyko #2, źródło.** Cytat z `infrastructure.md` o przerwaniu przy rozłączeniu jest częściowo nieaktualny: fiszki działają w kolejce, a quiz pod `waitUntil` (`infrastructure.md:94`).
4. **Ryzyko #7, warstwa.** „pgTAP / vitest” nie udowodni równoległości. Potrzebny jest skrypt Node na lokalnym Supabase. To samo dotyczy typu testów w §3 („integration (pgTAP + vitest)”): vitest nie ma tu dostępu do bazy.

## Code References

- `supabase/migrations/20261018092416_create_ai_calls.sql:33-73` — `begin_ai_call`: blokada, licznik, odmowa, zapis
- `src/lib/ai/call.ts:83-117` — obciążenie przed wywołaniem modelu, bez ponowień
- `src/lib/ai/fixtures.ts:62-75` — jedyny znacznik błędu przez HTTP (ocena)
- `supabase/migrations/20261025182503_claim_tokens_and_option_nulls.sql:165-212` — `claim_quiz`, TTL 90 s
- `supabase/migrations/20261025182503_claim_tokens_and_option_nulls.sql:269-271` — token w `create_quiz`
- `supabase/migrations/20261029203000_flashcard_claim_ttl_180.sql:44-59` — przejęcie pierwszej partii, TTL 180 s
- `src/pages/api/topics/[id]/quiz/index.ts:23-69` — kolejność rezerwacja, AI, zapis, zwolnienie
- `src/pages/api/topics/[id]/generate.ts:9-26` — podtematy bez rezerwacji
- `src/lib/topics/flashcard-job.ts:92-130` — zadanie kolejki, sprawdzenie tokenu przed AI
- `src/lib/topics/quiz-repository.ts:89-91`, `src/lib/topics/flashcard-repository.ts:210-214` — wygasła rezerwacja w odczycie TS
- `supabase/tests/database/quizzes.test.sql:179-199` — wzorzec cofania czasu i porzuconego tokenu
- `scripts/smoke-topics.mjs:113-135`, `:773-792` — świeże konto i sekwencyjny test limitu

## Architecture Insights

- Niezmienniki są w bazie, a TS tylko je tłumaczy na odpowiedzi (`src/lib/topics/AGENTS.md`). Najtańszy trwały dowód leży więc w pgTAP, a trasy trzeba sprawdzać tylko pod kątem kolejności wywołań.
- Stałe TTL są zapisane dwa razy, w SQL i w TS (`quiz-task.ts:9`, `flashcards-task.ts:13`). Żaden test nie pilnuje ich zgodności.
- Licznik generowań w smoke jest sprzężony z pętlą limitu (`smoke-topics.mjs:773-776`, `src/lib/topics/AGENTS.md`). Nowe wywołania AI na koncie `a` przesuną ten licznik, więc scenariusze tego etapu lepiej trzymać na osobnym świeżym koncie.

## Historical Context (from prior changes)

- `context/archive/2026-10-18-ai-call-guardrails/plan-brief.md:23,28` — każde wywołanie się liczy, ponawia tylko użytkownik (raport pracownika).
- `context/archive/2026-10-22-topic-with-confirmed-subtopics/plan-brief.md:22` — „Wygeneruj ponownie” zastępuje całą listę.
- `context/archive/2026-10-22-diagnostic-quiz-by-subtopic/reviews/impl-review.md:41-60` — znalezisko o przerwanym wywołaniu, z którego wyrosła rezerwacja quizu.
- `context/archive/2026-10-29-durable-flashcard-generation/plan-brief.md:24` — kolejka, `max_retries: 0`.
- `context/foundation/test-plan.md:135` — etap 1 sprawdzał każdy nowy test celowym zepsuciem w CI; ręczne kroki wrappera e2e czekały na maszynę z Dockerem.

## Related Research

Nie dotyczy; w `context/changes/` nie ma innego researchu na ten temat. Archiwum przeszukano tylko pod kątem decyzji wymienionych wyżej.

## Open Questions

Do rozstrzygnięcia w `/10x-plan`:

1. **Czy dodać szew błędu generowania do fixture?** Bez niego #1 na trasie pozostanie niesprawdzone. To niewielka zmiana kodu produkcyjnego fixture (tylko `AI_MODE=fake`). Rekomendacja: dodać, ponieważ istnieje gotowy wzorzec.
2. **Gdzie umieścić test równoległy:** w `scripts/smoke-topics.mjs` czy w nowym skrypcie uruchamianym w CI. Rekomendacja: wybrać w planie po sprawdzeniu czasu joba `smoke`; w obu wariantach użyć świeżego konta.
3. **Czy test równoległy ma wołać RPC `begin_ai_call`, czy trasę `/generate`?** RPC jest szybsze i celuje w blokadę. Trasa dowodzi też kosztu end-to-end. Rekomendacja: RPC jako główny dowód.
4. **Decyzja produktowa, nie testowa:** czy powtórka podtematów po utraconej odpowiedzi ma dalej płacić i nadpisywać listę? Dziś to wybrana semantyka: decyzja mówi o zastąpieniu „po potwierdzeniu w UI” (`plan-brief.md:22`), ale samego UI nie sprawdzano.

Luki w dowodach, bez wpływu na wnioski powyżej:

- Niczego nie uruchomiono, więc zachowanie blokady pod obciążeniem jest wnioskiem.
- `e2e/critical-path.spec.ts` czytał tylko pracownik, i tylko w części dotyczącej oceny.
- Poza plikami czytanymi bezpośrednio (migracje `create_ai_calls`, `claim_tokens`, `ttl_180`, trasy `quiz` i `generate`, `flashcard-job`, `fixtures`, fragmenty `quizzes.test.sql` i `smoke-topics.mjs`) kotwice pochodzą z raportów pracowników. Dotyczy to m.in. numerów linii w `flashcard-job.test.ts`, `FlashcardBatch.tsx` i plikach archiwum. Przy kontroli wyrywkowej jedna taka kotwica okazała się błędna i została poprawiona (`smoke-topics.mjs:702`), więc przed cytowaniem pozostałych w planie warto je sprawdzić.
- Nie sprawdzano gwarancji doręczenia Cloudflare Queues ani limitu `waitUntil` w dokumentacji Cloudflare.
