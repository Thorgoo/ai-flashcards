# S-06: Odpowiedzi otwarte oceniane przez AI i opanowanie — Plan Brief

> Full plan: `context/changes/ai-graded-open-answers/plan.md`

## What & Why

Fiszka po pierwszej poprawnej odpowiedzi A/B/C/D wraca jako pytanie otwarte: użytkownik pisze 2–3 zdania, AI ocenia je jako poprawne/błędne z jednozdaniowym uzasadnieniem, a po dwóch poprawnych odpowiedziach w różne dni fiszka jest opanowana. To domyka mechanizm opanowania z PRD (FR-015–FR-018, FR-028) i jest nazwanym w PRD ryzykiem — od spójności oceny zależy wiarygodność całej pętli, więc S-07 i S-10 czekają na ten wycinek.

## Starting Point

S-05 dał sesję A/B/C/D, harmonogram w kolumnach `flashcards` (`stage`, `open_streak`, `due_on`) i dziennik `flashcard_answers`, już przygotowane na `'open'`/`'mastered'`. Ścieżka AI ma gotowy rodzaj `grading` z limitem 100/dzień i timeoutem 20 s. Sesja, licznik „Ucz się (N)” i endpoint odpowiedzi obsługują dziś tylko A/B/C/D.

## Desired End State

W jednej kolejce sesji pojawiają się zaległe fiszki A/B/C/D i otwarte. Otwarta pokazuje pole odpowiedzi i postęp 0/2 lub 1/2; po „Sprawdź” użytkownik widzi werdykt, uzasadnienie AI i wzorcową odpowiedź, a fiszka wraca jutro (źle), za 3 dni (0/2 dobrze) albo zostaje opanowana (1/2 dobrze). Błąd oceny nie gubi tekstu (pole + sessionStorage), wyczerpany limit ocen pomija tylko fiszki otwarte.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Tolerancja oceny | Liczy się rdzeń myśli wzorcowej odpowiedzi; pominięty szczegół drugorzędny OK, błąd merytoryczny nie | Pasuje do 2–3 zdań z pamięci i parafrazy, bez rozmywania opanowania |
| Wynik AI i zapis | `correct` + uzasadnienie ≤ 1 zdanie; tekst odpowiedzi i uzasadnienie w `flashcard_answers` | Użytkownik wie dlaczego, a dziennik pozwala później sprawdzić spójność ocen |
| Kolejność w sesji | Jedna kolejka obu formatów: `due_on` → podtemat → pozycja; otwarta po ocenie opuszcza sesję | Minimalna zmiana S-05, harmonogram PRD bez wyjątków |
| Ochrona wpisanej odpowiedzi | Stan komponentu + sessionStorage per fiszka, czyszczone po potwierdzonej ocenie | Przeżywa błąd i odświeżenie karty bez zapisu na serwerze |
| Wyczerpany limit ocen | Komunikat, fiszki otwarte pominięte do końca sesji, A/B/C/D dalej | Sesja się nie zatrzymuje; A/B/C/D nie potrzebuje AI |
| Podważanie oceny | Brak — analiza z dziennika | Opanowanie pozostaje jednoznaczne i odporne na „samowybaczanie” |
| Ścieżka zapisu | Kontrole i replay przed AI w endpoincie, funkcja `answer_flashcard_open` pod blokadą sprawdza ponownie | Każde wywołanie AI zużywa limit, a ocena nie może trzymać blokady |
| Zaufanie do werdyktu | Funkcja przyjmuje `p_correct` od serwera aplikacji; świadomie nie jest granicą bezpieczeństwa | Oszukanie własnego harmonogramu szkodzi tylko sobie; sekret serwera byłby nieproporcjonalny |

## Scope

**In scope:**
- Migracja rozszerzająca (`answer_text`, `feedback`), funkcja `answer_flashcard_open`, pgTAP
- Zadanie AI `grade-open-answer` + fixtura fake + testy; sesja i „Ucz się (N)” z fiszkami otwartymi; endpoint z unią formatów; smoke
- UI fiszki otwartej, wersja robocza, obsługa limitu, nowy ekran końcowy

**Out of scope:**
- Podważanie/zmiana oceny, ocena „częściowo poprawna”, wersja robocza na serwerze
- Opanowanie podtematów i kolejna partia (S-07), ekran główny (S-08), seria dni (S-09)
- Zmiana modelu/limitu/timeoutu, e2e w przeglądarce

## Architecture / Approach

`POST /study/answer` z `format: 'open'`: sesja → temat → odczyt wstępny przez RLS (replay `attemptId` zwraca zapisany wynik bez AI; fiszka nie-otwarta lub niezaległa → `card_not_due`) → ocena AI (`kind: grading`; błąd → odpowiedź AI, nic nie zapisane) → `answer_flashcard_open` (pod `for update`: replay, `card_not_due`, przejście 0/2→1/2 dziś+3, 1/2→mastered, źle→0/2 dziś+1, wiersz dziennika). Klient trzyma kolejkę obu formatów; fiszka otwarta po potwierdzonej ocenie znika z kolejki.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schemat i funkcja odpowiedzi otwartej | Kolumny dziennika, `answer_flashcard_open`, pgTAP przejść i opanowania | Symulowanie „kolejnych dni” w testach bez prawa zapisu `due_on` |
| 2. Zadanie oceny i API | Ocena AI, sesja i licznik z otwartymi, endpoint, smoke | Spójność oceny prawdziwego AI (weryfikacja ręczna 3 wariantami) |
| 3. UI odpowiedzi otwartej | Pole, ocena w toku, werdykt, wersja robocza, limit, ekran końcowy | Złożoność stanu `StudySession` (unia prób, flaga limitu) |

**Prerequisites:** S-05 zarchiwizowane i na produkcji; `db push` migracji fazy 1 przed wdrożeniem fazy 2 (krok człowieka).
**Estimated effort:** ~3 sesje, po jednej na fazę.

## Open Risks & Assumptions

- Ocena AI może być niespójna między próbami — łagodzone regułą „rdzeń myśli” w prompcie i zapisem odpowiedzi + uzasadnienia do analizy; brak podważania oznacza, że błędna „błędna” kosztuje dzień.
- `p_correct` przychodzi od wywołującego RPC — zaakceptowane (jedno konto szkodzi tylko sobie), opisane w migracji i AGENTS.md.
- Wyścig dwóch kart z różnymi próbami zużywa jedną dodatkową ocenę — akceptowalne.
- Sesja ładuje wszystkie zaległe fiszki bez limitu (follow-up F4 z S-05, do S-07).

## Success Criteria (Summary)

- Fiszka przechodzi 0/2 → 1/2 → opanowana tylko przez dwie poprawne oceny w różne dni; błędna resetuje licznik bez powrotu do A/B/C/D.
- Błąd oceny lub odświeżenie nie gubi wpisanej odpowiedzi; wyczerpany limit nie zatrzymuje A/B/C/D.
- Na prawdziwym AI parafraza sedna przechodzi, błąd merytoryczny nie, a uzasadnienie jest zrozumiałe.
