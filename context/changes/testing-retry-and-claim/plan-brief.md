# Retry and claim integrity tests — Plan Brief

> Full plan: `context/changes/testing-retry-and-claim/plan.md`
> Research: `context/changes/testing-retry-and-claim/research.md`

## What & Why

Etap 2 planu testów dla ryzyk #1 (ponowienia), #2 (osierocona rezerwacja) i #7 (limit przy równoległych żądaniach). Research nie znalazł błędu, więc celem jest zabezpieczenie istniejących gwarancji przed regresją, z oczekiwanymi wartościami z PRD, a nie z kodu.

## Starting Point

SQL ma testy przejęć i sekwencyjnego limitu. Brakuje prób tuż poniżej TTL, testów odczytu wygasłej rezerwacji w TS, jakiegokolwiek ponowienia generowania i przejęcia przez HTTP oraz prawdziwej współbieżności.

## Desired End State

Regresja w obciążaniu limitu, przejmowaniu rezerwacji lub blokadzie limitu czerwieni CI, a każda nowa grupa testów ma zapisaną próbę celowego zepsucia. §6 planu testów opisuje wzorce dla kolejnych etapów.

## Key Decisions Made

| Decision                    | Choice                                                                     | Why (1 sentence)                                                                   | Source   |
| --------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| Reguła obciążania           | N prób modelu = N obciążeń, odmowa przed AI = 0                            | Limit jest „niezależny od liczby błędów lub ponowień" (`prd.md:139`)               | Research |
| Błąd generowania przez HTTP | Znacznik `[fake-ai-fail-twice]` w nazwie tematu                            | Obejmuje 4 rodzaje generowania i powtarza wzorzec z oceny; działa tylko na fake AI | Plan     |
| Miejsce testów              | Nowy `scripts/smoke-retry-claim.mjs` i osobny krok CI, własne świeże konta | Nie przesuwa licznika generowań w `smoke-topics.mjs`; krok smoke trwa dziś 18 s    | Plan     |
| Poziom testu równoległego   | RPC jako główny dowód, plus strzał w `/generate`                           | RPC celuje w blokadę, a trasa sprawdza koszt i spójność listy                      | Plan     |
| Dowód, że test ma zęby      | Jednorazowe usunięcie blokady, wynik zapisany                              | Zgodne z etapem 1, bez kopii funkcji w repozytorium                                | Plan     |
| Powtórka podtematów         | Bez zmian w kodzie, test przypina płatność i zastąpienie listy             | Decyzja produktowa; poza zakresem etapu testów                                     | Plan     |
| Granice czasu               | ±1 s w pgTAP i vitest, margines przez HTTP (80 i 95 s, 170 i 185 s)        | Przez HTTP zegar biegnie, więc ścisła granica byłaby niestabilna                   | Plan     |
| Sekwencje w pgTAP           | Nowy `retry_charges.test.sql`                                              | `flashcards.test.sql` ma asercje bez filtra po temacie                             | Plan     |

## Scope

**In scope:**

- pgTAP: granice TTL, sekwencje obciążeń, statusy liczone do limitu, limit 100
- vitest: odczyt wygasłej rezerwacji
- Fixture fake AI, skrypt HTTP, krok CI i 3 konta na liście `ALLOWED_EMAILS`
- Próby celowego zepsucia i aktualizacja §6

**Out of scope:**

- Zmiana semantyki podtematów i inny kod produkcyjny poza fixture
- §1–§5 planu testów
- Podwójne doręczenie z Cloudflare Queues, równoległe `claim_*`, północ w strefie Warsaw
- Stały krok CI z funkcją bez blokady

## Architecture / Approach

Każda warstwa dowodzi tylko tego, czego niższa nie może: pgTAP daje ścisłe granice i reguły, vitest odczyt TS, skrypt HTTP kolejność na trasie i zgodność SQL z TS, a skrypt równoległy szczelność blokady. Próby zepsucia idą przez szkic PR, który zamykamy bez merge'a, bo CI działa tylko na `main` i PR.

## Phases at a Glance

| Phase                    | What it delivers                                           | Key risk                                         |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------------------ |
| 1. Reguły bazy w pgTAP   | Granice TTL, sekwencje 3 obciążeń, limit 100               | Wyrocznia skopiowana z migracji                  |
| 2. Odczyt w vitest       | Pierwszy test `getQuizState`, granice fiszek               | Import stałej zamiast dosłownej wartości         |
| 3. Ponowienia przez HTTP | Znacznik, helpery, skrypt, krok CI, scenariusz 14 obciążeń | Refaktor helperów psuje `smoke-topics.mjs`       |
| 4. Przejęcie przez trasę | Scenariusz 7 obciążeń, zgodność `GET` i `POST`             | Niestabilność czasowa przy zbyt małym marginesie |
| 5. Dowód równoległości   | Rundy RPC, strzał w trasę, próba bez blokady               | Wyścig może się nie ujawnić w lokalnej puli      |
| 6. Aktualizacja §6       | Wzorce cookbooka i notatka etapu                           | Dotknięcie zamrożonych sekcji                    |

**Prerequisites:** Lokalny Supabase dla `npm run db:test` (Docker działa, sprawdzono 2026-11-04), `gh` do szkiców PR.
**Estimated effort:** Około 1–2 sesji; każda próba w CI to około 3,5 min.

## Open Risks & Assumptions

- Wielkość puli PostgREST nie jest zweryfikowana w działaniu. Jeśli próba E wykryje przekroczenie w mniej niż 2 z 5 rund, test nie jest dowodem i decyzję podejmuje użytkownik.
- Strzał w `/generate` może nie paść bez blokady, jeśli serwer preview szereguje żądania. Wtedy zostaje kontrolą kosztu, a dowodem współbieżności pozostaje RPC.
- Inny status niż 200 lub 429 przy strzale w trasę byłby prawdziwym błędem. Plan każe go zgłosić, a nie rozluźniać asercję.
- Licznik znacznika żyje w izolacie serwera, więc restart w trakcie skryptu powtórzyłby błędy. Skrypt używa jednego serwera i losowych nazw.

## Success Criteria (Summary)

- Job `smoke` jest zielony z nowym krokiem, a `smoke-topics.mjs` zachowuje swoje kroki i liczniki.
- Próby zepsucia A–E czerwienią właściwe kroki, a wyniki są zapisane w §6.5.
- Na prod znacznik nie ma żadnego skutku.
