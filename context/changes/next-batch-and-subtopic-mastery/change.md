---
change_id: next-batch-and-subtopic-mastery
title: Next batch and subtopic mastery
status: implemented
created: 2026-10-29
updated: 2026-10-29
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

### Testy ręczne na produkcji (2026-10-29, temat „TEST S-07 (do usunięcia w S-08)”)

- Pomiar (4.6): partia 2 (`flashcards-next`) — `latency_ms` 32 654, `output_tokens` 4 589, `input_tokens` 2 282; partia 1 tego tematu — 36 024 ms. Dłuższy prompt nie wydłużył generowania.
- 4.4 sprawdzone w ramce 390 px w Chrome (okno nie dało się zwęzić), nie na fizycznym telefonie.
- **Follow-up F1 (potwierdzone na produkcji, 4.5 niezaliczone):** przeładowanie strony w trakcie generowania partii 2 zgubiło pracę — wiersz `ai_calls` zostaje `pending`, zużyte 1 generowanie, brak partii; po 120 s claim wygasa i przycisk znów jest aktywny. Przyczyna: `waitUntil` daje ~30 s po rozłączeniu, a generowanie trwa 33–36 s (dotyczy też partii 1). Część progowa 4.5 działa (7/10 wyłączony z wyjaśnieniem, 8/10 aktywny). Naprawa (Queue / Durable Object) jako osobna zmiana.
