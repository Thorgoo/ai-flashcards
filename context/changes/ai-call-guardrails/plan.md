# Ai call guardrails Implementation Plan

## Overview

Fundament F-02 roadmapy: jedna serwerowa ścieżka wywołania AI (`callAi`), która przed każdym wywołaniem sprawdza dzienny limit konta w Postgresie (20 generowań / 100 ocen, dzień w strefie Europe/Warsaw), wywołuje Claude Sonnet 5.5 przez Structured Outputs, waliduje wynik schematem zod i zwraca stały kontrakt błędów z informacją, czy można ponowić. Tryb `AI_MODE=fake` podstawia przygotowane odpowiedzi w dev i CI. Konkretne prompty i endpointy powstają w wycinkach (pierwszy: S-02).

## Current State Analysis

- Brak jakiegokolwiek wywołania AI, klienta, sekretu i walidacji odpowiedzi (`context/foundation/roadmap.md:77`). Dostawca nie był wybrany (`roadmap.md:108`).
- Jedyne endpointy to `src/pages/api/auth/{callback,signin,signout}.ts` — styl `export const GET|POST: APIRoute`, każdy tworzy klienta przez `createClient(context.request.headers, context.cookies)` (`src/lib/supabase.ts:5`, zwraca `null`, gdy brak konfiguracji) i zwraca wyłącznie przekierowania. Brak endpointów JSON i kształtu odpowiedzi błędu.
- `src/middleware.ts` ustawia `locals.user` (z failem zamkniętym na allowliście) i chroni tylko `/dashboard`; `/api/*` musi samo sprawdzać zalogowanie.
- Sekrety: `astro:env` w `astro.config.mjs:18-25` (`envField.string({ context: "server", access: "secret", optional: true })`), lokalnie `.dev.vars`, produkcyjnie `wrangler secret put` (`infrastructure.md:83`).
- `zod` 4.6.2 jest tylko zależnością przechodnią; brak test runnera JS (F-01 przekazał go do F-02).
- Baza: jedna migracja (`supabase/migrations/20261017065708_revoke_anon_default_privileges.sql`) — `anon` nie ma uprawnień w `public`, nowe funkcje nie mają `EXECUTE` dla `PUBLIC`, a `authenticated`/`service_role` dostają je jawnie. Strażnik `supabase/tests/database/rls_guard.test.sql` wymaga wzorca właściciela dla każdej tabeli, wyjątki tylko z uzasadnieniem.
- CI (`.github/workflows/ci.yml`): job `ci` (lint, `astro check`, build) i job `smoke` (lokalny Supabase, `supabase test db`, `.env` budowany w linii 53, preview + `npm run smoke`).
- Ryzyka platformy (`infrastructure.md:32,62-63,92-93`): 10 ms CPU na Free, rozłączenie klienta przerywa Workera.

## Desired End State

- Tabela `public.ai_calls` zapisuje każde wywołanie AI (rodzaj, zadanie, model, status, kod błędu, czas, tokeny, data w Europe/Warsaw); użytkownik widzi tylko swoje wiersze i nie może ich zmieniać. Limit egzekwują funkcje `begin_ai_call` / `finish_ai_call`.
- `src/lib/ai/` udostępnia `callAi` z kontraktem `AiResult<T>`, kodami błędów z polskimi komunikatami i helperem odpowiedzi HTTP; tryby `live` (Anthropic SDK) i `fake` (fixtures).
- `npm test` (Vitest) i `supabase test db` przechodzą w CI; job `smoke` działa w `AI_MODE=fake`.
- `src/lib/ai/AGENTS.md` opisuje regułę „każde wywołanie AI przez `callAi`”, README opisuje klucz i tryb fake.

Weryfikacja: zielony CI na PR, ręczny test live z prawdziwym kluczem (pomijany domyślnie), po merge `db push` i `wrangler secret put ANTHROPIC_API_KEY`.

### Key Discoveries:

- `src/lib/supabase.ts:5` — klient SSR z kluczem anon + JWT użytkownika, więc RPC wykonuje się jako `authenticated` i `auth.uid()` działa w funkcjach.
- `supabase/migrations/20261017065708_revoke_anon_default_privileges.sql:11-12` — nowe funkcje w `public` są wykonywalne przez `authenticated`, nie przez `anon`; nic nie trzeba dodatkowo nadawać.
- `supabase/AGENTS.md` — wzorzec tabeli właściciela; we wzorcu właściciel może usuwać swoje wiersze, czyli mógłby wyzerować licznik — dlatego `ai_calls` dostaje wyjątek od strażnika.
- `.github/workflows/ci.yml:53` — jedyne miejsce, gdzie smoke ustawia zmienne aplikacji.
- `@anthropic-ai/sdk` działa na Workers (fetch-based); Structured Outputs (`output_config.format` z JSON Schema) jest GA, ale nie gwarantuje zgodności przy `stop_reason` `max_tokens`/`refusal` i nie wymusza liczności (`minItems` tylko 0/1) — walidacja zod zostaje obowiązkowa.

## What We're NOT Doing

- Żadnych promptów, schematów odpowiedzi konkretnych zadań ani endpointów użytkowych — należą do S-02+.
- Brak obsługi rozłączenia klienta (`ctx.waitUntil`, request ID): przerwane wywołanie zużywa limit, użytkownik ponawia. Nazwane ryzyko.
- Brak testu z perspektywy użytkownika i endpointu demonstracyjnego — pierwszy taki test powstaje w S-02 na trybie fake z F-02.
- Brak strefy czasowej per konto — jedna stała strefa Europe/Warsaw.
- Brak automatycznych ponowień (ani w SDK, ani w `callAi`) — każde ponowienie inicjuje użytkownik i każde zużywa limit.
- Brak streamingu odpowiedzi do UI i wskaźnika postępu (NFR „nie wygląda na zawieszony” realizują wycinki po stronie UI).
- Brak bindingów Cloudflare (Rate Limiting, KV, Durable Objects) do limitów.
- Brak `supabase gen types`.

## Implementation Approach

Licznik i log to ta sama tabela: limit = liczba dzisiejszych (Europe/Warsaw) wierszy danego rodzaju, niezależnie od statusu. `callAi` najpierw rezerwuje wywołanie (`begin_ai_call`, który atomowo sprawdza limit i wstawia wiersz `pending`), potem woła dostawcę, sprawdza `stop_reason`, waliduje zod i domyka wiersz (`finish_ai_call`). Logika `callAi` dostaje dostawcę i licznik jako zależności, więc testy jednostkowe działają w Node bez Astro i bez bazy; tylko `src/lib/ai/index.ts` czyta `astro:env` i składa zależności.

## Critical Implementation Details

- **Brak ponowień w SDK.** Klient Anthropic tworzony z `maxRetries: 0` — wbudowane ponowienia zrobiłyby z jednego wiersza `ai_calls` kilka płatnych wywołań i rozjechały licznik z rzeczywistością.
- **Kolejność w `callAi`.** `begin_ai_call` musi się udać przed wywołaniem dostawcy (limit przed kosztem); `finish_ai_call` jest best effort — jego błąd jest logowany (`console.error`), ale nie zmienia wyniku zwracanego użytkownikowi.
- **Wyścig limitu.** Dwa równoległe żądania tego samego konta nie mogą oba przejść przy 19/20: `begin_ai_call` serializuje się blokadą `pg_advisory_xact_lock` na parze (konto, rodzaj) przed policzeniem wierszy.
- **Data dnia liczona w bazie, nie w Workerze:** `(now() at time zone 'Europe/Warsaw')::date`, ustawiana przez funkcję — klient nie podaje daty.
- **Tryb fake nie może zadziałać przy zdalnej bazie.** `AI_MODE=fake` jest akceptowany tylko, gdy host `SUPABASE_URL` to `localhost` lub `127.0.0.1`; w przeciwnym razie `callAi` zwraca `ai_not_configured` i loguje błąd (fail closed, bez crasha). Lokalny dev na hostowanym Supabase wymaga więc trybu live z kluczem.
- **Wysiłek modelu.** Sonnet 5.5 domyślnie myśli z wysokim wysiłkiem, co wydłuża odpowiedź; domyślne parametry wywołania ustawiają najniższy dostępny poziom wysiłku/myślenia (nazwę parametru sprawdzić w aktualnym SDK), z możliwością nadpisania per wywołanie.

## Phase 1: Baza — tabela ai_calls i limity

### Overview

Migracja z tabelą wywołań, funkcjami rezerwacji i domknięcia wywołania oraz testy pgTAP limitu, dnia i izolacji.

### Changes Required:

#### 1. Migracja

**File**: `supabase/migrations/<timestamp>_create_ai_calls.sql` (przez `npx supabase migration new create_ai_calls`)

**Intent**: Trwały licznik i log wywołań AI per konto, którego użytkownik nie może zmienić, z limitem egzekwowanym w jednym miejscu.

**Contract**:

- Tabela `public.ai_calls`: `id uuid pk default gen_random_uuid()`, `user_id` zgodnie ze wzorcem z `supabase/AGENTS.md`, `kind text not null check (kind in ('generation','grading'))`, `task text not null`, `model text not null`, `status text not null default 'pending' check (status in ('pending','ok','failed'))`, `error_code text`, `latency_ms integer`, `input_tokens integer`, `output_tokens integer`, `called_on date not null`, `created_at timestamptz not null default now()`; indeks `(user_id, kind, called_on)`.
- RLS włączone; jedna polityka `select` dla `authenticated` z `(select auth.uid()) = user_id`; `revoke insert, update, delete, truncate on public.ai_calls from authenticated` (domyślne uprawnienia dają `all`).
- `public.begin_ai_call(p_kind text, p_task text, p_model text) returns table (call_id uuid, remaining integer)` — `security definer`, `set search_path = ''`; bez `auth.uid()` → błąd `42501`; limit: `generation` 20, `grading` 100; po przekroczeniu `raise exception 'ai_quota_exceeded' using errcode = 'P0429'`; wstawia wiersz `pending` z `called_on` = dzisiaj w Europe/Warsaw; `remaining` = limit minus liczba dzisiejszych wierszy po wstawieniu.
- `public.finish_ai_call(p_call_id uuid, p_status text, p_error_code text, p_latency_ms integer, p_input_tokens integer, p_output_tokens integer) returns void` — `security definer`, `set search_path = ''`; aktualizuje wyłącznie wiersz o `id = p_call_id`, `user_id = auth.uid()` i `status = 'pending'`; `p_status` tylko `ok`/`failed`.
- Migracja addytywna; niczego nie usuwa.

#### 2. Wyjątek strażnika

**File**: `supabase/tests/database/rls_guard.test.sql`

**Intent**: `ai_calls` celowo nie ma polityk zapisu (zapis tylko przez funkcje), więc łamie wzorzec „polityka na każdą komendę”.

**Contract**: Wiersz `('ai_calls')` w `rls_guard_exceptions` z komentarzem-uzasadnieniem: append-only licznik limitów, zapis wyłącznie przez `begin_ai_call`/`finish_ai_call`, właściciel tylko czyta.

#### 3. Testy limitu i izolacji

**File**: `supabase/tests/database/ai_calls.test.sql` (nowy) i `supabase/tests/database/account_isolation.test.sql`

**Intent**: Udowodnić, że limit, granica dnia i ochrona przed zapisem działają, a konto B nie widzi wywołań konta A.

**Contract**: `ai_calls.test.sql` (struktura jak w istniejących plikach: `begin; … plan(N); … finish(); rollback;`), minimum asercji:

- konto A: 20 × `begin_ai_call('generation', …)` przechodzi, 21. rzuca `P0429`; `grading` dla A nadal przechodzi;
- `remaining` po pierwszym wywołaniu = 19;
- wiersze A z `called_on` = wczoraj (wstawione jako `postgres`) nie liczą się do dzisiejszego limitu;
- wywołania konta B nie liczą się do limitu A;
- bezpośredni `insert` do `ai_calls` jako `authenticated` → `42501`; `update`/`delete` nie zmieniają wierszy;
- `finish_ai_call` konta B na wierszu A nie zmienia jego statusu; `finish_ai_call` właściciela ustawia `ok`;
- `anon`: `begin_ai_call` → `42501`.

`account_isolation.test.sql`: asercja „konto B nie widzi wierszy `ai_calls` konta A”.

### Success Criteria:

#### Automated Verification:

- Migration file exists under `supabase/migrations/` and lint passes: `npm run lint`
- CI job `smoke` passes, with `Database tests` reporting `account_isolation`, `ai_calls` and `rls_guard` as ok

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Moduł AI z testami jednostkowymi

### Overview

Klient AI, kontrakt wyników i błędów, tryb fake oraz Vitest z testami logiki na podstawionych zależnościach.

### Changes Required:

#### 1. Zależności i skrypt testów

**File**: `package.json`

**Intent**: SDK dostawcy, walidator i test runner jako jawne zależności.

**Contract**: `dependencies`: `@anthropic-ai/sdk`, `zod` (^4, zgodny z zainstalowanym 4.6.x); `devDependencies`: `vitest`; skrypt `"test": "vitest run"`. Plik `vitest.config.ts` (środowisko Node, `include: ["src/**/*.test.ts"]`, alias `@` → `src`).

#### 2. Zmienne środowiskowe

**File**: `astro.config.mjs`

**Intent**: Klucz i tryb AI jako sekrety serwerowe, jak istniejące zmienne.

**Contract**: `ANTHROPIC_API_KEY: envField.string({ context: "server", access: "secret", optional: true })`; `AI_MODE: envField.enum({ values: ["live", "fake"], context: "server", access: "secret", optional: true, default: "live" })` z komentarzem, że `fake` działa tylko z lokalnym Supabase.

#### 3. Kontrakt wyników i błędów

**File**: `src/lib/ai/errors.ts`

**Intent**: Jeden zestaw kodów błędów, komunikatów i statusów HTTP dla wszystkich wywołań AI, żeby UI w wycinkach obsługiwało błędy jednakowo.

**Contract**: `type AiErrorCode = "unauthenticated" | "quota_exceeded" | "ai_timeout" | "ai_unavailable" | "ai_invalid_output" | "ai_not_configured"`; dla każdego kodu: polski komunikat dla użytkownika, `retryable` (`true` dla `ai_timeout`, `ai_unavailable`, `ai_invalid_output`; `false` dla pozostałych) i status HTTP (401, 429, 504, 503, 502, 503). `type AiResult<T> = { ok: true; data: T; remaining: number } | { ok: false; error: { code: AiErrorCode; message: string; retryable: boolean } }`.

#### 4. Odpowiedź HTTP

**File**: `src/lib/ai/response.ts`

**Intent**: Endpointy w wycinkach zamieniają `AiResult` na odpowiedź jednym wywołaniem.

**Contract**: `aiResponse<T>(result: AiResult<T>, mode: "live" | "fake"): Response` — sukces: `200` z `{ data, remaining }`; błąd: status z `errors.ts` i `{ error: { code, message, retryable } }`; w trybie fake nagłówek `X-AI-Mode: fake`.

#### 5. Rdzeń wywołania

**File**: `src/lib/ai/call.ts`

**Intent**: Jedyne miejsce, które przechodzi przez limit → dostawcę → walidację → log.

**Contract**:

- `interface AiProvider { complete(req: AiProviderRequest): Promise<AiProviderResponse> }`, gdzie request = `{ model, system, prompt, jsonSchema, maxTokens, timeoutMs }`, response = `{ output: unknown; stopReason: string; usage?: { inputTokens: number; outputTokens: number } }`; błędy dostawcy rzucane jako `AiProviderError` z kodem `ai_timeout` | `ai_unavailable` | `ai_not_configured`.
- `interface AiQuota { begin(kind, task, model): Promise<{ callId: string; remaining: number }>; finish(callId, outcome): Promise<void> }`; `begin` rzuca `AiQuotaExceeded` przy limicie.
- `callAi<T>(deps: { provider: AiProvider; quota: AiQuota; userId: string | null }, req: { kind: "generation" | "grading"; task: string; system: string; prompt: string; schema: z.ZodType<T>; maxTokens: number; timeoutMs?: number; model?: string }): Promise<AiResult<T>>`.
- Kolejność i mapowanie: brak `userId` → `unauthenticated` (bez wywołania licznika); `AiQuotaExceeded` → `quota_exceeded` (bez wywołania dostawcy); `stopReason` inny niż `end_turn` lub nieudane `schema.safeParse` → `ai_invalid_output`; `AiProviderError` → jego kod; każdy wynik po `begin` kończy się `finish` (`ok`/`failed` + kod, czas, tokeny).
- Domyślny model `claude-sonnet-5-5`; domyślny timeout: 60 s dla `generation`, 20 s dla `grading`. JSON Schema dla dostawcy wyprowadzany z tego samego `schema` (zod v4 `z.toJSONSchema` lub helper SDK).

#### 6. Dostawcy

**File**: `src/lib/ai/live.ts`, `src/lib/ai/fake.ts`

**Intent**: `live` woła Claude przez Structured Outputs; `fake` zwraca odpowiedzi z fixtures bez sieci, ale przez ten sam limit i walidację.

**Contract**:

- `createLiveProvider({ apiKey, fetch? })` — `new Anthropic({ apiKey, maxRetries: 0, fetch })`; `messages.create` z `output_config.format` typu `json_schema`; mapuje timeout SDK na `ai_timeout`, błędy połączenia/5xx/429/529 na `ai_unavailable`, 401/403 na `ai_not_configured`; brak klucza → `ai_not_configured`.
- `createFakeProvider(fixtures: Record<string, (req) => unknown>)` — wybiera fixture po `task`; brak fixture → `ai_invalid_output`; fixture może rzucić `FakeAiFailure(code)`, żeby testy w wycinkach wywołały konkretny błąd; `usage` = 0. Rejestr domyślnych fixtures (początkowo pusty) w `src/lib/ai/fixtures.ts`, do którego wycinki dopisują swoje zadania.

#### 7. Licznik przez Supabase i punkt wejścia

**File**: `src/lib/ai/quota.ts`, `src/lib/ai/mode.ts`, `src/lib/ai/index.ts`

**Intent**: Połączyć rdzeń z bazą i konfiguracją; tylko ten punkt czyta `astro:env`.

**Contract**:

- `createSupabaseQuota(supabase)` — `rpc("begin_ai_call", …)` (błąd z kodem `P0429` → `AiQuotaExceeded`), `rpc("finish_ai_call", …)`.
- `resolveAiMode(mode: string | undefined, supabaseUrl: string | undefined): "live" | "fake" | "invalid"` — `fake` tylko przy hoście `localhost`/`127.0.0.1`, w przeciwnym razie `invalid`.
- `getAi(supabase, user)` (w `index.ts`) — czyta `AI_MODE`, `ANTHROPIC_API_KEY`, `SUPABASE_URL` z `astro:env/server`, buduje dostawcę i licznik i zwraca `{ mode, call: <T>(req) => Promise<AiResult<T>> }`; tryb `invalid` → każde wywołanie zwraca `ai_not_configured` i loguje błąd.

#### 8. Testy jednostkowe

**File**: `src/lib/ai/call.test.ts`, `src/lib/ai/live.test.ts`, `src/lib/ai/mode.test.ts`, `src/lib/ai/live.integration.test.ts`

**Intent**: Pokryć każdą gałąź kontraktu bez sieci i bez bazy; jeden opcjonalny test na prawdziwym API.

**Contract**:

- `call.test.ts` (licznik w pamięci, dostawca fake): sukces z `remaining`; `unauthenticated` bez wywołania licznika; `quota_exceeded` bez wywołania dostawcy; `stopReason: "max_tokens"` → `ai_invalid_output` + `finish(failed)`; zły kształt → `ai_invalid_output`; `FakeAiFailure("ai_timeout")` → `ai_timeout`, `retryable: true`; błąd `finish` nie zmienia wyniku.
- `live.test.ts` (SDK z wstrzykniętym `fetch` zwracającym odpowiedzi Messages API): poprawna odpowiedź → `output`; HTTP 500/529 → `ai_unavailable`; 401 → `ai_not_configured`; przerwanie/timeout → `ai_timeout`; brak klucza → `ai_not_configured`; dokładnie jedno żądanie HTTP przy błędzie (brak ponowień).
- `mode.test.ts`: `fake` + `http://127.0.0.1:54321` → `fake`; `fake` + `https://<ref>.supabase.co` → `invalid`; brak → `live`.
- `live.integration.test.ts`: pomijany, chyba że `AI_LIVE_TEST=1` i ustawiony `ANTHROPIC_API_KEY`; jedno małe wywołanie ze schematem zwraca dane zgodne ze schematem i loguje czas.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- Lint passes: `npm run lint`
- Type checking passes: `npx astro check`
- Build passes: `npm run build`

#### Manual Verification:

- With a real key, `AI_LIVE_TEST=1 npx vitest run src/lib/ai/live.integration.test.ts` returns schema-valid data; note the observed latency

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: CI, sekrety i dokumentacja

### Overview

Testy JS w CI, tryb fake w smoke, opis konfiguracji i przewodnik dla agentów obok kodu AI.

### Changes Required:

#### 1. CI

**File**: `.github/workflows/ci.yml`

**Intent**: Uruchamiać testy jednostkowe przy każdym PR, a smoke budować w trybie fake (bez klucza).

**Contract**: Job `ci`: krok `run: npm test` po `npm run lint`. Job `smoke`: w `printf` z linii 53 dopisać `AI_MODE=fake`.

#### 2. Konfiguracja lokalna i produkcyjna

**File**: `.env.example`, `README.md`

**Intent**: Opisać, skąd wziąć klucz, jak go ustawić i kiedy używać trybu fake.

**Contract**: `.env.example`: `ANTHROPIC_API_KEY=###` oraz `AI_MODE=live` z komentarzem o trybie fake. README: nowa sekcja „AI calls” — klucz w `.dev.vars` lokalnie i `npx wrangler secret put ANTHROPIC_API_KEY` na produkcji (krok człowieka); `AI_MODE=fake` działa tylko z lokalnym Supabase; limity 20/100 dziennie liczone w Europe/Warsaw; `npm test` i opcjonalny test live (`AI_LIVE_TEST=1`).

#### 3. Przewodnik katalogowy

**File**: `src/lib/ai/AGENTS.md`, `src/lib/ai/CLAUDE.md`

**Intent**: Każdy wycinek (człowiek lub agent) dodaje wywołania AI tą samą ścieżką.

**Contract**: `AGENTS.md` 120–250 słów, bez wklejonego kodu, z odwołaniami `@`: każde wywołanie AI przez `getAi(...).call` (`@index.ts`), nigdy własny klient Anthropic; endpoint zwraca wynik przez `aiResponse` (`@response.ts`); nowe zadanie = schemat zod + fixture w `@fixtures.ts` + testy; nie dodawać ponowień (każde wywołanie zużywa limit); limity zmienia się wyłącznie w migracji z funkcją `begin_ai_call`. `CLAUDE.md`: jedna linia `@AGENTS.md`.

#### 4. Roadmapa

**File**: `context/foundation/roadmap.md`

**Intent**: Zapisać decyzję o granicy dnia dla kolejnych wycinków.

**Contract**: W `## Open Roadmap Questions` pytanie 3 oznaczone jako rozstrzygnięte: dzień = data kalendarzowa w Europe/Warsaw, jedna strefa dla wszystkich kont (decyzja F-02, 2026-10-18).

### Success Criteria:

#### Automated Verification:

- Formatting check passes: `npx prettier --check src/lib/ai/AGENTS.md README.md .env.example context/foundation/roadmap.md`
- CI jobs `ci` (including `npm test`) and `smoke` (with `AI_MODE=fake`) pass on the PR

#### Manual Verification:

- `src/lib/ai/AGENTS.md` has 120–250 words and references files by path instead of pasting code

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- `callAi`: każda gałąź kontraktu (sukces, brak logowania, limit, `max_tokens`, zły kształt, błędy dostawcy, błąd `finish`).
- Dostawca live na wstrzykniętym `fetch`: mapowanie statusów HTTP i timeoutu, brak ponowień.
- `resolveAiMode`: blokada trybu fake przy zdalnej bazie.

### Integration Tests:

- pgTAP `ai_calls.test.sql`: limit 20/100, rozdzielność rodzajów, granica dnia, izolacja kont, brak bezpośredniego zapisu, `anon` bez dostępu.
- Strażnik RLS z udokumentowanym wyjątkiem dla `ai_calls`.

### Manual Testing Steps:

1. Lokalnie z prawdziwym kluczem: `AI_LIVE_TEST=1 npx vitest run src/lib/ai/live.integration.test.ts` — dane zgodne ze schematem, zanotować czas odpowiedzi Sonnet 5.5.
2. Po merge: `npx supabase db push` i `npx supabase migration list` — nowa migracja widoczna lokalnie i zdalnie.
3. Po merge: `npx wrangler secret put ANTHROPIC_API_KEY` (krok człowieka); logowanie i `/dashboard` na produkcji działają jak wcześniej.

## Performance Considerations

Oczekiwanie na odpowiedź Claude nie zużywa CPU Workera; walidacja zod obiektu rzędu kilku KB to mikrosekundy. `begin_ai_call` liczy wiersze po indeksie `(user_id, kind, called_on)` — maks. 100 wierszy na konto i dzień. Sonnet 5.5 dla generacji kilku tysięcy tokenów może trwać kilkadziesiąt sekund — dłuższy czas zwiększa ryzyko przerwania przy zablokowanym telefonie (zaakceptowane ryzyko; S-02 może zmienić model generacji przez parametr `model`).

## Migration Notes

Migracja `create_ai_calls` jest addytywna (nowa tabela i dwie funkcje). Wycofanie: nowa migracja usuwająca funkcje i tabelę — tracona jest tylko historia wywołań AI. Kod korzystający z `callAi` pojawia się dopiero w S-02, więc kolejność `db push` względem deployu F-02 nie ma znaczenia; dla S-02 migracja musi być wypchnięta przed merge.

## References

- Roadmap item: `context/foundation/roadmap.md` → F-02
- PRD: `context/foundation/prd.md` (FR-028, NFR limity 20/100, NFR brak wrażenia zawieszenia)
- Infra constraints: `context/foundation/infrastructure.md` (CPU, rozłączenie klienta, sekrety, Risk Register)
- Wzorzec tabel i testów: `supabase/AGENTS.md`, `supabase/tests/database/account_isolation.test.sql`, `supabase/tests/database/rls_guard.test.sql`
- Poprzedni fundament: `context/archive/2026-10-17-per-account-data-isolation/plan.md`
- Supabase client: `src/lib/supabase.ts`; env schema: `astro.config.mjs:18-25`; CI: `.github/workflows/ci.yml`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Baza — tabela ai_calls i limity

#### Automated

- [x] 1.1 Migration file exists under `supabase/migrations/` and lint passes: `npm run lint`
- [ ] 1.2 CI job `smoke` passes, with `Database tests` reporting `account_isolation`, `ai_calls` and `rls_guard` as ok

### Phase 2: Moduł AI z testami jednostkowymi

#### Automated

- [ ] 2.1 Unit tests pass: `npm test`
- [ ] 2.2 Lint passes: `npm run lint`
- [ ] 2.3 Type checking passes: `npx astro check`
- [ ] 2.4 Build passes: `npm run build`

#### Manual

- [ ] 2.5 With a real key, `AI_LIVE_TEST=1 npx vitest run src/lib/ai/live.integration.test.ts` returns schema-valid data; note the observed latency

### Phase 3: CI, sekrety i dokumentacja

#### Automated

- [ ] 3.1 Formatting check passes: `npx prettier --check src/lib/ai/AGENTS.md README.md .env.example context/foundation/roadmap.md`
- [ ] 3.2 CI jobs `ci` (including `npm test`) and `smoke` (with `AI_MODE=fake`) pass on the PR

#### Manual

- [ ] 3.3 `src/lib/ai/AGENTS.md` has 120–250 words and references files by path instead of pasting code
