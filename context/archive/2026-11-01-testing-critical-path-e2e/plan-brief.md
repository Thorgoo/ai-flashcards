# Critical-path E2E (test-plan Phase 1) — Plan Brief

> Full plan: `context/changes/testing-critical-path-e2e/plan.md`
> Research: `context/changes/testing-critical-path-e2e/research.md`

## What & Why

Pierwsze testy w przeglądarce w projekcie. Mają udowodnić, że pełna pętla US-01 (temat → podtematy → quiz → fiszki → nauka) działa na fake AI (ryzyko #4), oraz że błąd oceny odpowiedzi otwartej nie gubi tekstu, nie zmienia fiszki, a ponowienie działa (ryzyko #5). E2E to jedyna warstwa z zerowym pokryciem i jest potrzebna do zgłoszenia projektu (termin 2026-11-04).

## Starting Point

Pętlę przechodzi dziś tylko `scripts/smoke-topics.mjs` przez HTTP. Kod oceny chroni odpowiedź zgodnie z PRD (ocena przed zapisem, tekst zostaje w polu), ale nic tego nie testuje, a fake AI nie umie zasymulować błędu oceny. Brak Playwrighta; logowanie w UI tylko przez GitHub OAuth.

## Desired End State

`npm run e2e` lokalnie i krok e2e w jobie `smoke` w CI przechodzą jeden spec z dwoma testami: pętla do przodu fiszki w sesji nauki oraz błąd oceny z asercjami bazy i udanym „Spróbuj ponownie”. Smoke ma krok integracyjny #5. Test-plan §5/§6 opisuje nowy wzorzec.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Zakres #5 | Tylko sesja nauki, nie quiz | Quiz nie ma odpowiedzi wpisywanych ani oceny AI. | Research |
| Licznik ocen przy błędzie | Asercja +1, nie „bez zmian” | Limit liczy się niezależnie od wyniku (celowo). | Research |
| Szew błędu | Znacznik `[fake-ai-fail-once]`: błąd raz na dany tekst w procesie | Ponowienie wysyła ten sam tekst i `attemptId`, więc stały błąd uniemożliwiłby dowód udanego ponowienia. | Plan |
| Warstwa dowodu stanu bazy | Krok w `smoke-topics.mjs` + asercje bazy w e2e | Smoke ma już helpery bazy i działa w CI; `page.route` nie dociera do serwera. | Research / Plan |
| Lokalny env | Wrapper `npm run e2e` z kopią i przywróceniem `.env`/`.dev.vars` | Lokalne `.dev.vars` wskazuje na hostowany Supabase; jedna komenda jak w CI. | Plan |
| Konto testowe | Stałe `e2e@example.com`, usuwane i tworzone przy każdym przebiegu | Allowlista wymaga stałego e-maila; kaskada zeruje limity. | Plan |
| CI | E2E w jobie `smoke` już w Phase 1 | Stos już tam działa; regresja wykryta przed zgłoszeniem. | Plan |
| Kolejność testów | `describe.serial`: pętla, potem błąd oceny na tym samym temacie | Unika drugiego kompletu generowań i duplikacji seeda. | Plan |

## Scope

**In scope:**
- Szew fail-once w fixturze fake AI + test jednostkowy
- Krok #5 w `smoke-topics.mjs`
- Playwright: config, setup logowania, wrapper env, spec z dwoma testami
- Krok e2e w CI, aktualizacja test-planu §5/§6

**Out of scope:**
- OAuth w e2e, edycje podtematów, kolejna partia, odznaki, streak
- Przywracanie wersji roboczej po odświeżeniu, UX `quota_exceeded`
- Testy komponentów i tras w vitest; zmiany kodu aplikacji poza fixturą

## Architecture / Approach

Serwer `build` + `preview` na porcie 4321 z `AI_MODE=fake` i lokalnym Supabase (jak w CI). Projekt `setup` tworzy konto adminem, loguje hasłem do słoika `@supabase/ssr` i zapisuje `storageState`. Testy klikają po rolach i etykietach, a stan bazy czytają klientem service-role. Błąd oceny wywołuje znacznik w tekście, który fixture fake AI odrzuca tylko za pierwszym razem.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Szew fail-once | Jednorazowy błąd oceny w fake AI + test | Globalny stan modułu w testach |
| 2. Integracja #5 | Krok smoke z asercjami bazy | Stan fail-once musi przeżyć między żądaniami w workerd |
| 3. Infra Playwright | Config, setup logowania, `npm run e2e` | Format ciasteczek / przywracanie env |
| 4. E2E pętli (#4) | Test pętli do fiszki w nauce | Hydratacja, kolejka fiszek |
| 5. E2E błędu (#5) | Test błędu oceny z bazą | Kolejność kolejki nauki (seed z `due_on` = wczoraj) |
| 6. CI + test-plan | Krok e2e w CI, §5/§6 | Czas i niestabilność joba `smoke` |

**Prerequisites:** lokalny Supabase uruchomiony z `[auth.email] enable_signup = true` (jak w CI); Node 22.23.3.
**Estimated effort:** ~2–3 sesje w 6 fazach.

## Open Risks & Assumptions

- Zakładamy, że `astro preview` (workerd) zachowuje stan modułu między żądaniami; faza 2 to weryfikuje — jeśli nie, wracamy do planu.
- Nazwa i kształt ciasteczka sesji (`sb-127-auth-token`, możliwe dzielenie) są wywnioskowane z konwencji `@supabase/ssr`; setup sprawdza to wejściem na `/dashboard`.
- Twarde przerwanie procesu wrappera może zostawić wartości e2e w `.env`/`.dev.vars` — kolejny start to wykrywa i odmawia pracy.

## Success Criteria (Summary)

- Zepsuta pętla US-01 lub zgubiona odpowiedź przy błędzie oceny czerwieni CI na PR.
- `npm run e2e` działa lokalnie jedną komendą i zostawia konfigurację dewelopera nietkniętą.
- Każdy test czerwienieje na celowym zepsuciu opisanym w planie.
