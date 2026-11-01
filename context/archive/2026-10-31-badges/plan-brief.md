# S-10: Odznaki — Plan Brief

> Full plan: `context/changes/badges/plan.md`

## What & Why

Użytkownik zdobywa odznaki za serię dni, za opanowanie całego tematu i za łączną liczbę opanowanych fiszek, a potem je przegląda (FR-024–FR-027). To ostatni element strumienia „Motywacja”: nagroda za regularność i postęp, poza rdzeniem przepływu nauki.

## Starting Point

Seria liczy się przy odczycie w `study_streak()` (pomija tematy zarchiwizowane). Fiszka staje się opanowana tylko w `answer_flashcard_open`. Opanowanie tematu definiują S-07 i `mastery.ts`. Usunięcie fiszki kasuje ją bez śladu w liczniku, a odznak nie ma nigdzie.

## Desired End State

Odpowiedź, która domyka próg, pokazuje w sesji nauki „Zdobyto odznakę: Seria 7 dni”. Strona `/badges` (link w Topbarze, kafelek „Odznaki: N” na dashboardzie) pokazuje zdobyte odznaki z datą, niezdobyte wyszarzone z postępem („Seria 5/7”, „38/50”) i opanowane tematy. Przykład: 48 opanowanych fiszek, w tym 10 w temacie X; po archiwizacji X postęp to 38/50, zdobyte odznaki zostają, a przywrócenie X oddaje 48/50.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Progi serii | 3, 7, 30, 100 dni | Szybka pierwsza nagroda, 100 dni jako cel długoterminowy. |
| Progi fiszek | 10, 50, 100, 250 | Pierwszy próg = jedna partia. |
| Trwałość | Odznak nigdy się nie odbiera | Archiwizacja może skrócić serię (brief S-09), a odbieranie nagród demotywuje. |
| Archiwum a licznik | Licznik historyczny per temat; postęp = suma po tematach aktywnych | Spełnia FR-007 i FR-026 jednocześnie; przywrócenie oddaje postęp. |
| Opanowanie przez usunięcie | Przyznaje odznakę tematu | Zgodne z FR-020 i napisem „Temat opanowany” z S-07. |
| Mechanizm | Triggery w bazie + idempotentna `sync_badges` | Niezmienniki w bazie; żadna ścieżka zapisu nie ominie przyznania. |
| Seria | `study_streak()` deleguje do wewnętrznej `study_streak_of(uuid)` | Jedno źródło serii, także dla triggerów i migracji. |
| Powiadomienie | `data.badges` w odpowiedzi + `Alert` w StudySession | Nagroda w chwili wysiłku, bez biblioteki toastów; ponowienie zwraca to samo (po `attempt_id`). |
| Widok | `/badges` z niezdobytymi i postępem + kafelek na dashboardzie | Widoczny następny cel; dashboard nie puchnie. |
| Wstecz | Migracja uzupełnia liczniki i odznaki z bieżącego stanu | Istniejąca nauka zostaje nagrodzona; fiszek usuniętych wcześniej nie da się odtworzyć. |

## Scope

**In scope:**
- Migracja: `badges`, `topic_mastery_tallies`, `study_streak_of`, `sync_badges`, 4 triggery, `badge_overview()`, uzupełnienie wstecz + pgTAP
- `src/lib/badges/` (katalog, etykiety, repozytorium) + Vitest; `data.badges` w trasie odpowiedzi; smoke
- `/badges`, kafelek na dashboardzie, link w Topbarze, komunikat w sesji, linia w AGENTS.md

**Out of scope:**
- Odbieranie odznak, ponowna odznaka tematu, odznaki za quiz, najdłuższą serię i cel dzienny
- Komunikat poza sesją nauki, stan „obejrzane”, toasty, grafiki
- Edycja progów w UI

## Architecture / Approach

Trigger na `flashcards` (przejście w `mastered`) zwiększa licznik tematu. Triggery na wstawienie `flashcard_answers`, usunięcie fiszki i przywrócenie tematu wołają `sync_badges(user, topic, attempt)`. Funkcja sprawdza progi serii, sumę liczników po aktywnych tematach i opanowanie tematu, a potem robi `insert … on conflict do nothing`. Trasa odpowiedzi czyta odznaki po `attempt_id`, a `/badges` i dashboard czytają `badge_overview()`. Progi są w SQL, a TS je odzwierciedla.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Baza | Tabele, triggery, `sync_badges`, uzupełnienie wstecz, pgTAP | Testy DB tylko w CI; `study_streak_of` przypadkiem wystawiona dla `authenticated` |
| 2. Serwer | Katalog/etykiety, repozytorium, `data.badges`, smoke | Rozjazd progów SQL ↔ TS |
| 3. UI | `/badges`, kafelek, link, komunikat, AGENTS.md | Literały kolorów zamiast tokenów |

**Prerequisites:** S-07 i S-09 zarchiwizowane (są). `db push` migracji fazy 1 wykonuje człowiek przed wdrożeniem fazy 2.
**Estimated effort:** ~3 sesje, po jednej na fazę.

## Open Risks & Assumptions

- `answer_flashcard_open` ufa werdyktowi wywołującego (`p_correct`), więc odznakę da się „wyklikać” własnym API. Dotyczy to tylko własnego konta (to samo założenie co S-06).
- Odznakę tematu można przyspieszyć, usuwając nieopanowane fiszki; zaakceptowane jak próg 80% w S-07.
- `sync_badges` przy każdej odpowiedzi liczy serię; przy skali jednego konta jest to pomijalne.
- Odznaki przyznane przy migracji mają datę migracji, nie faktyczną datę osiągnięcia.

## Success Criteria (Summary)

- Przekroczenie progu w sesji nauki daje komunikat i trwały wpis na `/badges`; ponowienie nie duplikuje.
- Usunięcie fiszki nie zmniejsza licznika; archiwizacja obniża postęp, ale nie odbiera odznak.
- Po wdrożeniu istniejący postęp jest od razu nagrodzony.
