# S-09: Licznik serii dni — Implementation Plan

## Overview

Ekran główny (`/dashboard`) dostaje kafelek „Seria: N dni” (FR-023). Seria to liczba kolejnych dni kalendarzowych (Europe/Warsaw), w których konto odpowiedziało na co najmniej jedną fiszkę w aktywnym (niezarchiwizowanym) temacie. Seria jest podstawą odznak za serię w S-10.

## Current State Analysis

- Każda odpowiedź na fiszkę (A/B/C/D i otwarta) to jeden wiersz `flashcard_answers` z `answered_on` = data warszawska ustalana przez bazę (`supabase/migrations/20261026172800_flashcard_study_state.sql:22-39`, `20261028200200_flashcard_open_answers.sql:47`). Indeks `(topic_id, answered_on)` już istnieje.
- „Dzień” = data kalendarzowa Europe/Warsaw, jedna strefa dla wszystkich kont (roadmapa, Open Roadmap Question 3, rozstrzygnięte w F-02).
- `topic_overview()` (`supabase/migrations/20261030152352_topic_archive_and_overview.sql`) to wzorzec odczytu: funkcja SQL `stable security invoker`, `revoke … from public`, `grant … to authenticated`, wywoływana przez `listTopicOverview` (`src/lib/topics/repository.ts:107`).
- `/dashboard` (`src/pages/dashboard.astro`) liczy dane w SSR i przekazuje je do wyspy `HomeTopics`. Etykiety żyją w `src/components/topics/labels.ts` i mają testy w `labels.test.ts`.
- FR-007: zarchiwizowany temat jest wykluczony z serii. Roadmapa § S-08 Risk przypomina, że S-09 musi filtrować `archived_at is null`.
- Brak jakiegokolwiek licznika serii w kodzie i bazie.

## Desired End State

Na `/dashboard`, nad listą tematów, widać kafelek:

- `Seria: N dni` (`1 dzień` dla N = 1), a gdy dziś nie było jeszcze odpowiedzi i N > 0, dopisek „Ucz się dziś, aby utrzymać serię”.
- Dla N = 0: `Seria: 0 dni` z dopiskiem „Odpowiedz na fiszkę, aby zacząć serię”.

Przykład referencyjny (dziś = 30.10): odpowiedzi 25–29.10, brak 30.10 → `Seria: 5 dni` + dopisek. Po pierwszej odpowiedzi 30.10 → `Seria: 6 dni` bez dopisku. Ostatnia odpowiedź 28.10 → `Seria: 0 dni`.

Weryfikacja: pgTAP dla `study_streak()`, Vitest dla `streakLabel`, smoke sprawdza kafelek, ręcznie na produkcji.

### Key Discoveries:

- `answered_on` jest już datą warszawską liczoną przez bazę — seria nie potrzebuje stref czasowych w TS ani nowej kolumny.
- `flashcard_answers.topic_id` pozostaje po usunięciu fiszki (`flashcard_id` → null), więc usunięcie fiszki nie zmienia serii; tylko archiwizacja tematu (FR-007).
- `account_isolation.test.sql` sprawdza, że `anon` nie wykonuje funkcji w `public` — nowa funkcja musi mieć ten sam `revoke`/`grant` co `topic_overview()`.

## What We're NOT Doing

- Quiz diagnostyczny nie liczy się do serii — tylko odpowiedzi na fiszki.
- Brak progu „minimum N odpowiedzi dziennie” — to cel dzienny FR-022 (Parked).
- Brak najdłuższej serii w historii i zapisanego stanu serii — S-10 przyzna odznakę w chwili osiągnięcia progu.
- Brak licznika w Topbarze ani na stronach nauki — tylko kafelek na dashboardzie.
- Archiwizacja/przywrócenie w `HomeTopics` nie odświeża kafelka na żywo; nowa wartość pojawia się przy następnym załadowaniu strony.
- Archiwizacja nie „zamraża” historii: dni zbudowane tylko na zarchiwizowanym temacie znikają z serii, a przywrócenie tematu je oddaje.

## Implementation Approach

Seria liczona przy odczycie, bez przechowywanego stanu: baza → serwer/UI. Funkcja `study_streak()` bierze odrębne `answered_on` konta z tematów `archived_at is null`, wybiera kotwicę (dziś, jeśli jest dzień nauki, w przeciwnym razie wczoraj, jeśli jest) i liczy nieprzerwany ciąg dni wstecz od kotwicy. Brak kotwicy → 0. Dashboard wywołuje ją obok `topic_overview()` w tym samym SSR.

## Phase 1: Baza

### Overview

Migracja z funkcją `study_streak()` i test pgTAP pokrywający semantykę serii.

### Changes Required:

#### 1. Funkcja serii

**File**: `supabase/migrations/<timestamp>_study_streak.sql`

**Intent**: Dodać odczytową funkcję serii dni nauki konta, zgodną z decyzjami: dzień nauki = ≥1 odpowiedź na fiszkę, seria żyje do końca dnia po ostatnim dniu nauki, tematy zarchiwizowane są pomijane. Komentarz nagłówka opisuje te reguły i to, że S-10 ma czytać serię z tej funkcji.

**Contract**: `public.study_streak() returns table (streak_days integer, studied_today boolean)`, zawsze dokładnie jeden wiersz; `language sql stable security invoker set search_path = ''`; filtr `a.user_id = (select auth.uid())` oraz join do `public.topics` z `archived_at is null`; „dziś” = `(now() at time zone 'Europe/Warsaw')::date`, dni po dziś ignorowane. `revoke execute … from public; grant execute … to authenticated`. Brak dni nauki → `(0, false)`.

#### 2. Test pgTAP

**File**: `supabase/tests/database/study_streak.test.sql`

**Intent**: Zablokować semantykę serii. Wiersze `flashcard_answers` wstawiane jako właściciel tabel (`reset role`), bo `authenticated` ich nie pisze; daty względem `(now() at time zone 'Europe/Warsaw')::date`, żeby test nie zależał od dnia uruchomienia.

**Contract**: przypadki:
- brak odpowiedzi → `(0, false)`;
- dziś i wczoraj → `(2, true)`;
- przykład referencyjny: dziś−5 … dziś−1 bez dziś → `(5, false)`;
- ostatnia odpowiedź dziś−2 → `(0, false)`;
- przerwa w środku (dziś, dziś−1, dziś−3) → `(2, true)`;
- kilka odpowiedzi tego samego dnia i w dwóch tematach liczą się jako jeden dzień;
- dzień zbudowany tylko na temacie, który następnie zostaje zarchiwizowany, przerywa serię; po przywróceniu seria wraca;
- odpowiedzi konta B nie wpływają na serię konta A;
- `anon` nie może wykonać funkcji.

### Success Criteria:

#### Automated Verification:

- Migracja i testy bazy przechodzą w CI (`smoke` → `Database tests`)
- `study_streak.test.sql` pokrywa wszystkie przypadki z kontraktu, w tym archiwizację/przywrócenie i izolację konta
- `account_isolation.test.sql` i `rls_guard.test.sql` przechodzą bez zmian
- Lint przechodzi: `npm run lint`

#### Manual Verification:

- Po `db push` (wykonuje człowiek) `select * from study_streak()` w SQL editorze jako zalogowane konto zwraca jeden wiersz zgodny z historią odpowiedzi

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Serwer + UI

### Overview

Odczyt serii w repozytorium, kafelek na dashboardzie, etykieta z odmianą, smoke i jedna linia w przewodniku katalogu.

### Changes Required:

#### 1. Repozytorium

**File**: `src/lib/topics/repository.ts`

**Intent**: Dodać `getStudyStreak` obok `listTopicOverview`, z tym samym stylem obsługi błędu (rzucenie `Error`).

**Contract**: `export interface StudyStreak { days: number; studiedToday: boolean }`; `getStudyStreak(supabase: SupabaseClient): Promise<StudyStreak>` wywołuje `rpc("study_streak")` i mapuje jedyny wiersz (`streak_days`, `studied_today`).

#### 2. Etykiety

**File**: `src/components/topics/labels.ts` (+ `labels.test.ts`)

**Intent**: Tekst kafelka w jednym miejscu, z polską odmianą (`1 dzień`, pozostałe `dni`) i dopiskiem zależnym od stanu.

**Contract**: `streakLabel(days: number): string` → `Seria: 1 dzień` / `Seria: N dni`; `streakHint(streak: StudyStreak): string | null` → „Odpowiedz na fiszkę, aby zacząć serię” dla 0, „Ucz się dziś, aby utrzymać serię” dla N > 0 bez dzisiejszej nauki, `null` gdy dziś już była nauka. Testy: 0, 1, 2, 5, 22, każdy wariant dopisku.

#### 3. Kafelek na dashboardzie

**File**: `src/pages/dashboard.astro`

**Intent**: Wywołać `getStudyStreak` w tym samym SSR co `listTopicOverview` i wyrenderować statyczny kafelek nad `HomeTopics` (bez nowej wyspy), na tokenach (`bg-card`, `border-border`, `text-muted-foreground`) i istniejącej ikonie z `lucide-react`/tekstu — bez literałów kolorów.

**Contract**: kafelek renderuje się tylko gdy `supabase` istnieje; zawiera tekst `streakLabel` i opcjonalny `streakHint`.

#### 4. Smoke

**File**: `scripts/smoke-topics.mjs`

**Intent**: Krok „dashboard lists the account's topics” sprawdza też obecność kafelka serii; konto smoke odpowiadało dziś na fiszki, więc oczekiwany tekst to `Seria: 1 dzień`.

**Contract**: dodatkowy warunek w istniejącym `check` lub osobny `check` po tym samym żądaniu `/dashboard`.

#### 5. Przewodnik katalogu

**File**: `src/lib/topics/AGENTS.md`

**Intent**: Jedna linia w „Study state”: seria pochodzi wyłącznie z `study_streak()` (dzień = ≥1 odpowiedź na fiszkę w aktywnym temacie, data warszawska); S-10 czyta ją stamtąd, nie liczy po swojemu.

**Contract**: sekcja `## Study state (S-05, later S-06/S-08/S-09)`.

### Success Criteria:

#### Automated Verification:

- Testy jednostkowe przechodzą: `npm test` (`streakLabel`, `streakHint`)
- Kontrola typów przechodzi: `npx astro check`
- Lint przechodzi: `npm run lint`
- Build przechodzi: `npm run build`
- Smoke w CI przechodzi z krokiem kafelka serii

#### Manual Verification:

- Na produkcji, na temacie testowym: po odpowiedzi na fiszkę dashboard pokazuje serię ≥ 1 bez dopisku
- Zarchiwizowanie jedynego tematu z dzisiejszą odpowiedzią i przeładowanie strony zmniejsza serię; przywrócenie ją oddaje
- Kafelek czytelny na wąskim ekranie (telefon) i spójny z resztą dashboardu

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- `streakLabel` / `streakHint`: odmiana 0/1/2/5/22 i trzy warianty dopisku.

### Integration Tests:

- pgTAP `study_streak.test.sql`: semantyka serii, archiwizacja/przywrócenie, izolacja, uprawnienia.
- Smoke: kafelek na `/dashboard` po odpowiedziach konta smoke.

### Manual Testing Steps:

1. Na produkcji odpowiedz na fiszkę w temacie testowym i sprawdź kafelek na dashboardzie.
2. Zarchiwizuj temat testowy (jeśli to jedyny dzisiejszy), przeładuj — seria maleje; przywróć — wraca.
3. Sprawdź widok na wąskim ekranie.

## Performance Considerations

Jedno dodatkowe wywołanie RPC na załadowanie dashboardu; skan dni nauki jednego konta po indeksie `flashcard_answers_user_id_idx`. Przy skali jednego użytkownika pomijalne.

## Migration Notes

Migracja tylko rozszerzająca (nowa funkcja); wycofanie = `drop function public.study_streak()`. `db push` wykonuje człowiek.

## References

- Roadmapa: `context/foundation/roadmap.md` § S-09, Open Roadmap Question 3
- PRD: `context/foundation/prd.md` FR-023, FR-007
- Wzorzec funkcji odczytu: `supabase/migrations/20261030152352_topic_archive_and_overview.sql`
- Log odpowiedzi: `supabase/migrations/20261026172800_flashcard_study_state.sql:22-39`
- Poprzedni wycinek: `context/archive/2026-10-30-home-screen-and-topic-archive/plan.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Baza

#### Automated

- [x] 1.1 Migracja i testy bazy przechodzą w CI (`smoke` → `Database tests`) — 6502758
- [x] 1.2 `study_streak.test.sql` pokrywa wszystkie przypadki z kontraktu, w tym archiwizację/przywrócenie i izolację konta — 6502758
- [x] 1.3 `account_isolation.test.sql` i `rls_guard.test.sql` przechodzą bez zmian — 6502758
- [x] 1.4 Lint przechodzi: `npm run lint` — 6502758

#### Manual

- [ ] 1.5 Po `db push` (wykonuje człowiek) `select * from study_streak()` w SQL editorze jako zalogowane konto zwraca jeden wiersz zgodny z historią odpowiedzi

### Phase 2: Serwer + UI

#### Automated

- [x] 2.1 Testy jednostkowe przechodzą: `npm test` (`streakLabel`, `streakHint`)
- [x] 2.2 Kontrola typów przechodzi: `npx astro check`
- [x] 2.3 Lint przechodzi: `npm run lint`
- [x] 2.4 Build przechodzi: `npm run build`
- [ ] 2.5 Smoke w CI przechodzi z krokiem kafelka serii

#### Manual

- [ ] 2.6 Na produkcji, na temacie testowym: po odpowiedzi na fiszkę dashboard pokazuje serię ≥ 1 bez dopisku
- [ ] 2.7 Zarchiwizowanie jedynego tematu z dzisiejszą odpowiedzią i przeładowanie strony zmniejsza serię; przywrócenie ją oddaje
- [ ] 2.8 Kafelek czytelny na wąskim ekranie (telefon) i spójny z resztą dashboardu
