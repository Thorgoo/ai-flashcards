<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Temat z zatwierdzonymi podtematami

- **Plan**: context/changes/topic-with-confirmed-subtopics/plan.md
- **Scope**: Full plan
- **Reviewed phases**: 1, 2, 3, 4
- **Date**: 2026-10-22
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 3 warnings, 5 observations

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | WARNING |
| Scope Discipline    | PASS    |
| Safety & Quality    | WARNING |
| Architecture        | PASS    |
| Pattern Consistency | WARNING |
| Success Criteria    | PASS    |

Automatyczne kryteria przechodzą ponownie:

- `npm test`: 39 passed;
- lint, `astro check` i build;
- CI PR #22: `ci` i `smoke`.

Kroki ręczne mają dowody z sesji: CI oraz testy w przeglądarce na produkcji.

## Findings

### F1 — Równoległy zapis podtematu może ominąć blokadę zatwierdzenia

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20261022163613_create_topics_and_subtopics.sql:51-70, 98-103
- **Detail**:
  - Polityki zapisu na `subtopics` sprawdzają `draft` zwykłym odczytem.
  - FK bierze `FOR KEY SHARE`, a zatwierdzenie bierze `FOR NO KEY UPDATE`. Te blokady nie kolidują.
  - Dodanie albo usunięcie równoległe z zatwierdzeniem może więc wejść po fakcie. Skutek: zatwierdzony temat z 1 lub 11 podtematami albo lista zmieniona po zatwierdzeniu.
  - Plan przyjął to ryzyko w sekcji „Critical Implementation Details”. Jednak `src/lib/topics/AGENTS.md` obiecuje kolejnym wycinkom, że lista „nigdy się nie zmienia”, a ten wyścig to obala.
  - Wniosek wyprowadzony z semantyki blokad, nie odtworzony.
- **Fix A ⭐ Recommended**: Nowa migracja z triggerem `before insert or update or delete` na `subtopics`
  - Trigger robi `select status from topics where id = … for share` i rzuca P0409, gdy temat nie jest `draft`; do tego test pgTAP.
  - Strength: `FOR SHARE` koliduje z `FOR NO KEY UPDATE`, więc zapis czeka na zatwierdzenie i potem widzi `confirmed`. Inwariant z AGENTS.md staje się prawdziwy.
  - Tradeoff: nowa migracja, czyli `db push` do zrobienia przez człowieka, plus test.
  - Confidence: MED — semantyka blokad Postgresa jest dobrze znana, ale współbieżności nie da się łatwo przetestować w pgTAP.
  - Blind spot: zachowanie triggera przy kaskadowym usuwaniu tematu (FK cascade) trzeba sprawdzić.
- **Fix B**: Zostawić ryzyko i złagodzić obietnicę w AGENTS.md
  - Strength: zero kodu; ryzyko było świadomie przyjęte w planie.
  - Tradeoff: S-03 i dalsze wycinki muszą tolerować 1 lub 11 podtematów albo zmianę listy po zatwierdzeniu.
  - Confidence: HIGH — wymaga tego samego konta i dwóch żądań naraz.
  - Blind spot: przyszłe wycinki mogą polegać na liczbie podtematów (np. rozkład 10 pytań quizu).
- **Decision**: FIXED (Fix A) — migracja `20261022185614_lock_subtopic_writes_on_topic.sql` (trigger FOR SHARE na temacie), +3 asercje pgTAP; wymaga `db push`

### F2 — Błąd odczytu z bazy wychodzi jako 500 bez JSON

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/http.ts:47,54 (repository.ts:85,94,105)
- **Detail**:
  - `getTopic` rzuca wyjątek przy błędzie PostgREST, a `loadTopic` i `topicState` go nie łapią.
  - Astro zwraca wtedy własną odpowiedź 500, a klient pokazuje komunikat „Brak połączenia z serwerem”.
  - Gdy `topicState` padnie po udanej mutacji, użytkownik widzi błąd, choć zapis się udał.
- **Fix**: Łapać wyjątek w `loadTopic` i `topicState`, logować go i zwracać `topicErrorResponse("save_failed")`.
- **Decision**: FIXED — `readTopic` w `src/lib/topics/http.ts` łapie wyjątek, loguje i zwraca `save_failed`

### F3 — Pusty klucz AI daje błąd bez logu i zużywa limit

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/ai/live.ts:15-21, src/lib/ai/index.ts:18-30
- **Detail**:
  - To się zdarzyło na produkcji 2026-10-22: `ANTHROPIC_API_KEY` miał pustą wartość.
  - Gałąź `!apiKey` zwraca `ai_not_configured` bez `logAiError`, więc w logach Workera nie było nic.
  - Każda próba zużyła 1 z 20 dziennych generowań, bo `callAi` rezerwuje limit przed `provider.complete`.
  - Kod jest z F-02, ale S-02 to jego pierwszy realny konsument.
- **Fix**: W `getAi` sprawdzić klucz tak jak niepoprawny tryb: przy trybie live i pustym `ANTHROPIC_API_KEY` wołać `logAiError` i zwracać `ai_not_configured` bez rezerwacji limitu.
- **Decision**: FIXED — `getAi` (`src/lib/ai/index.ts`) loguje brak `ANTHROPIC_API_KEY` i zwraca `ai_not_configured` bez rezerwacji limitu

### F4 — Bezpośrednie zapisy przez PostgREST omijają część reguł tematu

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20261022163613_create_topics_and_subtopics.sql:25-28, 36, 43-44, 74-113
- **Detail**:
  - Konto może bezpośrednio przez PostgREST (z kluczem anon i własną sesją):
    - zmienić `scope_note` po zatwierdzeniu, a ta notatka zasila prompty S-03 i S-04;
    - usunąć zatwierdzony temat, choć FR-007 przewiduje archiwizację, nie usuwanie;
    - przenieść podtemat między własnymi szkicami;
    - podrobić pozycje (nie ma unikalności `(topic_id, position)`).
  - Żadna z tych rzeczy nie przekracza granicy konta; złożony FK i `with check` działają.
- **Fix A ⭐ Recommended**: Zapisać decyzję jako zadanie dla S-08 (archiwizacja i zmiana nazwy) i tam rozszerzyć trigger
  - Strength: S-08 i tak definiuje cykl życia tematu (FR-007), więc reguły powstaną razem z funkcją.
  - Tradeoff: do S-08 te luki zostają; dotyczą tylko danych własnego konta.
  - Confidence: HIGH — szkoda ograniczona do własnych danych użytkownika.
  - Blind spot: S-03 może już czytać `scope_note` zatwierdzonego tematu.
- **Fix B**: Rozszerzyć trigger teraz, w tej samej migracji co F1
  - Zamrozić `scope_note` po zatwierdzeniu, zablokować `delete` zatwierdzonego tematu i zmianę `topic_id`.
  - Strength: jedna migracja, inwariant domknięty od razu.
  - Tradeoff: przesądza decyzje FR-007 (czy zmiana nazwy i usuwanie są dozwolone) przed S-08.
  - Confidence: MED — ryzyko kolizji z założeniami S-08.
  - Blind spot: nie wiadomo, czy S-08 będzie usuwać, czy tylko archiwizować.
- **Decision**: FIXED (Fix A) — odłożone do S-08: `follow-ups/review-fixes.md` + roadmapa S-08 → Unknowns

### F5 — Odrzucona zmiana nazwy zostawia wpisany tekst w polu

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/components/topics/TopicEditor.tsx:200-209, 114
- **Detail**:
  - Po błędzie 409 (duplikat) w polu zostaje odrzucona nazwa.
  - Kolejne wyjście z pola wysyła ją ponownie.
  - To łamie zasadę planu „stan zawsze z odpowiedzi API”.
- **Fix**: `onRename` zwraca obietnicę z `run`; przy `false` przywrócić `setName(subtopic.name)`.
- **Decision**: FIXED — `TopicEditor.tsx`: `onRename` zwraca wynik `run`, odrzucona nazwa wraca do zapisanej

### F6 — Nazwa tematu może zamknąć znacznik w prompcie

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/topics/subtopics-task.ts:41
- **Detail**:
  - Nazwa albo notatka zawierająca `</temat>` wychodzi poza znacznik danych w prompcie.
  - Skutek jest ograniczony: wynik i tak waliduje schemat i dotyczy tylko danych autora.
- **Fix**: Usuwać `<` i `>` z wartości wstawianych do promptu.
- **Decision**: FIXED — `subtopics-task.ts`: `asData` usuwa `<` i `>` z nazwy i notatki; nowy test

### F7 — Drobne niespójności wzorców w komponentach

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/components/ui/*.tsx, src/pages/topics/[id].astro:7
- **Detail**:
  - Nowe komponenty shadcn importują z `radix-ui`, a `button.tsx` z `@radix-ui/react-slot`, więc są dwie zależności Radix.
  - Regex UUID jest powielony w `[id].astro` i `http.ts`.
  - Domyślne literały kolorów shadcn (`bg-black/50`, `text-white`) łamią regułę „kolor tylko przez tokeny”, tak samo jak istniejący `button.tsx`.
- **Fix**: Wyeksportować regex UUID z `http.ts` i użyć go w `[id].astro`; ujednolicenie Radix i tokenów zostawić na osobne porządki UI.
- **Decision**: FIXED — `isUuid` w `src/lib/topics/schemas.ts`, używany w `http.ts` i `[id].astro`; Radix ×2 i domyślne kolory shadcn zostawione na osobne porządki UI

### F8 — Drobne odchylenia od planu w testach i formularzu

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: supabase/tests/database/account_isolation.test.sql:75-81, src/components/topics/NewTopicForm.tsx:42, src/components/ui/alert.tsx
- **Detail**:
  - Test „B nie doda podtematu do tematu A” łapie błąd RLS (42501), a nie FK; FK jest sprawdzony w `topics.test.sql`.
  - Błąd walidacji w `NewTopicForm` to wspólny alert, a nie komunikat przy konkretnym polu.
  - `alert.tsx` doszedł spoza listy komponentów w planie (używany w obu wyspach).
  - Żadna z tych rzeczy nie zmienia zachowania.
- **Fix**: Bez zmian w kodzie; odnotować w raporcie jako zaakceptowane odchylenia.
- **Decision**: ACCEPTED — odchylenia bez wpływu na zachowanie (RLS zamiast FK w teście izolacji, FK sprawdzony w `topics.test.sql`; wspólny alert walidacji; `alert.tsx`)
