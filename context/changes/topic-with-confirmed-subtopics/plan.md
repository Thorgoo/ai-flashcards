# Temat z zatwierdzonymi podtematami — plan implementacji

## Overview

Wycinek S-02 roadmapy. Zalogowany użytkownik tworzy temat, opcjonalnie z notatką o zakresie i poziomie. AI generuje z niego 4–8 podtematów, każdy z rozpoznanym typem treści (pojęciowy albo językowy). Użytkownik może tę listę edytować: zmienić nazwę, poprawić typ, usunąć podtemat, dodać własny albo wygenerować całą listę od nowa. Potem ją zatwierdza, co ją nieodwracalnie blokuje. Temat wybiera z listy na `/dashboard`.

To pierwszy wycinek, który ma tabele domenowe i realne wywołanie AI. Ćwiczy oba fundamenty: F-01 (wzorzec konta i RLS) oraz F-02 (`getAi`, limity, tryb fake).

## Current State Analysis

- **Baza.** Są tylko `ai_calls`, `begin_ai_call` i `finish_ai_call` z F-02. Wzorzec „wiersz należy do konta” jest opisany w `supabase/AGENTS.md:5` i pokazany na `isolation_probe` (`supabase/tests/database/account_isolation.test.sql:16-31`). `rls_guard.test.sql` oblewa CI dla każdej tabeli w `public`, która łamie ten wzorzec.
- **Uprawnienia.** Domyślne uprawnienia dają `authenticated` prawo wykonywania nowych funkcji w `public`, a `anon` i `PUBLIC` nie dostają nic (`supabase/migrations/20261017065708_revoke_anon_default_privileges.sql`).
- **AI.** Jedyna ścieżka wywołania to `getAi(supabase, user).call(...)` (`src/lib/ai/index.ts:18`). Zasady opisuje `src/lib/ai/AGENTS.md`: schemat zod, fixture w `src/lib/ai/fixtures.ts` (dziś pusty), test na fake. `aiResponse` zwraca `{ data, remaining }` albo `{ error: { code, message, retryable } }` (`src/lib/ai/response.ts:5`). Kody i polskie komunikaty są w `src/lib/ai/errors.ts:12`.
- **Kontrakt `quota.ts` nie był jeszcze sprawdzony na prawdziwym PostgREST.** Chodzi o tablicę wierszy z `begin_ai_call` i o `P0429` w `error.code`. Archiwum F-02 (`context/archive/2026-10-18-ai-call-guardrails/change.md`, Notes) przenosi to sprawdzenie do S-02.
- **UI.** `/dashboard` to placeholder (`src/pages/dashboard.astro`). Middleware chroni tylko `/dashboard` (`src/middleware.ts:5`). W `src/components/ui` jest tylko `button.tsx`. Nie ma jeszcze żadnego wzorca wyspy React z endpointem JSON; logowanie to formularze POST z przekierowaniem.
- **Testy.** Vitest (`vitest.config.ts`, Node) obejmuje `src/**/*.test.ts`. `scripts/smoke.mjs` sprawdza przekierowania bez sesji. CI ma joby `ci` (lint, test, check, build) i `smoke` (lokalny Supabase, `supabase test db`, `AI_MODE=fake`, preview). Lokalnie nie ma Dockera, więc pgTAP i smoke działają tylko w CI.
- **Auth lokalnie.** Provider email jest włączony, wyłączona jest tylko rejestracja (`supabase/config.toml`, `[auth.email] enable_signup = false`). Użytkownika utworzonego przez admin API da się więc zalogować hasłem. Smoke ma `ALLOWED_EMAILS=smoke@example.com`.

## Desired End State

- `/dashboard` pokazuje listę tematów użytkownika (nazwa, status „Szkic” albo „Zatwierdzony”) i przycisk „Nowy temat”.
- `/topics/new` tworzy szkic tematu i przechodzi do `/topics/[id]`. Tam generowanie startuje samo, a ekran przez cały czas pokazuje, że AI pracuje.
- Na `/topics/[id]` szkic można edytować w granicach 2–10 podtematów. „Wygeneruj ponownie” po potwierdzeniu podmienia całą listę atomowo. Błąd AI pokazuje polski komunikat i „Spróbuj ponownie”, jeśli błąd na to pozwala, a dotychczasowa lista zostaje. „Zatwierdź” blokuje listę na stałe.
- Zablokowanej listy nie da się zmienić ani przez UI, ani przez API, ani przez bezpośredni zapis do bazy jako `authenticated`.
- W CI pełny przepływ API przechodzi na sesji testowej. Obejmuje to wyczerpanie limitu (21. generowanie daje 429 `quota_exceeded`) i brak dostępu drugiego konta do tematu.

### Key Discoveries:

- **Sprawdzenie FK omija RLS.** Sam `with check (auth.uid() = user_id)` pozwala kontu B wstawić podtemat do tematu konta A. Potrzebny jest złożony FK `(topic_id, user_id) → topics(id, user_id)`.
- **Blokadę egzekwuje baza, nie tylko API.** Polityki zapisu na `subtopics` przepuszczają tylko podtematy tematu w statusie `draft`. Przejście statusu pilnuje trigger.
- **Status trzeba sprawdzić przed wywołaniem AI.** Każde wywołanie zużywa limit (`src/lib/ai/AGENTS.md`), więc endpoint generowania sprawdza `draft` przed `getAi().call`.
- `callAi` konwertuje schemat zod przed rezerwacją limitu (`src/lib/ai/call.ts:105`). Udoskonalenia zod (`refine`) nie trafiają do JSON schema, ale działają w `safeParse`. Liczności i unikalność wyrażamy w zod.

## What We're NOT Doing

- Quiz diagnostyczny i jego start (S-03). Po zatwierdzeniu ekran pokazuje tylko informację, że quiz pojawi się w kolejnym kroku.
- Zmiana nazwy, archiwizacja i przywracanie tematu (FR-007, S-08), a także liczniki i daty na liście tematów (S-08).
- Zmiana kolejności podtematów (przeciąganie) oraz edycja notatki o zakresie po utworzeniu tematu.
- Ponowne generowanie z zachowaniem ręcznych poprawek albo z dodatkową wskazówką. Regeneracja zawsze zastępuje całą listę.
- Testy klikające UI w przeglądarce (Playwright). UI sprawdzamy ręcznie, a przepływ testuje smoke na API.
- Obsługa rozłączenia klienta w trakcie generowania. Zostaje zaakceptowane ryzyko z F-02: przerwane wywołanie zużywa limit.
- Usuwanie tematów z UI.

## Implementation Approach

Kolejność: baza → domena i API → test E2E na API → UI. Każda warstwa jest weryfikowana, zanim powstanie następna. Inwarianty bezpieczeństwa i spójności egzekwuje baza: wzorzec konta, złożony FK, blokada `draft`, trigger zatwierdzenia i atomowa podmiana listy. API mapuje ich błędy na wspólny kształt błędu. UI to strony SSR Astro z dwiema wyspami React, które wołają endpointy JSON. Każda mutacja zwraca pełny stan tematu, więc klient nie składa stanu sam.

## Critical Implementation Details

- **Generowanie.** `/topics/new` przekierowuje na `/topics/[id]?generate=1`. Wyspa uruchamia generowanie raz przy montowaniu i natychmiast usuwa parametr przez `history.replaceState`. Odświeżenie strony w trakcie generowania nie wywoła więc AI drugi raz. Pusty szkic bez parametru pokazuje przycisk „Generuj podtematy”.
- **Wyścig dodania z zatwierdzeniem.** Jeśli wstawienie podtematu i zatwierdzenie tego samego tematu trafią równocześnie, zatwierdzony temat może dostać jeden podtemat po fakcie. Blokada `FOR KEY SHARE` z FK nie koliduje z aktualizacją statusu. Przyjmujemy to jako ryzyko (jedno konto, dwa kliknięcia naraz) i nie dokładamy blokad.

## Faza 1: Schemat bazy

### Overview

Tabele `topics` i `subtopics` według wzorca konta. Dochodzą do tego integralność między kontami, blokada po zatwierdzeniu i atomowa podmiana listy, wszystko sprawdzone testami pgTAP.

### Changes Required:

#### 1. Migracja `create_topics_and_subtopics`

**File**: `supabase/migrations/<timestamp>_create_topics_and_subtopics.sql`, utworzona przez `npx supabase migration new create_topics_and_subtopics`.

**Intent**: Pierwsze tabele domenowe. Mają przechowywać szkic listy w bazie, żeby odświeżenie strony nie gubiło wygenerowanej listy, i egzekwować blokadę po zatwierdzeniu na poziomie danych.

**Contract**:

- **Tabela `public.topics`:**
  - `id uuid pk default gen_random_uuid()`;
  - `user_id` według wzorca z `isolation_probe`;
  - `name text not null`, długość po `btrim` w zakresie 1–100;
  - `scope_note text null`, maksymalnie 500 znaków;
  - `status text not null default 'draft'`, z checkiem `in ('draft','confirmed')`;
  - `created_at timestamptz not null default now()`;
  - `confirmed_at timestamptz null`;
  - `unique (id, user_id)` jako cel złożonego FK;
  - indeks na `user_id`;
  - RLS z czterema politykami właściciela, kopia wzorca.
- **Tabela `public.subtopics`:**
  - `id uuid pk default gen_random_uuid()`;
  - `user_id` według wzorca;
  - `topic_id uuid not null`;
  - `name text not null`, długość po `btrim` w zakresie 1–100;
  - `content_type text not null`, z checkiem `in ('conceptual','vocabulary')`;
  - `position integer not null check (position >= 0)`;
  - `created_at`;
  - `foreign key (topic_id, user_id) references public.topics (id, user_id) on delete cascade`;
  - unikalny indeks `(topic_id, lower(name))`;
  - indeksy `user_id` oraz `(topic_id, position)`.
- **RLS na `subtopics`:**
  - `select` dla właściciela;
  - `insert`, `update` i `delete` dla właściciela i tylko wtedy, gdy `exists (select 1 from public.topics t where t.id = topic_id and t.status = 'draft')`;
  - dla `update` ten warunek jest w `using` i w `with check`.
- **Trigger `before update` na `topics`:**
  - z `confirmed` nie da się wyjść, każda próba zmiany statusu kończy się wyjątkiem;
  - `draft → confirmed` wymaga od 2 do 10 podtematów, w przeciwnym razie `raise 'subtopic_count' using errcode = 'P0422'`, a przy sukcesie ustawia `confirmed_at = now()`;
  - funkcja triggera ma `set search_path = ''`.
- **Funkcja `public.replace_subtopics(p_topic_id uuid, p_subtopics jsonb) returns setof public.subtopics`:**
  - `security invoker`, więc RLS obowiązuje, oraz `set search_path = ''`;
  - najpierw `select … from public.topics where id = p_topic_id and status = 'draft' for update`; jeśli nic nie zwróci, `raise 'topic_not_editable' using errcode = 'P0409'`, a nieistniejący i cudzy temat dają ten sam błąd;
  - liczba elementów `p_subtopics` spoza 1–10 daje `P0422`;
  - potem `delete` wszystkich podtematów tematu i `insert` z `jsonb_to_recordset(...) with ordinality` (`name`, `content_type`, `position` = ordinal − 1);
  - zwraca nową listę posortowaną po `position`.

#### 2. Testy pgTAP

**File**: `supabase/tests/database/topics.test.sql` (nowy), `supabase/tests/database/account_isolation.test.sql`.

**Intent**: Udowodnić inwarianty z migracji. Zgodnie z `supabase/AGENTS.md:7` rozszerzamy też test izolacji o obie tabele.

**Contract**:

- `account_isolation.test.sql`: dla `topics` i `subtopics` asercje „B nie widzi, nie zmienia i nie usuwa wierszy A, nie wstawi wiersza jako A” oraz „B nie wstawi podtematu do tematu A, nawet z własnym `user_id`” (błąd złożonego FK). Plan rośnie odpowiednio.
- `topics.test.sql` sprawdza, że:
  - `replace_subtopics` podmienia listę i nadaje pozycje 0..n−1;
  - `replace_subtopics` na zatwierdzonym i na cudzym temacie daje `P0409`, a lista zostaje bez zmian;
  - pusta lista i lista 11-elementowa dają `P0422`;
  - zatwierdzenie z 1 i z 11 podtematami daje `P0422`;
  - zatwierdzenie z 2 podtematami ustawia `confirmed_at`;
  - powrót `confirmed → draft` się nie udaje;
  - `insert`, `update` i `delete` podtematu zatwierdzonego tematu niczego nie zmieniają: `insert` daje 42501, a `update` i `delete` dotykają 0 wierszy;
  - duplikat nazwy (różniący się wielkością liter) daje 23505;
  - `anon` nie wykona `replace_subtopics`.
- `rls_guard.test.sql` przechodzi bez nowych wyjątków. Jeśli dodatkowy warunek polityk nie przejdzie strażnika, plan się zatrzymuje i wymaga decyzji. Nie osłabiamy zapytania strażnika.

### Success Criteria:

#### Automated Verification:

- Migracja i testy pgTAP przechodzą w CI (job `smoke` → `Database tests`)
- `rls_guard` przechodzi bez nowych wpisów w `rls_guard_exceptions`
- `npm run lint` przechodzi

#### Manual Verification:

- Przegląd migracji: każda nowa funkcja ma `set search_path = ''`, żadna nie daje uprawnień `anon` ani `public`

**Implementation Note**: Po fazie zatrzymaj się na ręczne potwierdzenie. Migracja trafia na produkcję przez `npx supabase db push` jako krok człowieka, przed merge'em PR.

---

## Faza 2: Zadanie AI i API

### Overview

Moduł domenowy `src/lib/topics/` zawiera walidację wejścia, zadanie AI `subtopics` i dostęp do danych. Do tego dochodzą endpointy JSON i ochrona tras.

### Changes Required:

#### 1. Walidacja wejścia i limity

**File**: `src/lib/topics/schemas.ts`

**Intent**: Jedno źródło granic używanych przez API, UI i zadanie AI, zgodne z checkami w bazie.

**Contract**:

- Stałe:
  - `TOPIC_NAME_MAX = 100`, `SCOPE_NOTE_MAX = 500`, `SUBTOPIC_NAME_MAX = 100`;
  - `SUBTOPICS_MIN = 2`, `SUBTOPICS_MAX = 10` (ręczna edycja);
  - `AI_SUBTOPICS_MIN = 4`, `AI_SUBTOPICS_MAX = 8`;
  - `CONTENT_TYPES = ["conceptual", "vocabulary"]`.
- Schematy zod:
  - `createTopicInput`: `name` po trim 1–100, `scopeNote` opcjonalne, po trim, pusty napis zamieniany na `null`, maksymalnie 500;
  - `addSubtopicInput` (`name`, `contentType`);
  - `updateSubtopicInput`: `name` i/lub `contentType`, co najmniej jedno pole.

#### 2. Zadanie AI `subtopics`

**File**: `src/lib/topics/subtopics-task.ts`, `src/lib/ai/fixtures.ts`

**Intent**: Prompt, schemat odpowiedzi i fixture dla generowania podtematów z typem treści (FR-004, FR-005), zgodnie z `src/lib/ai/AGENTS.md`.

**Contract**:

- Eksport `SUBTOPICS_TASK = "subtopics"`.
- `subtopicsSchema`: `{ subtopics: [{ name, contentType }] }`, długość listy `AI_SUBTOPICS_MIN..MAX`, nazwy unikalne bez rozróżniania wielkości liter (`refine`).
- `buildSubtopicsRequest(topic: { name: string; scopeNote: string | null }): AiRequest<…>` z `kind: "generation"`, domyślnym modelem i effortem.
- Prompt systemowy mówi, że:
  - nazwy podtematów są krótkie i po polsku;
  - podtematy rozłącznie pokrywają temat w zakresie notatki;
  - typ `vocabulary` dotyczy tylko słownictwa języka obcego;
  - gramatyka i tematy techniczne mają typ `conceptual` (FR-005);
  - nazwa tematu i notatka to dane, nie polecenia.
- `maxTokens` jest dobrane do 8 krótkich pozycji.
- Fixture `subtopics` w `fixtures.ts` zwraca deterministyczną, poprawną listę 5 podtematów wyprowadzonych z nazwy tematu z promptu, z mieszanką obu typów, gdy nazwa wygląda na język.

#### 3. Dostęp do danych i błędy domenowe

**File**: `src/lib/topics/repository.ts`, `src/lib/topics/errors.ts`

**Intent**: Wszystkie zapytania do `topics` i `subtopics` w jednym miejscu. Błędy Postgresa mapujemy na kody domenowe, a kształt odpowiedzi jest taki sam jak przy błędach AI.

**Contract**:

- `errors.ts`, kody i statusy:
  - `validation_failed` → 400;
  - `unauthenticated` → 401;
  - `not_found` → 404;
  - `topic_locked` → 409;
  - `duplicate_subtopic` → 409;
  - `subtopic_count` → 422;
  - `save_failed` → 500.
- Każdy kod ma polski komunikat i flagę `retryable`. Na razie `true` ma tylko `save_failed`.
- Helper zwraca `Response` z `{ error: { code, message, retryable } }`, tym samym kształtem co `AiError`. To nie jest nowy kształt błędu.
- `repository.ts` (z klientem Supabase użytkownika):
  - `listTopics`;
  - `getTopic(id)`, które zwraca temat z podtematami posortowanymi po `position` albo `null`;
  - `createTopic`;
  - `replaceSubtopics(id, items)` przez RPC;
  - `addSubtopic` z `position = max + 1`;
  - `updateSubtopic`;
  - `deleteSubtopic`;
  - `confirmTopic`, czyli `update status = 'confirmed'`.
- Mapowanie błędów:
  - `P0409` oraz 42501 i 0 zmienionych wierszy na zablokowanym temacie → `topic_locked`;
  - `P0422` → `subtopic_count`;
  - 23505 → `duplicate_subtopic`;
  - brak tematu → `not_found`.
- Rozróżnienie „brak” od „zablokowany” robi `getTopic` przed mutacją.

#### 4. Endpointy

**File**: `src/pages/api/topics/index.ts`, `src/pages/api/topics/[id]/generate.ts`, `src/pages/api/topics/[id]/subtopics/index.ts`, `src/pages/api/topics/[id]/subtopics/[subtopicId].ts`, `src/pages/api/topics/[id]/confirm.ts`

**Intent**: API JSON dla wyspy edytora. Każda mutacja zwraca pełny, aktualny stan tematu.

**Contract**:

- Wspólne zasady:
  - brak `locals.user` → 401 `unauthenticated`;
  - ciało inne niż JSON albo niezgodne ze schematem → 400 `validation_failed`;
  - sukces zwraca `{ data: { topic, subtopics } }`, a w `generate` także `remaining`.
- `POST /api/topics` `{ name, scopeNote? }` → 201 `{ data: { id } }`.
- `POST /api/topics/[id]/generate`:
  - `getTopic`, przy statusie innym niż `draft` → 409 `topic_locked` **przed** wywołaniem AI;
  - potem `getAi(supabase, user).call(buildSubtopicsRequest(topic))`;
  - błąd AI → `aiResponse(result, ai.mode)` bez zmian;
  - sukces → `replaceSubtopics`, a odpowiedź ma nagłówek `X-AI-Mode` jak `aiResponse`;
  - błąd zapisu → 500 `save_failed`, a stara lista zostaje, bo RPC jest atomowe.
- `POST /api/topics/[id]/subtopics`:
  - liczba ≥ `SUBTOPICS_MAX` → 422 `subtopic_count`.
- `PATCH /api/topics/[id]/subtopics/[subtopicId]`: zmiana nazwy i/lub typu.
- `DELETE /api/topics/[id]/subtopics/[subtopicId]`:
  - liczba ≤ `SUBTOPICS_MIN` → 422 `subtopic_count`.
- `POST /api/topics/[id]/confirm` → zatwierdzony temat.

#### 5. Ochrona tras

**File**: `src/middleware.ts`

**Intent**: Strony tematów wymagają zalogowania.

**Contract**: `PROTECTED_ROUTES` obejmuje `"/topics"`. Endpointy `/api/topics/...` same zwracają 401 JSON i nie przekierowują.

#### 6. Testy jednostkowe

**File**: `src/lib/topics/subtopics-task.test.ts`, `src/lib/topics/schemas.test.ts`

**Intent**: Zadanie AI i walidacja wejścia na trybie fake, wzorem `src/lib/ai/call.test.ts`.

**Contract**:

- `subtopicsSchema`:
  - akceptuje 4 i 8 pozycji;
  - odrzuca 3, 9, duplikat nazwy (różniący się wielkością liter) i nieznany `contentType`.
- `zodOutputFormat(subtopicsSchema)` się konwertuje.
- `callAi` z fake providerem i fixture `subtopics` zwraca poprawną listę.
- Fixture zwracająca złą liczbę pozycji daje `ai_invalid_output`.
- Schematy wejścia: trim, puste `scopeNote` zamienione na `null`, granice długości.

### Success Criteria:

#### Automated Verification:

- `npm test` przechodzi (nowe testy `src/lib/topics/*.test.ts`)
- `npm run lint` przechodzi
- `npx astro check` przechodzi
- `npm run build` przechodzi

#### Manual Verification:

- Przegląd promptu `subtopics`: polskie nazwy, reguła typu treści zgodna z FR-005, nazwa i notatka traktowane jako dane

**Implementation Note**: Po fazie zatrzymaj się na ręczne potwierdzenie.

---

## Faza 3: Smoke E2E z sesją testową

### Overview

Test z perspektywy użytkownika na prawdziwym preview, lokalnym Supabase i AI w trybie fake. Przechodzi pełny przepływ API, sprawdza limit na PostgREST i brak dostępu drugiego konta.

### Changes Required:

#### 1. Skrypt smoke tematów

**File**: `scripts/smoke-topics.mjs`, `package.json`

**Intent**: Pierwszy test z sesją. Domyka przeniesione z F-02 sprawdzenie `quota.ts` na prawdziwym PostgREST.

**Contract**:

- Skrypt `"smoke:topics": "node scripts/smoke-topics.mjs"`.
- Wejście z env: `BASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- Tworzy konta `smoke@example.com` i `smoke-b@example.com` przez admin API (`email_confirm: true`, losowe hasło).
- Loguje je przez `createServerClient` z `@supabase/ssr` z przechwyceniem `setAll`. Format cookie bierzemy więc z biblioteki, nie odtwarzamy ręcznie.
- Kroki, każdy z PASS/FAIL jak w `smoke.mjs`:
  1. `POST /api/topics` bez sesji → 401.
  2. Pusta nazwa → 400.
  3. Utworzenie → 201.
  4. `generate` → 200, `X-AI-Mode: fake`, 4–8 podtematów, `remaining` 19.
  5. Zmiana nazwy, zmiana typu, dodanie i usunięcie → każda zwraca oczekiwaną listę.
  6. Duplikat nazwy → 409.
  7. `generate` ponownie → lista z fixture zastępuje edycje.
  8. Konto B: `generate` i `PATCH` na temacie A → 404.
  9. `confirm` → 200.
  10. Dodanie po zatwierdzeniu → 409 `topic_locked`.
  11. `generate` po zatwierdzeniu → 409 i `remaining` bez zmian (sprawdzone kolejnym generowaniem na nowym szkicu).
  12. Na nowym szkicu generowanie aż do wyczerpania limitu: 20. wywołanie w ciągu dnia → 200, 21. → 429 `quota_exceeded`, `retryable: false`.
  13. `GET /dashboard` z sesją → 200, a w HTML są nazwy utworzonych tematów.
- Na koniec usuwa konta testowe. Kod wyjścia jest różny od zera przy pierwszym FAIL-u.

#### 2. Podpięcie w CI i istniejący smoke

**File**: `.github/workflows/ci.yml`, `scripts/smoke.mjs`

**Intent**: Uruchamiać smoke tematów w jobie `smoke` bez wycieku klucza serwisowego do aplikacji.

**Contract**:

- `supabase status -o env` dodatkowo daje `SERVICE_ROLE_KEY`, przekazywany **tylko** w env kroku `smoke:topics`. Nie trafia do `.env` ani `.dev.vars`.
- `ALLOWED_EMAILS=smoke@example.com,smoke-b@example.com`.
- `smoke.mjs` dostaje krok „/topics/new przekierowuje niezalogowanego na /auth/signin”.

### Success Criteria:

#### Automated Verification:

- Job `smoke` przechodzi w CI, w tym nowy krok `smoke:topics` ze wszystkimi krokami PASS
- `npm run lint` przechodzi

#### Manual Verification:

- Log CI kroku `smoke:topics` pokazuje 429 przy 21. generowaniu (kontrakt `quota.ts` na PostgREST potwierdzony) i nie zawiera klucza serwisowego

**Implementation Note**: Po fazie zatrzymaj się na ręczne potwierdzenie.

---

## Faza 4: UI

### Overview

Lista tematów na `/dashboard`, formularz nowego tematu i edytor podtematów z wskaźnikiem generowania, błędami z ponowieniem i zatwierdzeniem.

### Changes Required:

#### 1. Komponenty shadcn

**File**: `src/components/ui/*`

**Intent**: Zgodnie z `CLAUDE.md` (sekcja UI) brakujące komponenty dodajemy z rejestru shadcn, nie piszemy ich od zera.

**Contract**: `input`, `textarea`, `label`, `select`, `alert-dialog`, `badge`, `card` (te, których brakuje), dodane przez `npx shadcn@latest add`. Kolory wyłącznie z tokenów `src/styles/global.css`.

#### 2. Lista tematów

**File**: `src/pages/dashboard.astro`

**Intent**: FR-006, wybór istniejącego tematu. S-08 rozbuduje ten widok.

**Contract**:

- SSR przez `listTopics`.
- Każda pozycja to nazwa z odznaką „Szkic” albo „Zatwierdzony” i link do `/topics/[id]`.
- Pusty stan z zachętą.
- Przycisk „Nowy temat” prowadzi do `/topics/new`.
- Używa `Topbar`. Teksty po polsku.

#### 3. Nowy temat

**File**: `src/pages/topics/new.astro`, `src/components/topics/NewTopicForm.tsx`

**Intent**: FR-003, nazwa i opcjonalna notatka o zakresie lub poziomie.

**Contract**:

- Wyspa wysyła `POST /api/topics`.
- Sukces przekierowuje do `/topics/[id]?generate=1`.
- Błąd walidacji jest pokazany przy polu.
- Limity długości z `schemas.ts`.

#### 4. Edytor podtematów

**File**: `src/pages/topics/[id].astro`, `src/components/topics/TopicEditor.tsx`

**Intent**: FR-004, FR-005 i FR-028 oraz NFR „brak wrażenia zawieszenia”.

**Contract**:

- SSR ładuje `getTopic`. Brak tematu, także cudzego, daje 404.
- Wyspa dostaje temat, podtematy i informację o `generate=1`.
- **Generowanie:**
  - automatycznie raz przy `generate=1` (parametr usuwany od razu);
  - w pustym szkicu przycisk „Generuj podtematy”;
  - w trakcie widoczny stan pracy z licznikiem upływających sekund i zablokowanymi akcjami.
- **Błąd:**
  - alert z `error.message`;
  - przy `retryable` przycisk „Spróbuj ponownie”;
  - lista sprzed błędu zostaje.
- **Szkic:**
  - każda pozycja ma edytowalną nazwę (zapis przy zatwierdzeniu pola), select typu „Pojęciowy” / „Językowy” i usuwanie (wyłączone przy 2);
  - „Dodaj podtemat” jest wyłączone przy 10;
  - „Wygeneruj ponownie” wymaga potwierdzenia w `AlertDialog` („obecna lista, w tym Twoje poprawki, zostanie zastąpiona”);
  - „Zatwierdź” wymaga potwierdzenia w `AlertDialog` („po zatwierdzeniu listy nie można zmienić”);
  - wyświetlany jest pozostały dzienny limit, gdy jest znany.
- **Zatwierdzony:** lista tylko do odczytu i informacja, że quiz diagnostyczny będzie kolejnym krokiem.
- Stan zawsze bierzemy z odpowiedzi API.

#### 5. Dokumentacja

**File**: `README.md`, `src/lib/topics/AGENTS.md`, `src/lib/topics/CLAUDE.md`

**Intent**: Zapisać nieoczywiste konwencje modułu dla kolejnych wycinków, czyli S-03, które startuje quiz z zatwierdzonego tematu.

**Contract**:

- `AGENTS.md` (120–250 słów) mówi, że:
  - blokadę egzekwuje baza;
  - status sprawdzamy przed wywołaniem AI;
  - błędy domenowe mają wspólny kształt z `src/lib/ai/errors.ts`;
  - każda mutacja zwraca pełny stan.
- `CLAUDE.md` to `@AGENTS.md`, jak w `src/lib/ai/`.
- README: krótka sekcja o `smoke:topics`, które działa tylko w CI (wymaga Dockera).

### Success Criteria:

#### Automated Verification:

- `npm run lint` przechodzi
- `npx astro check` przechodzi
- `npm run build` przechodzi
- Job `smoke` w CI przechodzi (oba skrypty smoke)

#### Manual Verification:

- Na produkcji: utworzenie tematu „Kubernetes” z notatką generuje 4–8 sensownych podtematów z typem pojęciowym, a temat „angielski — słówka podróżnicze” daje typ językowy
- Podczas generowania ekran przez cały czas pokazuje postęp, a odświeżenie strony w trakcie nie uruchamia drugiego generowania
- Edycja (nazwa, typ, dodanie, usunięcie), granice 2 i 10 oraz regeneracja z potwierdzeniem działają
- Zatwierdzenie blokuje listę, a po odświeżeniu widok jest tylko do odczytu
- Temat jest widoczny na `/dashboard` i otwiera się z listy
- Widok działa na telefonie (szerokość ok. 375 px)

**Implementation Note**: Po fazie zatrzymaj się na ręczne potwierdzenie.

---

## Testing Strategy

### Unit Tests:

- Schemat zadania `subtopics`: liczności, unikalność, `contentType`, konwersja do JSON schema.
- `callAi` z fixture `subtopics` (sukces i `ai_invalid_output`).
- Schematy wejścia API: trim, puste wartości, granice długości.

### Integration Tests:

- pgTAP: izolacja kont dla obu tabel, złożony FK, blokada `draft`, trigger zatwierdzenia (2–10, brak powrotu), atomowość i błędy `replace_subtopics`, unikalność nazw, brak uprawnień `anon`.
- `smoke:topics`: pełny przepływ API na sesji testowej, drugie konto, blokada przed wywołaniem AI, limit 20 i 429 na PostgREST.

### Manual Testing Steps:

1. Utwórz temat „Kubernetes” z notatką „podstawy, używam na co dzień”. Sprawdź, że podtematy mają typ pojęciowy.
2. Utwórz temat „angielski — słówka podróżnicze”. Sprawdź, że podtematy mają typ językowy.
3. Odśwież stronę w trakcie generowania. Nie startuje drugie generowanie, a pusty szkic pokazuje „Generuj podtematy”.
4. Zmień nazwę, popraw typ, dodaj podtemat do 10 i usuń do 2. Przyciski blokują się na granicach.
5. Wygeneruj ponownie (z potwierdzeniem). Lista zostaje zastąpiona.
6. Zatwierdź, odśwież stronę. Widok jest tylko do odczytu.

## Performance Considerations

Generowanie to jedno wywołanie Sonnet 5.5 z effortem `low` i małym wynikiem (do 8 krótkich pozycji), więc trwa zwykle kilka sekund. Limit czasu generowania z F-02 to 60 s. Zapytania dotyczą jednego tematu i co najwyżej 10 wierszy, po indeksach.

## Migration Notes

Migracja jest addytywna: dwie tabele, funkcja i trigger. Musi trafić na produkcję (`npx supabase db push`, krok człowieka) **przed** merge'em PR, bo nowy Worker od razu odpytuje `topics`. Wycofanie to nowa migracja usuwająca obiekty. Tracone są wtedy tylko szkice i zatwierdzone listy z okresu działania.

## References

- Roadmapa: `context/foundation/roadmap.md` (S-02)
- PRD: `context/foundation/prd.md` (US-01, FR-003–FR-006, FR-028, NFR limity i brak zawieszenia)
- Fundamenty: `context/archive/2026-10-17-per-account-data-isolation/`, `context/archive/2026-10-18-ai-call-guardrails/`
- Wzorzec tabeli: `supabase/tests/database/account_isolation.test.sql:16-31`, `supabase/AGENTS.md`
- Ścieżka AI: `src/lib/ai/index.ts:18`, `src/lib/ai/call.ts:94`, `src/lib/ai/AGENTS.md`
- Smoke: `scripts/smoke.mjs`, `.github/workflows/ci.yml`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schemat bazy

#### Automated

- [x] 1.1 Migracja i testy pgTAP przechodzą w CI (job `smoke` → `Database tests`) — d07bd21
- [x] 1.2 `rls_guard` przechodzi bez nowych wpisów w `rls_guard_exceptions` — d07bd21
- [x] 1.3 `npm run lint` przechodzi — d07bd21

#### Manual

- [x] 1.4 Przegląd migracji: każda nowa funkcja ma `set search_path = ''`, żadna nie daje uprawnień `anon` ani `public` — d07bd21

### Phase 2: Zadanie AI i API

#### Automated

- [x] 2.1 `npm test` przechodzi (nowe testy `src/lib/topics/*.test.ts`) — 967eb4b
- [x] 2.2 `npm run lint` przechodzi — 967eb4b
- [x] 2.3 `npx astro check` przechodzi — 967eb4b
- [x] 2.4 `npm run build` przechodzi — 967eb4b

#### Manual

- [x] 2.5 Przegląd promptu `subtopics`: polskie nazwy, reguła typu treści zgodna z FR-005, nazwa i notatka traktowane jako dane — 967eb4b

### Phase 3: Smoke E2E z sesją testową

#### Automated

- [x] 3.1 Job `smoke` przechodzi w CI, w tym nowy krok `smoke:topics` ze wszystkimi krokami PASS — 80c10b5
- [x] 3.2 `npm run lint` przechodzi — 80c10b5

#### Manual

- [x] 3.3 Log CI kroku `smoke:topics` pokazuje 429 przy 21. generowaniu (kontrakt `quota.ts` na PostgREST potwierdzony) i nie zawiera klucza serwisowego — 80c10b5

### Phase 4: UI

#### Automated

- [x] 4.1 `npm run lint` przechodzi — 388963b
- [x] 4.2 `npx astro check` przechodzi — 388963b
- [x] 4.3 `npm run build` przechodzi — 388963b
- [x] 4.4 Job `smoke` w CI przechodzi (oba skrypty smoke) — 388963b

#### Manual

- [x] 4.5 Na produkcji: utworzenie tematu „Kubernetes” z notatką generuje 4–8 sensownych podtematów z typem pojęciowym, a temat „angielski — słówka podróżnicze” daje typ językowy — 388963b
- [x] 4.6 Podczas generowania ekran przez cały czas pokazuje postęp, a odświeżenie strony w trakcie nie uruchamia drugiego generowania — 388963b
- [x] 4.7 Edycja (nazwa, typ, dodanie, usunięcie), granice 2 i 10 oraz regeneracja z potwierdzeniem działają — 388963b
- [x] 4.8 Zatwierdzenie blokuje listę, a po odświeżeniu widok jest tylko do odczytu — 388963b
- [x] 4.9 Temat jest widoczny na `/dashboard` i otwiera się z listy — 388963b
- [x] 4.10 Widok działa na telefonie (szerokość ok. 375 px) — 388963b
