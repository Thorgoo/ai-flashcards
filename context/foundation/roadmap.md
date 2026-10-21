---
project: AI Flashcards
version: 1
status: draft
created: 2026-10-05
updated: 2026-10-21
prd_version: 1
main_goal: quality
top_blocker: time
milestone_id: mvp-diagnosis-to-mastery
milestone_seq: 1
milestone_status: open
---

# Roadmap: AI Flashcards

> Derived from `context/foundation/prd.md` (v1) + `tech-stack.md`, `infrastructure.md`, `shape-notes.md` + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Milestone

**M-1: MVP — od diagnozy do opanowania** — Status: open

- **Intent:** Zalogowany użytkownik z allowlisty przechodzi pełną pętlę z PRD: temat → podtematy → quiz diagnostyczny → fiszki ze słabych podtematów → nauka z oceną AI → opanowanie → kolejna partia, a ekran główny, streak i odznaki pokazują postęp i zaniedbane tematy.
- **Source materials:** `context/foundation/prd.md` (v1)
- **Done when:** every F-NN and S-NN below is `done`.
- **Scope anchors:** US-01; FR-001 – FR-021, FR-023 – FR-028 (FR-022, nice-to-have, parked — see `## Parked`).

## Vision recap

Osoba ucząca się zawodowo kilku tematów naraz zdobywa wiedzę ad-hoc (np. w rozmowie z AI przy pracy), ale nic nie sprawia, że ta wiedza wraca i się utrwala, i nic nie pokazuje, czego w danym temacie jeszcze nie umie. Ręczne robienie fiszek do każdego tematu jest zbyt czasochłonne na co dzień. Produkt automatycznie diagnozuje słabe podtematy i generuje z nich fiszki, dzięki czemu codzienne powtórki kilku tematów naraz stają się realistyczne.

## North star

**S-04: Użytkownik dostaje pierwszą partię fiszek wygenerowanych ze swoich najsłabszych podtematów** — to najmniejszy kompletny przepływ, który dowodzi głównej tezy produktu („automat zamiast ręcznego tworzenia fiszek, celowany w to, czego nie umiem”); wszystko dalej (nauka, opanowanie, motywacja) ma sens tylko wtedy, gdy ten krok daje sensowne fiszki.

> „North star” (gwiazda przewodnia) oznacza tu najmniejszy wycinek od początku do końca, którego dostarczenie udowadnia główną hipotezę produktu — dlatego stoi tak wcześnie, jak pozwalają jego zależności. „Wycinek” (slice) to funkcja widoczna dla użytkownika, zrealizowana przez wszystkie warstwy naraz (dane + logika + ekran); „fundament” (foundation) to minimalny element przekrojowy, który sam nic nie pokazuje użytkownikowi, ale odblokowuje nazwane wycinki.

## At a glance

| ID   | Change ID                       | Outcome (user can …)                                                                                                                      | Prerequisites | PRD refs                                                              | Status   |
| ---- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------- | -------- |
| F-01 | per-account-data-isolation      | (foundation) dane są przypisane do konta i niewidoczne dla innych kont, ze sprawdzonym testem izolacji                                    | —             | Access Control, NFR (dane widoczne tylko dla właściciela), Guardrails | done     |
| F-02 | ai-call-guardrails              | (foundation) jedna ścieżka wywołań AI z walidacją wyniku, limitami dziennymi i podstawianymi odpowiedziami do testów                      | F-01          | FR-028, NFR (limity 20/100 dziennie), NFR (brak wrażenia zawieszenia) | done     |
| S-01 | allowlisted-oauth-login         | user can zalogować się przez OAuth (tylko adresy z allowlisty) i wylogować; publiczna rejestracja znika                                   | —             | FR-001, FR-002                                                        | done     |
| S-02 | topic-with-confirmed-subtopics  | user can utworzyć temat, poprawić wygenerowaną przez AI listę podtematów z typem treści i ją zatwierdzić                                  | S-01, F-02    | US-01, FR-003, FR-004, FR-005, FR-006, FR-028                         | proposed |
| S-03 | diagnostic-quiz-by-subtopic     | user can rozwiązać quiz diagnostyczny z opcją „nie wiem” i zobaczyć wynik per podtemat                                                    | S-02          | US-01, FR-008, FR-009, FR-010                                         | proposed |
| S-04 | first-weak-subtopic-batch       | user can dostać partię fiszek z najsłabszych podtematów, czytać „więcej” i usuwać złe fiszki                                              | S-03          | US-01, FR-011, FR-012, FR-013, FR-028                                 | proposed |
| S-05 | multiple-choice-study-session   | user can uczyć się zaległych fiszek w formacie A/B/C/D z natychmiastowym sprawdzeniem i harmonogramem powrotów                            | S-04          | US-01, FR-014, FR-015                                                 | proposed |
| S-06 | ai-graded-open-answers          | user can odpowiadać otwarcie, dostać ocenę AI i opanować fiszkę po dwóch poprawnych odpowiedziach w różne dni                             | S-05          | US-01, FR-015, FR-016, FR-017, FR-018, FR-028                         | proposed |
| S-07 | next-batch-and-subtopic-mastery | user can zobaczyć opanowanie per podtemat i po 80% partii wygenerować kolejną ze słabych, nieopanowanych podtematów                       | S-06          | US-01, FR-019, FR-020                                                 | proposed |
| S-08 | home-screen-and-topic-archive   | user can zobaczyć ekran główny z zaległymi fiszkami i datą ostatniej sesji per temat oraz zmienić nazwę, zarchiwizować i przywrócić temat | S-05          | FR-007, FR-021                                                        | proposed |
| S-09 | daily-streak                    | user can widzieć licznik serii dni nauki                                                                                                  | S-05          | FR-023                                                                | proposed |
| S-10 | badges                          | user can zdobywać odznaki za serię dni, opanowanie tematu i liczbę opanowanych fiszek oraz je przeglądać                                  | S-07, S-09    | FR-024, FR-025, FR-026, FR-027                                        | proposed |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme                       | Chain                                                                 | Note                                                                                                       |
| ------ | --------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A      | Pętla diagnoza → opanowanie | `F-01` → `F-02` → `S-02` → `S-03` → `S-04` → `S-05` → `S-06` → `S-07` | Rdzeń z kryterium sukcesu; przy celu „jakość” fundamenty izolacji i odporności AI idą pierwsze.            |
| B      | Wejście do aplikacji        | `S-01`                                                                | Równolegle do `F-01`/`F-02`; łączy się ze Stream A w `S-02`.                                               |
| C      | Przegląd tematów            | `S-08`                                                                | Odgałęzia się od Stream A po `S-05`; może iść równolegle do `S-06`/`S-07`.                                 |
| D      | Motywacja                   | `S-09` → `S-10`                                                       | Odgałęzia się po `S-05`; `S-10` czeka też na `S-07` (Stream A). Najbardziej przesuwalna przy presji czasu. |

## Baseline

What's already in place in the codebase as of `2026-10-05` (auto-researched + user-confirmed).
Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** partial — narzędzia gotowe (`src/layouts/Layout.astro`, `src/components/ui/button.tsx`), ale brak jakiegokolwiek ekranu produktu; `src/pages/index.astro` (Welcome) i `src/pages/dashboard.astro` to boilerplate szablonu, a `src/components/auth/SignUpForm.tsx` jest sprzeczny z PRD (brak publicznej rejestracji). Ekrany produktu dochodzą wraz z wycinkami; boilerplate usuwają `S-01` i `S-02`.
- **Backend / API:** partial — trasy tylko dla auth (`src/pages/api/auth/signin.ts`, `signup.ts`, `signout.ts`); brak tras domenowych.
- **Data:** absent — klient bazy jest (`src/lib/supabase.ts`), ale brak migracji, schematu i polityk dostępu per konto (`supabase/` zawiera tylko `config.toml`).
- **Auth:** partial — logowanie e-mail+hasło i middleware chroniące `/dashboard` (`src/middleware.ts`); brak OAuth i allowlisty (FR-001), istnieje publiczna rejestracja (Non-Goal).
- **AI:** absent — brak dostawcy, klienta, sekretu i walidacji odpowiedzi; `tech-stack.md` nie wskazuje dostawcy.
- **Limity wywołań AI:** absent — brak liczników 20/100 dziennie z NFR.
- **Testy:** absent — brak test runnera; `shape-notes.md` wymaga co najmniej jednego testu z perspektywy użytkownika na podstawionych odpowiedziach AI.
- **Deploy / infra:** present — Cloudflare Workers + Workers Builds z podglądami gałęzi, osobne KV sesji dla produkcji i podglądów, CI (`wrangler.jsonc`, `.github/workflows/ci.yml`, `context/deployment/deploy-plan.md`).
- **Observability:** partial — tylko Workers Logs (`observability.enabled` w `wrangler.jsonc`, 3 dni retencji); brak śledzenia błędów.

## Foundations

### F-01: Izolacja danych per konto

- **Outcome:** (foundation) istnieje powtarzalny sposób wprowadzania zmian schematu i wzorzec „wiersz należy do konta, inne konta go nie widzą”, potwierdzony automatycznym sprawdzeniem dwóch kont; żadne tabele domenowe poza minimalnym przykładem nie są jeszcze tworzone.
- **Change ID:** per-account-data-isolation
- **PRD refs:** Access Control, NFR (dane konta widoczne wyłącznie dla właściciela), Success Criteria § Guardrails (każde konto widzi wyłącznie swoje dane)
- **Unlocks:** F-02 (liczniki limitów są danymi per konto), S-02 (pierwsze tabele domenowe — tematy i podtematy — stosują ten wzorzec); ścieżka weryfikacji: test „konto B nie widzi danych konta A”, który każdy kolejny wycinek rozszerza o swoje tabele.
- **Prerequisites:** —
- **Parallel with:** S-01
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Przy celu „jakość” izolacja idzie przed pierwszą tabelą domenową, bo dopisywanie jej później do istniejących tabel jest łatwe do przeoczenia; ryzyko to przerośnięcie w „cały schemat z góry” — zakres kończy się na wzorcu i teście, tabele dochodzą w wycinkach.
- **Status:** done

### F-02: Bezpieczne wywołania AI

- **Outcome:** (foundation) jest jedna ścieżka wywołania AI, która waliduje kształt odpowiedzi, odrzuca niepoprawny wynik z czytelnym błędem i możliwością ponowienia, liczy osobne dzienne limity per konto (20 generowań / 100 ocen) i w testach może zostać zastąpiona podstawionymi odpowiedziami; konkretne prompty powstają w wycinkach.
- **Change ID:** ai-call-guardrails
- **PRD refs:** FR-028, NFR (limit 20 generowań dziennie), NFR (osobny limit 100 ocen dziennie), NFR (interfejs nigdy nie wygląda na zawieszony podczas generowania)
- **Unlocks:** S-02 (pierwsze wywołanie AI — generowanie podtematów), a przez nią S-03, S-04, S-06, S-07; ścieżka weryfikacji: test z perspektywy użytkownika na podstawionych odpowiedziach AI (`shape-notes.md` § Forward: technical-roadmap).
- **Prerequisites:** F-01
- **Parallel with:** S-01
- **Blockers:** —
- **Unknowns:**
  - Który dostawca i model AI (`tech-stack.md` go nie wskazuje) i czy odpowiedź mieści się w ograniczeniach środowiska uruchomieniowego (`infrastructure.md`: limit CPU, przerwanie żądania przy rozłączeniu klienta)? — Owner: user. Block: no.
- **Risk:** Musi poprzedzać pierwsze wywołanie AI, bo zapis „wszystko albo nic” i limity są trudne do dołożenia do kilku istniejących wywołań; znane ryzyko z `infrastructure.md` — zablokowany telefon przerywa generowanie, a próba i tak zużywa limit.
- **Status:** done

## Slices

### S-01: Logowanie przez OAuth z allowlistą

- **Outcome:** user can zalogować się przez jednego zewnętrznego dostawcę tożsamości, tylko jeśli jego adres jest na liście dozwolonych (utrzymywanej poza UI produktu), i wylogować się; publiczna rejestracja i logowanie hasłem znikają.
- **Change ID:** allowlisted-oauth-login
- **PRD refs:** FR-001, FR-002
- **Prerequisites:** —
- **Parallel with:** F-01, F-02
- **Blockers:** —
- **Unknowns:**
  - Który dostawca tożsamości (PRD mówi tylko „jeden zewnętrzny”) i gdzie żyje allowlista? — Owner: user. Block: no.
- **Risk:** Wcześnie, bo każdy kolejny wycinek zakłada zalogowane konto, a obecny formularz rejestracji łamie Non-Goal; `infrastructure.md` ostrzega, że adresy podglądów muszą być dopisane do dozwolonych przekierowań, inaczej logowanie pada na podglądach.
- **Resolved:** dostawca GitHub; allowlista w sekrecie `ALLOWED_EMAILS` (callback + middleware).
- **Status:** done

### S-02: Temat z zatwierdzonymi podtematami

- **Outcome:** user can utworzyć temat (z opcjonalną notatką o zakresie/poziomie), zobaczyć wygenerowaną przez AI listę podtematów z rozpoznanym typem treści (pojęciowy / językowy), usunąć, zmienić nazwę, dodać podtemat, poprawić typ lub wygenerować listę ponownie, zatwierdzić ją oraz wybrać istniejący temat z listy.
- **Change ID:** topic-with-confirmed-subtopics
- **PRD refs:** US-01, FR-003, FR-004, FR-005, FR-006, FR-028
- **Prerequisites:** S-01, F-02
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Pierwszy wycinek z AI i pierwszymi tabelami domenowymi — ćwiczy oba fundamenty na realnej funkcji; błędy podtematów dziedziczy cała reszta, dlatego edycja przed zablokowaniem jest częścią wycinka, a nie dodatkiem.
- **Status:** proposed

### S-03: Quiz diagnostyczny z wynikiem per podtemat

- **Outcome:** user can rozwiązać wygenerowany przez AI 10-pytaniowy quiz (A/B/C/D + „nie wiem”), po którego rozpoczęciu podtematy są zablokowane, i zobaczyć wynik z podziałem na podtematy.
- **Change ID:** diagnostic-quiz-by-subtopic
- **PRD refs:** US-01, FR-008, FR-009, FR-010
- **Prerequisites:** S-02
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Wynik per podtemat jest wejściem dla wyboru „najsłabszych podtematów” w S-04 — błędne przypisanie pytań do podtematów cicho psuje gwiazdę przewodnią.
- **Status:** proposed

### S-04: Pierwsza partia fiszek ze słabych podtematów

- **Outcome:** user can dostać partię 10 fiszek wygenerowanych z najsłabszych podtematów (podtemat ze 100% w quizie też dostaje mniejszą partię), w kształcie zależnym od typu treści, z rozszerzonym wyjaśnieniem pod „czytaj więcej” zapisanym razem z fiszką, przejrzeć je i usunąć niechciane.
- **Change ID:** first-weak-subtopic-batch
- **PRD refs:** US-01, FR-011, FR-012, FR-013, FR-028
- **Prerequisites:** S-03
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Gwiazda przewodnia — najcięższe generowanie (10 fiszek z wyjaśnieniami), więc najbardziej narażone na limity środowiska i zapis częściowy; zapis „wszystko albo nic” z F-02 musi tu zadziałać na pełnej skali.
- **Status:** proposed

### S-05: Sesja nauki w formacie A/B/C/D

- **Outcome:** user can rozpocząć sesję nauki tematu, zobaczyć tylko zaległe i nieopanowane fiszki, odpowiadać A/B/C/D ze sprawdzeniem natychmiastowym, przy czym błędna wraca w tej samej sesji, a poprawna przechodzi do formatu otwartego i wraca następnego dnia; sesja jest w pełni używalna na telefonie.
- **Change ID:** multiple-choice-study-session
- **PRD refs:** US-01, FR-014, FR-015
- **Prerequisites:** S-04
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - Co wyznacza granicę „dnia” dla harmonogramu (strefa czasowa konta?) — patrz Open Roadmap Question 3. Owner: user. Block: no.
- **Risk:** Wprowadza harmonogram z tabeli Business Logic, na którym opierają się S-06, S-08 i S-09; oddzielony od oceny AI, żeby harmonogram i natychmiastowe sprawdzenie (< 300 ms) dało się zweryfikować bez zależności od AI.
- **Status:** proposed

### S-06: Odpowiedzi otwarte oceniane przez AI i opanowanie

- **Outcome:** user can odpowiedzieć 2–3 zdaniami na fiszkę w formacie otwartym, dostać ocenę AI poprawna/błędna, po błędzie zobaczyć poprawną odpowiedź i reset licznika (bez powrotu do A/B/C/D), a po dwóch poprawnych odpowiedziach w różne dni mieć fiszkę opanowaną; przy błędzie oceny wpisana odpowiedź zostaje i można ją wysłać ponownie.
- **Change ID:** ai-graded-open-answers
- **PRD refs:** US-01, FR-015, FR-016, FR-017, FR-018, FR-028
- **Prerequisites:** S-05
- **Parallel with:** S-08, S-09
- **Blockers:** —
- **Unknowns:**
  - Jaka tolerancja oceny na parafrazę/niepełność (PRD Open Question 2)? Start od prostego pass/fail. — Owner: user. Block: no.
- **Risk:** Nazwane w PRD ryzyko do zwalidowania przed dalszą rozbudową — niespójna ocena podważa cały mechanizm opanowania, więc S-07 i S-10 czekają na ten wycinek.
- **Status:** proposed

### S-07: Opanowanie podtematów i kolejna partia

- **Outcome:** user can zobaczyć opanowanie per podtemat (opanowany = wszystkie jego fiszki ze wszystkich partii opanowane) i po opanowaniu 80% bieżącej partii wygenerować przyciskiem kolejną partię dla tego lub następnego najsłabszego nieopanowanego podtematu, z pominięciem opanowanych.
- **Change ID:** next-batch-and-subtopic-mastery
- **PRD refs:** US-01, FR-019, FR-020
- **Prerequisites:** S-06
- **Parallel with:** S-08, S-09
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Domyka pętlę z kryterium sukcesu; zależy od poprawnie liczonego opanowania z S-06, więc nie może iść wcześniej.
- **Status:** proposed

### S-08: Ekran główny i archiwizacja tematów

- **Outcome:** user can zobaczyć ekran główny z listą tematów, liczbą zaległych fiszek i datą ostatniej sesji per temat oraz zmienić nazwę tematu, zarchiwizować go (po potwierdzeniu, bez usuwania danych) i przywrócić.
- **Change ID:** home-screen-and-topic-archive
- **PRD refs:** FR-007, FR-021
- **Prerequisites:** S-05
- **Parallel with:** S-06, S-07, S-09, S-10
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Wymaga danych o zaległości i sesjach z S-05; archiwizacja wyklucza temat z serii dni i odznak — jeśli S-09/S-10 powstaną przed tym wycinkiem, to on musi dołożyć wykluczenie, w przeciwnym razie robią to one.
- **Status:** proposed

### S-09: Licznik serii dni

- **Outcome:** user can widzieć licznik serii dni, w których wykonał powtórki.
- **Change ID:** daily-streak
- **PRD refs:** FR-023
- **Prerequisites:** S-05
- **Parallel with:** S-06, S-07, S-08
- **Blockers:** —
- **Unknowns:**
  - Co wyznacza granicę „dnia” — patrz Open Roadmap Question 3. Owner: user. Block: no.
- **Risk:** Poza rdzeniem przepływu (PRD § Secondary), więc w osobnej ścieżce; jest podstawą odznak za serię w S-10.
- **Status:** proposed

### S-10: Odznaki

- **Outcome:** user can otrzymać odznaki za kamienie milowe serii dni, za 100% opanowania podtematów tematu i za łączną liczbę opanowanych fiszek (licznik historyczny — nie maleje po usunięciu fiszki) oraz przeglądać zdobyte odznaki.
- **Change ID:** badges
- **PRD refs:** FR-024, FR-025, FR-026, FR-027
- **Prerequisites:** S-07, S-09
- **Parallel with:** S-08
- **Blockers:** —
- **Unknowns:**
  - Dokładne progi odznak (PRD Open Question 1); start z progami tymczasowymi. — Owner: user. Block: no.
- **Risk:** Ostatni, bo konsumuje opanowanie (S-06, S-07) i serię (S-09); przy presji czasu to pierwszy kandydat do przesunięcia — świadomie, bo PRD trzyma go poza rdzeniem przepływu.
- **Status:** proposed

## Backlog Handoff

| Roadmap ID | Change ID                       | Suggested issue title                                                     | Ready for `/10x-plan` | Notes                                      |
| ---------- | ------------------------------- | ------------------------------------------------------------------------- | --------------------- | ------------------------------------------ |
| F-01       | per-account-data-isolation      | Izolacja danych per konto + test dwóch kont                               | yes                   | Run `/10x-plan per-account-data-isolation` |
| F-02       | ai-call-guardrails              | Bezpieczne wywołania AI: walidacja, limity 20/100, podstawiane odpowiedzi | no                    | Czeka na F-01                              |
| S-01       | allowlisted-oauth-login         | Logowanie OAuth z allowlistą, usunięcie rejestracji                       | done                  | #5, PR #16                                 |
| S-02       | topic-with-confirmed-subtopics  | Tworzenie tematu i zatwierdzanie podtematów z AI                          | no                    | Czeka na S-01, F-02                        |
| S-03       | diagnostic-quiz-by-subtopic     | Quiz diagnostyczny z wynikiem per podtemat                                | no                    | Czeka na S-02                              |
| S-04       | first-weak-subtopic-batch       | Pierwsza partia fiszek ze słabych podtematów                              | no                    | Gwiazda przewodnia; czeka na S-03          |
| S-05       | multiple-choice-study-session   | Sesja nauki A/B/C/D z harmonogramem powrotów                              | no                    | Czeka na S-04                              |
| S-06       | ai-graded-open-answers          | Odpowiedzi otwarte oceniane przez AI i opanowanie fiszek                  | no                    | Czeka na S-05                              |
| S-07       | next-batch-and-subtopic-mastery | Opanowanie podtematów i generowanie kolejnej partii                       | no                    | Czeka na S-06                              |
| S-08       | home-screen-and-topic-archive   | Ekran główny tematów + archiwizacja/przywracanie                          | no                    | Czeka na S-05                              |
| S-09       | daily-streak                    | Licznik serii dni                                                         | no                    | Czeka na S-05                              |
| S-10       | badges                          | Odznaki: seria, opanowanie tematu, liczba opanowanych fiszek              | no                    | Czeka na S-07, S-09                        |

## Open Roadmap Questions

1. **Jakie są dokładne progi odznak?** — kamienie milowe serii dni (FR-024) i łącznej liczby opanowanych fiszek (FR-026); np. 7/30/100 dni, 50/200 fiszek. Owner: użytkownik. Block: nie (S-10 może wystartować z progami tymczasowymi).
2. **Jak dokładnie AI ma oceniać poprawność krótkiej odpowiedzi otwartej (FR-016)?** — tolerancja na parafrazę/niepełność, ewentualne „częściowo poprawne”. Owner: użytkownik. Block: nie (S-06 startuje od prostego pass/fail).
3. **Co wyznacza granicę „dnia”** dla harmonogramu („następnego dnia”, „za 3 dni”, „osobne dni”), serii dni i limitów dziennych — strefa czasowa konta czy stała? Owner: użytkownik. Block: nie (dotyczy S-05, S-06, S-09, S-10, F-02; domyślna decyzja w pierwszym `/10x-plan`, który jej potrzebuje). **Rozstrzygnięte (F-02, 2026-10-18):** dzień = data kalendarzowa w strefie Europe/Warsaw, jedna strefa dla wszystkich kont (`begin_ai_call` w `supabase/migrations/`).

## Parked

- **Cel dzienny z podglądem postępu (FR-022)** — Why parked: jedyny wymóg nice-to-have, a głównym ryzykiem jest czas; wraca do kolejnego kamienia milowego lub do S-09, jeśli zostanie zapas.
- **Powiadomienia mailowe** — Why parked: PRD § Non-Goals.
- **Cele tygodniowe** — Why parked: PRD § Non-Goals.
- **Publiczna rejestracja** — Why parked: PRD § Non-Goals (S-01 ją usuwa).
- **Pełny algorytm powtórek (SM-2 lub podobny)** — Why parked: PRD § Non-Goals; świadomie prosta reguła z Business Logic.
- **Generowanie fiszek z własnego materiału** — Why parked: PRD § Non-Goals.
- **Automatyczne dobieranie kolejnej partii bez przycisku** — Why parked: PRD § Non-Goals (S-07 używa przycisku).
- **Dodawanie podtematów do zablokowanego tematu** — Why parked: PRD § Non-Goals.
- **Kontrolne powtórki opanowanych fiszek** — Why parked: PRD § Non-Goals.
- **Aplikacja natywna** — Why parked: PRD § Non-Goals.
- **Panel administracyjny** — Why parked: PRD § Non-Goals (allowlista poza UI).
- **Współdzielenie tematów między kontami** — Why parked: PRD § Non-Goals.
- **Format tak/nie** — Why parked: PRD § Non-Goals.

## Milestone History

## Done

- **S-01: Logowanie przez OAuth z allowlistą** — done 2026-10-11 (issue #5, PR #16). GitHub OAuth + `ALLOWED_EMAILS`; rejestracja i logowanie hasłem usunięte.
- **F-01: (foundation) istnieje powtarzalny sposób wprowadzania zmian schematu i wzorzec „wiersz należy do konta, inne konta go nie widzą”, potwierdzony automatycznym sprawdzeniem dwóch kont; żadne tabele domenowe poza minimalnym przykładem nie są jeszcze tworzone.** — Archived 2026-10-18 → `context/archive/2026-10-17-per-account-data-isolation/`. Lesson: —.
- **F-02: (foundation) jest jedna ścieżka wywołania AI, która waliduje kształt odpowiedzi, odrzuca niepoprawny wynik z czytelnym błędem i możliwością ponowienia, liczy osobne dzienne limity per konto (20 generowań / 100 ocen) i w testach może zostać zastąpiona podstawionymi odpowiedziami; konkretne prompty powstają w wycinkach.** — Archived 2026-10-21 → `context/archive/2026-10-18-ai-call-guardrails/`. Lesson: —.
