---
change_id: first-weak-subtopic-batch
title: Pierwsza partia fiszek ze słabych podtematów (S-04)
status: impl_reviewed
created: 2026-10-24
updated: 2026-10-25
archived_at: null
---

## Notes

S-04: partia 10 fiszek z najsłabszych podtematów (podtemat ze 100% też dostaje mniejszą partię), kształt zależny od typu treści, rozszerzone wyjaśnienie „czytaj więcej” zapisane z fiszką, przegląd i usuwanie niechcianych fiszek

Testy ręczne fazy 4 (produkcja, 2026-10-25, po merge PR #28): pomiar `ai_calls` — temat słownikowy 26,8 s / 2451 tokenów wyjścia, temat pojęciowy (przeładowany w trakcie) 35,0 s / 4816 tokenów; oba `ok`, 2 wywołania na 2 partie. 4.9 sprawdzone na szkicu „TEST S-04 (do usunięcia w S-08)” — `Confirmation` w edytorze obsługuje „Wygeneruj ponownie” i „Zatwierdź listę” (usuwanie podtematu nigdy nie miało potwierdzenia). Szkic zostaje do S-08.
