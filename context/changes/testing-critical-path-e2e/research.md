---
date: 2026-11-01T15:40:46+01:00
researcher: Claude (Opus 5.5) for Thorgoo
git_commit: 15d87600595a32db7d026a73f5f6695e6a639d91
branch: main
repository: Thorgoo/ai-flashcards
topic: "Ground rollout Phase 1 (Critical-path E2E) of context/foundation/test-plan.md — risks #4 and #5"
tags: [research, testing, e2e, playwright, study-session, grading, ai-fake]
status: complete
last_updated: 2026-11-01
last_updated_by: Claude (Opus 5.5)
---

# Research: Phase 1 „Critical-path E2E” — ryzyka #4 i #5

**Date**: 2026-11-01T15:40:46+01:00
**Researcher**: Claude (Opus 5.5) for Thorgoo
**Git Commit**: 15d87600595a32db7d026a73f5f6695e6a639d91
**Branch**: main
**Repository**: Thorgoo/ai-flashcards

Wszystkie kotwice `file:line` odnoszą się do drzewa roboczego na tym commicie. Testów ani buildów nie uruchamiano.

## Research Question

Ugruntować etap 1 z `context/foundation/test-plan.md` (ryzyka #4 i #5): znaleźć w kodzie rzeczywistą ścieżkę awarii, zweryfikować lub skorygować Risk Response Guidance, wskazać istniejące testy i najtańszą użyteczną warstwę, oznaczyć ryzyka spekulatywne. Dodatkowo: uruchomienie z `AI_MODE=fake`, logowanie konta testowego bez GitHub OAuth, seed danych, translacja błędu trasa → UI oraz kolejność zapisu względem oceny.

## Summary

**Ryzyko #4 (pętla US-01 w przeglądarce)** — realne i niepokryte. Pętla to 5 pełnych przeładowań stron z wyspami React `client:load`, sterowanych parametrami `?generate=1` / `?start=1` i `useEffect` (szczegóły niżej). Żaden obecny test nie uruchamia przeglądarki; `scripts/smoke-topics.mjs` przechodzi tę samą ścieżkę tylko przez HTTP. Punkty, które pęknąć mogą wyłącznie w przeglądarce: wyścigi hydratacji, auto-start zależny od parametrów URL, nieaktualne propsy SSR, asynchroniczne generowanie fiszek przez kolejkę (202 → polling co 2 s). Guidance z test-planu się potwierdza: jedna ścieżka e2e na fake AI. Wszystkie kroki da się obsłużyć selektorami ról/etykiet — w `src` nie ma żadnego `data-testid`, ale nie jest potrzebny.

**Ryzyko #5 (błąd oceny AI)** — **zawężone**. Część „quiz” jest spekulatywna: quiz diagnostyczny przyjmuje tylko indeks 0–3 lub `dont_know` i nie wywołuje AI. Odpowiedź wpisywana i ocena AI istnieją wyłącznie w sesji nauki (fiszki `stage='open'`). Na tej ścieżce kod chroni zgodnie z PRD: trasa wywołuje AI **przed** jakimkolwiek zapisem fiszki i przy błędzie zwraca odpowiedź bez wywołania RPC; UI zostawia tekst w polu (read-only) i pokazuje „Spróbuj ponownie”, które wysyła ten sam tekst i ten sam `attemptId`. **Korekta guidance**: „licznik się nie zmienia” jest prawdziwe dla `flashcards.open_streak`/`stage`/`due_on`, ale **fałszywe dla dziennego licznika ocen** (`ai_calls`) — nieudana ocena celowo zużywa 1 ze 100 ocen. Test musi to asertywnie sprawdzić jako oczekiwane (+1), a nie jako brak zmian. Główna luka: **fake AI nie umie zasymulować błędu oceny przez HTTP** — potrzebny nowy szew (np. magiczny ciąg w fixturze).

**Infrastruktura** — brak Playwrighta, brak `seed.sql`, logowanie tylko przez GitHub OAuth. Wszystkie potrzebne wzorce istnieją w CI (`.github/workflows/ci.yml` job `smoke`) i w `scripts/smoke-topics.mjs`: lokalny Supabase, przełączenie `[auth.email] enable_signup`, konto tworzone adminem + `signInWithPassword` + ciasteczka `@supabase/ssr`, `build && preview` na porcie 4321 z `AI_MODE=fake` w `.env` i `.dev.vars`.

## Detailed Findings

### Ryzyko #4 — pętla temat → podtematy → quiz → fiszki → nauka

Mapa kroków (ścieżka sprawdzona przez lekturę komponentów i stron; nie uruchamiana):

| # | URL | Wyspa | Akcja i selektor | API | Stan po akcji / oczekiwanie |
|---|---|---|---|---|---|
| 1 | `/topics/new` | `NewTopicForm` (`src/pages/topics/new.astro:15`) | `getByLabel('Temat')` (`NewTopicForm.tsx:34-45`), przycisk „Utwórz i wygeneruj podtematy” (`:65-68`) | `POST /api/topics` → 201 (`src/pages/api/topics/index.ts:8-17`) | `window.location.assign('/topics/<id>?generate=1')` (`NewTopicForm.tsx:24`) |
| 2 | `/topics/[id]?generate=1` | `TopicEditor` (`[id].astro:83-92`); `autoGenerate` liczone w `[id].astro:24-28` | brak — generowanie startuje w `useEffect` po hydratacji i zdejmuje `?generate=1` przez `history.replaceState` (`TopicEditor.tsx:75-83`) | `POST /api/topics/[id]/generate` (synchronicznie) | `role="status"` „AI przygotowuje podtematy…” (`GeneratingNotice.tsx:17-21`), potem pola „Nazwa podtematu” (`TopicEditor.tsx:215`); fake daje 5 podtematów (`src/lib/ai/fixtures.ts:11-23`) |
| 3 | to samo | to samo | „Zatwierdź listę” (`TopicEditor.tsx:168-181`) → `alertdialog` → „Zatwierdź” `exact` (`Confirmation.tsx:33-34`) | `POST /api/topics/[id]/confirm` | „Zatwierdzony” + link „Rozpocznij quiz diagnostyczny” → `/topics/<id>/quiz?start=1` (`TopicEditor.tsx:343-355`) |
| 4 | `/topics/[id]/quiz?start=1` | `QuizRunner` (`quiz.astro:50-57`, `autoStart` w `:25`) | brak — auto-start (`QuizRunner.tsx:59-67`); fallback „Rozpocznij quiz” (`:119`) | `POST /api/topics/[id]/quiz` (+ polling GET co 2 s tylko przy stanie generating, `:73-81`) | „Pytanie 1 z 10” (`:126`) |
| 5 | to samo | to samo | 10× „Nie wiem” (`:153-163`) lub opcja `/Poprawna/`; przed kliknięciem asercja „Pytanie N z 10” | `POST /api/topics/[id]/quiz/answer` | „Wynik według podtematów” + link „Wygeneruj fiszki” → `/topics/<id>/flashcards?start=1` (`:204-209`) |
| 6 | `/topics/[id]/flashcards?start=1` | `FlashcardBatch` (`flashcards.astro:74-81`) | brak — auto-start (`FlashcardBatch.tsx:78-86`) | `POST /api/topics/[id]/flashcards` → **202**, zadanie w kolejce `FLASHCARD_JOBS` (`flashcards/index.ts:24-55`, `src/worker.ts:14-21`); polling `GET .../flashcards/summary` co 2 s (`FlashcardBatch.tsx:69-72,111-119`) | Najdłuższe oczekiwanie: nagłówek „Partia 1 (opanowane 0/10)” i link „Ucz się” (`:174,195-201`) |
| 7 | `/topics/[id]/study` | `StudySession` (`study.astro:52`) | link „Ucz się” (`exact`, bo istnieje też „Ucz się (N)” — `labels.ts`) | brak przy wejściu (sesja czytana w SSR, `study.astro:37`) | nowa fiszka ma `stage='choice'` i termin dziś (`supabase/migrations/20261026172800_flashcard_study_state.sql:13,15`) → `h1` z przodem fiszki (`StudySession.tsx:346-348`), „Pozostało: 10” (`:487`) |

Gdzie pętla może pęknąć w przeglądarce, a nie w testach logiki:

1. **Hydratacja** — przycisk w kroku 1 jest w SSR `disabled`, a pole kontrolowane przez React; tekst wpisany przed hydratacją może zniknąć. Test musi czekać, aż przycisk stanie się aktywny po `fill`.
2. **Auto-start po parametrach URL** — trzy miejsca (`generate=1`, dwa razy `start=1`) usuwają parametr przez `replaceState`; przeładowanie strony wyłącza auto-start.
3. **Nieaktualne propsy SSR** — link quizu po zatwierdzeniu i `hasFlashcards` na ekranie wyników zależą od propsów z momentu renderu.
4. **Kolejka fiszek** — jeżeli konsument kolejki nie działa na serwerze testowym, ekran zostaje na „AI przygotowuje fiszki…”. CI uruchamia `build` + `preview` i smoke czeka na partie (`scripts/smoke-topics.mjs:111-129`), więc preview wykonuje konsumenta. Dla `astro dev` nie zweryfikowano.
5. **Strażnicy stron** — `quiz`/`flashcards`/`study` renderują w SSR `h1` „Najpierw …” zamiast wyspy, gdy poprzedni krok się nie utrwalił (`study.astro:22-35`). To dobre asercje negatywne w raporcie porażki.

Istniejące pokrycie: `scripts/smoke-topics.mjs` (job `smoke` w CI) przechodzi tę samą sekwencję API na fake AI, ale bez przeglądarki. Testów komponentów brak (vitest w środowisku `node`, `src/**/*.test.ts` — `vitest.config.ts`); `src/components/topics/labels.test.ts` testuje tylko etykiety.

**Werdykt guidance #4**: potwierdzone. „Zielone testy jednostkowe = działający ekran” jest dokładnie tą luką — żaden test nie wykonuje JS po stronie klienta. Najtańsza warstwa to jedna ścieżka e2e. Przypadki, które wykrywa już integracja/smoke (walidacja, limity, izolacja kont), nie powinny trafiać do e2e.

### Ryzyko #5 — błąd oceny AI

**Zakres ryzyka (korekta).** Quiz diagnostyczny nie ma odpowiedzi wpisywanych ani wywołania AI: `quiz/answer.ts` przyjmuje tylko indeks lub `dont_know` (`src/lib/topics/schemas.ts:56-59`). Odpowiedź wpisywana i ocena AI występują w sesji nauki dla fiszek `stage='open'` — PRD FR-015/FR-016 (`context/foundation/prd.md:97-99`), FR-028 (`:129`), NFR (`:136`).

**Kolejność zapisu** (`src/pages/api/topics/[id]/study/answer.ts`):

```ts
const preflight = await readOpenAttempt(session.supabase, found.topic.id, input.cardId, input.attemptId); // :39
if (preflight.value.kind === "replay") return Response.json({ data: preflight.value.result });           // :41
const grading = await ai.call(buildGradingRequest(preflight.value.card, input.answerText));               // :44
if (!grading.ok) return aiResponse(grading, ai.mode);                                                     // :45
const saved = await answerFlashcardOpen(/* … */ grading.data);                                            // :48-54
```

- Przy `!grading.ok` trasa wraca w `:45` przed wywołaniem RPC `answer_flashcard_open`, więc na tej ścieżce nie ma zapisu fiszki ani wiersza `flashcard_answers`.
- Jedyny zapis przed wywołaniem AI to rezerwacja limitu: `deps.quota.begin(...)` → RPC `begin_ai_call` wstawia wiersz `ai_calls` (`src/lib/ai/call.ts:103`); wynik oznaczany przez `finish_ai_call` (`:151-162`). Migracja `supabase/migrations/20261018092416_create_ai_calls.sql:1-3` mówi, że limit liczy się „niezależnie od wyniku”. **Nieudana ocena zużywa więc 1 ocenę z dziennego limitu 100 — celowo.**
- RPC `answer_flashcard_open` jest jedną funkcją z `FOR UPDATE` i obsługą replay (`supabase/migrations/20261028200200_flashcard_open_answers.sql:37-144`); jej atomowość i odrzucenia pokrywa już `supabase/tests/database/flashcard_open.test.sql` (m.in. `:248-253`). pgTAP nie modeluje błędu AI, bo przy nim RPC nie jest wywoływane.

**Translacja błędu trasa → UI.** Statusy z `src/lib/ai/errors.ts:12-23`, ciało `{error:{code,message,retryable}}` (`src/lib/ai/response.ts:186`):

| Kod | HTTP | Retryable |
|---|---|---|
| `ai_timeout` | 504 | tak |
| `ai_unavailable` | 503 | tak |
| `ai_invalid_output` | 502 | tak |
| `quota_exceeded` | 429 | nie |
| `ai_not_configured` | 503 | nie |
| `save_failed` (zapis po udanej ocenie, `src/lib/topics/errors.ts:59`) | 500 | tak |

Odpowiedź niebędąca JSON-em staje się w kliencie `NETWORK_ERROR` z `retryable` (`src/components/topics/api.ts:27-35`).

UI (`src/components/topics/StudySession.tsx`):

- `failed()` kończy się `setAttempt({ ...next, error })` (`:145`) bez zmiany `step`; klucz `OpenCard` `${card.id}:${step}:${hydrated}` (`:294`) zostaje ten sam, więc komponent się nie remontuje.
- Pole: `const value = attempt?.answerText ?? text;` (`:415`), `readOnly={attempt !== null}` (`:439`) — tekst zostaje, ale bez edycji.
- „Sprawdź” ukryty, gdy istnieje próba (`:451`); przy `retryable` widoczne „Spróbuj ponownie” → `retry()` → `save(attempt)` z tym samym tekstem i `attemptId` (`:225-226`, `:530`).
- Wersja robocza w sessionStorage przy każdym wpisie (`:444`), usuwana dopiero po udanym zapisie (`:174`).
- Wyjątki: przy `quota_exceeded` karty otwarte znikają z kolejki i rośnie `step` (`:136-142`) — tekst zostaje tylko w sessionStorage; przy błędach nieponawialnych (np. `ai_not_configured`) dostępne jest tylko „Pomiń”.

**Wymuszenie błędu w teście.** `FakeAiFailure` istnieje (`src/lib/ai/fake.ts:6-35`), ale jest używany tylko w testach jednostkowych (`call.test.ts:97,156`, `flashcard-job.test.ts:133`). Fixture oceny (`src/lib/ai/fixtures.ts:64-73`) zwraca tylko poprawna/błędna wg słowa „poprawnie”; w sprawdzonym kodzie nie ma przełącznika środowiska, nagłówka ani magicznego wejścia wywołującego błąd przez HTTP. Opcje szwu:

- **Magiczny ciąg w fixturze oceny** (np. odpowiedź zawierająca znacznik błędu → `throw new FakeAiFailure("ai_timeout")`) — zgodny z istniejącą konwencją „poprawnie”, działa tylko w trybie fake, który działa wyłącznie przy lokalnym Supabase (`src/lib/ai/mode.ts:7-19`). Daje prawdziwy błąd serwera i prawdziwy stan bazy, więc e2e i smoke mogą sprawdzić bazę.
- **`page.route` zwracające 504** — tylko połowa UI, bez dowodu na stan bazy (anty-wzorzec z test-planu, jeśli użyty sam).
- **Test trasy w vitest** — wymaga mockowania `astro:env/server`; testów tras jeszcze nie ma, a bez prawdziwej bazy nie dowodzi stanu.

**Przygotowanie fiszki otwartej.** Fiszka z pętli ma `stage='choice'`. Fiszka otwarta po poprawnej odpowiedzi A/B/C/D dostaje termin w przyszłości, a sesja pokazuje tylko `due_on ≤ dziś` (archiwalny plan `context/archive/2026-10-28-ai-graded-open-answers/plan.md:19`). Test musi więc ustawić `stage='open'` i `due_on` = dziś klientem service-role, tak jak robi to `makeDue` w `scripts/smoke-topics.mjs:33-36`.

**Werdykt guidance #5**:
- Potwierdzone: tekst zostaje w polu, stan fiszki (`stage`, `open_streak`, `due_on`) się nie zmienia, nie powstaje wiersz `flashcard_answers`, ponowienie działa (ten sam `attemptId`).
- Skorygowane: (1) ryzyko dotyczy tylko sesji nauki, nie quizu; (2) dzienny licznik ocen (`ai_calls` kind `grading`) **rośnie o 1** — asercja ma to sprawdzać jako oczekiwane, nie jako „brak zmian”; (3) „5xx = nic się nie stało” jest prawdziwe dla fiszki, ale nie dla limitu.
- Najtańsza warstwa: wywołanie HTTP na fake AI + lokalny Supabase (rozszerzenie `smoke-topics.mjs` albo nowy test integracyjny trasy) dla stanu bazy i ponowienia; **jeden krok e2e** dla „tekst zostaje w polu + Spróbuj ponownie wysyła go bez przepisywania”, z asercją bazy klientem service-role.

### Uruchomienie z `AI_MODE=fake`

- `AI_MODE` to sekret `astro:env/server`, enum `live|fake`, domyślnie `live` (`astro.config.mjs:26-32`); czytany w `src/lib/ai/index.ts:2,18-42`.
- `fake` działa tylko przy `SUPABASE_URL` na `localhost`/`127.0.0.1`; inaczej `invalid` → każde wywołanie AI zwraca `ai_not_configured` (`src/lib/ai/mode.ts:7-19`, `index.ts:28-30`).
- Fixtury są deterministyczne i bez opóźnienia (`src/lib/ai/fake.ts:14-35`, `fixtures.ts`). Limity dzienne obowiązują także w trybie fake (`index.ts:39-40`).
- Adapter Cloudflare czyta `.dev.vars` w runtime `preview`/`dev`, build czyta `.env`; CI zapisuje oba pliki (`.github/workflows/ci.yml:59-60`). Lokalne `.dev.vars` wskazuje na hostowany Supabase i nie ma `AI_MODE`, więc uruchomienie e2e lokalnie nadpisze konfigurację dewelopera. Plan musi rozstrzygnąć strategię (kopia zapasowa/przywrócenie albo osobny katalog/plik). W repo nie znaleziono przełącznika plików env.

### Logowanie bez GitHub OAuth

- UI ma tylko OAuth (`src/pages/api/auth/signin.ts:10-13`); endpointu logowania hasłem brak.
- Middleware chroni `/dashboard`, `/topics`, `/badges` (`src/middleware.ts:6`), a użytkownika spoza `ALLOWED_EMAILS` wylogowuje przy każdym żądaniu (`:16-18`; `src/lib/allowlist.ts:3-13`, fail-closed). **E-mail konta testowego musi być w `ALLOWED_EMAILS`.**
- Wzorzec z `scripts/smoke-topics.mjs:95-117`: `admin.auth.admin.createUser({email, password, email_confirm:true})` → `createServerClient` z pamięciowym słoikiem ciasteczek → `signInWithPassword` → ciasteczko `*auth-token*`. Dla Playwrighta: ten sam słoik przepisać do `context.addCookies()` (domena `localhost`, ścieżka `/`) i zapisać `storageState` w projekcie setup. Nazwa `sb-127-auth-token` i ewentualne dzielenie na `.0/.1` wynikają z konwencji `@supabase/ssr` — niezweryfikowane w runtime.
- Lokalnie `[auth.email] enable_signup = false` wyłącza cały provider e-mail (`supabase/config.toml:202-205`), więc `signInWithPassword` nie zadziała. CI przełącza to `sed` przed `supabase start` (`ci.yml:44-49`); e2e lokalnie potrzebuje tego samego.
- `jwt_expiry` 3600 s i rotacja refresh tokenów (`supabase/config.toml:157,165`) — współdzielony `storageState` może się unieważnić przy równoległych workerach odświeżających sesję.

### Seed danych i limity

- `supabase/seed.sql` nie istnieje, choć `config.toml:60-65` go wskazuje. Seed = klient service-role (jak `makeDue`, `master`, `setMasteredTally` w `smoke-topics.mjs:32-73`) albo przejście przez API na fake AI.
- Limity: 20 generowań i 100 ocen na konto na dobę Europe/Warsaw (`create_ai_calls.sql:1-2,41,49,62`). Jedno przejście pętli zużywa generowania na podtematy, quiz i partię fiszek. Bezpieczne powtarzanie: świeży użytkownik na przebieg i usunięcie go na końcu (tak robi smoke, `:752-755`).

## Code References

- `src/pages/api/topics/[id]/study/answer.ts:37-55` — kolejność: preflight → ocena AI → zapis RPC
- `src/lib/ai/call.ts:86-168` — rezerwacja limitu przed wywołaniem providera, `finish_ai_call` po
- `src/lib/ai/errors.ts:12-23` — mapowanie kodów błędów AI na statusy HTTP
- `src/components/topics/StudySession.tsx:122-145,164-174,225-226,294,415,439,444,451,530` — obsługa błędu i ponowienia w UI
- `src/lib/ai/fixtures.ts:64-73` — fake ocena (słowo „poprawnie”), bez ścieżki błędu
- `src/lib/ai/fake.ts:6-35` — `FakeAiFailure`, dziś tylko w testach jednostkowych
- `src/lib/ai/mode.ts:7-19` — `fake` tylko przy lokalnym Supabase
- `supabase/migrations/20261028200200_flashcard_open_answers.sql:37-144` — atomowa funkcja odpowiedzi otwartej
- `supabase/migrations/20261018092416_create_ai_calls.sql:1-3` — limit liczony niezależnie od wyniku
- `src/middleware.ts:6-30`, `src/lib/allowlist.ts:3-13` — ochrona tras i allowlista
- `scripts/smoke-topics.mjs:33-36,95-129` — `makeDue`, logowanie hasłem, czekanie na partię
- `.github/workflows/ci.yml:28-72` — job `smoke`: lokalny Supabase, `.env`/`.dev.vars`, `build` + `preview --port 4321`
- `src/components/topics/NewTopicForm.tsx`, `TopicEditor.tsx`, `QuizRunner.tsx`, `FlashcardBatch.tsx` — kroki pętli (tabela wyżej)

## Architecture Insights

- Kontrakt „ocena przed zapisem; błąd AI → nic nie zapisane w fiszce” był decyzją planu S-06, a nie przypadkiem — test ma go chronić przed regresją przy przyszłych zmianach trasy.
- Nawigacja między krokami to pełne przeładowania (`window.location.assign`, zwykłe `<a href>`), bez `ClientRouter`; każdy krok e2e zaczyna się od nowej hydratacji.
- Generowanie fiszek jest asynchroniczne (kolejka Cloudflare) i wymaga serwera w trybie `build` + `preview`, tak jak w CI.
- Tryb fake jest zabezpieczony przed użyciem na produkcji (`mode.ts`), więc szew błędu w fixturze nie otwiera ścieżki w prod.

## Historical Context (from prior changes)

- `context/archive/2026-10-28-ai-graded-open-answers/plan.md:44,155` — kontrakt trasy: „ocena AI (błąd → odpowiedź `aiResponse` z błędem, nic nie zapisane) → funkcja SQL”. **Zgodny** z obecnym kodem (`study/answer.ts:44-45`).
- Ten sam plan, `:19,209` — tekst zostaje w polu i w sessionStorage, „Spróbuj ponownie” wysyła go bez przepisywania. **Zgodny** z `StudySession.tsx:415,444,530`.
- Ten sam plan, `:40` — e2e było świadomie poza zakresem S-06; `:231,314` — błąd oceny sprawdzono tylko ręcznie (symulowany błąd sieci). Brak automatycznego testu potwierdza lukę z test-planu.

## Related Research

Brak innych dokumentów `research.md` dla tych ryzyk w `context/changes/**` ani `context/archive/**`.

## Open Questions

1. **Szew błędu fake AI** — magiczny ciąg w `fixtures.ts` (rekomendowany: prawdziwy błąd serwera + prawdziwy stan bazy) czy `page.route` (tylko UI)? Decyzja planu.
2. **Strategia `.dev.vars`** przy lokalnym e2e — nadpisanie z kopią zapasową czy inny mechanizm; CI nie ma tego problemu.
3. **`astro dev` vs `preview`** — czy konsument kolejki działa pod `astro dev`; bezpieczny wybór to `build` + `preview` jak w CI.
4. **Gdzie umieścić warstwę integracyjną #5** — rozszerzenie `scripts/smoke-topics.mjs` (istniejący job CI) czy nowy test integracyjny; vitest dziś obejmuje tylko `src/**/*.test.ts` w środowisku `node`, bez testów tras.
5. **Przy `quota_exceeded` tekst znika z ekranu** (zostaje tylko w sessionStorage) — zgodne z planem S-06; poza zakresem tego etapu, chyba że produkt zdecyduje inaczej.
