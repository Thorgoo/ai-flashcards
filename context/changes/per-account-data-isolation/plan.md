# Per account data isolation Implementation Plan

## Overview

Fundament F-01 roadmapy (issue #4): powtarzalny sposób wprowadzania zmian schematu (migracje Supabase) oraz wzorzec „wiersz należy do konta, inne konta go nie widzą”, potwierdzony automatycznym testem dwóch kont i testem-strażnikiem, które uruchamia CI. Odblokowuje F-02 (liczniki limitów per konto) i S-02 (pierwsze tabele domenowe).

## Current State Analysis

- `supabase/` zawiera tylko `config.toml` i `.gitignore` — brak `migrations/`, `tests/`, `seed.sql` (choć `[db.seed]` wskazuje `./seed.sql`, `supabase/config.toml:65`). Postgres 17 (`supabase/config.toml:36`), Supabase CLI 2.117 w devDependencies.
- Aplikacja odpytuje bazę kluczem `anon` + JWT użytkownika (`src/lib/supabase.ts`), czyli każde zapytanie zalogowanego użytkownika działa jako rola `authenticated`; rola `anon` nie potrzebuje dostępu do tabel aplikacji.
- Logowanie e-mail jest wyłączone od S-01 (`supabase/config.toml`, `[auth.email] enable_signup = false`), więc test nie może zakładać kont przez API rejestracji.
- CI (`.github/workflows/ci.yml`, job `smoke`) już stawia lokalny Supabase (`supabase start -x …`) i zatrzymuje go w kroku `if: always()`.
- Lokalnie (maszyna autora) nie ma Dockera — `supabase start` / `supabase test db` da się uruchomić tylko w CI.
- Brak `context/foundation/lessons.md` i `docs/reference/contract-surfaces.md`.

## Desired End State

- `supabase/migrations/` istnieje z pierwszą migracją, która odbiera roli `anon` domyślne uprawnienia do przyszłych tabel, sekwencji i funkcji w schemacie `public`.
- `supabase/tests/database/` zawiera dwa testy pgTAP: test izolacji dwóch kont na tabeli tymczasowej oraz test-strażnik, który czerwienieje, gdy jakakolwiek tabela w `public` nie stosuje wzorca.
- CI uruchamia `supabase test db` przy każdym PR/pushu na `main`; job przechodzi.
- `supabase/AGENTS.md` (+ `supabase/CLAUDE.md`) opisuje regułę dla nowych tabel i odsyła do testu jako kanonicznego wzorca; README opisuje workflow migracji, w tym ręczne `db push` na produkcję.

Weryfikacja: zielony CI na PR oraz ręczne `npx supabase db push` po merge z potwierdzeniem w `npx supabase migration list`.

### Key Discoveries:

- `.github/workflows/ci.yml` — job `smoke` ma już działający lokalny Supabase; nowy krok testów bazy wpina się przed `supabase stop` bez nowego joba.
- `src/lib/supabase.ts` — jeden klient SSR z kluczem anon; brak klienta `service_role` w aplikacji (i tak ma pozostać).
- `context/foundation/infrastructure.md` (Operational Story → Approval) — destrukcyjne migracje i zmiany produkcji są decyzją człowieka; migracje mają być wstecznie kompatybilne (expand → contract).

## What We're NOT Doing

- Żadnych tabel domenowych ani tabeli `profiles` — tabela-przykład istnieje wyłącznie wewnątrz transakcji testowej; `topics`/`subtopics` dodaje S-02.
- Brak decyzji o strefie czasowej konta (Open Roadmap Question 3).
- Brak test runnera JS (Vitest itp.) — należy do F-02.
- Brak generowania typów (`supabase gen types`) — sens dopiero przy pierwszych tabelach (S-02).
- Brak automatycznego `db push` z CI — migracje na produkcję wdraża człowiek.
- Brak event triggera auto-włączającego RLS.
- Brak `seed.sql`.

## Implementation Approach

Wzorzec tabeli należącej do konta (stosowany od S-02 i zademonstrowany w teście):

- kolumna `user_id uuid not null default auth.uid() references auth.users (id) on delete cascade`,
- `alter table … enable row level security`,
- cztery polityki dla roli `authenticated` (select / insert / update / delete) z warunkiem `(select auth.uid()) = user_id` (`using` oraz `with check` dla insert/update).

Druga linia obrony: rola `anon` nie dostaje domyślnych uprawnień do nowych obiektów w `public`, więc nawet tabela z zapomnianym RLS nie jest czytelna bez logowania. Trzecia: test-strażnik w CI wykrywa tabelę bez RLS, bez `user_id` lub bez polityk.

## Critical Implementation Details

- **Default privileges muszą dotyczyć roli tworzącej obiekty.** Migracje i testy `supabase test db` tworzą obiekty jako `postgres`, więc migracja używa `alter default privileges for role postgres in schema public revoke … from anon`; tabela tymczasowa w teście (tworzona przez `postgres`) dziedziczy te uprawnienia, co pozwala testowi sprawdzić migrację.
- **Przełączanie konta w pgTAP:** `set local role authenticated` + `set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}'` (wartość `sub` czyta `auth.uid()`); przed przełączeniem na drugie konto `reset role`, aby wstawić dane jako `postgres` tylko tam, gdzie test tego wymaga.

## Phase 1: Migracje i baseline uprawnień

### Overview

Ustanawia katalog migracji i konwencję ich tworzenia, dokłada pierwszą migrację (baseline uprawnień `anon`) oraz skrypty npm i dokumentację workflow.

### Changes Required:

#### 1. Pierwsza migracja

**File**: `supabase/migrations/<timestamp>_revoke_anon_default_privileges.sql` (utworzony przez `npx supabase migration new revoke_anon_default_privileges`)

**Intent**: Odebrać roli `anon` domyślne uprawnienia do przyszłych tabel, sekwencji i funkcji w `public`, bo aplikacja zawsze odpytuje bazę jako `authenticated`, a dostęp anonimowy do danych nie jest przewidziany.

**Contract**: `alter default privileges for role postgres in schema public revoke all on tables / sequences / functions from anon`. Migracja nie usuwa żadnych istniejących obiektów (wstecznie kompatybilna).

#### 2. Skrypty npm

**File**: `package.json`

**Intent**: Jedno polecenie do testów bazy i jedno do odtworzenia lokalnej bazy z migracji.

**Contract**: `"db:test": "supabase test db"`, `"db:reset": "supabase db reset"`.

#### 3. Dokumentacja workflow migracji

**File**: `README.md`

**Intent**: Opisać, jak tworzyć i testować migracje lokalnie oraz jak (ręcznie) wdrażać je na produkcję.

**Contract**: Nowa sekcja „Database migrations”: `npx supabase migration new <name>`, `npm run db:reset`, `npm run db:test` (wymagają Dockera; CI uruchamia je zawsze), produkcja: jednorazowo `npx supabase link --project-ref <ref>`, potem `npx supabase db push` wykonywane przez człowieka przed merge kodu zależnego od schematu; migracje wstecznie kompatybilne (expand → contract), nigdy nie edytować migracji już wypchniętej. Usunąć zdanie, że projekt nie wymaga migracji (jeśli zostało).

### Success Criteria:

#### Automated Verification:

- Migration file exists under `supabase/migrations/` and lint passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- README section „Database migrations” reads correctly and names `db push` as a human step

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Testy izolacji w pgTAP + CI

### Overview

Dwa testy pgTAP dowodzą wzorca i pilnują go na przyszłość; CI uruchamia je na lokalnym Supabase.

### Changes Required:

#### 1. Test izolacji dwóch kont

**File**: `supabase/tests/database/account_isolation.test.sql`

**Intent**: Kanoniczna demonstracja wzorca: w transakcji utworzyć tabelę `public.isolation_probe` ze wzorcem z „Implementation Approach”, wstawić dwóch użytkowników do `auth.users` i udowodnić, że konto B nie widzi ani nie modyfikuje danych konta A, a `anon` nie ma dostępu. Każdy kolejny wycinek dopisuje tu analogiczne asercje dla swoich tabel.

**Contract**: `begin; create extension if not exists pgtap with schema extensions; select plan(N); … select * from finish(); rollback;`. Asercje (minimum):
- konto A wstawia wiersz bez podawania `user_id` → wiersz dostaje `user_id = A` (default `auth.uid()`),
- konto A widzi 1 wiersz; konto B widzi 0 wierszy,
- konto B: `update` i `delete` wiersza A wykonane przez `lives_ok` nie zgłaszają błędu, a następnie konto A nadal widzi swój wiersz z oryginalną wartością (Postgres nie pozwala na data-modifying CTE w podzapytaniu, więc liczba dotkniętych wierszy nie jest asercją),
- konto B: `insert` z jawnym `user_id = A` → błąd naruszenia polityki (`throws_ok`, kod `42501`),
- rola `anon`: `select` z tabeli → `permission denied` (`throws_ok`, kod `42501`) — weryfikuje migrację z fazy 1.

#### 2. Test-strażnik

**File**: `supabase/tests/database/rls_guard.test.sql`

**Intent**: Uniemożliwić dodanie tabeli w `public` bez wzorca — CI czerwienieje z nazwą tabeli.

**Contract**: Dla każdej tabeli zwykłej i partycjonowanej w schemacie `public`, poza jawną (początkowo pustą) listą wyjątków zdefiniowaną w pliku z komentarzem-uzasadnieniem: musi mieć włączone RLS, kolumnę `user_id` i co najmniej jedną politykę. Asercja `is_empty` na zapytaniu zwracającym naruszające tabele z powodem. Przy braku tabel test przechodzi.

#### 3. CI

**File**: `.github/workflows/ci.yml`

**Intent**: Uruchamiać testy bazy przy każdym PR, na Supabase już stawianym w jobie `smoke`.

**Contract**: Nowy krok `Database tests` (`run: supabase test db`) bezpośrednio po `Start local Supabase`, przed buildem; krok `supabase stop` pozostaje `if: always()`. Atrapy `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID/SECRET` przenieść z `env:` kroku startowego na `env:` całego joba `smoke`, bo każde polecenie CLI czyta `supabase/config.toml` z `env(...)`.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- CI job `smoke` passes on the PR, including the `Database tests` step with both test files reported as ok

#### Manual Verification:

- A temporary commit that removes the select policy's `user_id` condition makes the isolation test fail in CI; the commit is reverted before merge

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Konwencja dla agentów

### Overview

Lokalny przewodnik obok kodu bazy, żeby każdy kolejny wycinek (człowiek lub agent) stosował wzorzec i rozszerzał test.

### Changes Required:

#### 1. Przewodnik katalogowy

**File**: `supabase/AGENTS.md`

**Intent**: Krótki (120–250 słów) przewodnik dla pracy w `supabase/`: reguła dla nowych tabel, gdzie jest kanoniczny wzorzec, jak rozszerzać testy, zasady migracji.

**Contract**: Treść obejmuje: każda tabela w `public` należy do konta i stosuje wzorzec z `@tests/database/account_isolation.test.sql` (bez wklejania SQL); nowa tabela = dopisanie asercji „B nie widzi A” do testu izolacji; wyjątek od strażnika tylko z uzasadnieniem w `rls_guard.test.sql`; migracje przez `npx supabase migration new`, nigdy nie edytować wypchniętej; `db push` na produkcję wykonuje człowiek; lokalne testy wymagają Dockera, CI uruchamia je zawsze.

#### 2. Nakładka Claude Code

**File**: `supabase/CLAUDE.md`

**Intent**: Claude Code ładuje `CLAUDE.md`, nie `AGENTS.md` — jedno źródło prawdy przez import.

**Contract**: Jedna linia `@AGENTS.md`.

### Success Criteria:

#### Automated Verification:

- Formatting check passes: `npx prettier --check supabase/AGENTS.md`

#### Manual Verification:

- `supabase/AGENTS.md` has 120–250 words and references the test files by path instead of pasting SQL

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- Brak testów jednostkowych JS — zmiana dotyczy wyłącznie bazy.

### Integration Tests:

- `account_isolation.test.sql` — izolacja dwóch kont dla select/insert/update/delete i brak dostępu `anon`.
- `rls_guard.test.sql` — każda tabela w `public` stosuje wzorzec.

### Manual Testing Steps:

1. Otworzyć PR i sprawdzić w logach CI krok `Database tests` (oba pliki `ok`).
2. Po merge: `npx supabase link --project-ref <ref>` (raz), `npx supabase db push`, `npx supabase migration list` — migracja widoczna lokalnie i zdalnie.
3. Zalogować się na produkcji przez GitHub — logowanie i `/dashboard` działają jak wcześniej.

## Performance Considerations

Polityki używają `(select auth.uid())` zamiast gołego `auth.uid()`, żeby Postgres liczył wartość raz na zapytanie, a nie per wiersz; tabele domenowe w S-02+ powinny mieć indeks na `user_id`.

## Migration Notes

Migracja jest addytywna (zmienia tylko domyślne uprawnienia dla przyszłych obiektów) — rollback nie jest potrzebny; w razie potrzeby odwrotna migracja przywraca `grant` dla `anon`.

## References

- Roadmap item: `context/foundation/roadmap.md` → F-01 (issue #4)
- Supabase client: `src/lib/supabase.ts`
- CI: `.github/workflows/ci.yml`
- Infra constraints: `context/foundation/infrastructure.md` (Operational Story)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Migracje i baseline uprawnień

#### Automated

- [x] 1.1 Migration file exists under `supabase/migrations/` and lint passes: `npm run lint` — 5034728
- [x] 1.2 Build passes: `npm run build` — 5034728

#### Manual

- [x] 1.3 README section „Database migrations” reads correctly and names `db push` as a human step — 5034728

### Phase 2: Testy izolacji w pgTAP + CI

#### Automated

- [x] 2.1 Lint passes: `npm run lint`
- [ ] 2.2 CI job `smoke` passes on the PR, including the `Database tests` step with both test files reported as ok

#### Manual

- [ ] 2.3 A temporary commit that removes the select policy's `user_id` condition makes the isolation test fail in CI; the commit is reverted before merge

### Phase 3: Konwencja dla agentów

#### Automated

- [ ] 3.1 Formatting check passes: `npx prettier --check supabase/AGENTS.md`

#### Manual

- [ ] 3.2 `supabase/AGENTS.md` has 120–250 words and references the test files by path instead of pasting SQL
