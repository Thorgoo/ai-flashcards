# Quiz diagnostyczny z wynikiem per podtemat — Plan Brief

> Full plan: `context/changes/diagnostic-quiz-by-subtopic/plan.md`

## What & Why

Wycinek S-03. Na zatwierdzonym temacie użytkownik rozwiązuje wygenerowany przez AI quiz z 10 pytaniami (A/B/C/D + „nie wiem”) i widzi wynik w podziale na podtematy. Ten wynik decyduje w S-04, z których podtematów powstaną fiszki, więc błędne przypisanie pytania do podtematu po cichu zepsułoby całą resztę produktu.

## Starting Point

S-02 dostarczył zatwierdzone tematy z zablokowaną w bazie listą 2–10 podtematów z typem treści. Są też gotowe wzorce: tabele z RLS, atomowe RPC, zadanie AI z fixture, endpointy JSON, wyspa z postępem generowania i smoke na sesji testowej. Quizu jeszcze nie ma: zatwierdzony temat pokazuje tylko informację, że będzie kolejnym krokiem.

## Desired End State

Na zatwierdzonym temacie widać „Rozpocznij quiz”, „Kontynuuj quiz” albo „Zobacz wynik”. Quiz idzie pytanie po pytaniu i każda odpowiedź zapisuje się od razu, więc przerwany quiz wraca do pierwszego pytania bez odpowiedzi. Po 10. odpowiedzi widać wynik per podtemat (poprawne/zadane, %, „nie wiem”) i przegląd pytań z poprawnymi odpowiedziami.

## Key Decisions Made

| Decision                 | Choice                                                              | Why (1 sentence)                                                 |
| ------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Liczba quizów            | Jeden na temat                                                      | Jedno jednoznaczne wejście dla S-04 i prosty model danych.       |
| Rozkład pytań            | Równo, różnica ≤ 1 (np. 4/3/3), nadwyżka na pierwsze podtematy      | Porównywalne wyniki per podtemat przy wyborze najsłabszych.      |
| Przebieg                 | Pytanie po pytaniu, każda odpowiedź zapisana, bez zmiany odpowiedzi | Nic nie ginie przy przerwie i dobrze działa na telefonie.        |
| Start                    | Przycisk „Rozpocznij quiz”                                          | Świadome użycie dziennego limitu; spójne z S-02.                 |
| Wynik                    | % poprawnych; „nie wiem” = 0, ale pokazywane osobno                 | Prosty wskaźnik do rankingu w S-04.                              |
| Ujawnianie odpowiedzi    | Dopiero na ekranie wyniku                                           | Diagnoza nie uczy w trakcie.                                     |
| Przechowywanie wyniku    | Liczony w SQL (`quiz_results`) z odpowiedzi                         | Jedno źródło prawdy dla ekranu i S-04.                           |
| Przypisanie do podtematu | Złożony FK `(subtopic_id, topic_id)`                                | Baza gwarantuje podtemat tego samego tematu (ryzyko z roadmapy). |
| Kwoty w AI               | Serwer liczy kwoty, schemat zod per żądanie je sprawdza             | Model nie może zmienić rozkładu.                                 |
| Kolejność odpowiedzi     | Tasuje serwer                                                       | Modele zwykle stawiają poprawną odpowiedź na A.                  |

## Scope

**In scope:**

- `quizzes` i `quiz_questions`, `create_quiz`, `answer_quiz_question`, `quiz_results`, pgTAP;
- zadanie AI `quiz` z fixture;
- endpointy `/api/topics/[id]/quiz` i `/quiz/answer`;
- rozszerzenie `smoke:topics`;
- ekran quizu i wyniku;
- dokumentacja.

**Out of scope:**

- powtórny quiz;
- informacja zwrotna w trakcie;
- zmiana odpowiedzi;
- punkty ujemne;
- limit czasu;
- ranking najsłabszych i fiszki (S-04);
- zmiany na `/dashboard` (S-08);
- ukrywanie `correct_index` przed bezpośrednim PostgREST (tylko własne dane).

## Architecture / Approach

Inwarianty pilnuje baza:

- jeden quiz na zatwierdzony temat;
- 10 pytań zapisywanych atomowo;
- pytanie w podtemacie tego samego tematu;
- jednorazowa odpowiedź i niezmienne pytanie (trigger);
- `completed_at` po ostatniej odpowiedzi.

`quiz-task.ts` liczy kwoty, buduje prompt i schemat oraz tasuje opcje. Endpointy sprawdzają status tematu i istnienie quizu przed AI i zwracają `QuizState`, który do ukończenia nie zawiera poprawnych odpowiedzi. `QuizRunner` renderuje tylko stan z API.

## Phases at a Glance

| Phase                      | What it delivers                                    | Key risk                                                         |
| -------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| 1. Schemat bazy            | Tabele, trzy funkcje, trigger, pgTAP                | Złożony FK do `subtopics` wymaga dodatkowego `unique`            |
| 2. Zadanie AI, API i smoke | `quiz-task`, repozytorium, endpointy, Vitest, smoke | Model myli kwoty, więc odpowiedź zostaje odrzucona i limit spada |
| 3. UI                      | Wejście z tematu, `QuizRunner`, ekran wyniku, docs  | Wznawianie i blokada przycisków przy wolnej sieci                |

**Prerequisites:** S-02 jest done. Migracja trafia na produkcję (`db push`, krok człowieka) przed merge'em.
**Estimated effort:** ~3 sesje, 3 fazy.

## Open Risks & Assumptions

- Ścisłe kwoty mogą częściej odrzucać odpowiedź modelu. Każde ponowienie zużywa limit; w razie problemów kwoty idą wyżej w prompcie.
- Zakładamy, że 10 pytań mieści się w ok. 3000 tokenów i w 60 s z F-02.
- Poprawne odpowiedzi są czytelne przez bezpośredni PostgREST dla właściciela. To świadomie przyjęte, bo dotyczy tylko jego danych.

## Success Criteria (Summary)

- Użytkownik rozwiązuje quiz z 10 pytaniami rozłożonymi równo na podtematy, z „nie wiem”, i może go przerwać i wznowić.
- Wynik per podtemat jest liczony z zapisanych odpowiedzi, a S-04 może z niego korzystać.
- Drugiego quizu ani zmiany odpowiedzi nie da się zrobić ani w UI, ani przez API, ani w bazie.
