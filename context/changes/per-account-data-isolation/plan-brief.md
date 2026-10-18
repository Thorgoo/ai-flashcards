# Per account data isolation — Plan Brief

> Full plan: `context/changes/per-account-data-isolation/plan.md`

## What & Why

Fundament F-01 (issue #4): zanim powstanie pierwsza tabela domenowa, projekt dostaje powtarzalny sposób zmian schematu i wzorzec „wiersz należy do konta, inne konta go nie widzą”, udowodniony testem dwóch kont. Dopisywanie izolacji do istniejących tabel później jest łatwe do przeoczenia — dlatego idzie pierwsza (cel roadmapy: jakość).

## Starting Point

`supabase/` ma tylko `config.toml` — bez migracji i testów. Aplikacja odpytuje bazę kluczem anon + JWT użytkownika (rola `authenticated`). CI już stawia lokalny Supabase w jobie `smoke`. Lokalnie nie ma Dockera, więc testy bazy weryfikuje CI.

## Desired End State

Jest katalog `supabase/migrations/` z pierwszą migracją (rola `anon` bez domyślnych uprawnień w `public`), dwa testy pgTAP uruchamiane w CI (izolacja dwóch kont + strażnik RLS dla każdej tabeli w `public`) oraz przewodnik `supabase/AGENTS.md`, który każe każdemu kolejnemu wycinkowi stosować wzorzec i rozszerzać test.

## Key Decisions Made

| Decision                    | Choice                                  | Why (1 sentence)                                                                      |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| Test izolacji               | pgTAP (`supabase test db`)              | Natywne narzędzie Supabase, zero nowych zależności, działa na Supabase już stawianym w CI. |
| Tabela-przykład             | Tylko w transakcji testu                | Zero martwego schematu na produkcji; realne tabele dochodzą w S-02.                   |
| Egzekwowanie wzorca         | Test-strażnik w pgTAP                   | CI czerwienieje z nazwą tabeli bez RLS / `user_id` / polityk.                         |
| Migracje na produkcję       | Ręcznie `npx supabase db push`          | Zgodne z zasadą zatwierdzania przez człowieka; brak sekretów bazy w CI.               |
| Druga linia obrony          | `anon` bez domyślnych uprawnień         | Tabela z zapomnianym RLS i tak nie jest czytelna bez logowania.                       |

## Scope

**In scope:**
- Pierwsza migracja (default privileges `anon`), skrypty `db:test` / `db:reset`
- Testy pgTAP: izolacja dwóch kont, strażnik RLS
- Krok `Database tests` w CI
- `supabase/AGENTS.md` + `supabase/CLAUDE.md`, sekcja README o migracjach

**Out of scope:**
- Tabele domenowe, `profiles`, strefa czasowa konta
- Test runner JS (F-02), generowanie typów (S-02)
- Automatyczny `db push` z CI, event trigger na RLS, `seed.sql`

## Architecture / Approach

Wzorzec: `user_id uuid not null default auth.uid() references auth.users on delete cascade` + RLS + 4 polityki dla `authenticated` z `(select auth.uid()) = user_id`. Test tworzy tabelę `isolation_probe` w transakcji, wstawia dwóch użytkowników do `auth.users`, przełącza konta przez `set local role authenticated` + `request.jwt.claims` i sprawdza select/insert/update/delete oraz brak dostępu `anon`; całość jest wycofywana (`rollback`). Strażnik iteruje po tabelach `public` (z jawną listą wyjątków).

## Phases at a Glance

| Phase                              | What it delivers                                        | Key risk                                                     |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| 1. Migracje i baseline uprawnień   | Katalog migracji, migracja `anon`, skrypty, README      | Default privileges ustawione dla złej roli (musi być `postgres`) |
| 2. Testy izolacji w pgTAP + CI     | 2 testy pgTAP + krok CI                                 | Brak Dockera lokalnie — pierwsza weryfikacja dopiero w CI    |
| 3. Konwencja dla agentów           | `supabase/AGENTS.md` + `CLAUDE.md`                      | Przewodnik zbyt długi lub wklejający SQL                     |

**Prerequisites:** S-01 zmergowane (jest); dostęp do projektu Supabase do `db push` po merge.
**Estimated effort:** ~1 sesja, 3 małe fazy.

## Open Risks & Assumptions

- Zakładamy, że `supabase test db` w CI działa z obecnym zestawem wyłączonych usług (`-x …`) — pgTAP potrzebuje tylko bazy.
- Po merge trzeba pamiętać o ręcznym `db push`; migracja F-01 jest nieszkodliwa, jeśli trafi z opóźnieniem.

## Success Criteria (Summary)

- CI na PR przechodzi z krokiem `Database tests` (oba testy ok).
- Udowodnione: konto B nie widzi ani nie modyfikuje danych konta A; `anon` nie ma dostępu.
- Następny wycinek (S-02) wie z `supabase/AGENTS.md`, jak dodać tabelę i rozszerzyć test.
