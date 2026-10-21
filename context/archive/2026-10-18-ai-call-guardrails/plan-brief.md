# Ai call guardrails — Plan Brief

> Full plan: `context/changes/ai-call-guardrails/plan.md`

## What & Why

F-02 buduje jedną serwerową ścieżkę wywołań AI, zanim powstanie pierwsze z nich (S-02). Ścieżka pilnuje dziennych limitów na konto (20 generowań / 100 ocen), waliduje odpowiedź modelu i zwraca czytelny błąd z informacją, czy można ponowić — bo limity i obsługa błędów są trudne do dołożenia do kilku istniejących wywołań (FR-028, NFR limity).

## Starting Point

W aplikacji nie ma żadnego wywołania AI, klucza, walidatora ani test runnera JS; jedyne endpointy (`src/pages/api/auth/*`) zwracają przekierowania. Baza ma wzorzec tabel należących do konta i strażnika RLS z F-01.

## Desired End State

Wycinek dodający funkcję AI pisze tylko schemat odpowiedzi, prompt i fixture: wywołuje `getAi(...).call(...)`, dostaje `AiResult` (dane + pozostały limit albo kod błędu z polskim komunikatem i `retryable`) i zamienia go na odpowiedź HTTP przez `aiResponse`. Każde wywołanie zostaje w tabeli `ai_calls`; w dev i CI działa tryb fake bez klucza.

## Key Decisions Made

| Decision               | Choice                                                                          | Why (1 sentence)                                                                            |
| ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Dostawca i model       | Claude Sonnet 5.5 przez `@anthropic-ai/sdk`, Structured Outputs + walidacja zod | Lepsza jakość generacji (nazwane ryzyko PRD); model nadpisywalny per wywołanie w wycinkach. |
| Granica dnia           | Data kalendarzowa w Europe/Warsaw, jedna strefa dla wszystkich kont             | Pasuje do obu użytkowników, bez kolumny strefy; rozstrzyga pytanie 3 roadmapy.              |
| Co zużywa limit        | Każde wywołanie AI, niezależnie od wyniku                                       | Dosłowne odczytanie PRD; limit realnie ogranicza koszt.                                     |
| Rozłączenie klienta    | Akceptowane ryzyko, brak mechanizmu w F-02                                      | Najprościej; `waitUntil` (30 s) i tak może nie wystarczyć.                                  |
| Licznik i log          | Jedna tabela `ai_calls`, zapis tylko przez funkcje `security definer`           | Jeden byt dla limitu i diagnostyki; użytkownik nie może wyzerować licznika.                 |
| Podstawianie w testach | `AI_MODE=fake` (fixtures), odrzucany przy zdalnym `SUPABASE_URL`                | Ten sam mechanizm w Vitest, dev i E2E z S-02, bez ryzyka na produkcji.                      |
| Zakres testów          | Vitest (Node) + pgTAP; test z perspektywy użytkownika w S-02                    | F-02 nie ma funkcji użytkowej, więc testuje to, co buduje.                                  |
| Ponowienia             | Brak (`maxRetries: 0`, brak pętli w `callAi`)                                   | Każde wywołanie zużywa limit, więc ponawia tylko użytkownik.                                |

## Scope

**In scope:**

- Tabela `ai_calls`, funkcje `begin_ai_call` / `finish_ai_call`, testy pgTAP, wyjątek strażnika
- `src/lib/ai/*`: `callAi`, kody błędów, `aiResponse`, dostawcy live/fake, licznik przez RPC, `getAi`
- Vitest z testami jednostkowymi i opcjonalnym testem live
- `npm test` w CI, `AI_MODE=fake` w smoke, README, `.env.example`, `src/lib/ai/AGENTS.md`

**Out of scope:**

- Prompty, schematy zadań i endpointy użytkowe (S-02+)
- `waitUntil` / request ID przy rozłączeniu, streaming, wskaźnik postępu
- Strefa czasowa per konto, bindingi Cloudflare do limitów, `supabase gen types`

## Architecture / Approach

Endpoint wycinka → `getAi(supabase, user).call(req)` → `begin_ai_call` (blokada na koncie i rodzaju, liczba dzisiejszych wierszy < limit, wstawia `pending`) → dostawca (Claude lub fixture) → sprawdzenie `stop_reason` + `schema.safeParse` → `finish_ai_call` (best effort) → `AiResult` → `aiResponse`. Rdzeń dostaje dostawcę i licznik jako zależności, więc testy działają bez Astro i bazy.

## Phases at a Glance

| Phase                               | What it delivers                                   | Key risk                                                                     |
| ----------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1. Baza — tabela ai_calls i limity  | Licznik/log z limitem 20/100 i testy pgTAP         | Wyścig dwóch równoległych wywołań przy 19/20 (blokada advisory)              |
| 2. Moduł AI z testami jednostkowymi | `callAi`, live/fake, kontrakt błędów, Vitest       | Parametry Structured Outputs/wysiłku w aktualnym SDK; Vitest bez `astro:env` |
| 3. CI, sekrety i dokumentacja       | Testy w CI, smoke w trybie fake, README, AGENTS.md | Brak klucza na produkcji do czasu ręcznego `wrangler secret put`             |

**Prerequisites:** F-01 zarchiwizowane (wzorzec tabel, strażnik RLS, migracja uprawnień); klucz Anthropic API do ręcznego testu live.
**Estimated effort:** ~2–3 sesje w 3 fazach.

## Open Risks & Assumptions

- Sonnet 5.5 dla dłuższej generacji może odpowiadać kilkadziesiąt sekund; zablokowany telefon przerwie wywołanie, a limit i tak spadnie.
- Structured Outputs nie wymusza liczności ani zgodności przy `max_tokens`/`refusal` — walidacja zod jest jedyną gwarancją.
- Limit 10 ms CPU na planie Free — założenie, że walidacja i RPC się mieszczą; przy błędzie 1102 przejście na Paid (`infrastructure.md`).
- Dev na hostowanym Supabase nie może użyć trybu fake (świadoma blokada).

## Success Criteria (Summary)

- Wywołanie powyżej limitu dnia zwraca `quota_exceeded` bez kosztu po stronie dostawcy, a limit resetuje się o północy czasu warszawskiego.
- Zły, ucięty lub nieudany wynik AI zawsze kończy się czytelnym błędem z `retryable`, nigdy wyjątkiem w endpoincie.
- CI przechodzi bez klucza API dzięki trybowi fake; S-02 może od razu napisać test z perspektywy użytkownika.
