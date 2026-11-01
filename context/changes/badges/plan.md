# S-10: Odznaki — Implementation Plan

## Overview

Użytkownik zdobywa trwałe odznaki za kamienie milowe serii dni (FR-024), za 100% opanowania podtematów tematu (FR-025) i za łączną liczbę opanowanych fiszek (FR-026, licznik historyczny), dostaje komunikat w sesji nauki w chwili zdobycia i przegląda wszystkie odznaki na stronie `/badges` (FR-027). Odznaki przyznaje baza (triggery), więc żadna ścieżka zapisu ich nie pominie.

## Current State Analysis

- Fiszka staje się opanowana wyłącznie w `answer_flashcard_open` (`supabase/migrations/20261028200200_flashcard_open_answers.sql:114-119`, `security definer`, jedna transakcja). Funkcja najpierw aktualizuje `flashcards`, potem wstawia wiersz `flashcard_answers` (`:129-139`); ponowienie tego samego `attempt_id` wraca wcześniej (`:58-70`, `:84-96`) i nic nie wstawia.
- `answer_flashcard_choice` (`20261028192001_answer_flashcard_choice_attempt_conflict.sql`) też wstawia `flashcard_answers` — każda odpowiedź może wydłużyć serię.
- Usunięcie fiszki to bezpośredni `delete` pod RLS (`src/lib/topics/flashcard-repository.ts:377-393`); `flashcard_answers.flashcard_id` przechodzi na `null`. Liczby opanowanych fiszek nie da się odtworzyć po usunięciu — trzeba ją przechowywać.
- `study_streak()` (`20261030200000_study_streak.sql`) liczy serię przy odczycie z `auth.uid()`, pomija tematy zarchiwizowane i jest jedynym źródłem serii (`src/lib/topics/AGENTS.md`). Archiwizacja może skrócić serię — odznaka musi być zapisana w chwili osiągnięcia progu.
- Opanowanie tematu: każdy podtemat ma ≥ 1 fiszkę i wszystkie są `mastered` (`20261029203000_flashcard_claim_ttl_180.sql:107-116`; lustro w `src/lib/topics/mastery.ts`). Temat może przejść w stan opanowany także przez usunięcie ostatniej nieopanowanej fiszki.
- Archiwizacja/przywrócenie: `topics.archived_at` przez `setTopicArchived` (`src/lib/topics/repository.ts:270-285`); tematów się nie usuwa (`revoke delete`).
- UI: dashboard ładuje `topic_overview()` + `study_streak()` (`src/pages/dashboard.astro:11-14`), kafelek serii `:29-37`; linki w `src/components/Topbar.astro:9-18`; chronione trasy `src/middleware.ts:6`; komunikaty w `StudySession.tsx` przez `notice` + `<Alert role="status">` (`:99`, `:235-239`). Brak komponentu toast.

## Desired End State

- Tabela `badges` trzyma zdobyte odznaki konta; żadnej nigdy się nie odbiera.
- Progi: seria 3, 7, 30, 100 dni; opanowane fiszki 10, 50, 100, 250; temat — po jednej odznace na temat.
- Licznik opanowanych fiszek jest per temat, nie maleje po usunięciu fiszki; postęp = suma liczników tematów aktywnych. Przykład: 48 opanowanych, w tym 10 w temacie X; po archiwizacji X postęp to 38/50, zdobyte odznaki zostają; przywrócenie X oddaje 48/50.
- Temat 9/10 → usunięcie jedynej nieopanowanej fiszki → temat opanowany → odznaka tematu (bez komunikatu w sesji, widoczna na `/badges`).
- Odpowiedź na fiszkę, która domyka próg, zwraca nowe odznaki w `data.badges`; StudySession pokazuje „Zdobyto odznakę: …”. Ponowienie tej samej próby zwraca te same odznaki.
- `/badges` pokazuje wszystkie odznaki progów (zdobyte z datą, niezdobyte wyszarzone z postępem, np. „Seria 5/7”, „38/50”) i zdobyte odznaki tematów; dashboard ma kafelek „Odznaki: N” z linkiem; Topbar ma link „Odznaki”.
- Po migracji konto z 60 opanowanymi fiszkami, serią 8 dni i jednym opanowanym tematem ma odznaki 10, 50, 3 dni, 7 dni i odznakę tematu (data = dzień migracji).

### Key Discoveries:

- Kolejność w `answer_flashcard_open`: update `flashcards` → insert `flashcard_answers`. Trigger `after insert` na `flashcard_answers` widzi już opanowaną fiszkę i zna `attempt_id` (`NEW.id`).
- Trigger uruchomiony wewnątrz `security definer` nadal widzi `auth.uid()` z JWT, ale migracja (uzupełnienie wstecz) nie — seria musi mieć wariant z parametrem konta.
- Wzorzec „authenticated tylko czyta, zapisy przez funkcje” już istnieje dla `quizzes`/`quiz_questions` (`src/lib/topics/AGENTS.md`); `rls_guard.test.sql` ma listę `rls_guard_exceptions`.
- `callApi` (`src/components/topics/api.ts:16`) czyta tylko `data`/`remaining`/`error` — nowe pole musi być w `data`.

## What We're NOT Doing

- Odbieranie odznak (po archiwizacji, usunięciu fiszki, przerwaniu serii).
- Odznaki za quiz, najdłuższą serię, cel dzienny (FR-022 parked).
- Ponowna odznaka tematu po tym, jak kolejna partia „odopanuje” temat i zostanie znów opanowany.
- Komunikat o odznace poza sesją nauki (usunięcie fiszki, przywrócenie tematu) i stan „nowe/obejrzane”.
- Biblioteka toastów, animacje, grafiki odznak poza ikonami `lucide-react`.
- Edycja progów w UI; odtwarzanie fiszek opanowanych i usuniętych przed migracją.
- Odznaki tematów zarchiwizowanych przyznawane w trakcie archiwum (tylko po przywróceniu).

## Implementation Approach

Wszystko, co przyznaje odznaki, żyje w bazie: jedna idempotentna funkcja `sync_badges(user, topic, attempt)` sprawdza trzy rodzaje progów i robi `insert … on conflict do nothing`. Wołają ją triggery w każdej chwili, w której stan może przekroczyć próg: wstawienie odpowiedzi (seria, liczba fiszek, temat), usunięcie fiszki (temat), przywrócenie tematu (seria, liczba fiszek, temat). Licznik historyczny zwiększa osobny trigger na przejściu `stage → 'mastered'`. Seria ma jedno źródło: `study_streak()` deleguje do wewnętrznej `study_streak_of(uuid)`. Serwer czyta przegląd odznak jedną funkcją SQL, a trasa odpowiedzi dobiera odznaki po `attempt_id`. Progi są w SQL; TS je odzwierciedla (jak `mastery.ts`).

## Critical Implementation Details

- **Timing & lifecycle** — odznaki odpowiedzi trzeba przyznawać w triggerze na `flashcard_answers` (nie na `flashcards`), bo dopiero tam jest `attempt_id`, a fiszka jest już opanowana. Licznik zwiększa trigger na `flashcards` (przejście `old.stage <> 'mastered' and new.stage = 'mastered'`), który odpala się wcześniej w tej samej transakcji — `sync_badges` widzi więc aktualną sumę.
- **Bezpieczeństwo** — `study_streak_of(uuid)` i `sync_badges(...)` nie mogą być wykonywalne przez `authenticated` (inaczej każdy policzy serię cudzego konta); tylko funkcje triggerów (`security definer`) je wołają.

## Phase 1: Baza

### Overview

Schemat odznak i liczników, przyznawanie w triggerach, uzupełnienie wstecz i testy pgTAP.

### Changes Required:

#### 1. Migracja odznak

**File**: `supabase/migrations/<timestamp>_badges.sql` (przez `npx supabase migration new badges`)

**Intent**: Dodać trwałe odznaki, historyczny licznik opanowanych fiszek per temat i ich przyznawanie, bez zmiany RPC odpowiedzi. Expand-only poza `create or replace study_streak()` o identycznej sygnaturze i wyniku.

**Contract**:
- Tabela `badges`: `id`, `user_id` (wzorzec konta), `kind text check in ('streak','mastered_cards','topic')`, `threshold integer` (null dla `topic`), `topic_id uuid` (null poza `topic`; FK złożony `(topic_id, user_id)` → `topics` jak w `flashcard_answers`), `attempt_id uuid null` (odpowiedź, która przyznała odznakę), `awarded_at timestamptz default now()`. Unikalność: `(user_id, kind, threshold)` dla `streak`/`mastered_cards`, `(user_id, topic_id)` dla `topic` (indeksy częściowe). Check spójności `kind` ↔ `threshold`/`topic_id`. Indeks na `attempt_id`.
- Tabela `topic_mastery_tallies`: `topic_id` (PK, FK złożony z `user_id`), `user_id` (wzorzec konta), `mastered_count integer not null default 0 check >= 0`.
- Obie tabele: RLS jak `isolation_probe`, ale `authenticated` ma tylko `select` (zapisy wyłącznie z funkcji `security definer`) — jak `quizzes`; brakujące polityki zapisu zgłosić w `rls_guard_exceptions` z jednym zdaniem powodu.
- `study_streak_of(p_user uuid) returns table (streak_days integer, studied_today boolean)` — treść obecnej `study_streak()` z `p_user` zamiast `auth.uid()`; `security definer`, bez `execute` dla `authenticated`. `study_streak()` (ten sam kształt i `grant` dla `authenticated`) staje się `security definer` i zwraca `study_streak_of(auth.uid())` — definer jest potrzebny, bo `authenticated` nie ma `execute` na `study_streak_of`; zawężenie do `auth.uid()` w środku zachowuje izolację.
- Progi w jednym miejscu SQL (np. funkcja `badge_thresholds()` lub stałe w `sync_badges`): seria `{3,7,30,100}`, fiszki `{10,50,100,250}`.
- `sync_badges(p_user uuid, p_topic uuid, p_attempt uuid)`: `security definer`, bez `execute` dla `authenticated`. Kroki: (a) progi serii ≤ `study_streak_of(p_user).streak_days`; (b) progi fiszek ≤ suma `mastered_count` po tematach konta z `archived_at is null`; (c) gdy `p_topic` aktywny i spełnia warunek opanowania (każdy podtemat ≥ 1 fiszka, wszystkie `mastered` — ta sama definicja co w `claim_next_flashcard_batch`) → odznaka `topic`. Każdy insert `on conflict do nothing`, z `attempt_id = p_attempt`.
- Triggery:
  - `flashcards after update of stage` (warunek przejścia w `mastered`) → upsert `topic_mastery_tallies` +1.
  - `flashcard_answers after insert` → `sync_badges(new.user_id, new.topic_id, new.id)`.
  - `flashcards after delete` → `sync_badges(old.user_id, old.topic_id, null)`.
  - `topics after update of archived_at` gdy `old.archived_at is not null and new.archived_at is null` → `sync_badges(new.user_id, new.id, null)`.
- `badge_overview()` (`security invoker`, `stable`): jeden wiersz z `streak_days` (z `study_streak()`), `mastered_cards` (suma liczników tematów aktywnych) i tablicą/`jsonb` zdobytych odznak (`kind`, `threshold`, `topic_id`, nazwa tematu, `topics.archived_at is not null`, `awarded_at`), posortowaną po `awarded_at`.
- Uzupełnienie wstecz na końcu migracji: `topic_mastery_tallies` = liczba obecnych fiszek `mastered` per temat; następnie `sync_badges(user, topic, null)` dla każdego tematu każdego konta (oraz raz per konto bez tematu, jeśli konto nie ma tematów — wtedy i tak nie ma serii).

#### 2. Testy pgTAP

**File**: `supabase/tests/database/badges.test.sql`, `supabase/tests/database/account_isolation.test.sql`, `supabase/tests/database/rls_guard.test.sql`

**Intent**: Udowodnić reguły przyznawania i izolację, z datami liczonymi względem dzisiejszej daty warszawskiej (jak `study_streak.test.sql`).

**Contract**: przypadki — seria 3 dni daje odznakę 3 i nie 7, z `attempt_id` ostatniej odpowiedzi; ponowna odpowiedź tego samego dnia nie duplikuje; drugie poprawne open → licznik +1, przy 10 → odznaka 10; usunięcie opanowanej fiszki nie zmniejsza licznika; archiwizacja tematu obniża sumę w `badge_overview()`, odznaki zostają; przywrócenie oddaje sumę i może przyznać próg; usunięcie ostatniej nieopanowanej fiszki daje odznakę tematu; podtemat bez fiszek blokuje odznakę tematu; konto B nie widzi odznak/liczników A i nie może ich wstawić; `authenticated` nie wykona `sync_badges` ani `study_streak_of`; `study_streak()` zwraca to samo co przed migracją (istniejący `study_streak.test.sql` przechodzi bez zmian).

### Success Criteria:

#### Automated Verification:

- CI „Database tests” przechodzi: `npm run db:test` (nowy `badges.test.sql`, rozszerzony `account_isolation.test.sql`, `rls_guard.test.sql`, niezmieniony `study_streak.test.sql`)
- `npm run lint` i `npm test` przechodzą

#### Manual Verification:

- Człowiek wykonuje `npx supabase db push`; na produkcji konto testowe ma odznaki zgodne ze stanem sprzed migracji (zapytanie w Supabase Studio)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Serwer

### Overview

Katalog odznak w TS, odczyt przeglądu, nowe odznaki w odpowiedziach sesji nauki, smoke.

### Changes Required:

#### 1. Katalog i etykiety

**File**: `src/lib/badges/catalog.ts` (+ `catalog.test.ts`)

**Intent**: Lustro progów z SQL i budowa listy do wyświetlenia (wszystkie odznaki progów ze statusem i postępem + zdobyte odznaki tematów).

**Contract**: `STREAK_THRESHOLDS = [3, 7, 30, 100]`, `MASTERED_CARD_THRESHOLDS = [10, 50, 100, 250]` z komentarzem „mirrors <migration>; change both together”; typ `EarnedBadge { kind, threshold | null, topicId | null, topicName | null, topicArchived, awardedAt }`; `badgeLabel(badge)` → „Seria 7 dni”, „50 opanowanych fiszek”, „Temat opanowany: <nazwa>” (odmiana „dzień/dni” z `streakLabel` w `src/components/topics/labels.ts`); `badgeBoard(overview)` → wiersze progów `{ label, earned, awardedAt?, progress: "5/7" }` (postęp ucięty do progu: przy serii 9 próg 7 jest zdobyty, 30 pokazuje „9/30”). Vitest: odmiana, postęp, zdobyta odznaka mimo niższego bieżącego stanu (seria 0, odznaka 3 zdobyta).

#### 2. Repozytorium

**File**: `src/lib/badges/repository.ts`

**Intent**: Odczyt `badge_overview()` i odznak danej próby, wzorem `getStudyStreak` (`src/lib/topics/repository.ts:135-142`).

**Contract**: `getBadgeOverview(supabase)` → `{ streakDays, masteredCards, earned: EarnedBadge[] }`; `getAttemptBadges(supabase, attemptId)` → `EarnedBadge[]` (select z `badges` po `attempt_id`, z nazwą tematu). Błąd → throw, jak istniejące repozytoria.

#### 3. Trasa odpowiedzi

**File**: `src/pages/api/topics/[id]/study/answer.ts`, `src/lib/topics/study-repository.ts`

**Intent**: Po zapisie odpowiedzi (także w gałęzi ponowienia open i choice) dołączyć odznaki tej próby, żeby klient pokazał je bez dodatkowego żądania.

**Contract**: `ChoiceResult` i `OpenResult` dostają `badges: EarnedBadge[]` (pusta tablica, gdy brak). Kształt błędów bez zmian.

#### 4. Smoke

**File**: `scripts/smoke-topics.mjs`

**Intent**: Sprawdzić end-to-end, że odpowiedź zwraca `data.badges` i że opanowanie domyka odznakę.

**Contract**: po pierwszej odpowiedzi `data.badges` jest tablicą; przygotować stan kluczem serwisowym (jak `makeDue`/ustawianie opanowania w S-07) tak, by odpowiedź open przekroczyła próg 10 lub opanowała temat, i oczekiwać odznaki w odpowiedzi; ponowienie tej samej próby zwraca te same odznaki. Liczba generowań bez zmian.

### Success Criteria:

#### Automated Verification:

- `npm test` przechodzi (nowy `catalog.test.ts`)
- `npm run lint` i `npm run build` przechodzą
- CI `npm run smoke:topics` przechodzi z nowymi asercjami odznak

#### Manual Verification:

- Na preview odpowiedź w sesji nauki (DevTools → Network) ma `data.badges`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: UI

### Overview

Strona `/badges`, kafelek na dashboardzie, link w Topbarze, komunikat w sesji nauki, wpis w AGENTS.md.

### Changes Required:

#### 1. Strona odznak

**File**: `src/pages/badges.astro`, `src/middleware.ts`

**Intent**: Przegląd wszystkich odznak (FR-027): sekcja „Seria dni”, „Opanowane fiszki” (zdobyte z datą, niezdobyte wyszarzone z postępem) i „Opanowane tematy” (zdobyte; przy zarchiwizowanym temacie dopisek „zarchiwizowany”; pusty stan z jednym zdaniem). Statyczny SSR jak `dashboard.astro`.

**Contract**: `/badges` dodane do `PROTECTED_ROUTES`; layout `Layout` > `main.mx-auto max-w-2xl p-4` > `Topbar`; kolory tylko z tokenów `global.css` (zdobyta: `text-success`/`border-border`, niezdobyta: `text-muted-foreground`); ikony `lucide-react` (np. `Flame`, `Layers`, `Trophy`); komponenty z `src/components/ui` (`Badge`) — bez nowych literałów kolorów.

#### 2. Dashboard i Topbar

**File**: `src/pages/dashboard.astro`, `src/components/Topbar.astro`

**Intent**: Kafelek „Odznaki: N” (link do `/badges`) obok kafelka serii, ładowany w tym samym `Promise.all`; link „Odznaki” obok „Dashboard” w Topbarze z tymi samymi klasami.

**Contract**: dashboard woła `getBadgeOverview` równolegle z istniejącymi RPC; kafelek ma kształt kafelka serii (`:29-37`).

#### 3. Komunikat w sesji nauki

**File**: `src/components/topics/StudySession.tsx`

**Intent**: Gdy `saved.badges` nie jest puste, pokazać „Zdobyto odznakę: <etykieta>” (kilka → lista) w istniejącym `notice` / `<Alert role="status">` z linkiem do `/badges`.

**Contract**: używa `badgeLabel` z katalogu; komunikat nie blokuje przejścia do kolejnej fiszki.

#### 4. Przewodnik

**File**: `src/lib/topics/AGENTS.md`

**Intent**: Jedna linia: odznaki przyznaje wyłącznie `sync_badges` z triggerów; nie wstawiać ich z TS; progi w migracji i `src/lib/badges/catalog.ts` zmieniać razem.

**Contract**: sekcja „Study state”.

### Success Criteria:

#### Automated Verification:

- `npm run lint`, `npm test`, `npm run build` przechodzą
- CI `npm run smoke` i `npm run smoke:topics` przechodzą

#### Manual Verification:

- Na produkcji (temat testowy): odpowiedź domykająca próg pokazuje komunikat w sesji; `/badges` pokazuje zdobyte z datą i niezdobyte z postępem; kafelek na dashboardzie pokazuje N i prowadzi do `/badges`
- Archiwizacja tematu z opanowanymi fiszkami obniża postęp na `/badges`, zdobyte odznaki zostają; przywrócenie oddaje postęp
- `/badges` bez sesji przekierowuje do logowania

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful.

---

## Testing Strategy

### Unit Tests:

- `catalog.test.ts`: odmiana etykiet, postęp do progu, zdobyta odznaka przy niższym bieżącym stanie, zarchiwizowany temat.

### Integration Tests:

- pgTAP `badges.test.sql` (reguły przyznawania, licznik historyczny, archiwum, usunięcie, izolacja, uprawnienia).
- `smoke-topics.mjs`: `data.badges` w odpowiedzi, odznaka po progu, idempotentne ponowienie.

### Manual Testing Steps:

1. Na produkcji w temacie testowym opanować fiszkę domykającą próg → komunikat w sesji.
2. Otworzyć `/badges` → zdobyta z datą, następny próg z postępem.
3. Zarchiwizować i przywrócić temat → postęp spada i wraca, odznaki zostają.

## Performance Considerations

`sync_badges` przy każdej odpowiedzi liczy serię (skan odpowiedzi konta) i sumę liczników — skala jednego konta, akceptowalne; indeksy `flashcard_answers_user_id_idx` już są.

## Migration Notes

Migracja uzupełnia liczniki z obecnych fiszek `mastered` i przyznaje odznaki z bieżącego stanu (`awarded_at` = chwila migracji, `attempt_id` = null). Fiszek opanowanych i usuniętych przed migracją nie da się odtworzyć — zaakceptowane. `db push` przed wdrożeniem fazy 2 (trasa czyta `badges`).

## References

- Roadmapa: `context/foundation/roadmap.md` (S-10), PRD FR-007, FR-020, FR-024–FR-027
- Seria: `context/archive/2026-10-30-daily-streak/plan-brief.md`, `supabase/migrations/20261030200000_study_streak.sql`
- Opanowanie: `context/archive/2026-10-29-next-batch-and-subtopic-mastery/plan-brief.md`, `src/lib/topics/mastery.ts`
- Odpowiedzi: `supabase/migrations/20261028200200_flashcard_open_answers.sql`, `src/pages/api/topics/[id]/study/answer.ts`

## Deviations

Odstępstwa od tekstu planu wykryte w `reviews/impl-review.md` (F1); zachowanie zgodne z intencją.

- **RLS `badges` / `topic_mastery_tallies`** (faza 1): zamiast samego `select` i wyjątków w `rls_guard_exceptions` obie tabele mają 4 polityki właściciela, a zapisy blokuje `revoke all` + `grant select` (wzorzec `quizzes`); `rls_guard.test.sql` bez zmian.
- **Komunikat w sesji** (faza 3): osobny stan `earned` i własny `<Alert role="status">` zamiast stringa `notice`, bo string nie zmieści listy i linku do `/badges`.
- **Etykiety** (fazy 2–3): `daysLabel` jest w `src/lib/badges/catalog.ts`, a `labels.ts` z niego korzysta (kierunek odwrotny do planu); `awardedLabel` (dzień Europe/Warsaw) i `badgeCountLabel` doszły do `src/components/topics/labels.ts`.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Baza

#### Automated

- [x] 1.1 CI „Database tests” przechodzi: `npm run db:test` (nowy `badges.test.sql`, rozszerzony `account_isolation.test.sql`, `rls_guard.test.sql`, niezmieniony `study_streak.test.sql`) — 15797c8
- [x] 1.2 `npm run lint` i `npm test` przechodzą — 15797c8

#### Manual

- [x] 1.3 Człowiek wykonuje `npx supabase db push`; na produkcji konto testowe ma odznaki zgodne ze stanem sprzed migracji (zapytanie w Supabase Studio)

### Phase 2: Serwer

#### Automated

- [x] 2.1 `npm test` przechodzi (nowy `catalog.test.ts`) — 06ea320
- [x] 2.2 `npm run lint` i `npm run build` przechodzą — 06ea320
- [x] 2.3 CI `npm run smoke:topics` przechodzi z nowymi asercjami odznak — 06ea320

#### Manual

- [x] 2.4 Na preview odpowiedź w sesji nauki (DevTools → Network) ma `data.badges`

### Phase 3: UI

#### Automated

- [x] 3.1 `npm run lint`, `npm test`, `npm run build` przechodzą — 2dc5bdb
- [x] 3.2 CI `npm run smoke` i `npm run smoke:topics` przechodzą — 2dc5bdb

#### Manual

- [x] 3.3 Na produkcji (temat testowy): odpowiedź domykająca próg pokazuje komunikat w sesji; `/badges` pokazuje zdobyte z datą i niezdobyte z postępem; kafelek na dashboardzie pokazuje N i prowadzi do `/badges`
- [x] 3.4 Archiwizacja tematu z opanowanymi fiszkami obniża postęp na `/badges`, zdobyte odznaki zostają; przywrócenie oddaje postęp
- [x] 3.5 `/badges` bez sesji przekierowuje do logowania
