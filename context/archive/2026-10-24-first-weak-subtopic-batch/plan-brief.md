# S-04: Pierwsza partia fiszek ze słabych podtematów — Plan Brief

> Full plan: `context/changes/first-weak-subtopic-batch/plan.md`
> Research: `context/changes/first-weak-subtopic-batch/research.md`

## What & Why

Po quizie diagnostycznym użytkownik dostaje 10 fiszek wygenerowanych przez AI z podtematów, w których wypadł najsłabiej, z wyjaśnieniem „czytaj więcej” zapisanym razem z fiszką, i może usunąć złe fiszki. To gwiazda przewodnia roadmapy: dowodzi tezy „automat zamiast ręcznego robienia fiszek, celowany w to, czego nie umiem”.

## Starting Point

S-03 zostawia ukończony quiz z wynikiem per podtemat (`quiz_results` + `percent`) i sprawdzony wzorzec długiego generowania: claim przed AI, zapis jednym RPC, `waitUntil` + polling. Dla fiszek nie istnieje jeszcze nic — tabela, zadanie AI, endpoint ani ekran.

## Desired End State

Ekran wyniku quizu i strona tematu mają „Wygeneruj fiszki”. Strona `/topics/[id]/flashcards` generuje partię nr 1 jednym wywołaniem AI, z widocznym postępem i odpornością na przeładowanie, pokazuje 10 fiszek pogrupowanych po podtematach (przód, 4 opcje, wzorcowa odpowiedź, przykład dla słownikowych, „czytaj więcej”) i pozwala trwale usunąć fiszkę po potwierdzeniu.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Rozdział 10 fiszek | Każdy podtemat 1, reszta proporcjonalnie do (100 − %) największymi resztami, remis → `position`; wszystkie 100% → równo | Spełnia FR-020 (100% dostaje mniej, nie zero) i celuje w najsłabsze; deterministyczne (A0 B33 C50 D100 → 4/3/2/1) | Plan |
| Fiszka słownikowa — odpowiedź otwarta | Znaczenie + własne zdanie; wzorzec = tłumaczenie + przykładowe zdanie | Mieści się w 2–3 zdaniach z FR-011 i sprawdza użycie słowa | Plan |
| Model partii | Tabela `flashcard_batches` (seq, status, claimed_at) + `flashcards` | Claim ma naturalny wiersz; S-07 doda partię nr 2 bez zmiany schematu | Plan |
| Usuwanie | Twarde, po potwierdzeniu | Brak filtrowania „usuniętych” w S-05–S-07; licznik historyczny S-10 trzyma własny stan | Plan |
| Budżet generowania | 1 wywołanie Sonnet 5.5, `maxTokens` 8000, timeout 90 s, TTL claimu 120 s | Jedna pozycja limitu, zapis „wszystko albo nic” bez zmian wzorca | Plan |
| Wejście w UI | CTA na wyniku quizu i stronie tematu → nowa strona z `?start=1` | Wzorzec quizu; generowanie zużywa limit, więc zawsze świadome | Plan |
| Wejście rankingu | `quiz_results`, lista podtematów z `subtopics`, brak wyniku = 0% | `quiz_results` gubi podtemat bez pytań | Research |
| Zapis i odporność | Claim + RPC w jednej transakcji + `waitUntil` + polling | Wzorzec po incydencie produkcyjnym S-03 F1 | Research |
| Typy treści | `conceptual` / `vocabulary` wg kształtów FR-005 | Tak nazywa je kod i baza | Research |

## Scope

**In scope:** migracja z dwiema tabelami i trzema RPC, reguła rozdziału, zadanie AI z fixture, repozytorium, GET/POST/DELETE, kody błędów, smoke, strona fiszek z „czytaj więcej” i usuwaniem, CTA, wyjęcie `Confirmation`, komponent collapsible.

**Out of scope:** kolejne partie i próg 80% (S-07), sesja nauki (S-05), ocena AI (S-06), ponowne generowanie pierwszej partii, edycja fiszek, miękkie usuwanie, streaming/`AbortSignal`, zmiany w `src/lib/ai/*`, claim dla podtematów, Playwright.

## Architecture / Approach

Kopia wzorca quizu warstwa po warstwie. Endpoint POST sprawdza zatwierdzenie tematu i ukończenie quizu, liczy rozdział z wyników, zajmuje partię (`claim_flashcard_batch`), woła AI z kwotami w tagach promptu, waliduje zod (`superRefine`: kwoty, unikalne opcje, `example` tylko dla `vocabulary`), tasuje opcje i zapisuje całość przez `create_flashcard_batch`; przy błędzie zwalnia claim. `authenticated` czyta obie tabele i może tylko usuwać fiszki.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Baza fiszek | Tabele, RPC claim/release/create, pgTAP i izolacja | Testy bazy tylko w CI (brak Dockera lokalnie) |
| 2. Domena i zadanie AI | `batchAllocation`, schemat, prompt, wiersze, fixture, repozytorium, Vitest | Rozjazd limitów zod ↔ SQL i TTL TS ↔ SQL |
| 3. API | GET/POST/DELETE, kody błędów, smoke | Przesunięcie licznika generowań w smoke |
| 4. UI | Strona fiszek, „czytaj więcej”, usuwanie, CTA, pomiar na podglądzie | Realny czas generowania > 75 s |

**Prerequisites:** S-03 zmergowane (jest); dostęp do `db push` produkcji; podgląd z prawdziwym kluczem AI do pomiaru.
**Estimated effort:** ~3–4 sesje w 4 fazach.

## Open Risks & Assumptions

- Szacunek 4–5 tys. tokenów i czas < 75 s nie są zmierzone — weryfikuje kryterium 4.3; przy przekroczeniu wracamy do budżetu przed merge.
- `waitUntil` (~30 s po rozłączeniu) może nie wystarczyć przy zamknięciu karty — zużyty limit bez zapisu; claim wygasa po 120 s.
- Plan Workers (Free 10 ms CPU) nieznany z repo — możliwe 1102; mitygacja: Workers Paid przy pierwszym wystąpieniu.
- Przy 10 podtematach rozdział zawsze daje po 1 — ważenie słabości nie działa; zaakceptowane.

## Success Criteria (Summary)

- Po quizie użytkownik dostaje 10 sensownych fiszek z podziałem zgodnym z regułą, także dla tematu językowego.
- Przeładowanie w trakcie nie zużywa drugiego generowania; drugie generowanie pierwszej partii jest odrzucane.
- Usunięta fiszka znika trwale; inne konto nie widzi ani nie usuwa cudzych fiszek.
