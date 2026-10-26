# S-05: Sesja nauki w formacie A/B/C/D — Plan Brief

> Full plan: `context/changes/multiple-choice-study-session/plan.md`

## What & Why

Użytkownik ma partię fiszek z S-04, ale nie ma jak się z nich uczyć. S-05 dodaje sesję nauki tematu: zaległe fiszki A/B/C/D, natychmiastowe sprawdzenie, błędna wraca w tej samej sesji, poprawna przechodzi do formatu otwartego i wraca jutro (FR-014, FR-015, tabela z PRD § Business Logic). Harmonogram i dziennik odpowiedzi stąd są podstawą S-06 (ocena AI), S-08 (ekran główny) i S-09 (seria dni).

## Starting Point

`flashcards` ma tylko treść i `correct_index`, bez stanu nauki ani historii; `authenticated` może tylko czytać i usuwać, więc zapis musi iść przez funkcję `security definer` (wzorzec `answer_quiz_question`). Granica dnia jest już ustalona: Europe/Warsaw.

## Desired End State

Na stronie tematu i fiszek jest „Ucz się (N)”. Strona `/topics/[id]/study` prowadzi przez kolejkę na telefonie: dotknięcie opcji od razu pokazuje wynik, wzorcową odpowiedź i „Czytaj więcej”; błędna fiszka wraca na koniec, sesja kończy się, gdy wszystkie dostały poprawną odpowiedź. Poprawne fiszki mają format otwarty 0/2 i termin na jutro; każda odpowiedź jest w dzienniku.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Model danych | Kolumny stanu na `flashcards` + dziennik `flashcard_answers` | Szybkie zapytanie zaległych, a historia od razu służy S-08/S-09. |
| Fiszki w formacie otwartym | Pomijane w sesji, liczone na ekranie końcowym | Brak tymczasowego UI do wyrzucenia; S-06 dokłada drugi typ do kolejki. |
| Sprawdzenie | Natychmiast w kliencie + zapis w tle, serwer liczy poprawność sam | NFR < 300 ms niezależnie od sieci; „Dalej” czeka na zapis, więc postęp nie ginie. |
| Powrót błędnej | Na koniec kolejki; sesja kończy się, gdy wszystkie poprawne | Najprostsza reguła z najdłuższym odstępem. |
| Błąd, potem dobrze w tej samej sesji | Otwarta 0/2, jutro (dosłownie tabela PRD) | Jedna reguła; ochronę przed zgadywaniem dają 2 odpowiedzi otwarte w różne dni. |
| Wejście | Strona `/study`, przycisk na stronie tematu i fiszek | Naturalny krok po przeglądzie partii i stałe wejście z tematu. |
| Ponowienia zapisu | `attemptId` z klienta jako klucz dziennika (idempotencja) | Ponowienie po utraconej odpowiedzi nie dubluje wiersza ani nie trafia na `card_not_due`. |
| Usunięcie fiszki | Dziennik zostaje (`flashcard_id` → null) | Seria dni (S-09) nie może tracić historii po FR-012. |
| Testy | Vitest (kolejka, dzień) + pgTAP + smoke | Każda warstwa testowana tam, gdzie najtaniej, jak w S-03/S-04. |

## Scope

**In scope:** stan harmonogramu fiszki, dziennik odpowiedzi, funkcja przejścia A/B/C/D, API sesji, mobilna strona sesji, przyciski „Ucz się (N)”, token `--success`, testy pgTAP/Vitest/smoke, notatka w `src/lib/topics/AGENTS.md`.

**Out of scope:** format otwarty i ocena AI (S-06), ekran główny i data ostatniej sesji (S-08), seria dni (S-09), stan sesji na serwerze, „nie wiem” w sesji, ponowne tasowanie opcji, SM-2, testy e2e.

## Architecture / Approach

`GET /api/topics/[id]/study` → zaległe fiszki `stage='choice' and due_on <= dziś` + liczba czekających na format otwarty. Wyspa `StudySession` trzyma kolejkę (`study-queue.ts`), pokazuje wynik z `correctIndex` i wysyła `POST /study/answer {cardId, answer, attemptId}` → `answer_flashcard_choice` (blokada fiszki, idempotencja, `card_not_due`, przejście z tabeli, wiersz dziennika w jednej transakcji). Kolejka przesuwa się dopiero po potwierdzeniu serwera.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schemat i funkcja odpowiedzi | Kolumny stanu, `flashcard_answers`, `answer_flashcard_choice`, pgTAP | Błąd w przejściach dziedziczą S-06/S-08/S-09; testy DB tylko w CI |
| 2. API sesji i kolejka | Repozytorium, GET/POST `/study`, `card_not_due`, Vitest, smoke | Rozjazd „dziś” TS↔SQL na granicy północy (zapis rozstrzyga baza) |
| 3. UI nauki i wejścia | `/study` na telefonie, przyciski „Ucz się (N)”, token, AGENTS.md | Ergonomia na telefonie i obsługa błędu zapisu bez utraty postępu |

**Prerequisites:** S-04 zarchiwizowany (partia fiszek istnieje); CI z Supabase dla testów bazy.
**Estimated effort:** ~3 sesje, po jednej na fazę.

## Open Risks & Assumptions

- Do czasu S-06 fiszki po poprawnej odpowiedzi nie są nigdzie ćwiczone — świadomie, S-06 jest następne w Stream A.
- Klient zna poprawną odpowiedź przed wyborem (jak przegląd w S-04) — akceptowane, aplikacja jest dla siebie, a serwer i tak liczy poprawność sam.
- Wszystkie konta w jednej strefie (Europe/Warsaw) — decyzja z F-02.

## Success Criteria (Summary)

- Użytkownik na telefonie przechodzi sesję do końca, widząc wynik każdej odpowiedzi od razu.
- Po sesji poprawne fiszki wracają jutro (w formacie otwartym), a ponowne wejście dziś pokazuje „Na dziś wszystko”.
- Każda odpowiedź jest zapisana dokładnie raz, także po błędzie sieci, i widoczna tylko dla właściciela.
