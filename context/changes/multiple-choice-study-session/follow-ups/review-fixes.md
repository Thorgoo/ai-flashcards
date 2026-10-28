# Follow-ups z impl-review (2026-10-28)

- **F4 (odłożone do S-07)** — `getStudySession` (`src/lib/topics/study-repository.ts`) zwraca wszystkie zaległe fiszki z pełnymi tekstami bez limitu, a strona tematu (`src/pages/topics/[id].astro`) wczytuje karty partii tylko po to, by odczytać `batch.status`. Przy jednej partii to ≤ 10 fiszek; gdy S-07 doda kolejne partie, dodaj limit sesji i zapytanie wyłącznie o status partii.
