# S-08: Ekran główny i archiwizacja tematów — Plan Brief

> Full plan: `context/changes/home-screen-and-topic-archive/plan.md`

## What & Why

`/dashboard` staje się ekranem głównym (FR-021). Przy każdym temacie widać, ile fiszek czeka na powtórkę i kiedy była ostatnia sesja. Użytkownik może też zmienić nazwę tematu, zarchiwizować go po potwierdzeniu i przywrócić (FR-007). Archiwizacja zastępuje usuwanie, bo trwała utrata postępu nauki to zbyt duże ryzyko.

## Starting Point

Dashboard pokazuje dziś tylko nazwę i status tematu. Kolumny archiwizacji nie ma. Trigger `guard_topic_status` przepuszcza zmianę `scope_note` zatwierdzonego tematu, a polityka RLS pozwala usunąć temat. Obie dziury pochodzą z przeglądu S-02. Dane do ekranu już istnieją: `flashcards.stage/due_on` oraz log `flashcard_answers.answered_on` (data warszawska).

## Desired End State

Każdy aktywny temat na ekranie głównym pokazuje „Do powtórki: N” (dokładnie tyle, ile poda „Ucz się”) i „Ostatnia sesja: DD.MM.YYYY” albo „—”. Ma też akcje „Zmień nazwę” i „Archiwizuj” (z dialogiem). Zarchiwizowane tematy leżą w zwiniętej sekcji „Zarchiwizowane (N)” z przyciskiem „Przywróć”. Zarchiwizowany temat jest niedostępny: strony przekierowują na dashboard, a API zwraca 409 `topic_archived`. Po przywróceniu wraca bez utraty danych.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Co liczy „do powtórki” | `stage in (choice, open) and due_on <= dziś` | Liczba na ekranie zawsze zgadza się z sesją „Ucz się”. |
| „Ostatnia sesja” | `max(flashcard_answers.answered_on)`, a bez odpowiedzi „—” | Jedno źródło z indeksem; quiz diagnostyczny nie jest sesją powtórek. |
| Dostęp do zarchiwizowanego tematu | Pełna blokada (redirect + 409), działa tylko przywrócenie | „Ukryty do przywrócenia” obowiązuje wszędzie, a AI i odpowiedzi nie trafiają na ukryty temat. |
| Miejsce archiwum | Zwinięta sekcja na dashboardzie | Jeden ekran, istniejący `Collapsible`, bez nowej trasy. |
| Reguły zapisu w bazie | Zatwierdzony temat: tylko `name` i `archived_at`; brak DELETE dla konta | Zamyka dziury z S-02, a baza egzekwuje „bez usuwania”. |
| Generowanie w trakcie archiwizacji | Zadanie kończy się i zapisuje wynik | Zero zmian w kolejce i zadaniach; po przywróceniu partia jest kompletna. |
| Testy | pgTAP + Vitest + smoke + ręcznie na produkcji | Ryzyko leży w regułach bazy; to istniejący układ testów. |
| Agregacja | Funkcja SQL `topic_overview()` (`security invoker`) | Jedno zapytanie zamiast N+1, a „dziś” liczy baza tak jak RPC odpowiedzi. |

## Scope

**In scope:**
- `archived_at`, nowa wersja triggera, `revoke delete`, `topic_overview()` i pgTAP
- `PATCH /api/topics/[id]`, blokada w `loadTopic` i na 4 stronach tematu, kod `topic_archived`, smoke
- Wyspa `HomeTopics` na dashboardzie (liczniki, zmiana nazwy, dialog archiwizacji, sekcja archiwum)

**Out of scope:**
- Wykluczenie archiwum z serii, odznak i celu dziennego (zrobią to S-09 i S-10)
- Przerywanie trwającego generowania
- Widok tylko do odczytu
- Trwałe usuwanie
- Rozbicie licznika na zaległe i dzisiejsze
- Blokada RPC odpowiedzi w bazie

## Architecture / Approach

Kolejność to baza → serwer → UI.

- **Baza.** Migracja jest rozszerzająca. Trigger sam ustawia `archived_at = now()`, więc klient nie poda daty. `topic_overview()` grupuje fiszki i odpowiedzi po `topic_id` na istniejących indeksach.
- **Serwer.** `loadTopic` domyślnie odrzuca zarchiwizowany temat. Tylko trasa PATCH ładuje go z `allowArchived`.
- **UI.** Dashboard renderuje dane z SSR w wyspie React, która po udanym PATCH aktualizuje wiersz z odpowiedzi.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Baza | Archiwizacja, reguły zapisu, brak DELETE, `topic_overview()`, pgTAP | Istniejące testy kaskady i `rls_guard` używają DELETE i trzeba je przestawić na `reset role` lub wyjątek |
| 2. Serwer | Repozytorium, PATCH, blokada `topic_archived`, przekierowania stron, Vitest, smoke | Pominięta trasa lub strona bez blokady |
| 3. UI | Ekran główny z licznikami, zmianą nazwy, dialogiem i sekcją archiwum | Rozjazd licznika z „Ucz się (N)” |

**Prerequisites:** S-05 gotowe (`due_on`, `flashcard_answers`). Testy DB działają tylko w CI. `db push` wykonuje człowiek.
**Estimated effort:** ~3 sesje, po jednej na fazę.

## Open Risks & Assumptions

- Predykat „do powtórki” jest w dwóch miejscach (`getStudySession` i `topic_overview()`). Komentarz w migracji wiąże je ze sobą, a kontrolą jest ręczny test 3.5.
- Archiwizacja nie blokuje w bazie RPC odpowiedzi. Bezpośrednie wywołanie PostgREST może dopisać odpowiedź do ukrytego tematu, ale dotyczy to tylko harmonogramu tego samego konta.
- S-09 i S-10 muszą pamiętać o wykluczeniu `archived_at is not null` (roadmapa § S-08 Risk).

## Success Criteria (Summary)

- Ekran główny pokazuje dla każdego tematu liczbę do powtórki zgodną z sesją i datę ostatniej sesji.
- Zmiana nazwy, archiwizacja (z potwierdzeniem) i przywrócenie działają bez utraty fiszek i postępu.
- Baza odrzuca zmianę `scope_note` zatwierdzonego tematu i usunięcie tematu przez konto.
