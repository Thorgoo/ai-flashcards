# Follow-ups z impl-review (2026-10-25)

- **F1 (zaakceptowane ryzyko)** — `waitUntil` daje ~30 s po rozłączeniu, generowanie fiszek trwa 27–35 s. Obserwuj w `ai_calls` wywołania `flashcards` ze statusem `ok` bez partii `ready` (utracona praca). Wróć do tematu w S-07 (kolejne partie) — wtedy rozważ Queue/Durable Object.
- **F5 (pomiar po wdrożeniu)** — po zmianie promptu (wyjaśnienia 400–700 znaków) zmierz `latency_ms` / `output_tokens` jednej partii na produkcji. Jeśli czas przekroczy ~30 s częściej niż dotąd, skróć zakres albo przyspiesz decyzję z F1.
