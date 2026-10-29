# S-07: Opanowanie podtematów i kolejna partia — plan implementacji

## Overview

Użytkownik widzi opanowanie per podtemat (FR-020: podtemat opanowany = ma co najmniej jedną fiszkę i wszystkie jego fiszki ze wszystkich partii są opanowane). Po opanowaniu ≥ 80% istniejących fiszek najnowszej partii może przyciskiem wygenerować kolejną partię 10 fiszek (FR-019) — wyłącznie dla nieopanowanych podtematów, rozdzieloną regułą z S-04 według odsetka nieopanowanych fiszek, z listą istniejących pytań w prompcie, żeby AI nie powtarzało fiszek. Domyka pętlę z kryterium sukcesu US-01 (`context/foundation/roadmap.md` § S-07).

## Current State Analysis

- Partie: tabela `flashcard_batches` ma już `seq` i `unique (topic_id, seq)` (`supabase/migrations/20261024095230_create_flashcards.sql:9-21`), ale `claim_flashcard_batch`, `release_flashcard_batch_claim` i `create_flashcard_batch` mają `seq = 1` na sztywno i wymagają ukończonego quizu (`supabase/migrations/20261025182503_claim_tokens_and_option_nulls.sql:23-150`). Wzorzec: claim przed AI (zwraca `claimed_at` jako token), zapis 10 fiszek jednym RPC, zwolnienie claimu po błędzie, TTL 120 s (`FLASHCARD_CLAIM_TTL_SECONDS`, `src/lib/topics/flashcards-task.ts:9`).
- Opanowanie fiszki istnieje od S-06: `flashcards.stage = 'mastered'` (`supabase/migrations/20261026172800_flashcard_study_state.sql:12`), zmieniane wyłącznie przez `answer_flashcard_open`. Opanowania podtematu ani postępu partii nikt dziś nie liczy.
- Rozdział: `batchAllocation(percents)` (`flashcards-task.ts:15-35`) — każdy podtemat ≥ 1, reszta proporcjonalnie do `100 − percent`, remis → wcześniejszy indeks; obsługuje 1–10 podtematów. Schemat zod z kwotami i `toFlashcardRows` są niezależne od numeru partii (`flashcards-task.ts:47-173`).
- Fixtura fake `flashcards` czyta tagi `<podtemat nr typ fiszek wynik="\d+">` z promptu (`src/lib/ai/fixtures.ts:43-60`) — prompt kolejnej partii z tymi samymi tagami (liczba całkowita w `wynik`) działa z nią bez zmian.
- Stan: `getFlashcardState` czyta tylko partię `seq = 1` (`src/lib/topics/flashcard-repository.ts:82-123`) i jest jedynym źródłem dla `GET/POST/DELETE /flashcards`, `src/pages/topics/[id].astro:47`, `[id]/flashcards.astro:29`, `[id]/quiz.astro:26`, `[id]/study.astro:29` (ten ostatni sprawdza `.batch.status === "ready"`).
- Sesja nauki i licznik „Ucz się (N)” czytają fiszki wszystkich partii po `topic_id` (`src/lib/topics/study-repository.ts:76`) — fiszki kolejnej partii trafią do nauki bez zmian.
- UI: `FlashcardBatch.tsx` pokazuje jedną partię pogrupowaną po podtematach z usuwaniem i „Czytaj więcej”, `GeneratingNotice` + polling co 2 s, obsługa `batch_generating`/`batch_exists` przez odświeżenie (`src/components/topics/FlashcardBatch.tsx:33-82`). `TopicEditor.tsx` → `ConfirmedList` pokazuje zatwierdzone podtematy z typem treści (`src/components/topics/TopicEditor.tsx:285-341`).
- Smoke ma klienta z kluczem serwisowym i helpery przygotowujące stan (`makeDue`, `scripts/smoke-topics.mjs:26-36`), kopię `batchAllocation` (`:49`), a pętla limitu generowań startuje od 5 (`:504`).
- Follow-up F1 z S-04 (`context/archive/2026-10-24-first-weak-subtopic-batch/follow-ups/review-fixes.md`): `waitUntil` daje ~30 s, generowanie 27–35 s — decyzja: zostaje, mierzymy partię 2.
- Brak `context/foundation/lessons.md`. Reguły: `src/lib/topics/AGENTS.md` (kontrole przed AI, `topicErrorResponse`, smoke przy zmianie endpointu), `src/lib/ai/AGENTS.md` (fixtura + Vitest na zadanie), `supabase/AGENTS.md` (tylko nowe migracje, rozszerzające; testy DB tylko w CI; `db push` robi człowiek), `CLAUDE.md` § UI (tokeny, komponenty z `src/components/ui`).

## Desired End State

Strona tematu (po ukończonym quizie i wygenerowaniu partii 1) pokazuje przy każdym podtemacie „Opanowane X/Y” i znacznik „Opanowany”, gdy Y ≥ 1 i X = Y; gdy wszystkie podtematy są opanowane — informację „Temat opanowany”. Strona `/topics/[id]/flashcards` pokazuje wszystkie partie: najnowszą rozwiniętą na górze, starsze jako zwijane sekcje „Partia N”, w każdej fiszki pogrupowane po podtematach z oznaczeniem opanowanej fiszki; usuwanie działa w każdej partii. Nad partiami: postęp bieżącej partii („Opanowane w partii: 6/10 — kolejna partia od 8”) i przycisk „Wygeneruj kolejną partię”, aktywny gdy `opanowane × 5 ≥ istniejące × 4` i jest choć jeden nieopanowany podtemat. Kliknięcie generuje partię N+1 (10 fiszek tylko z nieopanowanych podtematów, każdy ≥ 1, więcej dla słabszych) z tym samym postępem, pollingiem i odpornością na przeładowanie co partia 1.

Przykład rozdziału: podtematy A (4/4 opanowane), B (1/3), C (0/2), D (0 fiszek — usunięte) → A pominięty; słabość: D 0%, C 0%, B 33% → kolejność D, C, B (remis D/C → wynik quizu, potem pozycja) → `batchAllocation([0, 0, 33])` = [4, 3, 3] (po 1 na podtemat, pozostałe 7 dzielone proporcjonalnie 100:100:67 → udziały 2,62 / 2,62 / 1,76 → części całkowite 2/2/1, dwie wolne fiszki do największych reszt: B (0,76), potem D (remis z C → wcześniejszy indeks)).

Weryfikacja: pgTAP (`flashcard_next.test.sql`), Vitest (`mastery.test.ts`, `flashcards-task.test.ts`, `schemas.test.ts`), rozszerzony `scripts/smoke-topics.mjs` w CI, testy ręczne na podglądzie/produkcji.

### Key Discoveries:

- Próg w liczbach całkowitych: `mastered * 5 >= total * 4` — dla `total = 0` (wszystkie fiszki partii usunięte) daje prawdę bez osobnego przypadku; 6/7 → tak, 5/7 → nie, 8/10 → tak. Ta sama formuła musi być w SQL i TS.
- Idempotencja przez numer partii: klient wysyła `seq` partii, którą chce utworzyć (= najnowsza gotowa + 1). Ponowienie lub drugie kliknięcie po zapisaniu tej partii trafia na `seq ≤ ostatnia gotowa` → `batch_exists` przed AI, więc nie zużywa limitu.
- Stare funkcje partii 1 zostają nietknięte (wzorzec „expand, then contract”, `supabase/AGENTS.md`); nowe funkcje mają inne nazwy, więc PostgREST nie musi rozstrzygać przeciążeń.
- `CARD_COLUMNS` jest współdzielone z `study-repository.ts`; stan fiszki (`stage`) dla widoku dokładamy osobnym polem zapytania repozytorium fiszek, nie zmieniając kształtu czytanego przez sesję nauki.

## What We're NOT Doing

- Kolejki Cloudflare / Durable Object dla generowania (F1) — zostaje `waitUntil` + polling; mierzymy partię 2 i wracamy do tematu przy stratach.
- Progu per podtemat ani partii „jednego podtematu” — próg liczony dla całej najnowszej partii, partia mieszana jak w S-04.
- Sygnału słabości z dziennika odpowiedzi (`flashcard_answers`) — słabość = odsetek nieopanowanych fiszek podtematu.
- Twardego odrzucania duplikatów w zod — tylko lista istniejących pytań w prompcie.
- Ponownego sprawdzania pod blokadą, czy podtematy w zapisywanych fiszkach są nadal nieopanowane (zmiana opanowania w trakcie generowania jest nieszkodliwa).
- Zmiany rozmiaru partii (zawsze 10), modelu, limitów dziennych, timeoutu ani TTL claimu.
- Kontrolnych powtórek opanowanych fiszek, odznaki za opanowanie tematu (S-10), ekranu głównego (S-08).
- Usuwania ani zmiany starych funkcji partii 1; testów e2e w przeglądarce.

## Implementation Approach

Kopia wzorca S-04 warstwa po warstwie, z jednym nowym elementem domenowym: opanowaniem liczonym z `flashcards`. Baza dostaje trzy funkcje dla partii N+1, które pod blokadą tematu sprawdzają numer partii, próg 80% i istnienie nieopanowanego podtematu. TS dostaje czyste funkcje opanowania/postępu/kolejności słabości (lustro reguł SQL), nowe zadanie AI `flashcards-next` (ten sam schemat i fixtura, inny prompt z listą istniejących pytań) oraz stan obejmujący wszystkie partie. Endpoint `POST /flashcards/next` robi wszystkie kontrole przed AI, potem claim, AI, zapis, `waitUntil`. UI rozbudowuje istniejące ekrany bez nowych komponentów bazowych.

## Critical Implementation Details

- **Zgodność reguł SQL ↔ TS** — próg (`mastered * 5 >= total * 4`), definicja opanowanego podtematu (≥ 1 fiszka i wszystkie `mastered`) i rozmiar partii są w `claim_next_flashcard_batch` i w `src/lib/topics/mastery.ts`; komentarz w obu miejscach wskazuje drugie, a `src/lib/topics/AGENTS.md` dostaje jedną linię o tej parze.
- **Kolejność wdrożenia** — migracja fazy 1 musi być na produkcji (`npx supabase db push`, krok człowieka) przed wdrożeniem fazy 3, bo endpoint woła nowe funkcje.

## Phase 1: Baza kolejnych partii

### Overview

Nowa migracja rozszerzająca z trzema funkcjami dla partii N+1 i testami pgTAP. Bez nowych tabel i kolumn.

### Changes Required:

#### 1. Migracja

**File**: `supabase/migrations/<timestamp>_next_flashcard_batches.sql` (przez `npx supabase migration new next_flashcard_batches`)

**Intent**: Pozwolić zająć i zapisać partię o numerze `p_seq ≥ 2` tylko wtedy, gdy jest dokładnie kolejną po najnowszej gotowej, najnowsza gotowa partia ma ≥ 80% opanowanych istniejących fiszek i temat ma choć jeden nieopanowany podtemat — sprawdzane pod blokadą, bo stan mógł się zmienić od odczytu w API.

**Contract**:
- `claim_next_flashcard_batch(p_topic_id uuid, p_seq integer) returns timestamptz` (`security definer`, `search_path = ''`): temat potwierdzony i należący do wywołującego `for share` (inaczej `topic_not_confirmed`); `v_last` = największy `seq` gotowej partii tematu; `v_last is null` lub `p_seq > v_last + 1` → `next_batch_locked`; `p_seq <= v_last` → `batch_exists`; z fiszek partii `v_last` liczy `total`/`mastered` i przy `mastered * 5 < total * 4` → `next_batch_locked`; gdy żaden podtemat tematu nie jest nieopanowany (nieopanowany = 0 fiszek albo choć jedna nie-`mastered`) → `topic_mastered`. Dalej jak `claim_flashcard_batch`: `insert … on conflict (topic_id, seq) do nothing returning claimed_at`; istniejący wiersz `ready` → `batch_exists`, świeży claim (< 120 s) → `batch_generating`, starszy → przejęcie z nowym `claimed_at`.
- `release_next_flashcard_batch_claim(p_topic_id uuid, p_seq integer, p_claimed_at timestamptz) returns void` — usuwa tylko własny wiersz `generating` o tym `seq` i dokładnie tym `claimed_at`.
- `create_next_flashcard_batch(p_topic_id uuid, p_seq integer, p_cards jsonb, p_claimed_at timestamptz) returns void` — jak `create_flashcard_batch` (temat `for share`, dokładnie 10 elementów → inaczej `batch_size` P0422, claim tej partii `for update`, `ready` → `batch_exists`, inny `claimed_at` lub brak → `batch_not_claimed`), z `seq = p_seq` i wymaganym tokenem.
- Wszystkie błędy biznesowe: `errcode = 'P0409'` (`batch_size`: `P0422`) z przyczyną w `hint`, jak w istniejących funkcjach. `revoke execute … from public`, `grant execute … to authenticated`. Komentarz nagłówkowy: reguły progu i opanowania zsynchronizowane z `src/lib/topics/mastery.ts`, 120 s z `FLASHCARD_CLAIM_TTL_SECONDS`.

#### 2. Testy bazy

**File**: `supabase/tests/database/flashcard_next.test.sql`

**Intent**: Udowodnić reguły progu, numeracji, opanowania tematu, claimu i zapisu dla partii N+1. Stan opanowania fiszek ustawiany jako właściciel tabeli (`reset role`) w transakcji testu, jak w `flashcard_open.test.sql`.

**Contract**: przypadki co najmniej: brak partii 1 → `next_batch_locked`; 7/10 opanowanych → `next_batch_locked`; 8/10 → claim zwraca `timestamptz`; partia z usuniętymi fiszkami 6/7 → dozwolone, 5/7 → nie; partia z 0 fiszek → dozwolone; `p_seq = v_last` → `batch_exists`; `p_seq = v_last + 2` → `next_batch_locked`; wszystkie podtematy opanowane → `topic_mastered`; podtemat z 0 fiszek przy reszcie opanowanej → claim dozwolony; drugi claim w TTL → `batch_generating`, po TTL → przejęcie; `create` z obcym `claimed_at` → `batch_not_claimed`, z 9 kartami → `batch_size`, poprawny → partia `ready` z 10 fiszkami o `seq = p_seq` i stanem `choice`; `release` usuwa tylko własny claim z pasującym tokenem; konto B na temacie A → `topic_not_confirmed`; `anon` nie ma `execute`.

### Success Criteria:

#### Automated Verification:

- Migracja i testy bazy przechodzą w CI (`smoke` → `Database tests`)
- `flashcard_next.test.sql` pokrywa próg (8/10, 7/10, 6/7, 5/7, pusta partia), numerację, `topic_mastered`, podtemat bez fiszek, claim/TTL, `create`/`release` z tokenem i izolację konta
- Lint przechodzi: `npm run lint`

#### Manual Verification:

- Przegląd migracji: wyłącznie rozszerzająca, stare funkcje partii 1 nietknięte, brak `grant` dla `anon`/`public`, komentarz o zgodności z `mastery.ts` obecny

**Implementation Note**: Po fazie i zielonym CI zatrzymaj się na potwierdzenie ręcznej weryfikacji. Migrację na produkcję wypycha człowiek (`npx supabase db push`) przed wdrożeniem fazy 3.

---

## Phase 2: Domena i zadanie AI

### Overview

Czyste funkcje opanowania i kolejności słabości, zadanie AI kolejnej partii, repozytorium stanu wszystkich partii i wywołania nowych RPC — z testami Vitest. Bez zmian w endpointach i UI poza dostosowaniem konsumentów nowego kształtu stanu, żeby build przechodził.

### Changes Required:

#### 1. Reguły opanowania

**File**: `src/lib/topics/mastery.ts` (nowy), `src/lib/topics/mastery.test.ts` (nowy)

**Intent**: Jedno miejsce w TS dla definicji opanowanego podtematu, progu 80% i kolejności słabości, lustrzane do SQL z fazy 1.

**Contract**:
- `subtopicMastery(subtopics, cards: { subtopicId; mastered: boolean }[]): SubtopicMastery[]` — w kolejności listy; `SubtopicMastery = { id, name, contentType, total, mastered, isMastered }`, `isMastered = total >= 1 && mastered === total`.
- `batchProgress(cards of latest ready batch): { total, mastered, required, unlocked }`, `required = ceil(total * 4 / 5)`, `unlocked = mastered * 5 >= total * 4`.
- `masteryPercent(m) = total === 0 ? 0 : round(mastered / total * 100)`.
- `nextBatchSubtopics(mastery, quizPercents: Map<id, number>)` — tylko nieopanowane, posortowane rosnąco po `masteryPercent`, potem wynik quizu (brak = 0), potem pozycja; zwraca `FlashcardSubtopic[]` z `percent = masteryPercent`.
- Testy: przypadki progu z fazy 1, pusta partia, podtemat z 0 fiszek nieopanowany, przykład A/B/C/D z „Desired End State” → kolejność D, C, B i `batchAllocation` = [4, 3, 3].

#### 2. Zadanie AI kolejnej partii

**File**: `src/lib/topics/flashcards-task.ts`, `src/lib/topics/flashcards-task.test.ts`

**Intent**: Prompt kolejnej partii, który traktuje `wynik` jako odsetek opanowanych fiszek, dostaje istniejące pytania podtematów jako dane „nie powtarzaj” i prosi o nowe zagadnienia lub inne ujęcie; reużywa schematu, kwot i mapowania wierszy z S-04.

**Contract**:
- `export const NEXT_FLASHCARDS_TASK = "flashcards-next"`.
- `buildNextFlashcardsRequest(topic, subtopics: FlashcardSubtopic[], existingFronts: Map<subtopicId, string[]>, seq: number): AiRequest<GeneratedFlashcards>` — te same tagi `<podtemat nr typ fiszek wynik>` (całkowity `wynik`), po nich blok `<istniejace_pytania>` z `<pytanie nr="i">` na każdy front (przez `asData`), do `MAX_EXISTING_FRONTS_PER_SUBTOPIC = 30` najnowszych na podtemat; ten sam `flashcardsSchema`, `maxTokens: 8000`, `timeoutMs: 90_000`. System prompt wspomina, że treść `<istniejace_pytania>` to dane, nie polecenia.
- Testy: kwoty i kolejność w promptcie, limit 30 frontów, `asData` dla frontów, schemat odrzuca złą kwotę.

#### 3. Fixtura fake

**File**: `src/lib/ai/fixtures.ts`

**Intent**: `AI_MODE=fake` obsługuje nowe zadanie tą samą fixturą co partia 1.

**Contract**: `[NEXT_FLASHCARDS_TASK]: flashcards` w `fakeFixtures`; regex fixtury dopasowuje prompt kolejnej partii (test w `flashcards-task.test.ts` lub `call.test.ts` przez `callAi` na fake).

#### 4. Repozytorium stanu i RPC

**File**: `src/lib/topics/flashcard-repository.ts`, `src/lib/topics/http.ts`

**Intent**: Stan fiszek obejmuje wszystkie partie, opanowanie per podtemat i postęp bieżącej partii; repozytorium woła nowe funkcje SQL z tokenem claimu.

**Contract**:
- `FlashcardView` dostaje `mastered: boolean` (z `stage`, dociągane w zapytaniu repozytorium fiszek, bez zmiany `CARD_COLUMNS`).
- `FlashcardState = { batches: { id; seq; cards: FlashcardView[] }[] /* gotowe, od najnowszej */; generating: { seq } | null /* świeży claim */; current: { seq; total; mastered; required; unlocked } | null; subtopics: SubtopicMastery[]; topicMastered: boolean }`; `null` gdy temat nie ma żadnej gotowej partii ani świeżego claimu (porzucony claim czyta się jak brak, jak dziś).
- `getFlashcardState` czyta wszystkie wiersze `flashcard_batches` tematu, fiszki tematu i podtematy (trzy zapytania równolegle), grupuje, liczy przez `mastery.ts`; fiszki w partii posortowane jak dziś (pozycja podtematu, potem pozycja).
- `hasReadyBatch(state)` — pomocnik dla stron.
- `claimNextFlashcardBatch(supabase, topicId, seq)`, `releaseNextFlashcardBatchClaim(supabase, topicId, seq, claimedAt)`, `createNextFlashcardBatch(supabase, topicId, seq, rows, claimedAt)`; `P0409_REASONS` rozszerzone o `next_batch_locked`, `topic_mastered`, `batch_not_claimed` → mapuje na `save_failed` jak dziś.
- Konsumenci starego kształtu (`[id].astro`, `[id]/flashcards.astro`, `[id]/quiz.astro`, `[id]/study.astro`, `FlashcardBatch.tsx`, endpoint `POST /flashcards` partii 1) dostosowani minimalnie, żeby build przechodził — pełne UI w fazie 4.

#### 5. Kody błędów i dokumentacja obszaru

**File**: `src/lib/topics/errors.ts`, `src/lib/topics/AGENTS.md`

**Intent**: Nowe przyczyny odmowy mają polski komunikat w istniejącym kształcie; agent wie o parze reguł SQL ↔ TS.

**Contract**: `next_batch_locked` (409, „Kolejna partia odblokuje się po opanowaniu 80% fiszek bieżącej partii.”, `retryable: false`), `topic_mastered` (409, „Wszystkie podtematy tego tematu są już opanowane.”, `retryable: false`); komunikat `batch_exists` uogólniony („Ta partia fiszek jest już gotowa.”). `AGENTS.md`: linia o `@mastery.ts` ↔ `claim_next_flashcard_batch` i o tym, że opanowanie podtematu liczy się z `flashcards`, nie z quizu.

### Success Criteria:

#### Automated Verification:

- Testy jednostkowe przechodzą: `npm test` (`mastery.test.ts`, `flashcards-task.test.ts`)
- Kontrola typów i build przechodzą: `npm run build`
- Lint przechodzi: `npm run lint`
- Istniejący `smoke-topics.mjs` (partia 1, nauka) nadal przechodzi w CI

#### Manual Verification:

- Przegląd promptu `flashcards-next`: dane użytkownika i istniejące pytania tylko w tagach przez `asData`, polecenie o nowych zagadnieniach zrozumiałe

**Implementation Note**: Po fazie i zielonym CI zatrzymaj się na potwierdzenie ręcznej weryfikacji.

---

## Phase 3: API

### Overview

Endpoint kolejnej partii z kontrolami przed AI, nowy kształt stanu w istniejących endpointach i rozszerzony smoke.

### Changes Required:

#### 1. Schemat wejścia

**File**: `src/lib/topics/schemas.ts`, `src/lib/topics/schemas.test.ts`

**Intent**: Walidacja ciała żądania kolejnej partii.

**Contract**: `nextBatchInput = z.object({ seq: z.number().int().min(2) })`; zły kształt → `validation_failed` przez istniejący odczyt ciała w `http.ts`.

#### 2. Endpoint kolejnej partii

**File**: `src/pages/api/topics/[id]/flashcards/next.ts` (nowy)

**Intent**: Wygenerować partię `seq` dla nieopanowanych podtematów; każda odmowa przed wywołaniem AI, bo każde wywołanie zużywa limit.

**Contract**: `POST` z `{ seq }` → sesja → `loadTopic` → odczyt stanu (`readFlashcardState`) i quizu (`readQuizState`) → bez gotowej partii lub `seq > current.seq + 1` lub `!current.unlocked` → `next_batch_locked`; `seq <= current.seq` → `batch_exists`; `topicMastered` → `topic_mastered`; `generating` → `batch_generating` → `claimNextFlashcardBatch` (powtarza kontrole pod blokadą) → `nextBatchSubtopics` + istniejące fronty ze stanu → `ai.call(buildNextFlashcardsRequest(…))` → `toFlashcardRows` → `createNextFlashcardBatch`; po błędzie AI lub zapisu `releaseNextFlashcardBatchClaim`; sukces → `aiResponse` z pełnym stanem. Praca w `waitUntil` jak `POST /flashcards` (`src/pages/api/topics/[id]/flashcards/index.ts:44-50`).

#### 3. Istniejące endpointy

**File**: `src/pages/api/topics/[id]/flashcards/index.ts`, `src/pages/api/topics/[id]/flashcards/[cardId].ts`

**Intent**: GET, POST partii 1 i DELETE zwracają nowy `FlashcardState`; zachowanie partii 1 bez zmian.

**Contract**: kształt odpowiedzi `{ data: FlashcardState | null }`; usunięcie fiszki z dowolnej partii przelicza opanowanie i postęp w zwracanym stanie.

#### 4. Smoke

**File**: `scripts/smoke-topics.mjs`

**Intent**: Przepływ kolejnej partii na prawdziwym PostgREST z fake AI.

**Contract**: po sekcjach nauki: (a) `POST /flashcards/next` `{ seq: 2 }` przed progiem → 409 `next_batch_locked` i brak nowego wiersza `ai_calls`; (b) kluczem serwisowym ustaw `stage = 'mastered'` na tylu fiszkach partii 1, by spełnić próg i zostawić co najmniej jeden podtemat nieopanowany (komentarz: przygotowanie stanu jak `makeDue`); (c) `{ seq: 2 }` → 200, `X-AI-Mode: fake`, 10 fiszek, żadna w podtemacie opanowanym, każdy nieopanowany ≥ 1, `remaining === GENERATION_LIMIT - 5`; (d) ponowne `{ seq: 2 }` → `batch_exists`; (e) GET: 2 partie, `subtopics[].total/mastered` zgodne; (f) konto B → 404; (g) wszystkie fiszki opanowane → `{ seq: 3 }` → `topic_mastered` bez wywołania AI; pętla limitu startuje od 6, komentarz o liczbie generowań zaktualizowany.

### Success Criteria:

#### Automated Verification:

- Testy jednostkowe przechodzą: `npm test` (w tym `schemas.test.ts`)
- Kontrola typów i build przechodzą: `npm run build`
- Lint przechodzi: `npm run lint`
- Rozszerzony `smoke-topics.mjs` przechodzi w CI

#### Manual Verification:

- Na podglądzie gałęzi z prawdziwym AI (temat testowy, fiszki opanowane kluczem serwisowym): partia 2 ma 10 sensownych fiszek, nie powtarza pytań partii 1, omija opanowany podtemat

**Implementation Note**: Po fazie i zielonym CI zatrzymaj się na potwierdzenie ręcznej weryfikacji. Przed wdrożeniem upewnij się, że migracja fazy 1 jest na produkcji.

---

## Phase 4: UI

### Overview

Strona fiszek z wieloma partiami, postępem i przyciskiem kolejnej partii; opanowanie per podtemat na stronie tematu; pomiar czasu partii 2.

### Changes Required:

#### 1. Strona fiszek

**File**: `src/components/topics/FlashcardBatch.tsx`, `src/pages/topics/[id]/flashcards.astro`

**Intent**: Pokazać wszystkie partie i pozwolić wygenerować kolejną, z tym samym zachowaniem generowania co partia 1.

**Contract**: najnowsza partia rozwinięta na górze, starsze jako `Collapsible` „Partia N (opanowane X/Y)”; w każdej grupy po podtematach jak dziś, fiszka opanowana ma `Badge` „Opanowana”; usuwanie bez zmian. Blok postępu nad partiami: „Opanowane w partii N: X/Y — kolejna partia od Z” lub „Temat opanowany — wszystkie podtematy opanowane”; przycisk „Wygeneruj kolejną partię” (ikona `Layers`) aktywny gdy `current.unlocked && !topicMastered && !generating`, wyłączony z wyjaśnieniem w przeciwnym razie. Klik → `POST /flashcards/next` `{ seq: current.seq + 1 }`; `batch_generating`/`batch_exists` → odświeżenie; `generating` w stanie → `GeneratingNotice` „AI przygotowuje kolejną partię…” i polling co 2 s, partie już gotowe pozostają widoczne. Tylko komponenty z `src/components/ui` i tokeny z `global.css`.

#### 2. Strona tematu

**File**: `src/components/topics/TopicEditor.tsx`, `src/pages/topics/[id].astro`

**Intent**: Opanowanie per podtemat tam, gdzie użytkownik patrzy na temat.

**Contract**: `ConfirmedList` dostaje `mastery: SubtopicMastery[] | null` (null przed partią 1 lub przy błędzie odczytu — lista jak dziś); przy podtemacie „Opanowane X/Y” i `Badge` „Opanowany” gdy `isMastered`; przy `topicMastered` krótka informacja „Temat opanowany”. Strona liczy `hasFlashcards`/`study` przez `hasReadyBatch`.

#### 3. Pozostałe strony

**File**: `src/pages/topics/[id]/quiz.astro`, `src/pages/topics/[id]/study.astro`

**Intent**: Zachować dzisiejsze zachowanie na nowym kształcie stanu (nauka dostępna, gdy jest choć jedna gotowa partia, także w trakcie generowania kolejnej).

**Contract**: użycie `hasReadyBatch`.

### Success Criteria:

#### Automated Verification:

- Build i typy przechodzą: `npm run build`
- Lint przechodzi: `npm run lint`
- Testy jednostkowe nadal przechodzą: `npm test`

#### Manual Verification:

- Na telefonie (produkcja, temat testowy): strona tematu pokazuje „Opanowane X/Y” i „Opanowany”; strona fiszek pokazuje postęp, zwijane starsze partie, bez poziomego przewijania
- Przycisk kolejnej partii wyłączony poniżej progu z wyjaśnieniem, aktywny od progu; generowanie z przeładowaniem w trakcie kończy się jedną partią i jednym zużytym generowaniem
- Czas generowania partii 2 na produkcji zmierzony (`ai_calls.latency_ms` dla `flashcards-next`) i zapisany w Notes `change.md`; przy > 30 s częściej niż partia 1 — wpis follow-up F1
- Gdy wszystkie podtematy opanowane: „Temat opanowany”, przycisk niedostępny

**Implementation Note**: Po fazie zatrzymaj się na potwierdzenie ręcznej weryfikacji.

---

## Testing Strategy

### Unit Tests:

- `mastery.test.ts`: próg (8/10, 7/10, 6/7, 5/7, 0/0), podtemat z 0 fiszek nieopanowany, kolejność słabości z remisem (quiz, potem pozycja), przykład A/B/C/D → [4, 3, 3].
- `flashcards-task.test.ts`: prompt kolejnej partii (tagi zgodne z fixturą, limit 30 frontów, `asData`), fixtura fake na `flashcards-next`.
- `schemas.test.ts`: `nextBatchInput`.

### Integration Tests:

- pgTAP `flashcard_next.test.sql` (reguły pod blokadą, izolacja konta).
- `smoke-topics.mjs`: odmowa przed progiem bez AI, partia 2, idempotencja, `topic_mastered`, inne konto, limit dzienny.

### Manual Testing Steps:

1. Temat testowy z partią 1: kluczem serwisowym opanuj 7 z 10 fiszek → przycisk wyłączony z „kolejna partia od 8”.
2. Opanuj ósmą → przycisk aktywny; generuj i przeładuj w trakcie → jedna partia 2, jedno generowanie.
3. Sprawdź, że partia 2 nie zawiera opanowanego podtematu i nie powtarza pytań partii 1.
4. Usuń wszystkie fiszki jednego podtematu → na stronie tematu nie jest „Opanowany”.
5. Opanuj wszystko → „Temat opanowany”, brak przycisku.

## Performance Considerations

- Stan czyta wszystkie fiszki tematu (dziesiątki–kilkaset wierszy) zamiast 10 — akceptowalne dla MVP; zapytania równoległe, indeksy `flashcards_topic_id_stage_due_on_idx` i `flashcards_subtopic_id_idx` już istnieją.
- Prompt partii N rośnie o fronty (≤ 30 × ≤ 300 znaków na podtemat); czas generowania partii 2 mierzony ręcznie w fazie 4 (F1).

## Migration Notes

- Migracja wyłącznie dodaje funkcje; stary Worker działa na nowym schemacie. Rollback Workera nie wymaga cofania migracji.
- `npx supabase db push` przed wdrożeniem fazy 3 — krok człowieka.

## References

- Roadmap: `context/foundation/roadmap.md` § S-07; PRD: `context/foundation/prd.md` FR-019, FR-020, US-01
- Wzorzec partii 1: `context/archive/2026-10-24-first-weak-subtopic-batch/plan.md`, `src/pages/api/topics/[id]/flashcards/index.ts:28-88`
- Opanowanie fiszki: `context/archive/2026-10-28-ai-graded-open-answers/plan.md`
- Follow-up F1: `context/archive/2026-10-24-first-weak-subtopic-batch/follow-ups/review-fixes.md`
- Funkcje claimu z tokenem: `supabase/migrations/20261025182503_claim_tokens_and_option_nulls.sql:23-150`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Baza kolejnych partii

#### Automated

- [x] 1.1 Migracja i testy bazy przechodzą w CI (`smoke` → `Database tests`) — 0b73626
- [x] 1.2 `flashcard_next.test.sql` pokrywa próg (8/10, 7/10, 6/7, 5/7, pusta partia), numerację, `topic_mastered`, podtemat bez fiszek, claim/TTL, `create`/`release` z tokenem i izolację konta — 0b73626
- [x] 1.3 Lint przechodzi: `npm run lint` — 0b73626

#### Manual

- [x] 1.4 Przegląd migracji: wyłącznie rozszerzająca, stare funkcje partii 1 nietknięte, brak `grant` dla `anon`/`public`, komentarz o zgodności z `mastery.ts` obecny — 0b73626

### Phase 2: Domena i zadanie AI

#### Automated

- [x] 2.1 Testy jednostkowe przechodzą: `npm test` (`mastery.test.ts`, `flashcards-task.test.ts`) — 9477935
- [x] 2.2 Kontrola typów i build przechodzą: `npm run build` — 9477935
- [x] 2.3 Lint przechodzi: `npm run lint` — 9477935
- [x] 2.4 Istniejący `smoke-topics.mjs` (partia 1, nauka) nadal przechodzi w CI — 9477935

#### Manual

- [x] 2.5 Przegląd promptu `flashcards-next`: dane użytkownika i istniejące pytania tylko w tagach przez `asData`, polecenie o nowych zagadnieniach zrozumiałe — 9477935

### Phase 3: API

#### Automated

- [x] 3.1 Testy jednostkowe przechodzą: `npm test` (w tym `schemas.test.ts`) — 04ee0a2
- [x] 3.2 Kontrola typów i build przechodzą: `npm run build` — 04ee0a2
- [x] 3.3 Lint przechodzi: `npm run lint` — 04ee0a2
- [x] 3.4 Rozszerzony `smoke-topics.mjs` przechodzi w CI — 04ee0a2

#### Manual

- [ ] 3.5 Na podglądzie gałęzi z prawdziwym AI (temat testowy, fiszki opanowane kluczem serwisowym): partia 2 ma 10 sensownych fiszek, nie powtarza pytań partii 1, omija opanowany podtemat

### Phase 4: UI

#### Automated

- [x] 4.1 Build i typy przechodzą: `npm run build`
- [x] 4.2 Lint przechodzi: `npm run lint`
- [x] 4.3 Testy jednostkowe nadal przechodzą: `npm test`

#### Manual

- [ ] 4.4 Na telefonie (produkcja, temat testowy): strona tematu pokazuje „Opanowane X/Y” i „Opanowany”; strona fiszek pokazuje postęp, zwijane starsze partie, bez poziomego przewijania
- [ ] 4.5 Przycisk kolejnej partii wyłączony poniżej progu z wyjaśnieniem, aktywny od progu; generowanie z przeładowaniem w trakcie kończy się jedną partią i jednym zużytym generowaniem
- [ ] 4.6 Czas generowania partii 2 na produkcji zmierzony (`ai_calls.latency_ms` dla `flashcards-next`) i zapisany w Notes `change.md`; przy > 30 s częściej niż partia 1 — wpis follow-up F1
- [ ] 4.7 Gdy wszystkie podtematy opanowane: „Temat opanowany”, przycisk niedostępny
