# S-09: Licznik serii dni — Plan Brief

> Full plan: `context/changes/daily-streak/plan.md`

## What & Why

Ekran główny pokazuje licznik serii dni nauki (FR-023). To motywacja do codziennych powtórek i podstawa odznak za serię w S-10.

## Starting Point

Każda odpowiedź na fiszkę jest już wierszem `flashcard_answers` z datą warszawską `answered_on`, liczoną przez bazę. Dashboard ma wzorzec odczytu przez funkcję SQL (`topic_overview()`), ale żadnego licznika serii.

## Desired End State

Nad listą tematów na `/dashboard` widać kafelek „Seria: N dni” (dla N = 1 „1 dzień”). Gdy dziś nie było jeszcze nauki, a seria trwa, pojawia się dopisek „Ucz się dziś, aby utrzymać serię”. Przykład: nauka 25–29.10, dziś 30.10 bez nauki → „Seria: 5 dni” + dopisek; ostatnia nauka 28.10 → „Seria: 0 dni”.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Dzień nauki | ≥1 odpowiedź na fiszkę (A/B/C/D lub otwarta); quiz się nie liczy | To samo źródło co „Ostatnia sesja” w S-08, a seria mierzy powtórki. |
| Dziś bez nauki | Seria żyje do końca dnia po ostatnim dniu nauki, z dopiskiem | Licznik nie spada do 0 każdego ranka. |
| Tematy zarchiwizowane | Wykluczone dynamicznie; archiwizacja może skrócić serię, przywrócenie ją oddaje | Dosłownie FR-007, bez przechowywanego stanu. |
| Miejsce | Kafelek na dashboardzie, w tym samym SSR | Jeden ekran przeglądu postępu, jedno wywołanie RPC. |
| Obliczanie | Funkcja SQL `study_streak()` (`security invoker`) przy odczycie | Wzorzec `topic_overview()`, „dziś” liczy baza jak przy zapisie odpowiedzi. |
| Dzień | Data kalendarzowa Europe/Warsaw | Rozstrzygnięte w F-02. |

## Scope

**In scope:**
- Migracja `study_streak()` + pgTAP
- `getStudyStreak`, `streakLabel`/`streakHint` + Vitest, kafelek w `dashboard.astro`, krok smoke, linia w `src/lib/topics/AGENTS.md`

**Out of scope:**
- Quiz jako dzień nauki, próg minimum odpowiedzi (FR-022 parked)
- Najdłuższa seria i zapisany stan serii (S-10)
- Licznik w Topbarze lub w sesji nauki
- Odświeżanie kafelka na żywo po archiwizacji (tylko po przeładowaniu)

## Architecture / Approach

`study_streak()` bierze odrębne `answered_on` konta z tematów `archived_at is null`, ustala kotwicę (dziś, inaczej wczoraj, inaczej brak → 0) i liczy nieprzerwany ciąg dni wstecz. Zwraca `(streak_days, studied_today)`. Dashboard wywołuje ją obok `topic_overview()` i renderuje statyczny kafelek na tokenach.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Baza | `study_streak()` + pgTAP (kotwica, przerwy, archiwum, izolacja) | Test zależny od dnia uruchomienia — daty liczone względem dzisiejszej daty warszawskiej |
| 2. Serwer + UI | Repozytorium, kafelek, etykiety z odmianą, smoke, AGENTS.md | Rozjazd odmiany „dzień/dni” lub kafelek nieodświeżony po archiwizacji |

**Prerequisites:** S-05 i S-08 gotowe (`flashcard_answers`, `archived_at`). Testy DB działają tylko w CI. `db push` wykonuje człowiek.
**Estimated effort:** ~2 sesje, po jednej na fazę.

## Open Risks & Assumptions

- Archiwizacja tematu może skrócić widoczną serię; S-10 musi przyznawać odznaki w chwili osiągnięcia progu, a nie liczyć je z bieżącej serii.
- Około północy data warszawska w bazie decyduje o „dziś”; kafelek odczytuje ją z tej samej funkcji, więc nie ma rozjazdu z TS.

## Success Criteria (Summary)

- Dashboard pokazuje serię dni zgodną z historią odpowiedzi na fiszki w aktywnych tematach.
- Seria nie zeruje się rano przed pierwszą nauką, a dopisek przypomina o dzisiejszej nauce.
- Archiwizacja i przywrócenie tematu zmieniają serię zgodnie z FR-007.
