# Temat z zatwierdzonymi podtematami — Plan Brief

> Full plan: `context/changes/topic-with-confirmed-subtopics/plan.md`

## What & Why

Wycinek S-02. Użytkownik tworzy temat z opcjonalną notatką o zakresie. AI proponuje 4–8 podtematów, każdy z typem treści (pojęciowy albo językowy). Użytkownik poprawia tę listę i zatwierdza ją. Błędy podtematów dziedziczy cała reszta produktu (quiz, fiszki), dlatego edycja przed zablokowaniem jest częścią wycinka, a nie dodatkiem.

## Starting Point

Gotowe są fundamenty F-01 (wzorzec „wiersz należy do konta” i strażnik RLS) i F-02 (`getAi().call` z limitami, walidacją zod i trybem fake). Nie ma jeszcze żadnej tabeli domenowej, zadania AI ani interaktywnego ekranu. `/dashboard` to placeholder, a smoke testuje tylko przekierowania bez sesji.

## Desired End State

Na `/dashboard` widać listę tematów i przycisk „Nowy temat”. Po utworzeniu tematu ekran pokazuje postęp generowania, a potem edytowalną listę 2–10 podtematów. Można zmienić nazwę, typ, dodać i usunąć podtemat albo wygenerować listę od nowa. „Zatwierdź” blokuje listę na stałe, w UI i w bazie. W CI test na sesji testowej przechodzi cały przepływ, łącznie z wyczerpaniem dziennego limitu.

## Key Decisions Made

| Decision           | Choice                                                     | Why (1 sentence)                                                           |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| Zatwierdzenie      | Zatwierdzenie = nieodwracalna blokada                      | Jeden punkt bez powrotu; S-03 nie musi obsługiwać zmian listy.             |
| Wygeneruj ponownie | Zastępuje całą listę, po potwierdzeniu w UI                | Prosty, przewidywalny model; atomowość FR-028 bez dodatkowej pracy.        |
| Rozmiar listy      | AI 4–8, ręczna edycja 2–10                                 | Przy quizie z 10 pytaniami każdy podtemat dostaje 1–5 pytań.               |
| Szkic              | W bazie (`topics.status = draft`)                          | Odświeżenie strony nie gubi listy ani zużytego wywołania AI.               |
| UI                 | Strony SSR Astro + wyspy React z API JSON                  | Ciągły wskaźnik pracy i ponowienie bez przeładowania strony.               |
| Wybór tematu       | Prosta lista na `/dashboard`                               | Jedno miejsce, które S-08 rozbuduje.                                       |
| Test E2E           | Smoke na API z sesją testową (admin API + `@supabase/ssr`) | Bez nowych zależności; sprawdza `quota.ts` na prawdziwym PostgREST.        |
| Model              | Domyślny Sonnet 5.5, effort `low`                          | Jakość rozpoznania typu treści przy krótkim czasie.                        |
| Integralność       | Złożony FK `(topic_id, user_id)`                           | Sprawdzenie FK omija RLS; bez tego konto B dopięłoby podtemat do tematu A. |
| Blokada            | RLS `draft` na podtematach + trigger statusu               | Zablokowanej listy nie zmieni żaden klient, nie tylko UI.                  |

## Scope

**In scope:**

- tabele `topics` i `subtopics`, `replace_subtopics`, trigger zatwierdzenia, pgTAP;
- zadanie AI `subtopics` z fixture;
- endpointy `/api/topics/...` i ochrona `/topics`;
- `smoke:topics` w CI;
- `/dashboard`, `/topics/new`, `/topics/[id]`;
- `AGENTS.md` modułu.

**Out of scope:**

- quiz (S-03);
- zmiana nazwy i archiwizacja tematu, liczniki na liście (S-08);
- zmiana kolejności podtematów;
- regeneracja z zachowaniem poprawek;
- Playwright;
- obsługa rozłączenia w trakcie generowania;
- usuwanie tematów.

## Architecture / Approach

Inwarianty pilnuje baza: RLS, złożony FK, blokada `draft`, trigger przejścia statusu i atomowe RPC `replace_subtopics`. Moduł `src/lib/topics/` ma walidację (zod), zadanie AI i repozytorium, które mapuje błędy Postgresa na kody domenowe w kształcie `{ error: { code, message, retryable } }`. Endpointy sprawdzają status tematu przed wywołaniem AI i po każdej mutacji zwracają pełny stan. `TopicEditor` (React) renderuje wyłącznie stan z odpowiedzi API. Generowanie startuje raz po utworzeniu tematu, sterowane parametrem `?generate=1`, który jest od razu usuwany z adresu.

## Phases at a Glance

| Phase               | What it delivers                                 | Key risk                                                  |
| ------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| 1. Schemat bazy     | Tabele, blokada, `replace_subtopics`, pgTAP      | Polityki z warunkiem `draft` mogą nie przejść `rls_guard` |
| 2. Zadanie AI i API | `src/lib/topics/`, endpointy, middleware, Vitest | Prompt źle rozpoznaje typ treści                          |
| 3. Smoke E2E        | `smoke:topics` w CI z sesją i limitem 429        | Budowanie cookie sesji z `@supabase/ssr` poza aplikacją   |
| 4. UI               | Lista, nowy temat, edytor z postępem i błędami   | Pierwszy wzorzec wyspy React z API w repo                 |

**Prerequisites:** S-01 i F-02 są done. Migracja trafia na produkcję (`db push`, krok człowieka) przed merge'em.
**Estimated effort:** ~3–4 sesje, 4 fazy.

## Open Risks & Assumptions

- Równoczesne „dodaj” i „zatwierdź” może zostawić jeden podtemat dodany po zatwierdzeniu. Ryzyko przyjęte, bez dodatkowych blokad.
- Przerwane w trakcie generowanie zużywa limit (ryzyko odziedziczone z F-02).
- Zakładamy, że lokalny provider email pozwala logować hasłem użytkownika utworzonego przez admin API. Weryfikacja w fazie 3.

## Success Criteria (Summary)

- Użytkownik tworzy temat, widzi postęp generowania, poprawia listę i zatwierdza ją. Zatwierdzonej listy nie da się już zmienić.
- Drugie konto nie widzi ani nie zmienia cudzych tematów, co potwierdzają pgTAP i smoke.
- 21. generowanie w ciągu dnia daje czytelny błąd limitu (429), sprawdzony w CI na prawdziwym PostgREST.
