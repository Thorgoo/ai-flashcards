---
date: 2026-10-24T11:36:28+02:00
researcher: Claude (Opus 5.5) dla Thorgoo
git_commit: 397a74b8a6e834782980fa9c8c5de559c9f300d2
branch: feat/first-weak-subtopic-batch
repository: Thorgoo/ai-flashcards
topic: "S-04: na czym w kodzie opiera się pierwsza partia fiszek ze słabych podtematów"
tags: [research, flashcards, quiz-results, ai-call, claim, supabase-rls, s-04]
status: complete
last_updated: 2026-10-24
last_updated_by: Claude (Opus 5.5)
---

# Research: S-04 — pierwsza partia fiszek ze słabych podtematów

**Date**: 2026-10-24T11:36:28+02:00
**Researcher**: Claude (Opus 5.5) dla Thorgoo
**Git Commit**: 397a74b8a6e834782980fa9c8c5de559c9f300d2
**Branch**: feat/first-weak-subtopic-batch
**Repository**: Thorgoo/ai-flashcards

## Research Question

Co istniejący kod (S-02, S-03, F-01, F-02) daje i narzuca wycinkowi S-04 (`context/foundation/roadmap.md:152-162`): partia 10 fiszek z najsłabszych podtematów, podtemat ze 100% dostaje mniejszą partię, kształt zależny od typu treści, „czytaj więcej” zapisane z fiszką, przegląd i usuwanie (FR-011, FR-012, FR-013, FR-028)?

## Summary

- **Wejście rankingu istnieje i jest stabilne:** wynik per podtemat liczy funkcja SQL `public.quiz_results(p_quiz_id)` w momencie odczytu (nie jest zapisywany), a `percent` liczy TS (`src/lib/topics/quiz-repository.ts:144-152`). „Nie wiem” (`answer = -1`) liczy się jako błędna. Bramka „quiz ukończony” = `quizzes.completed_at IS NOT NULL`, ustawiane atomowo przez ostatnie `answer_quiz_question`.
- **Typ treści w kodzie to `conceptual | vocabulary`** (nie „language”) — `src/lib/topics/schemas.ts:22`. Kształty fiszek definiuje FR-005 (`context/foundation/prd.md:73`): pojęciowa = pytanie + poprawna odpowiedź + 3 błędne opcje; słownikowa = słowo + tłumaczenie + przykładowe zdanie + 3 błędne tłumaczenia. Oba kształty już niosą 3 dystraktory potrzebne w S-05.
- **Ścieżka AI do skopiowania:** `*-task.ts` (zod + prompt + `build*Request`) → `getAi(...).call` z `kind: "generation"` (limit 20/dzień, liczony przed wywołaniem, niezwracany) → zapis jednym RPC plpgsql w jednej transakcji. Wzorzec claim (`claim_quiz` / `release_quiz_claim`, TTL 90 s, `waitUntil`, polling GET) powstał po incydencie z produkcji (S-03 impl-review F1) i jest tu wprost potrzebny.
- **Główne ryzyko otwarte:** 10 fiszek z wyjaśnieniami to więcej tokenów niż quiz (`maxTokens: 3000`, `quiz-task.ts:87`) przy tym samym limicie czasu 60 s (`call.ts:11`) i TTL claimu 90 s. W repo nie ma zmierzonej latencji ani liczby tokenów generowania quizu.
- **Nic dla fiszek jeszcze nie istnieje** — ani tabela, ani typ, endpoint czy komponent (przeszukane `src/` i `supabase/` pod „flashcard”, „fiszk”, „batch”; jedyne trafienia to prompty systemowe w `subtopics-task.ts:25`, `quiz-task.ts:56`).
- **Decyzje do planu (nierozstrzygnięte w żadnym źródle):** rozdział 10 fiszek między podtematy, rozmiar „mniejszej partii”, kształt odpowiedzi otwartej dla fiszki słownikowej, model danych partii pod S-07, punkt wejścia w UI.

## Detailed Findings

### 1. Model danych tematu, podtematów i quizu

- `topics`: status tylko `draft → confirmed`; zatwierdzony jest trwały (trigger `guard_topic_status`, `supabase/migrations/20261022163613_create_topics_and_subtopics.sql:74-113`). Ukończenie quizu nie zmienia statusu tematu — w tej migracji i w `repository.ts:5` nie ma stanu „quiz ukończony” ani „ma fiszki”.
- `subtopics`: `content_type` z checkiem `conceptual|vocabulary` (`...163613...sql:35`), lista zablokowana po zatwierdzeniu (polityki `:51-70` + trigger `guard_subtopic_topic_draft`, `20261022185614_lock_subtopic_writes_on_topic.sql:6-35`). `unique(id, topic_id)` dodane jako cel kompozytowego FK (`20261023125014_create_diagnostic_quizzes.sql:10`).
- `quizzes`: jeden quiz na temat (`topic_id UNIQUE`), `completed_at`, `status generating|ready`, `claimed_at` (`...125014...sql:12-35`, `20261024064348_quiz_generation_claim.sql:9-11`).
- `quiz_questions`: odpowiedź jest kolumną pytania (`answer` null / 0–3 / −1 = „nie wiem”, `...125014...sql:53-54`); brak osobnej tabeli odpowiedzi.
- Uprawnienia: `authenticated` ma tylko `SELECT` na quizach i pytaniach; wszystkie zapisy przez RPC `SECURITY DEFINER` z błędami P0409/P0422 i przyczyną w `hint` (`...064348...sql:15-16`; mapowanie `quiz-repository.ts:64-73`).

### 2. Wynik per podtemat — wejście do „najsłabszych”

- `quiz_results` — `language sql stable security invoker`, zwraca `subtopic_id, name, content_type, position, asked, correct, dont_know` w kolejności `position` (`...125014...sql:174-205`). `src/lib/topics/AGENTS.md` mówi, że S-04 czyta z tego samego źródła.
- Funkcja robi `join public.subtopics ... group by` od pytań (`...125014...sql:201-203`): podtemat bez pytań nie pojawiłby się w wyniku. Dziś to się nie zdarza — `quizQuotas` (`quiz-task.ts:14-18`) dzieli 10 pytań równo z resztą dla pierwszych pozycji, a zatwierdzony temat ma 2–10 podtematów, więc każdy podtemat dostaje ≥ 1 pytanie (np. 3 podtematy → 4/3/3; 10 → po 1). `create_quiz` w SQL sprawdza jednak tylko liczbę 10 pytań, nie kwoty (`...064348...sql:103-108`) — kwoty pilnuje zod `superRefine` (`quiz-task.ts:43-50`).
- Wnioski (nie zaobserwowane, tylko wyprowadzone): przy 1–5 pytaniach na podtemat procenty są gruboziarniste, więc remisy będą częste i plan musi mieć regułę rozstrzygania (np. `position`). Lista podtematów do rankingu bezpieczniej pochodzi z `subtopics` z dołączonym wynikiem niż z samego `quiz_results`.
- Bramka: `completed_at` ustawia ostatnie `answer_quiz_question` pod `FOR UPDATE` wiersza quizu (`...064348...sql:162-174`); w TS `QuizState.quiz.completedAt` (`quiz-repository.ts:38-43`).
- Zaakceptowane ryzyko z S-03 (impl-review F5, `context/archive/2026-10-22-diagnostic-quiz-by-subtopic/reviews/impl-review.md:102-110`): przez PostgREST można odczytać `correct_index` i odpowiadać nie po kolei; decyzja brzmi „wróć, jeśli S-04 zacznie polegać na uczciwych odpowiedziach”. S-04 na nich polega, ale skutek dotyczy wyłącznie własnych danych konta.

### 3. Ścieżka wywołania AI (F-02) i jak użyć jej w nowym zadaniu

- Dostawca Anthropic tworzony wyłącznie w `src/lib/ai/live.ts:24` z `maxRetries: 0`; `src/lib/ai/AGENTS.md:5-7` zakazuje innej ścieżki i pętli ponowień. Model domyślny `claude-sonnet-5-5` (`call.ts:9`), `effort` domyślnie `low` (`call.ts:73-74`), structured output przez `zodOutputFormat` (`call.ts:94`), walidacja zod tylko przy `stopReason === "end_turn"` — `max_tokens`/`refusal` → `ai_invalid_output` (`call.ts:128-141`).
- Limity per żądanie: `maxTokens` 1000 (podtematy, `subtopics-task.ts:48`) i 3000 (quiz, `quiz-task.ts:87`); timeout 60 s dla `generation`, 20 s dla `grading` (`call.ts:11`, użyty `:124`).
- Limit dzienny: `begin_ai_call` (`20261018092416_create_ai_calls.sql:33-73`) — 20 `generation` / 100 `grading`, dzień w strefie `Europe/Warsaw` (`:41`), advisory lock per konto i rodzaj (`:54-56`), wiersz `pending` wstawiany przed wywołaniem i liczony bez względu na wynik (komentarz `:1-4`). S-04 używa `kind: "generation"`.
- Tryb fake: `AI_MODE=fake` działa tylko przy lokalnym `SUPABASE_URL` (`mode.ts:7-19`); fixture wybierany po nazwie zadania (`fake.ts:17`), rejestr w `fixtures.ts:41-44`; fixture quizu wyprowadza wynik z tagów promptu, żeby spełniać kwoty (`fixtures.ts:25-37`).
- Nowe zadanie potrzebuje (`src/lib/ai/AGENTS.md:10-13`): `*-task.ts` ze stałą `TASK`, schematem zod, promptem systemowym i `build*Request`; danych użytkownika w tagach przez `asData` (usuwa `<`/`>`, `subtopics-task.ts:33-36`; S-02 impl-review F6); fixture w `fixtures.ts`; testu Vitest w stylu `quiz-task.test.ts` (schemat, `zodOutputFormat` nie rzuca `:80-81`, end-to-end przez `createFakeProvider` `:102-103`).
- Mapowanie błędów: kody AI → HTTP w `src/lib/ai/errors.ts:12-23` (`quota_exceeded` 429 nieponawialny; `ai_timeout` 504, `ai_unavailable` 503, `ai_invalid_output` 502 ponawialne); kody tematu w `src/lib/topics/errors.ts:15-36` — zasada „dodaj kod, nie kształt” (`src/lib/topics/AGENTS.md:13`).

### 4. Claim i zapis „wszystko albo nic” (wzorzec z S-03)

- Powód: przeładowanie strony anulowało Workera po pobraniu limitu i przed zapisem — na produkcji „remaining 18 po jednym udanym quizie”, a użytkownik widział znów „Rozpocznij quiz” (`.../reviews/impl-review.md:41-63`). Wybrano Fix A: claim przed AI + `waitUntil` + stan `generating` + polling. Recenzent zaznaczył, że `waitUntil` przedłuża pracę tylko o ok. 30 s, więc sam nie pokrywa 60 s wywołania (`:56`). Naprawa zweryfikowana na produkcji 2026-10-24 (commit `f156332`).
- `claim_quiz` (`...064348...sql:124-167`): temat `FOR SHARE`, `insert ... on conflict (topic_id) do nothing`; istniejący `ready` → `quiz_exists`, claim młodszy niż 90 s → `quiz_generating`, starszy przejmowany. `release_quiz_claim` (`:171-179`). TTL 90 s > timeout 60 s (`quiz-task.ts:9`); `getQuizState` traktuje przeterminowany claim jak brak quizu (`quiz-repository.ts:89-91`).
- Zapis: `create_quiz(p_topic_id, p_questions jsonb)` — jeden plpgsql w jednej transakcji, temat `FOR SHARE`, dokładnie 10 elementów (P0422 `quiz_size`), wiersz quizu `FOR UPDATE`, przełączenie na `ready` i jeden `insert ... select from jsonb_array_elements with ordinality` (`...064348...sql:181-242`).
- Endpoint: `src/pages/api/topics/[id]/quiz/index.ts:23-64` — sprawdzenie stanu → claim → AI → `toQuizRows` → `createQuiz`; przy błędzie `releaseQuizClaim`; praca w `cfContext.waitUntil(work)` i jednocześnie `await work` (`:35-42`). Klient: `quiz_generating` → odśwież i odpytuj GET co 2 s (`QuizRunner.tsx:21, 40-44, 69-79`).
- Ślepa plamka zgłoszona w tej samej recenzji (`impl-review.md:57`): generowanie podtematów (`generate.ts`) nie ma claimu ani `waitUntil`. Nie dotyczy S-04 bezpośrednio.

### 5. Ograniczenia środowiska (Cloudflare Workers)

- `context/foundation/infrastructure.md`: plan Free = 10 ms CPU (oczekiwanie na `fetch` nie jest CPU), brak limitu czasu zegarowego przy podłączonym kliencie (`:32`); wprost wskazany scenariusz „walidacja 10 fiszek z rozszerzonymi wyjaśnieniami” jako możliwe sporadyczne 1102 (`:62`), z mitygacją — przejście na Workers Paid przy pierwszym 1102 (`:48, :92`); rozłączenie klienta anuluje Workera (`:63`).
- Plan F-02 ocenił walidację zod kilku KB jako mikrosekundy (`context/archive/2026-10-18-ai-call-guardrails/plan.md:301`).
- W `wrangler.jsonc` nie ma `limits.cpu_ms` ani wskazania planu — z repo nie wynika, czy produkcja jest na Free czy Paid.
- Brak w kodzie: streamingu, przekazywania `AbortSignal` z żądania, `beforeunload` (przeszukane `src/lib/ai/*`, endpointy quizu, `QuizRunner.tsx`).

### 6. Wzorzec nowej tabeli i testy bazy

- Kształt (`supabase/AGENTS.md`; wzorzec `isolation_probe` w `supabase/tests/database/account_isolation.test.sql:15-31`): `user_id uuid not null default auth.uid() references auth.users on delete cascade`, RLS, jedna polityka na komendę `to authenticated` z `(select auth.uid()) = user_id`, indeks na `user_id`; kompozytowe FK `(topic_id, user_id)` i `(subtopic_id, topic_id)` jak w `quiz_questions` (`...125014...sql:57-60`).
- `rls_guard.test.sql` wywala CI przy odstępstwie; wyjątki tylko w `rls_guard_exceptions` z uzasadnieniem (`:11-15`). `account_isolation.test.sql` ma dziś `plan(27)` — nowa tabela dokłada asercje i podbija licznik.
- Wzorzec tabeli z zablokowanym zapisem (jak quizy): `revoke all ... from authenticated; grant select` + RPC. Usuwanie fiszek (FR-012) wymaga wtedy albo polityki i uprawnienia `delete`, albo RPC do usuwania — wybór dla planu.
- Migracje przez `npx supabase migration new`, bez edycji migracji już na `main`, `db push` to ręczny krok przed merge; pgTAP uruchamia tylko CI (job `smoke` → `Database tests`, `.github/workflows/ci.yml:54-55`), bo lokalnie nie ma Dockera (`supabase/AGENTS.md:16`).

### 7. UI i trasy

- Strony renderują dane po stronie serwera (`createClient` + `isUuid` + `getTopic`, 404 dla obcego/nieistniejącego tematu, `src/pages/topics/[id].astro:10-16`), odczyty mogące się nie udać w try/catch (`:22-31`), wrapper `<div class="dark bg-background ...">` z `max-w-2xl p-4` i `Topbar` (`:43-45`).
- Auto-start przez `?start=1` usuwane `history.replaceState` przed wywołaniem AI (`quiz.astro:20`, `QuizRunner.tsx:57-65`).
- Ekran wyniku quizu (`QuizRunner.tsx:171-236`) nie ma żadnego CTA dalej — tylko link powrotny do tematu (`:85-91`). Na stronie tematu przycisk zmienia się na „Zobacz wynik quizu” (`TopicEditor.tsx:305-316`). Punkt wejścia do fiszek to decyzja S-04.
- Wyspy wołają `callApi<T>` (`src/components/topics/api.ts:16, 41-61`), błędy jako `Alert variant="destructive"` z „Spróbuj ponownie” przy `retryable` (`QuizRunner.tsx:97-108`), postęp przez `GeneratingNotice` (licznik sekund, copy „kilkanaście sekund” `GeneratingNotice.tsx:21`).
- `src/components/ui`: alert, alert-dialog, badge, button, input, label, select, textarea. Brak card / collapsible / accordion — „czytaj więcej” wymaga dodania komponentu z rejestru shadcn (pułapka z importem `cn`, S-03 `plan.md:358`). Potwierdzenie usunięcia istnieje jako lokalny `Confirmation` w `TopicEditor.tsx:321-342` (nieeksportowany); treść w portalu potrzebuje `PORTAL_THEME = "dark text-foreground"` (`TopicEditor.tsx:42`). Nowy kolor = nowy token w `src/styles/global.css`.

### 8. Testy z perspektywy użytkownika

- Wymóg: co najmniej jeden test z perspektywy użytkownika na podstawionych odpowiedziach AI (`context/foundation/shape-notes.md:232`, `roadmap.md:103`). S-02 i S-03 spełniły go przez `scripts/smoke-topics.mjs` (API, konta przez admin API, `AI_MODE=fake`, bez Playwright — S-02 `plan.md:40, 290-292`; S-03 `plan.md:276-291`).
- Pułapka: pętla limitu dziennego w smoke zaczyna od 4, bo wcześniej są 3 generowania (`smoke-topics.mjs:234-236`); generowanie fiszek przesunie to na 5. Smoke odpowiada na quiz stałym wzorcem (`:207-208`), a opcje są tasowane — asercje o tym, które podtematy są najsłabsze, wymagają deterministycznego tasowania (wstrzykiwalne, S-03 `plan.md:209`).

## Code References

- `supabase/migrations/20261023125014_create_diagnostic_quizzes.sql:174-205` — `quiz_results`, wejście rankingu
- `src/lib/topics/quiz-repository.ts:126-152` — `getQuizState`, liczenie `percent`
- `src/lib/topics/quiz-task.ts:9-18, 43-50, 87` — TTL claimu, kwoty pytań, walidacja kwot, `maxTokens`
- `supabase/migrations/20261024064348_quiz_generation_claim.sql:124-242` — `claim_quiz`, `release_quiz_claim`, `create_quiz`
- `src/pages/api/topics/[id]/quiz/index.ts:23-64` — przepływ endpointu generowania z `waitUntil`
- `src/lib/ai/call.ts:9-11, 86-168` — model, timeouty, kolejność limit → AI → walidacja
- `supabase/migrations/20261018092416_create_ai_calls.sql:33-73` — `begin_ai_call`
- `src/lib/ai/fixtures.ts:25-44` — fixture sterowany promptem, rejestr zadań
- `src/lib/topics/schemas.ts:22` — `CONTENT_TYPES`
- `context/foundation/prd.md:73, 89-94, 107, 129` — FR-005, FR-011–013, FR-020, FR-028
- `src/components/topics/QuizRunner.tsx:21-108, 171-236` — polling, retry, ekran wyniku bez CTA
- `supabase/tests/database/account_isolation.test.sql:15-31` — wzorzec izolacji
- `scripts/smoke-topics.mjs:207-208, 234-236` — wzorzec odpowiedzi, licznik generowań

## Architecture Insights

- Jedna ścieżka AI, bez ponowień; limit liczony przed wywołaniem; walidacja zod jako ostatnia bramka; ograniczenia, których nie wyrazi JSON schema (dokładne liczby, kwoty per podtemat), w `refine/superRefine`.
- Zapisy domenowe po wygenerowaniu: tabela tylko do odczytu dla `authenticated` + RPC `SECURITY DEFINER` w jednej transakcji; błędy rozpoznawane po `hint`, nie po treści.
- Mutacje zwracają pełny stan, wyspy renderują tylko ten stan (`src/lib/topics/AGENTS.md:14`); GET istnieje wyłącznie do pollingu, strony czytają repozytorium bezpośrednio (S-03 `plan.md:254`).
- Przy długim generowaniu: claim + `waitUntil` + stan `generating` + polling — wzorzec przyjęty po incydencie produkcyjnym.

## Historical Context (from prior changes)

- `context/archive/2026-10-22-diagnostic-quiz-by-subtopic/plan.md:51` i `plan-brief.md:50` — „ranking najsłabszych i fiszki (S-04)” jawnie odłożone do S-04; jeden quiz na temat jako „jedyne wejście dla S-04”, wynik liczony w SQL (`plan-brief.md:21, 25, 27`). Werdykt: aktualne.
- `.../diagnostic-quiz-by-subtopic/reviews/impl-review.md:41-63` (F1, naprawione) — źródło wzorca claim; `:102-110` (F5, zaakceptowane) — warunek „wróć, jeśli S-04 polega na uczciwych odpowiedziach”: warunek teraz spełniony, ryzyko nadal dotyczy tylko własnych danych.
- `context/archive/2026-10-22-topic-with-confirmed-subtopics/` follow-ups (F4, odłożone do S-08; `roadmap.md:210`) — `scope_note` zatwierdzonego tematu nadal da się zmienić, a trafia do promptu S-04. Werdykt: nadal otwarte.
- `context/archive/2026-10-18-ai-call-guardrails/plan.md:170` — 60 s dla generowania; `plan.md:301` — koszt zod pomijalny. Werdykt: aktualne (zgodne z `call.ts:11`).
- `context/foundation/shape-notes.md:35-36` umieszcza gramatykę w typie językowym, natomiast kod i PRD klasyfikują ją jako pojęciową (`subtopics-task.ts:29-30`, `prd.md:73`). Werdykt: notatka shape przestarzała w tym punkcie; obowiązuje PRD/kod.

## Related Research

- Brak wcześniejszych `research.md` w `context/changes/**` i `context/archive/**` dla tego obszaru (archiwa zawierają `plan.md`, `plan-brief.md`, `reviews/`).

## Open Questions

Decyzje dla `/10x-plan` (żadne przejrzane źródło ich nie rozstrzyga):

1. **Rozdział 10 fiszek** między podtematy według wyniku i reguła remisów (sugestia: `percent` rosnąco, potem `position`). Ile podtematów obejmuje pierwsza partia — wszystkie czy tylko najsłabsze?
2. **„Mniejsza partia” dla podtematu ze 100%** — ile fiszek i czy wchodzi w te same 10, czy ponad nie (FR-020 wymaga tylko, by nie był pominięty).
3. **Fiszka słownikowa a odpowiedź otwarta S-06** — FR-011 chce pytań na 2–3 zdania, a kształt słownikowy z FR-005 to słowo + tłumaczenie; trzeba ustalić, co jest „poprawną odpowiedzią” takiej fiszki.
4. **Model danych partii** pod S-07 (próg 80% bieżącej partii, kolejne partie): tabela `flashcard_batches` czy numer partii na fiszce; czy jedna pierwsza partia na temat ma unikalność w bazie (analogicznie do `quizzes.topic_id UNIQUE`).
5. **Usuwanie (FR-012)** — polityka + uprawnienie `delete` czy RPC; twarde czy miękkie usunięcie (FR-026: licznik opanowanych nie maleje po usunięciu — dotyczy S-10, ale wybór miękkiego/twardego zapada tutaj).
6. **Budżet generowania** — `maxTokens`, timeout i TTL claimu dla 10 fiszek z wyjaśnieniami; czy jedno wywołanie, czy kilka (każde liczy się do limitu 20). Brak pomiarów w repo — realne `latency_ms`/`output_tokens` quizu są tylko w produkcyjnej tabeli `ai_calls`; warto je odczytać przed ustaleniem budżetu.
7. **Punkt wejścia w UI** — CTA na ekranie wyniku quizu i/lub na stronie tematu; nowa strona `/topics/[id]/flashcards` z auto-startem `?start=1` wg wzorca quizu.
8. **Plan Workers (Free vs Paid)** — nie wynika z repo; przy Free ryzyko 1102 dla tej skali jest nazwane w `infrastructure.md:62`.
