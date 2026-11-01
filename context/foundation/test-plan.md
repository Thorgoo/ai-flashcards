# Test Plan

> Phased test rollout for this project. Strategy is frozen at the top
> (§1–§5); cookbook patterns at the bottom (§6) fill in as phases ship.
> Read before writing any new test.
>
> Refresh: re-run `/10x-test-plan --refresh` when stale (see §8).
>
> Last updated: 2026-11-01

## 1. Strategy

Testy w tym projekcie stosują trzy nienegocjowalne zasady:

1. **Koszt × sygnał.** Wygrywa najtańszy test, który daje rzeczywisty sygnał
   dla danego ryzyka. Nie promuj testu do e2e tylko dlatego, że e2e „wydaje
   się bezpieczniejsze”. Nie nakładaj modelu wizji na deterministyczny diff,
   który już wykrywa regresję.
2. **Obawy użytkownika są pełnoprawnym dowodem.** Ryzyka zakotwiczone w
   „zespół obawia się X, a awaria ujawniłaby się gdzieś w <obszarze>” mają
   taką samą wagę jak linie PRD czy dane hot-spotów.
3. **Ryzyka to scenariusze, nie lokalizacje w kodzie.** Ten plan dokumentuje,
   *co może się zepsuć* i *dlaczego uważamy to za prawdopodobne* — na
   podstawie dokumentów, wywiadu i *sygnału* z bazy kodu (częstotliwość zmian,
   struktura, baza testów). NIE twierdzi, że wie, która linia odpowiada za
   awarię. Tę wiedzę wytwarza `/10x-research` w każdym etapie wdrożenia.
   Jeśli plan i research nie zgadzają się co do miejsca awarii, research jest
   źródłem prawdy.

Hot-spot scope used for likelihood weighting: `src/`, `supabase/` (migrations + tests), `scripts/` — 54 commits/30d.

## 2. Risk Map

Najważniejsze scenariusze awarii, uporządkowane wg wpływ × prawdopodobieństwo.
Kolumna Source cytuje *dowód, który podniósł ryzyko* — nigdy konkretny plik
jako „miejsce awarii” (to zadanie researchu, zob. §1 zasada #3).

| # | Risk (failure scenario) | Impact | Likelihood | Source (evidence — not anchor) |
|---|---|---|---|---|
| 1 | Ponowienie generowania (podtematy, quiz, fiszki, kolejna partia) zapisuje wynik podwójnie albo zużywa dzienny limit, nie dając wyniku | High | High | interview Q1; PRD FR-028 („całkowicie albo wcale”); PRD NFR limit 20/dzień; hot-spot dir `src/lib/topics` (92 file-changes/30d), `src/lib/ai` (33) |
| 2 | Przerwane generowanie (zablokowany telefon, timeout) zostawia osieroconą rezerwację — ponowienie jest zablokowane lub nigdy się nie kończy | High | High | interview Q2; `infrastructure.md` (przerwanie żądania przy rozłączeniu klienta); roadmap F-02 Risk; hot-spot dir `supabase/migrations` (18 migracji/30d, w tym poprawki rezerwacji) |
| 3 | Migracja funkcji odpowiadania psuje przejścia stanu fiszki (A/B/C/D → otwarta, licznik 0/2 → 1/2 → opanowana, reset po błędzie, harmonogram powrotów) | High | High | interview Q3; PRD Business Logic (tabela stanów); PRD FR-015, FR-017, FR-018; hot-spot dir `supabase/migrations` (2 poprawki powtórzonej odpowiedzi w 30d) |
| 4 | Pętla temat → podtematy → quiz → fiszki → nauka psuje się w przeglądarce (złożony widok, routing, stany UI), mimo zielonych testów logiki | High | Medium | interview Q4; PRD US-01, Success Criteria § Primary; hot-spot dir `src/components/topics` (38), `src/pages/topics` (26) |
| 5 | Błąd oceny AI w sesji nauki (odpowiedź otwarta) gubi wpisaną odpowiedź albo mimo błędu zmienia stan/licznik fiszki (dzienny limit ocen jest pobierany celowo także przy błędzie) | High | Medium | PRD Guardrails, FR-028, NFR („wpisana odpowiedź nigdy nie ginie”); hot-spot dir `src/pages/api` (34) |
| 6 | (abuse) Konto B odczytuje lub modyfikuje temat/fiszkę/quiz konta A po ID przez nową tabelę lub funkcję bez ochrony | High | Medium | PRD Access Control, Guardrails; roadmap F-01; hot-spot dir `supabase/tests/database` (40) — każdy wycinek dodaje tabele |
| 7 | (abuse) Równoległe lub powtarzane żądania przekraczają dzienny limit 20/100 — niekontrolowany koszt AI | Medium | Medium | PRD NFR (limity „niezależne od liczby błędów lub ponowień”); hot-spot dir `src/lib/ai` (33) |

### Risk Response Guidance

| Risk | What would prove protection | Must challenge | Context `/10x-research` must ground | Likely cheapest layer | Anti-pattern to avoid |
|------|-----------------------------|----------------|--------------------------------------|-----------------------|-----------------------|
| #1 | Dwa ponowienia po porażce dają dokładnie jeden komplet wyniku, a limit jest obciążony zgodnie z regułą z PRD | „Status 200 przy ponowieniu = brak duplikatu” | Moment pobrania limitu, klucz rezerwacji, transakcyjność zapisu | integration (pgTAP + vitest na fake AI) | Oczekiwana liczba wierszy wzięta z bieżącego kodu zamiast z FR-028 |
| #2 | Po przerwaniu w trakcie generowania kolejna próba po TTL przejmuje rezerwację i kończy się sukcesem | „TTL wystarczy — nikt nie utknie” | Cykl życia rezerwacji, sterowanie czasem w testach, ścieżka wygasania | integration (pgTAP ze sterowanym czasem) | Czekanie na prawdziwy upływ czasu zamiast sterowania zegarem |
| #3 | Każdy wiersz tabeli stanów z PRD daje oczekiwany nowy stan i termin powrotu; powtórzona odpowiedź nie liczy się drugi raz | „Istniejące testy pokrywają wszystkie przejścia” | Funkcje odpowiadania w bazie, pokrycie istniejących testów bazy dla nauki i odpowiedzi otwartych | integration (pgTAP sterowany tabelą; wyrocznia = tabela PRD) | Wyrocznia skopiowana z SQL migracji |
| #4 | Użytkownik w przeglądarce przechodzi pełną pętlę US-01 na fake AI i widzi fiszkę w sesji nauki | „Zielone testy jednostkowe = działający ekran” | Uruchomienie z `AI_MODE=fake`, logowanie konta testowego bez GitHub OAuth, seed danych | e2e (Playwright, jedna ścieżka krytyczna) | e2e dla przypadków, które wykryje integracja; kruche selektory CSS |
| #5 | Przy błędzie oceny odpowiedź zostaje w polu, stan fiszki w bazie (etap, licznik otwarty, termin, dziennik odpowiedzi) się nie zmienia, dzienny licznik ocen rośnie o 1, ponowne wysłanie działa | „5xx = nic się nie stało” (prawda dla fiszki, nie dla limitu ocen); „quiz też ma ocenę AI” (nie ma) | Translacja błędu trasa → UI, kolejność zapisu względem oceny, szew wymuszający błąd oceny w trybie fake AI przez HTTP | integration trasy (fake AI + lokalna baza) + jeden krok e2e | Asercja samego komunikatu bez sprawdzenia stanu w bazie; symulacja błędu tylko w przeglądarce bez dowodu na stan bazy |
| #6 | Konto B dostaje odmowę lub pusty wynik dla każdego zasobu i funkcji konta A — odczyt i zapis | „Zalogowany = uprawniony” | Lista tabel i funkcji vs pokrycie istniejącego testu izolacji | integration (pgTAP, rozszerzenie wzorca) | Test tylko odczytu, bez zapisu i wywołań funkcji |
| #7 | 21. generowanie w dobie jest odrzucane, także przy równoległych żądaniach | „Sprawdzenie licznika przed wywołaniem = szczelne” | Atomowość licznika, wyścig między żądaniami | integration (pgTAP / vitest) | Test sekwencyjny udający współbieżność |

## 3. Phased Rollout

Każdy wiersz to osobny etap wdrożenia otwierający własny folder zmiany przez
`/10x-new`. Status przesuwa się w prawo; orkiestrator aktualizuje go, gdy na
dysku pojawiają się artefakty.

| # | Phase name | Goal (one line) | Risks covered | Test types | Status | Change folder |
|---|---|---|---|---|---|---|
| 1 | Critical-path E2E | Udowodnić, że pełna pętla US-01 działa w przeglądarce na fake AI, a błąd oceny nie gubi odpowiedzi | #4, #5 | e2e (Playwright) + integration | planned | context/changes/testing-critical-path-e2e/ |
| 2 | Retry and claim integrity | Udowodnić, że ponowienie nie duplikuje wyniku ani nie marnuje limitu, przerwanie nie blokuje kolejnej próby, a limit jest szczelny | #1, #2, #7 | integration (pgTAP + vitest) | not started | — |
| 3 | Flashcard state-transition guard | Udowodnić, że każda migracja funkcji odpowiadania zachowuje tabelę stanów z PRD | #3 | integration (pgTAP, table-driven) | not started | — |
| 4 | Isolation and quality gates | Udowodnić, że każda tabela i funkcja jest objęta testem izolacji, i utrwalić e2e w CI | #6 | integration (pgTAP) + gates | not started | — |

Kolejność: Phase 1 pierwsza, bo e2e to jedyna warstwa z zerowym pokryciem (interview Q4) i jest wymagana do zgłoszenia projektu (termin 2026-11-04); Phase 2 i 3 to ryzyka High × High z częściowym istniejącym pokryciem; Phase 4 utrwala poziom bazowy.

## 4. Stack

Test profile: `meaningful` — vitest skonfigurowany, 16 plików testowych skupionych w `src/lib/` (topics, ai, badges), 12 testów pgTAP w `supabase/tests/database/`, 2 skrypty smoke w CI; brak testów tras API, komponentów i e2e.

| Layer | Tool | Version | Notes |
|---|---|---|---|
| unit + integration (TS) | Vitest | ^5.0.5 | Środowisko node, `src/**/*.test.ts`; AI podstawiane przez `AI_MODE=fake` |
| integration (DB) | pgTAP przez Supabase CLI | supabase ^2.23.4 | `npm run db:test`; uruchamiane w CI na lokalnym Supabase |
| smoke | skrypty Node | n/a | `npm run smoke`, `npm run smoke:topics` — konta testowe logowane hasłem |
| e2e | none yet — see Phase 1 | — | Playwright do dodania w Phase 1 |
| accessibility | none — out of scope | — | Nie objęte rolloutem |

**Stack grounding tools (current session):**
- Docs: none — Context7 not available in current session; checked: 2026-11-01
- Search: Exa.ai — available, not used for this plan (no tool-version claims beyond local manifests); checked: 2026-11-01
- Runtime/browser: Claude in Chrome — available; possible manual smoke on prod, not a test layer; checked: 2026-11-01
- Provider/platform: GitHub (`gh`), Linear — available, not used; Cloudflare MCP requires authentication; checked: 2026-11-01

## 5. Quality Gates

| Gate | Where | Required? | Catches |
|---|---|---|---|
| lint + typecheck (`eslint`, `astro check`) | local + CI | required (wired) | składnia / dryf typów |
| unit + integration (vitest) | CI | required (wired) | regresje logiki |
| database tests (`supabase test db`) | CI smoke job | required (wired); extended by Phase 2–4 | regresje funkcji SQL, izolacji, limitów |
| smoke scripts | CI smoke job | required (wired) | uruchomienie aplikacji na lokalnym Supabase |
| e2e on critical flow (Playwright) | CI smoke job + local `npm run e2e` | required (wired in Phase 1) | zepsuta pętla US-01 w przeglądarce; zgubiona odpowiedź przy błędzie oceny |
| manual prod check | Chrome na prod po merge | recommended | błędy specyficzne dla środowiska |

## 6. Cookbook Patterns

### 6.1 Adding a unit test

- **Location**: obok testowanego modułu w `src/lib/`, nazwa `<module>.test.ts`.
- **Reference test**: `src/lib/topics/study-queue.test.ts`.
- **Run locally**: `npm test`.

### 6.2 Adding a database integration test

- TBD — see §3 Phase 2 (wzorzec ponowień i rezerwacji ze sterowanym czasem) i Phase 3 (test przejść sterowany tabelą stanów z PRD).
- **Reference test (istniejący)**: `supabase/tests/database/flashcard_study.test.sql`.
- **Run locally**: `npm run db:test`.

### 6.3 Adding an e2e test

- **Location**: `e2e/<flow>.spec.ts`; wspólne helpery bazy (klient service-role, stan fiszki, liczniki ocen, data w Warszawie) w `e2e/support/supabase.ts`.
- **Reference test**: `e2e/critical-path.spec.ts` — pętla US-01 i błąd oceny z ponowieniem, w jednym `test.describe.serial` na wspólnym temacie.
- **Logowanie**: projekt `setup` (`e2e/auth.setup.ts`) odtwarza konto `e2e@example.com` (świeże limity AI), loguje hasłem do ciasteczek `@supabase/ssr` i zapisuje `storageState`. E-mail musi być w `ALLOWED_EMAILS`.
- **Selektory**: tylko `getByRole` / `getByLabel` / `getByText`; po `fill` w formularzu wyspy React czekaj na aktywny przycisk (hydratacja). Nie przeładowuj stron z `?generate=1` / `?start=1`.
- **Stan bazy**: dane do scenariusza ustawiaj klientem service-role (np. fiszka `open` z `due_on` = wczoraj, żeby była pierwsza w kolejce); asercje UI zawsze uzupełniaj odczytem bazy.
- **Błąd AI**: tekst ze znacznikiem `[fake-ai-fail-once]` (`src/lib/ai/fixtures.ts`) daje jeden prawdziwy błąd 503 serwera na dany tekst; dodaj losowy sufiks, bo smoke i e2e dzielą serwer w CI. Nie używaj `page.route` do symulowania błędów serwera.
- **Run locally**: `npm run e2e` (wymaga lokalnego Supabase z `[auth.email] enable_signup = true`; wrapper podmienia i przywraca `.env` / `.dev.vars`). W CI: krok „Run E2E tests” w jobie `smoke`, raport i trace jako artefakt `playwright-report` przy porażce.

### 6.4 Adding a test for a new table or database function

- TBD — see §3 Phase 4 (wzorzec odmowy dostępu konta B do zasobów konta A, odczyt i zapis).
- **Reference test (istniejący)**: `supabase/tests/database/account_isolation.test.sql`.

### 6.5 Per-rollout-phase notes

- **Phase 1 (Critical-path E2E, 2026-11-01)**: ryzyko #5 dotyczy tylko sesji nauki; nieudana ocena celowo pobiera 1 ocenę z limitu. Dowód stanu bazy w `scripts/smoke-topics.mjs` (krok „a failed grading …”) i w e2e. Każdy nowy test sprawdzono celowym zepsuciem w CI. Ręczne kroki wrappera `npm run e2e` (przywracanie env, Ctrl+C, odmowa przy kopii) czekają na maszynę z Dockerem.

## 7. What We Deliberately Don't Test

- **Odznaki i streak poza istniejącymi testami SQL** — obecne testy bazy wystarczą; to funkcje motywacyjne, poza rdzeniem pętli. Re-evaluate if progi odznak lub reguła streaka zmienią się poza SQL. (Source: Phase 2 interview Q5.)
- **Logowanie GitHub OAuth w e2e** — dwa konta z allowlisty, smoke sprawdza przekierowanie; e2e loguje konto testowe hasłem. Re-evaluate if pojawi się publiczna rejestracja lub drugi dostawca.
- **Spójność oceny prawdziwego modelu AI** — istnieje test integracyjny na prawdziwym modelu; dostrajanie tolerancji (PRD Open Question 2) przez realne użycie, nie test.

## 8. Freshness Ledger

- Strategy (§1–§5) last reviewed: 2026-11-01
- Stack versions last verified: 2026-11-01
- AI-native tool references last verified: 2026-11-01

Refresh (`/10x-test-plan --refresh`) when:

- a new top-3 risk surfaces from the roadmap or archive,
- a recommended tool's `checked:` date is older than three months,
- the project's tech stack changes (new framework, new test runner),
- §7 negative-space no longer matches what the team believes.
