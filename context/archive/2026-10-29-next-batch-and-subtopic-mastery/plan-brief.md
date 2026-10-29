# S-07: Opanowanie podtematów i kolejna partia — Plan Brief

> Full plan: `context/changes/next-batch-and-subtopic-mastery/plan.md`

## What & Why

Użytkownik widzi, które podtematy już opanował, a po opanowaniu ≥ 80% bieżącej partii generuje przyciskiem kolejną partię 10 fiszek — tylko z nieopanowanych podtematów, z większą liczbą fiszek dla słabszych. To domyka pętlę z PRD (FR-019, FR-020, US-01): diagnoza → fiszki → nauka → opanowanie → kolejna partia.

## Starting Point

S-04 dał partię nr 1 (claim przed AI, zapis jednym RPC, `waitUntil` + polling) w tabeli `flashcard_batches`, która ma już `seq`, ale funkcje i odczyt stanu znają tylko `seq = 1`. S-06 dał opanowanie fiszki (`stage = 'mastered'`). Sesja nauki już czyta fiszki wszystkich partii.

## Desired End State

Strona tematu pokazuje przy podtemacie „Opanowane X/Y” i „Opanowany”; strona fiszek pokazuje wszystkie partie (najnowsza na górze, starsze zwijane), postęp bieżącej partii („6/10 — kolejna partia od 8”) i przycisk „Wygeneruj kolejną partię”. Partia 2+ omija opanowane podtematy, nie powtarza istniejących pytań i zachowuje się przy przeładowaniu jak partia 1.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Zakres progu 80% | Cała najnowsza gotowa partia, `opanowane × 5 ≥ istniejące × 4` | Pasuje do partii mieszanej z S-04 i roadmapy; jeden licznik |
| Skład kolejnej partii | 10 fiszek na wszystkie nieopanowane podtematy regułą `batchAllocation` (każdy ≥ 1) | Reużywa sprawdzonej funkcji i walidacji; nic nie utyka bez fiszek |
| „Najsłabszy” dla partii 2+ | Odsetek nieopanowanych fiszek podtematu; remis → wynik quizu → pozycja | Ten sam wskaźnik, który użytkownik widzi; bez zapytań do dziennika |
| Podtemat bez fiszek | Nieopanowany (opanowany = ≥ 1 fiszka i wszystkie opanowane) | Usunięcie nigdy nie „opanowuje” tematu |
| Usunięte fiszki w progu | Mianownik = istniejące fiszki partii; pusta partia = próg spełniony | Usunięcie nie blokuje kolejnej partii (6/7 → tak, 5/7 → nie) |
| Powtórzenia | Fronty istniejących fiszek (≤ 30 na podtemat) w prompcie jako dane | Tanio i skutecznie; bez odrzucania kosztującego limit |
| Ekrany | Opanowanie na stronie tematu; postęp i przycisk na stronie fiszek | Opanowanie tam, gdzie patrzy się na temat; generowanie tam, gdzie już jest |
| Widok partii | Wszystkie partie, najnowsza rozwinięta, starsze zwijane | Można usunąć złą fiszkę z każdej partii (FR-012) |
| Trwałość (F1) | Zostaje `waitUntil` + polling; pomiar czasu partii 2 | Zero nowej infrastruktury; Queue dopiero przy stratach |
| Idempotencja | Klient wysyła `seq` tworzonej partii; `seq ≤ ostatnia gotowa` → `batch_exists` przed AI | Ponowienie i podwójny klik nie zużywają limitu |

Przykład: A 4/4, B 1/3, C 0/2, D 0 fiszek → A pominięty, kolejność D, C, B → `batchAllocation([0, 0, 33])` = D 4, C 3, B 3.

## Scope

**In scope:**
- Migracja z `claim/release/create_next_flashcard_batch` (próg, numeracja, `topic_mastered` pod blokadą) + pgTAP
- `mastery.ts` (opanowanie, postęp, kolejność słabości), zadanie `flashcards-next`, alias fixtury, stan wszystkich partii, Vitest
- `POST /flashcards/next`, kody `next_batch_locked` / `topic_mastered`, smoke
- UI strony fiszek i strony tematu, dostosowanie stron quizu i nauki

**Out of scope:** Queue/Durable Object, próg per podtemat, słabość z dziennika odpowiedzi, twarde odrzucanie duplikatów, zmiana rozmiaru partii/modelu/limitów, odznaki (S-10), ekran główny (S-08), zmiany starych funkcji partii 1, e2e w przeglądarce.

## Architecture / Approach

`POST /flashcards/next { seq }`: sesja → temat → stan i quiz → kontrole (`next_batch_locked`, `batch_exists`, `topic_mastered`, `batch_generating`) przed AI → `claim_next_flashcard_batch` (powtarza je pod blokadą tematu) → `nextBatchSubtopics` + istniejące fronty → AI `flashcards-next` (schemat i kwoty z S-04) → `create_next_flashcard_batch` z tokenem claimu; błąd → `release…`. Opanowanie liczone z `flashcards` w `mastery.ts` i lustrzanie w SQL.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Baza kolejnych partii | Trzy funkcje N+1 z progiem i `topic_mastered`, pgTAP | Testy bazy tylko w CI (brak Dockera lokalnie) |
| 2. Domena i zadanie AI | `mastery.ts`, prompt z istniejącymi pytaniami, stan wszystkich partii, Vitest | Rozjazd reguł SQL ↔ TS |
| 3. API | `POST /flashcards/next`, nowy kształt stanu, smoke | Przesunięcie licznika generowań w smoke |
| 4. UI | Partie, postęp, przycisk, opanowanie na stronie tematu, pomiar | Czas partii 2 > 30 s (F1) |

**Prerequisites:** S-06 zarchiwizowane i na produkcji (jest); `db push` migracji fazy 1 przed wdrożeniem fazy 3 (krok człowieka).
**Estimated effort:** ~4 sesje, po jednej na fazę.

## Open Risks & Assumptions

- Dłuższy prompt partii 2+ może wydłużyć generowanie ponad ~30 s `waitUntil` — zamknięta karta zużyje limit bez zapisu (claim wygasa po 120 s); mierzone w kryterium 4.6.
- Próg można „przeskoczyć”, usuwając nieopanowane fiszki — zaakceptowane (alternatywa blokowała użytkownika).
- Lista frontów nie łapie parafraz — możliwe tematycznie podobne fiszki w kolejnych partiach.
- Smoke ustawia opanowanie kluczem serwisowym (przygotowanie stanu jak `makeDue`), nie przez ocenę AI.

## Success Criteria (Summary)

- Przy ≥ 80% opanowanych fiszek bieżącej partii użytkownik generuje partię 2 z samych nieopanowanych podtematów, bez powtórek pytań; poniżej progu przycisk jest wyłączony z wyjaśnieniem.
- Strona tematu poprawnie pokazuje „Opanowane X/Y”, „Opanowany” i „Temat opanowany”; podtemat bez fiszek nie jest opanowany.
- Ponowienie, podwójny klik i przeładowanie w trakcie dają jedną partię i jedno zużyte generowanie.
