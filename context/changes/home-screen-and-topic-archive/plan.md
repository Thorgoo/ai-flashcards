# S-08: Ekran główny i archiwizacja tematów — plan implementacji

## Overview

`/dashboard` staje się ekranem głównym z FR-021: lista tematów, a przy każdym liczba fiszek do powtórki i data ostatniej sesji. Dochodzi FR-007: zmiana nazwy tematu, archiwizacja po potwierdzeniu (bez usuwania danych) i przywracanie. Przy okazji zamykamy dwie dziury z przeglądu S-02, odnotowane w roadmapie (`context/foundation/roadmap.md` § S-08 Unknowns): przez PostgREST da się dziś zmienić `scope_note` zatwierdzonego tematu i usunąć temat.

## Current State Analysis

- **Brak archiwizacji.** `topics` nie ma kolumny archiwizacji (`supabase/migrations/20261022163613_create_topics_and_subtopics.sql:5-15`).
- **Trigger blokuje zmianę nazwy, ale nie `scope_note`.** `guard_topic_status` przepuszcza zatwierdzony temat tylko wtedy, gdy status zostaje `confirmed` (`:76-82`), a nie porównuje innych kolumn. Dlatego zmiana nazwy działa (trigger jej nie blokuje), ale zmiana `scope_note` też przechodzi. Polityka `owner can delete` (`:27-28`) pozwala usunąć dowolny temat.
- **Dashboard.** `src/pages/dashboard.astro:11` woła `listTopics` (`src/lib/topics/repository.ts:82`, sortowanie `created_at desc`) i renderuje nazwę oraz badge statusu. Nie ma wyspy React ani żadnych danych o nauce.
- **„Do powtórki”.** Predykat sesji nauki to `stage in ('choice','open') and due_on <= dziś (Europe/Warsaw)` (`src/lib/topics/study-repository.ts:61,79-87`). `countDueCards` liczy go dla jednego tematu (`:117-127`). Indeks `flashcards (topic_id, stage, due_on)` istnieje (`supabase/migrations/20261026172800_flashcard_study_state.sql:19`).
- **„Ostatnia sesja”.** Tabela sesji nie istnieje. Każda odpowiedź na fiszkę to wiersz `flashcard_answers` z `answered_on date` (data warszawska) i indeksem `(topic_id, answered_on)` (`20261026172800_flashcard_study_state.sql:22-39`).
- **Blokady w API.** Każda trasa `/api/topics/[id]/*` zaczyna od `loadTopic` (`src/lib/topics/http.ts:47`). Strony `src/pages/topics/[id].astro:15`, `[id]/quiz.astro:14`, `[id]/flashcards.astro:20` i `[id]/study.astro:15` wołają `getTopic` bezpośrednio. Zadania w tle (`src/lib/topics/flashcard-job.ts`, `generateQuiz` przez `waitUntil` w `quiz/index.ts:37-41`) nie używają `loadTopic`.
- **UI.** W `src/components/ui` są `alert-dialog`, `input`, `badge`, `button` i `collapsible`. Wzorzec zwijanej sekcji jest w `src/components/topics/FlashcardBatch.tsx:178`. Klient API to `callApi` (`src/components/topics/api.ts`). Etykiety są w `src/components/topics/labels.ts`.
- **Testy, które dziś usuwają tematy.** `account_isolation.test.sql:132` (B usuwa temat A, `lives_ok`) oraz testy kaskady: `topics.test.sql:200`, `flashcards.test.sql:387`, `quizzes.test.sql:259` i `flashcard_study.test.sql:237`. Te ostatnie wykonują `delete from public.topics` jako `authenticated`.
- **Zasady obszarów.** `supabase/AGENTS.md`:
  - tylko nowe, rozszerzające migracje;
  - `rls_guard.test.sql` wymaga polityki per komenda, a wyjątek trzeba wpisać z powodem;
  - testy DB działają tylko w CI;
  - `db push` wykonuje człowiek.

  `src/lib/topics/AGENTS.md`:
  - błędy przez `topicErrorResponse`, nowy kod zamiast nowego kształtu;
  - smoke trzeba rozszerzyć przy zmianie endpointu;
  - kolumny nauki zmieniają wyłącznie RPC odpowiedzi.

  `CLAUDE.md` § UI: tokeny i komponenty z `src/components/ui`.
- **Inne pliki.** `context/foundation/lessons.md` nie istnieje. S-09 i S-10 jeszcze nie powstały, więc wykluczenie zarchiwizowanych tematów z serii i odznak należy do nich (roadmapa § S-08 Risk).

## Desired End State

`/dashboard` (ekran główny) pokazuje aktywne tematy, od najnowszego. Każdy wiersz zawiera:
- nazwę jako link do tematu;
- badge statusu;
- „Do powtórki: N”, gdzie N to liczba fiszek, które sesja „Ucz się” podałaby teraz;
- „Ostatnia sesja: 29.10.2026” albo „Ostatnia sesja: —”, gdy temat nie ma żadnej odpowiedzi na fiszkę.

Każdy wiersz ma akcje „Zmień nazwę” (edycja w miejscu) i „Archiwizuj”. Archiwizacja otwiera AlertDialog z informacją, że dane nie są usuwane i temat można przywrócić. Pod listą jest zwinięta sekcja „Zarchiwizowane (N)” z przyciskiem „Przywróć” przy każdym temacie.

Przykład: temat ma fiszki A (`due_on` = wczoraj, `stage` open), B (dziś, choice), C (jutro, choice) i D (wczoraj, mastered). Wtedy „Do powtórki: 2” (A i B). Ostatnia odpowiedź padła 29.10, a quiz ukończono 30.10, więc „Ostatnia sesja: 29.10.2026”.

Zarchiwizowany temat:
- znika z listy aktywnej;
- jego strony `/topics/[id]*` przekierowują na `/dashboard`;
- każda trasa `/api/topics/[id]/*` zwraca 409 `topic_archived`, a działa tylko przywrócenie przez `PATCH /api/topics/[id]`;
- generowanie trwające w chwili archiwizacji kończy się i zapisuje wynik.

Po przywróceniu wszystko wraca bez utraty danych.

Baza:
- zatwierdzony temat pozwala zmienić tylko `name` i `archived_at`; `scope_note` jest zamrożony;
- `authenticated` nie może usunąć tematu;
- `topic_overview()` zwraca wiersze tylko własnego konta.

### Key Discoveries:

- **Wartość `archived_at` ustawia trigger.** Przejście `null → nie-null` ustawia `now()` niezależnie od podanej wartości. `nie-null → null` przywraca. `nie-null → inna nie-null` zachowuje starą wartość. Dzięki temu klient nie może podać własnej daty.
- **„Ostatnia sesja” to `max(answered_on)`.** To już data warszawska, więc nie trzeba konwertować strefy w TS. Formatowanie to czysta zamiana `YYYY-MM-DD → DD.MM.YYYY`.
- **„Dziś” w `topic_overview()` liczy baza.** Używa `(now() at time zone 'Europe/Warsaw')::date`, tak samo jak `answer_flashcard_*`. Licznik i sesja widzą więc tę samą datę.
- **Bez polityki `delete` samo RLS cicho usunęłoby 0 wierszy.** Dlatego odbieramy też uprawnienie: `revoke delete on public.topics from authenticated`. Próba usunięcia kończy się wtedy błędem 42501, a nie mylącym sukcesem.

## What We're NOT Doing

- Nie wykluczamy zarchiwizowanych tematów z serii dni, odznak ani celu dziennego. S-09 i S-10 jeszcze nie istnieją i zrobią to same (roadmapa § S-08 Risk), a FR-022 jest zaparkowany.
- Nie przerywamy ani nie blokujemy generowania quizu lub partii przy archiwizacji. `flashcard-job.ts` i `generateQuiz` zostają bez zmian.
- Nie dodajemy widoku tylko do odczytu dla zarchiwizowanego tematu. Strony przekierowują.
- Nie blokujemy w bazie RPC odpowiedzi (`answer_flashcard_*`) ani claimów dla zarchiwizowanych tematów. Blokada działa na poziomie API (`loadTopic`).
- Nie dajemy możliwości trwałego usuwania tematów, także szkiców. Usunięcie konta nadal kaskaduje.
- Nie zmieniamy `/` (Welcome) ani nawigacji w `Topbar`.
- Nie pokazujemy osobno fiszek zaległych i dzisiejszych. Nie liczymy ukończenia quizu jako sesji.
- Nie zmieniamy edycji `scope_note` w szkicu, bo nie ma do niej UI.

## Implementation Approach

Kolejność to baza → serwer → UI, zgodnie ze wzorcem „zmiany w bazie”.

1. **Baza.** Jedna nowa migracja rozszerzająca: kolumna z wartością domyślną `null`, nowa definicja triggera, odebranie DELETE i funkcja odczytu. Stary Worker działa na nowym schemacie, bo nigdy nie usuwa tematów ani nie zmienia `scope_note`.
2. **Agregacja.** Liczbę do powtórki i datę liczy jedna funkcja SQL `security invoker`, więc RLS obowiązuje. Zapytania per temat z TS dawałyby N+1.
3. **Serwer.** Blokada zarchiwizowanego tematu siedzi w jednym miejscu, `loadTopic`. Trasa PATCH ładuje temat z wyjątkiem dla archiwum, bo tylko ona przywraca.
4. **UI.** Jedna wyspa React na dashboardzie dostaje dane z SSR i po udanym PATCH aktualizuje wiersz lokalnie. Zmiana nazwy i archiwizacja nie zmieniają licznika ani daty.

## Faza 1: Baza — archiwizacja, reguły zapisu, `topic_overview()`

### Overview

Schemat i reguły zapisu tematu zgodne z FR-007 oraz funkcja odczytu dla ekranu głównego, pokryte pgTAP.

### Changes Required:

#### 1. Migracja

**File**: `supabase/migrations/<timestamp>_topic_archive_and_overview.sql` (przez `npx supabase migration new topic_archive_and_overview`)

**Intent**: Dodać archiwizację. Ograniczyć zapis zatwierdzonego tematu do nazwy i archiwizacji. Zabronić usuwania tematu przez konto. Dać ekranowi głównemu jedną funkcję z liczbą fiszek do powtórki i datą ostatniej sesji per temat.

**Contract**:
- `alter table public.topics add column archived_at timestamptz` (nullable, domyślnie `null`).
- `create or replace function public.guard_topic_status()` zachowuje dotychczasowe reguły statusu i `confirmed_at`, a dodatkowo:
  - dla `UPDATE` na zatwierdzonym temacie `new.scope_note is distinct from old.scope_note` daje błąd `topic_not_editable` (P0409);
  - `archived_at` dla INSERT zawsze `null`. Dla UPDATE: `null → nie-null` ustawia `now()`, `nie-null → null` zostaje, `nie-null → nie-null` przyjmuje `old.archived_at`. Dotyczy to obu statusów.
  
  Zmiana `name` jest dozwolona w obu statusach (ograniczenie długości z tabeli nadal obowiązuje).
- `drop policy "owner can delete" on public.topics;` oraz `revoke delete on public.topics from authenticated;`. Komentarz: archiwizacja zastępuje usuwanie (FR-007), a usunięcie konta kaskaduje.
- `create function public.topic_overview()`:
  - `returns table (id uuid, name text, status text, archived_at timestamptz, created_at timestamptz, due_count integer, last_studied_on date)`;
  - `language sql stable security invoker set search_path = ''`;
  - zwraca wszystkie tematy konta (aktywne i zarchiwizowane), `order by created_at desc`;
  - `due_count` to liczba fiszek tematu z `stage in ('choice','open') and due_on <= (now() at time zone 'Europe/Warsaw')::date`, a 0 dla tematu bez fiszek;
  - `last_studied_on` to `max(flashcard_answers.answered_on)` tematu albo `null`;
  - komentarz, że predykat jest lustrem `getStudySession` (`src/lib/topics/study-repository.ts`) i oba miejsca trzeba zmieniać razem.
- `grant execute on function public.topic_overview() to authenticated` (bez `anon`/`public`, zgodnie z pierwszą migracją).

#### 2. Testy bazy

**File**: `supabase/tests/database/topic_archive.test.sql` (nowy)

**Intent**: Udowodnić reguły zapisu, archiwizację i wartości `topic_overview()`.

**Contract**: przypadki do pokrycia:
- zmiana nazwy szkicu i zatwierdzonego tematu przechodzi;
- zmiana `scope_note` zatwierdzonego tematu rzuca `topic_not_editable`, a w szkicu przechodzi;
- archiwizacja z podaną datą zapisuje `now()`, ponowne ustawienie innej daty zachowuje pierwszą, a przywrócenie zeruje;
- INSERT z `archived_at` zapisuje `null`;
- `delete from public.topics` jako `authenticated` rzuca 42501;
- `topic_overview()` dla przykładu A/B/C/D z Desired End State zwraca `due_count = 2`;
- `last_studied_on` jest maksimum z `answered_on`, a dla tematu bez odpowiedzi `null`;
- szkic ma `due_count = 0`;
- konto B nie widzi tematów A w `topic_overview()`.

Fiszki i odpowiedzi wstawiamy po `reset role`, wzorem fixtur w `flashcard_study.test.sql`.

#### 3. Dostosowanie istniejących testów

**File**: `supabase/tests/database/account_isolation.test.sql`, `rls_guard.test.sql`, `topics.test.sql`, `flashcards.test.sql`, `quizzes.test.sql`, `flashcard_study.test.sql`

**Intent**: Brak DELETE dla `authenticated` łamie testy, które dziś usuwają tematy. Testy kaskady dalej mają sprawdzać kaskadę, bo to ścieżka usunięcia konta.

**Contract**:
- `account_isolation.test.sql:132`: `lives_ok` zamienić na `throws_ok(..., '42501', ...)` z opisem „account B cannot delete topics”.
- `rls_guard.test.sql`: wpis w `rls_guard_exceptions` dla `topics`, zwalniający tylko kontrolę polityki DELETE, z powodem „archive replaces delete (FR-007); account deletion cascades”.
- Testy kaskady (`topics.test.sql:200`, `flashcards.test.sql:387`, `quizzes.test.sql:259`, `flashcard_study.test.sql:237`): wykonać `delete` po `reset role`, a dalej jako właściciel, czyli tą ścieżką, którą idzie kaskada konta. Asercje po kaskadzie zostają bez zmian. Zaktualizować `plan(n)`, jeśli zmieni się liczba testów.

### Success Criteria:

#### Automated Verification:

- Migracja i testy bazy przechodzą w CI (`smoke` → `Database tests`)
- `topic_archive.test.sql` pokrywa zmianę nazwy, zamrożenie `scope_note`, datę archiwizacji ustawianą przez trigger, przywrócenie, brak DELETE, `due_count` i `last_studied_on` dla przykładu A/B/C/D oraz izolację konta
- `rls_guard.test.sql` i `account_isolation.test.sql` przechodzą z wyjątkiem dla DELETE na `topics`
- Lint przechodzi: `npm run lint`

#### Manual Verification:

- Przegląd migracji: wyłącznie rozszerzająca, stara migracja nietknięta, brak `grant` dla `anon`/`public`, komentarz o lustrze predykatu `getStudySession` obecny

**Implementation Note**: Po fazie i zielonym CI zatrzymaj się na ręczne potwierdzenie przed kolejną fazą.

---

## Faza 2: Serwer — repozytorium, PATCH, blokada zarchiwizowanych

### Overview

Warstwa TS dla przeglądu, zmiany nazwy i archiwizacji. Jedna trasa PATCH. Zarchiwizowany temat jest zablokowany w API i na stronach.

### Changes Required:

#### 1. Repozytorium

**File**: `src/lib/topics/repository.ts`

**Intent**: Wystawić datę archiwizacji i przegląd tematów oraz dodać operacje zmiany nazwy i archiwizacji/przywracania.

**Contract**:
- `Topic` dostaje `archivedAt: string | null`, a `TOPIC_COLUMNS`, `TopicRow` i `toTopic` dostają `archived_at`.
- `interface TopicOverview { id; name; status: TopicStatus; archivedAt: string | null; createdAt; dueCount: number; lastStudiedOn: string | null }`.
- `listTopicOverview(supabase): Promise<TopicOverview[]>` przez `supabase.rpc("topic_overview")`, a błąd rzuca wyjątek, jak `listTopics`. Zastępuje `listTopics`, które usuwamy, bo dashboard był jedynym wywołaniem.
- `renameTopic(supabase, id, name): Promise<RepoResult<Topic | null>>` i `setTopicArchived(supabase, id, archived: boolean): Promise<RepoResult<Topic | null>>` robią `update … eq("id") .select(TOPIC_COLUMNS).maybeSingle()`. Wartość `null` znaczy „nie znaleziono”. Archiwizacja wysyła `archived_at: new Date().toISOString()`, a wartość i tak nadpisuje trigger. Błędy idą przez `errorCode`.

#### 2. Schemat i błędy

**File**: `src/lib/topics/schemas.ts`, `src/lib/topics/errors.ts`

**Intent**: Walidować ciało PATCH i dodać kod błędu zarchiwizowanego tematu.

**Contract**:
- `updateTopicInput` to `z.union` dwóch ścisłych obiektów: `{ name }` (ta sama reguła co `name` w `createTopicInput`: przycięte, 1–`TOPIC_NAME_MAX`) albo `{ archived: boolean }`. Pusty obiekt i obie właściwości naraz kończą się błędem. Do tego eksport typu.
- `TopicErrorCode` dostaje `"topic_archived"` z wartościami `{ message: "Ten temat jest zarchiwizowany. Przywróć go na ekranie głównym.", retryable: false, status: 409 }`.

#### 3. Blokada w `loadTopic`

**File**: `src/lib/topics/http.ts`

**Intent**: Każda trasa `/api/topics/[id]/*` odrzuca zarchiwizowany temat bez zmian w samych trasach.

**Contract**: `loadTopic(supabase, id, options?: { allowArchived?: boolean })`. Gdy temat ma `archivedAt !== null` i nie ma `allowArchived`, zwraca `topicErrorResponse("topic_archived")`. Domyślnie blokuje.

#### 4. Trasa PATCH

**File**: `src/pages/api/topics/[id].ts` (nowy)

**Intent**: Zmiana nazwy, archiwizacja i przywracanie tematu.

**Contract**: `PATCH`, w kolejności:
1. `requireSession`;
2. `loadTopic(..., { allowArchived: true })`;
3. `readJson(updateTopicInput)`;
4. jeśli temat jest zarchiwizowany, a ciało to nie `{ archived: false }`, zwraca 409 `topic_archived`;
5. wywołuje `renameTopic` albo `setTopicArchived`;
6. `null` daje 404, a sukces zwraca `{ data: Topic }`.

Archiwizacja już zarchiwizowanego tematu jest idempotentna: zwraca 200 i bieżący stan.

#### 5. Strony tematu

**File**: `src/pages/topics/[id].astro`, `[id]/quiz.astro`, `[id]/flashcards.astro`, `[id]/study.astro`

**Intent**: Zarchiwizowany temat jest ukryty także pod bezpośrednim adresem.

**Contract**: po `getTopic`, gdy `found?.topic.archivedAt` jest ustawione, `return Astro.redirect("/dashboard")`. Zachowanie 404 dla brakującego tematu zostaje bez zmian.

#### 6. Testy i smoke

**File**: `src/lib/topics/schemas.test.ts`, `scripts/smoke-topics.mjs`

**Intent**: Pokryć walidację PATCH i przepływ end-to-end endpointu (`src/lib/topics/AGENTS.md`: smoke przy zmianie endpointu).

**Contract**:
- Vitest `updateTopicInput` musi przyjąć `{name}` (z przycięciem) i `{archived:true|false}`, a odrzucić `{}`, `{name:""}`, nazwę 101-znakową, `{name, archived}` i nieznany klucz.
- Smoke, kolejne kroki na zatwierdzonym temacie: PATCH zmiany nazwy daje 200 i nową nazwę; PATCH archiwizacji daje 200 i `archivedAt`; `GET /api/topics/[id]/flashcards` daje 409 `topic_archived`; PATCH zmiany nazwy na zarchiwizowanym temacie daje 409; PATCH przywrócenia daje 200 i `archivedAt: null`; GET znów daje 200. Liczba generowań w smoke się nie zmienia.

### Success Criteria:

#### Automated Verification:

- Testy jednostkowe przechodzą: `npm test` (w tym `updateTopicInput` w `schemas.test.ts`)
- Kontrola typów przechodzi: `npx astro check`
- Lint przechodzi: `npm run lint`
- Build przechodzi: `npm run build`
- Smoke w CI przechodzi z krokami zmiany nazwy, archiwizacji, 409 `topic_archived` i przywrócenia

#### Manual Verification:

- Otwarcie `/topics/<id>` zarchiwizowanego tematu (zarchiwizowanego przez API) przekierowuje na `/dashboard`

**Implementation Note**: Po fazie i zielonym CI zatrzymaj się na ręczne potwierdzenie przed kolejną fazą.

---

## Faza 3: UI — ekran główny

### Overview

Wyspa React na `/dashboard` z licznikami, datą ostatniej sesji, zmianą nazwy, archiwizacją z potwierdzeniem i sekcją zarchiwizowanych.

### Changes Required:

#### 1. Etykiety

**File**: `src/components/topics/labels.ts`, `src/components/topics/labels.test.ts` (nowy, jeśli brak)

**Intent**: Czyste, testowalne teksty wiersza.

**Contract**:
- `dueLabel(count: number): string` zwraca `"Do powtórki: N"`.
- `lastSessionLabel(date: string | null): string` zwraca `"Ostatnia sesja: DD.MM.YYYY"` albo `"Ostatnia sesja: —"`. Zamiana stringa `YYYY-MM-DD` odbywa się bez `Date`, więc bez przesunięć strefy.
- Vitest dla obu, w tym `"2026-01-05"` → `"05.01.2026"`.

#### 2. Wyspa ekranu głównego

**File**: `src/components/topics/HomeTopics.tsx` (nowy)

**Intent**: Lista aktywnych tematów z akcjami i zwinięta sekcja zarchiwizowanych. Stan pochodzi z propsów SSR, a każdy udany PATCH aktualizuje wiersz z odpowiedzi.

**Contract**:
- Props: `{ topics: TopicOverview[] }`.
- Wiersz aktywny:
  - link `/topics/{id}` z nazwą;
  - badge `TOPIC_STATUS_LABELS`;
  - `dueLabel` i `lastSessionLabel`, tylko dla `confirmed`, bo szkic nie ma fiszek;
  - przycisk „Zmień nazwę”, który przełącza na `Input` z „Zapisz”/„Anuluj” (Enter zapisuje, Escape anuluje, `maxLength` = `TOPIC_NAME_MAX`);
  - przycisk „Archiwizuj” otwierający `AlertDialog`. Tytuł: „Zarchiwizować temat „{name}”?”, opis: „Temat i jego fiszki znikną z listy. Nic nie zostanie usunięte — możesz go przywrócić w sekcji Zarchiwizowane.”, akcje „Anuluj” i „Archiwizuj”.
- Sekcja `Collapsible` „Zarchiwizowane (N)”, zwinięta domyślnie i ukryta, gdy N = 0. Wiersze mają nazwę bez linku i przycisk „Przywróć”, bez potwierdzenia.
- Każde wywołanie idzie przez `callApi("/api/topics/{id}", "PATCH", body)`. W czasie zapisu przyciski wiersza są wyłączone. Błąd pokazujemy przy wierszu jako `error.message`. Przy `topic_archived` lub `not_found` dodatkowo odświeżamy stronę, bo stan jest nieaktualny.
- Pusty stan, gdy nie ma żadnych tematów, zostaje jak dziś. Gdy są tylko zarchiwizowane: „Wszystkie tematy są zarchiwizowane.” plus sekcja.
- Tylko komponenty z `src/components/ui` i tokeny (`CLAUDE.md` § UI), bez literałów kolorów.

#### 3. Dashboard

**File**: `src/pages/dashboard.astro`

**Intent**: Strona podaje dane z `listTopicOverview` do wyspy.

**Contract**: `listTopicOverview` zamiast `listTopics`. Lista i pusty stan są renderowane przez `<HomeTopics client:load topics={...} />`. Nagłówek z „Nowy temat” zostaje w Astro.

### Success Criteria:

#### Automated Verification:

- Testy jednostkowe przechodzą: `npm test` (`dueLabel`, `lastSessionLabel`)
- Kontrola typów przechodzi: `npx astro check`
- Lint przechodzi: `npm run lint`
- Build przechodzi: `npm run build`

#### Manual Verification:

- Na produkcji, na temacie testowym: dashboard pokazuje „Do powtórki: N” zgodne z liczbą fiszek w „Ucz się (N)” na stronie tematu i datę ostatniej odpowiedzi; temat bez odpowiedzi pokazuje „—”
- Zmiana nazwy (Enter, Escape, pusta nazwa → błąd) działa i przetrwa odświeżenie
- Archiwizacja pokazuje dialog; po potwierdzeniu temat trafia do „Zarchiwizowane (N)”, a jego URL przekierowuje na dashboard
- Przywrócenie przenosi temat z powrotem z tymi samymi fiszkami, postępem i datą ostatniej sesji
- Widok na szerokości telefonu bez poziomego przewijania, fokus widoczny na przyciskach i w dialogu

**Implementation Note**: Po fazie wykonaj testy ręczne na produkcji i zatrzymaj się na potwierdzenie.

---

## Testing Strategy

### Unit Tests:

- `updateTopicInput`: obie gałęzie unii, przycięcie nazwy, odrzucenia (pusty obiekt, pusta lub za długa nazwa, dwie właściwości naraz, nieznany klucz)
- `dueLabel` i `lastSessionLabel`: 0, N, `null`, zera wiodące w dacie

### Integration Tests:

- pgTAP `topic_archive.test.sql`: reguły triggera, brak DELETE, `topic_overview()` (przykład A/B/C/D, szkic, brak odpowiedzi, izolacja)
- Smoke: PATCH zmiany nazwy, archiwizacji i przywrócenia oraz 409 `topic_archived` na trasie tematu

### Manual Testing Steps:

1. Na temacie testowym odpowiedz na jedną fiszkę. Dashboard ma pokazać dzisiejszą datę i licznik zmniejszony o jeden.
2. Zmień nazwę i odśwież. Ma zostać nowa nazwa.
3. Zarchiwizuj i potwierdź. Temat ma się pojawić w sekcji, a `/topics/<id>/study` ma przekierowywać.
4. Przywróć. Licznik, data i fiszki mają być bez zmian.

## Performance Considerations

`topic_overview()` to jedno zapytanie na stronę z agregacjami po istniejących indeksach `flashcards (topic_id, stage, due_on)` i `flashcard_answers (topic_id, answered_on)`. Skala to kilka–kilkanaście tematów na konto, więc cache nie jest potrzebny.

## Migration Notes

Migracja jest rozszerzająca. Istniejące tematy dostają `archived_at = null`, czyli zostają aktywne. Stary Worker nie usuwa tematów i nie zmienia `scope_note`, więc rollback kodu nie trafi na niezgodność. `npx supabase db push` wykonuje człowiek (`supabase/AGENTS.md`).

## References

- Roadmapa: `context/foundation/roadmap.md` § S-08
- PRD: `context/foundation/prd.md` FR-007, FR-021
- Predykat sesji: `src/lib/topics/study-repository.ts:61,79-87,117-127`
- Trigger tematu: `supabase/migrations/20261022163613_create_topics_and_subtopics.sql:63-99`
- Log odpowiedzi: `supabase/migrations/20261026172800_flashcard_study_state.sql:22-39`
- Centralne ładowanie tematu: `src/lib/topics/http.ts:47`
- Wzorzec zwijanej sekcji: `src/components/topics/FlashcardBatch.tsx:178`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Baza — archiwizacja, reguły zapisu, topic_overview()

#### Automated

- [x] 1.1 Migracja i testy bazy przechodzą w CI (`smoke` → `Database tests`) — 7fd7c19
- [x] 1.2 `topic_archive.test.sql` pokrywa zmianę nazwy, zamrożenie `scope_note`, datę archiwizacji ustawianą przez trigger, przywrócenie, brak DELETE, `due_count` i `last_studied_on` dla przykładu A/B/C/D oraz izolację konta — 7fd7c19
- [x] 1.3 `rls_guard.test.sql` i `account_isolation.test.sql` przechodzą z wyjątkiem dla DELETE na `topics` — 7fd7c19
- [x] 1.4 Lint przechodzi: `npm run lint` — 7fd7c19

#### Manual

- [x] 1.5 Przegląd migracji: wyłącznie rozszerzająca, stara migracja nietknięta, brak `grant` dla `anon`/`public`, komentarz o lustrze predykatu `getStudySession` obecny — 7fd7c19

### Phase 2: Serwer — repozytorium, PATCH, blokada zarchiwizowanych

#### Automated

- [x] 2.1 Testy jednostkowe przechodzą: `npm test` (w tym `updateTopicInput` w `schemas.test.ts`)
- [x] 2.2 Kontrola typów przechodzi: `npx astro check`
- [x] 2.3 Lint przechodzi: `npm run lint`
- [x] 2.4 Build przechodzi: `npm run build`
- [ ] 2.5 Smoke w CI przechodzi z krokami zmiany nazwy, archiwizacji, 409 `topic_archived` i przywrócenia

#### Manual

- [ ] 2.6 Otwarcie `/topics/<id>` zarchiwizowanego tematu (zarchiwizowanego przez API) przekierowuje na `/dashboard`

### Phase 3: UI — ekran główny

#### Automated

- [ ] 3.1 Testy jednostkowe przechodzą: `npm test` (`dueLabel`, `lastSessionLabel`)
- [ ] 3.2 Kontrola typów przechodzi: `npx astro check`
- [ ] 3.3 Lint przechodzi: `npm run lint`
- [ ] 3.4 Build przechodzi: `npm run build`

#### Manual

- [ ] 3.5 Na produkcji, na temacie testowym: dashboard pokazuje „Do powtórki: N” zgodne z liczbą fiszek w „Ucz się (N)” na stronie tematu i datę ostatniej odpowiedzi; temat bez odpowiedzi pokazuje „—”
- [ ] 3.6 Zmiana nazwy (Enter, Escape, pusta nazwa → błąd) działa i przetrwa odświeżenie
- [ ] 3.7 Archiwizacja pokazuje dialog; po potwierdzeniu temat trafia do „Zarchiwizowane (N)”, a jego URL przekierowuje na dashboard
- [ ] 3.8 Przywrócenie przenosi temat z powrotem z tymi samymi fiszkami, postępem i datą ostatniej sesji
- [ ] 3.9 Widok na szerokości telefonu bez poziomego przewijania, fokus widoczny na przyciskach i w dialogu
