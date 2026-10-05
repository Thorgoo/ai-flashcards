---
project: "AI Flashcards"
version: 1
status: draft
created: 2026-09-27
context_type: greenfield
product_type: web-app
target_scale:
  users: small
  qps: low
  data_volume: small
timeline_budget:
  mvp_weeks: 3
  hard_deadline: 2026-11-04
  after_hours_only: true
---

## Vision & Problem Statement

Osoba ucząca się zawodowo kilku tematów naraz (Spring, Kubernetes, chmura, angielski) zdobywa wiedzę głównie ad-hoc — podczas pracy, w rozmowie z Claude nad konkretnym problemem. Ta wiedza jest epizodyczna: pomaga rozwiązać dany problem, ale nic nie sprawia, że wraca i utrwala się później, i nic nie pokazuje, czego konkretnie w danym temacie jeszcze nie umie. Przy kilku tematach naraz i braku jednego miejsca łączącego naukę z wszystkich z nich, zawsze któryś temat zostaje zaniedbany na rzecz bieżącej pracy. Ręczne tworzenie fiszek dla każdego tematu byłoby zbyt czasochłonne, by robić to codziennie — stąd brak systemu powtórek, nie brak chęci.

Insight: nauka wspierana przez AI (np. Claude) podczas pracy daje zrozumienie w danym momencie, ale bez zewnętrznego mechanizmu, który zdiagnozuje słabe punkty i przypomina o nich w czasie, nie zamienia się w trwałą pamięć — a automatyczne wygenerowanie diagnozy i fiszek (zamiast ręcznego ich tworzenia) jest tym, co czyni codzienne powtórki realistyczne przy kilku tematach naraz.

## User & Persona

Primary persona: sam twórca produktu — osoba pracująca zawodowo z kilkoma technologiami (Spring, Kubernetes, chmura) i ucząca się dodatkowo angielskiego, chcąca codziennie zwiększać poziom w każdym z tych tematów. Pierwszy użytkownik produktu jest jednocześnie jego twórcą. Moment, w którym sięga po produkt: gdy chce sprawdzić, czego w danym temacie jeszcze nie umie (quiz diagnostyczny) oraz codziennie, żeby wykonać powtórki across wszystkich tematów naraz, zanim jakiś temat zostanie zaniedbany.

### Secondary persona

Żona twórcy — docelowo drugie konto, głównie do nauki angielskiego i tematów HR. Nie jest aktywnym użytkownikiem w MVP, ale jej potrzeby (język, nie technika) są bezpośrednim powodem, dla którego temat "typu treści" (pojęciowy vs językowy) i model wielokontowy są częścią projektu od początku, nie dopisane później.

## Success Criteria

### Primary
- Użytkownik loguje się, widzi ekran główny z listą tematów (liczba fiszek do powtórki i data ostatniej sesji per temat), tworzy temat, otrzymuje wygenerowany przez AI quiz diagnostyczny, widzi wynik z podziałem na podtematy, otrzymuje fiszki wygenerowane z najsłabszych podtematów (w kształcie zależnym od automatycznie rozpoznanego typu treści — pojęciowego lub językowego) i uczy się z nich: fiszka startuje jako multiple-choice, po pierwszej poprawnej odpowiedzi przechodzi w krótką odpowiedź otwartą ocenianą przez AI, a opanowana jest po dwóch poprawnych odpowiedziach otwartych na osobnych okazjach. Po opanowaniu 80% fiszek bieżącej partii użytkownik może ręcznie wygenerować kolejną partię z najsłabszych, jeszcze nieopanowanych podtematów, bez powtarzania już opanowanych.

### Secondary
- Cel dzienny (edytowalna liczba powtórek dziennie, nice-to-have) z podglądem dzisiejszego postępu względem niego. Licznik serii dni i odznaki za kamienie milowe streaka, opanowanie tematu i łączną liczbę opanowanych fiszek są must-have w MVP jako funkcje motywacyjne, ale nie są częścią rdzenia przepływu (diagnoza → nauka → opanowanie) opisanego w Primary. Powiadomienia mailowe i cele tygodniowe są rozszerzeniami po MVP.

### Guardrails
- Każde konto widzi wyłącznie swoje tematy, fiszki, wyniki quizów i postęp.
- Błąd lub nieprawidłowa odpowiedź AI (timeout, zły format, błąd oceny odpowiedzi otwartej) nigdy nie usuwa ani nie psuje zapisanych fiszek, postępu ani wpisanej przez użytkownika odpowiedzi — użytkownik widzi komunikat i może ponowić.

## User Stories

### US-01: User diagnoses their level and studies AI-generated flashcards targeting weak subtopics

- **Given** a logged-in user with a topic that has AI-generated subtopics
- **When** they take the AI-generated diagnostic quiz and start a study session
- **Then** they see flashcards generated from their weakest subtopics (in a content shape matching the topic's automatically detected type), each starting in multiple-choice format and switching to an AI-graded open-answer format after a correct answer, with mastery reached after two correct open-answer responses given on separate occasions

#### Acceptance Criteria
- Diagnostic quiz results show a per-subtopic breakdown; each question offers an "I don't know" option.
- Generated flashcards are tagged with a subtopic from the topic's stored subtopic list, and include an extended explanation viewable via "read more".
- A flashcard's format transitions correctly: multiple-choice until first correct answer, then a short (2-3 sentence) open answer graded by AI; a wrong open-answer response shows the correct answer and resets the mastery counter to zero without demoting the card back to multiple-choice.
- Mastery requires two correct open-answer responses on separate, non-immediately-consecutive review occasions.
- Clicking "next batch" generates new flashcards only from the weakest not-yet-mastered subtopics, skipping already-mastered ones.
- An AI generation or grading failure shows an error and allows retry without losing existing flashcards, progress, or the user's typed answer.

## Functional Requirements

### Uwierzytelnianie
- FR-001: User can log in via OAuth through a single external identity provider, restricted to an allowlist of approved email addresses maintained outside the product's own UI (no admin panel). Priority: must-have
  > Socrates: Brak kontrargumentu — FR stoi jak jest.
- FR-002: User can log out. Priority: must-have
  > Socrates: Brak kontrargumentu — FR stoi jak jest.

### Zarządzanie tematami
- FR-003: User can create a new topic (e.g. "Spring", "angielski"), optionally with a scope/level note (e.g. "Spring Boot 3, REST, używam na co dzień") passed to AI when generating subtopics and the diagnostic quiz. Priority: must-have
  > Socrates: Brak kontrargumentu — FR stoi jak jest.
- FR-004: When a topic is created, the system generates a list of subtopics using AI and shows it to the user before the diagnostic quiz, each tagged with its detected content type (FR-005); the user can remove, rename, or add a subtopic, correct its detected content type, or request regeneration. Once confirmed and the quiz starts, the subtopic list and content types are locked for MVP. Every quiz question and flashcard is tagged with one of these subtopics. Priority: must-have
  > Socrates: Kontrargument rozważony: jeśli AI źle dobierze podtematy (lub ich typ treści) na starcie, cała późniejsza struktura (quizy, fiszki) dziedziczy ten błąd bez możliwości edycji. Rozstrzygnięcie: FR zmieniony — lista podtematów i ich typy treści są pokazywane użytkownikowi przed quizem, można je poprawić lub wygenerować ponownie; blokowane dopiero po rozpoczęciu quizu. Dodawanie podtematów do już istniejącego, zablokowanego tematu to rozszerzenie po MVP.
- FR-005: System automatically determines the content type of each subtopic — conceptual (question + correct answer + 3 incorrect options; used for technical topics like Spring/Kubernetes and for grammar, e.g. "Present Perfect") or vocabulary (word + translation + example sentence + 3 incorrect translations; used for language vocabulary) — based on the topic's name/scope note. The user never sets this manually at creation, but can correct it per subtopic before the quiz starts (FR-004). Priority: must-have
  > Socrates: Brak kontrargumentu — FR stoi jak jest.
- FR-006: User can select an existing topic. Priority: must-have
  > Socrates: Brak kontrargumentu — FR stoi jak jest.
- FR-007: User can rename a topic, archive a topic, and restore a previously archived topic. Archiving hides a topic and its flashcards/progress from the active list and excludes them from the daily goal, streak, and badge counts, without deleting them, until the topic is restored, after confirmation. Priority: must-have
  > Socrates: Kontrargument rozważony: trwałe usunięcie bez cofnięcia to duże ryzyko przypadkowej utraty całego postępu nauki. Rozstrzygnięcie: usunięcie tematu realizowane jako archiwizacja z możliwością przywrócenia, nie trwałe usunięcie.

### Quiz diagnostyczny
- FR-008: System generates a diagnostic quiz (multiple-choice) for a topic using AI. Priority: must-have
  > Socrates: Brak kontrargumentu — FR stoi jak jest.
- FR-009: User can answer the diagnostic quiz; each question includes an "I don't know" option alongside A/B/C/D. Priority: must-have
  > Socrates: Kontrargument rozważony: bez opcji "nie wiem" użytkownik zgadujący losowo zniekształca wynik diagnozy (fałszywie "zna" podtemat). Rozstrzygnięcie: dodano opcję "nie wiem" do każdego pytania quizu.
- FR-010: System shows quiz results broken down by subtopic. Priority: must-have
  > Socrates: Brak kontrargumentu — FR stoi jak jest.

### Generowanie i nauka fiszek
- FR-011: System generates flashcards from the topic's weakest subtopics using AI, in a content shape matching each subtopic's detected type (FR-005); each flashcard's question is phrased to elicit a short answer (2-3 zdania), and generation also produces an extended explanation for "read more" (FR-013). Priority: must-have
  > Socrates: Brak kontrargumentu — FR stoi jak jest.
- FR-012: User can review and delete an incorrect/unwanted flashcard. Priority: must-have
  > Socrates: Brak kontrargumentu — FR stoi jak jest.
- FR-013: User can click "read more" on a flashcard to see an expanded explanation of the concept; this content is generated together with the flashcard at creation time and simply displayed on click — no additional AI call happens during study. Priority: must-have
  > Socrates: Kontrargument rozważony: gdyby treść była generowana na żądanie przy kliknięciu, to kolejne miejsce, gdzie AI działa podczas nauki (obok oceny odpowiedzi otwartej). Rozstrzygnięcie: treść generowana i zapisywana razem z fiszką; kliknięcie tylko ją wyświetla.
- FR-014: User can start a study session for a topic; the system shows flashcards that are due and not yet mastered. A flashcard answered wrong comes back sooner than one answered correctly (simple rule, no full SM-2 algorithm in MVP; details in Business Logic). Priority: must-have
  > Socrates: Kontrargument rozważony: prosta reguła bez pełnego SM-2 może uczyć gorzej niż sprawdzony algorytm. Rozstrzygnięcie: zaakceptowane jako świadoma hipoteza MVP — to była własna decyzja użytkownika już przy szkicowaniu przepływu; pełny SM-2 to rozszerzenie po MVP.
- FR-015: System shows a new flashcard as multiple-choice (A/B/C/D, checked automatically) and switches it to a short open-answer format (2-3 zdania, graded by AI) after the user's first correct answer. Priority: must-have
  > Socrates: Kontrargument rozważony: skok z MC bezpośrednio do trudnego, ocenianego przez AI pytania otwartego (bez pośredniego kroku samooceny) może być zbyt duży po jednej poprawnej odpowiedzi wielokrotnego wyboru. Rozstrzygnięcie: zaakceptowane — użytkownik świadomie zrezygnował z kroku samooceny (Q&A) na rzecz bezpośredniego przejścia do oceny AI.
- FR-016: System (AI) grades the user's open-answer response against the flashcard's correct answer, returning correct/incorrect. Priority: must-have
  > Socrates: Kontrargument rozważony: ocena AI krótkiej odpowiedzi może być niespójna między próbami — to jedyne miejsce, gdzie jakość AI bezpośrednio decyduje o wiarygodności całego mechanizmu opanowania. Rozstrzygnięcie: zaakceptowane jako nazwane ryzyko do zwalidowania jako pierwsze.
- FR-017: System resets a flashcard's "two correct open-answer responses" counter to zero (without returning it to multiple-choice) and shows the user the correct answer whenever they submit a wrong open-answer response. Priority: must-have
  > Socrates: Kontrargument rozważony: reset bez cofnięcia do MC może być zbyt łagodny — użytkownik może utknąć w powtarzającym się błędzie bez wzmocnienia podstaw. Rozstrzygnięcie: zaakceptowane — pokazanie poprawnej odpowiedzi po błędzie uznane za wystarczające wzmocnienie; to była świadoma decyzja użytkownika.
- FR-018: System marks a flashcard as mastered after the user gives two correct open-answer responses on separate, non-immediately-consecutive review occasions. Priority: must-have
  > Socrates: Kontrargument rozważony: wymóg drugiej okazji "w przyszłości" wydłuża czas opanowania i dodaje nowy stan do harmonogramu powtórek (FR-014). Rozstrzygnięcie: zaakceptowane jako świadomy wybór.
- FR-019: Once at least 80% of the current batch's flashcards for a subtopic are mastered, the user can trigger generation of the next batch of flashcards for that subtopic (or the next-weakest not-yet-mastered subtopic), excluding already-mastered subtopics. Priority: must-have
  > Socrates: Brak kontrargumentu — FR stoi jak jest.
- FR-020: System shows mastery per subtopic for a topic — a subtopic is mastered when all flashcards generated for it (across all batches) are mastered; a subtopic that scored 100% on the diagnostic quiz still receives a smaller batch of flashcards rather than being skipped, so quiz results alone never mark a subtopic mastered. Priority: must-have
  > Socrates: Brak kontrargumentu — FR stoi jak jest.
- FR-021: User can view a home screen listing all topics with, per topic, the number of flashcards due for review and the date of the last study session. Priority: must-have
  > Socrates: Kontrargument rozważony: to dodatkowy ekran/agregacja ponad to, co pokazują poszczególne tematy. Rozstrzygnięcie: FR dodany — bez tego nic w produkcie nie pokazuje zaniedbanego tematu, a to jest centralny problem z Vision & Problem Statement.

### Cel i postęp
- FR-022: User can set/edit a daily review goal (target number of reviews per day) and see today's progress against that goal. Priority: nice-to-have
  > Socrates: Brak kontrargumentu — FR stoi jak jest.
- FR-023: System tracks and displays a daily streak counter. Priority: must-have
  > Socrates: Kontrargument rozważony: sam streak bez odznak może nie motywować. Rozstrzygnięcie: FR podniesiony do must-have — odznaki za serię dni (must-have) go wymagają jako podstawy.

### Odznaki
- FR-024: System awards a badge when the user reaches a streak milestone (exact thresholds TBD). Priority: must-have
  > Socrates: Kontrargument rozważony: konkretne progi to na razie przykłady, nie decyzja. Rozstrzygnięcie: FR zostaje, dokładne progi idą do Open Questions.
- FR-025: System awards a badge when a topic reaches 100% subtopic mastery (per FR-020's definition). Priority: must-have
  > Socrates: Kontrargument rozważony: przy dużych tematach 100% opanowania może być nierealistycznym celem w praktyce. Rozstrzygnięcie: zaakceptowane bez zmian.
- FR-026: System awards a badge at total mastered-flashcard count milestones (exact thresholds TBD); this count is historical — it never decreases when a mastered flashcard is later deleted (FR-012). Priority: must-have
  > Socrates: Kontrargument rozważony: konkretne progi to na razie przykłady, nie decyzja. Rozstrzygnięcie: FR zostaje, dokładne progi idą do Open Questions; dodatkowo doprecyzowano, że usunięcie fiszki nie cofa już zdobytego postępu w liczniku.
- FR-027: User can view their earned badges. Priority: must-have
  > Socrates: Brak kontrargumentu — FR stoi jak jest.

### Odporność na błędy AI
- FR-028: If any AI call (subtopic generation, quiz generation, flashcard generation, next-batch generation, or open-answer grading) fails, times out, or returns output that fails validation, the system shows an error and lets the user retry. Generation results are saved completely or not at all (never partially), and a grading failure never discards the user's typed answer — they can resubmit it without retyping. Priority: must-have
  > Socrates: Kontrargument rozważony: błąd oceny to inny przypadek niż błąd generowania (zachowanie wpisanej odpowiedzi to inna logika niż zapis generowania) — jeden FR może nie wystarczyć jako specyfikacja obu przypadków. Rozstrzygnięcie: FR zostaje jako jeden wspólny wzorzec obsługi błędów AI, doprecyzowany o osobne zachowanie dla błędu oceny (zachowanie wpisanej odpowiedzi zamiast pełnego zapisu generowania).

## Non-Functional Requirements

- Dane konta (tematy, fiszki, wyniki quizów, postęp) są widoczne wyłącznie dla jego zalogowanego właściciela.
- W trakcie generowania przez AI (podtematy, quiz, fiszki, następna partia) interfejs nigdy nie sprawia wrażenia zawieszonego — użytkownik ma ciągłe potwierdzenie, że system pracuje, nawet gdy generowanie trwa do kilkunastu sekund.
- Odpowiedź w formacie multiple-choice jest sprawdzana natychmiast (< 300 ms) — poprawna odpowiedź jest już zapisana przy generowaniu. Ocena odpowiedzi otwartej jest jedynym miejscem, gdzie system zależy od AI podczas nauki: interfejs nigdy nie sprawia wrażenia zawieszonego podczas oczekiwania na ocenę, a odpowiedź, którą użytkownik wpisał, nigdy nie ginie — nawet jeśli ocena się nie powiedzie.
- Postęp nauki (opanowane fiszki, wyniki quizów, streak) jest dostępny z każdego urządzenia po zalogowaniu i nie ginie między sesjami.
- Sesja nauki jest w pełni użyteczna w przeglądarce mobilnej na telefonie, bez wymogu aplikacji natywnej.
- Liczba wywołań generowania AI (podtematy, quiz, fiszki, następna partia) na konto w ciągu dnia ma ustalony limit — 20 dziennie — niezależny od liczby błędów lub ponowień.
- Liczba wywołań oceny odpowiedzi otwartej przez AI na konto w ciągu dnia ma osobny, wyższy limit — 100 dziennie — tak, żeby wyczerpanie limitu generowania nigdy nie blokowało oceniania w trwającej sesji nauki.

## Business Logic

System diagnozuje wiedzę użytkownika per podtemat i generuje/planuje fiszki tak, by priorytetyzować najsłabsze podtematy, aż do ich opanowania.

Reguła konsumuje wejścia deklarowane i wytwarzane w toku korzystania z aplikacji: temat i opcjonalny opis zakresu/poziomu podany przez użytkownika (na tej podstawie system sam rozpoznaje typ treści każdego podtematu — pojęciowy albo językowy — z możliwością korekty przez użytkownika przed quizem, FR-004/FR-005), wyniki quizu diagnostycznego per podtemat (10 pytań), oraz historię odpowiedzi na fiszki (poprawne/błędne, w jakim formacie, kiedy). Wyjściem jest: lista podtematów tematu z przypisanym typem treści, partie po 10 fiszek wygenerowanych z najsłabszych podtematów (w kształcie zależnym od typu podtematu, z dołączonym rozszerzonym wyjaśnieniem), harmonogram, który podtematy/fiszki pokazać w najbliższej sesji nauki, oraz status opanowania każdej fiszki, każdego podtematu (i tematu jako całości) oraz odznaki przyznane na tej podstawie. Użytkownik napotyka tę regułę przy tworzeniu tematu (generowanie podtematów i rozpoznanie typu treści), po quizie diagnostycznym (podział wyniku na podtematy), w sesji nauki (kolejność i format fiszek, ocena odpowiedzi otwartych) oraz przy generowaniu kolejnej partii fiszek — odblokowanej po opanowaniu 80% fiszek bieżącej partii danego podtematu — celującej w najsłabsze nieopanowane podtematy, z pominięciem opanowanych. Podtemat, który uzyskał 100% w quizie diagnostycznym, nadal otrzymuje (mniejszą) partię fiszek — quiz sam w sobie nigdy nie oznacza podtematu jako opanowanego.

Progresja formatu fiszki i próg opanowania są częścią tej samej reguły, wg harmonogramu:

| Stan fiszki | Odpowiedź | Nowy stan | Kiedy wraca |
| --- | --- | --- | --- |
| A/B/C/D | źle | A/B/C/D | w tej samej sesji |
| A/B/C/D | dobrze | otwarta 0/2 | następnego dnia |
| otwarta 0/2 | źle | otwarta 0/2 | następnego dnia |
| otwarta 0/2 | dobrze | otwarta 1/2 | za 3 dni |
| otwarta 1/2 | źle | otwarta 0/2 | następnego dnia |
| otwarta 1/2 | dobrze | opanowana | w MVP już nie wraca |

Multiple-choice samo w sobie umożliwia zgadnięcie (25% szans), więc ochronę przed zgadywaniem daje dopiero wymóg dwóch poprawnych odpowiedzi otwartych na osobnych dniach (nigdy w tej samej sesji) — format startowy jest tylko punktem wejścia, a próg opanowania wymusza realną, powtórzoną w czasie weryfikację wiedzy, nie tylko rozpoznania z listy ani jednorazowego trafienia. Sposób oceny odpowiedzi otwartej przez AI (tolerancja na parafrazę) nie jest jeszcze ustalony — patrz `## Open Questions`.

## Access Control

Logowanie: jedna metoda — OAuth przez zewnętrznego dostawcę tożsamości, ograniczone do listy dozwolonych adresów e-mail (closed allowlist); brak publicznej rejestracji. Model płaski — brak ról (bez admin/member). Każde konto widzi i zarządza wyłącznie własnymi tematami, fiszkami i postępem. Produkt ma z góry przewidywać wiele kont (docelowo drugie konto — żona, głównie angielski i tematy HR), nawet jeśli w MVP korzysta z niego tylko jedna osoba.

## Non-Goals

- **Powiadomienia mailowe** — brak maili o postępie/przypomnieniach w MVP.
- **Cele tygodniowe** — w MVP tylko cel dzienny, nie tygodniowy.
- **Publiczna rejestracja** — tylko allowlist; brak samodzielnego zakładania kont przez inne osoby.
- **Pełny algorytm powtórek (SM-2 lub podobny)** — w MVP prosta reguła (źle = szybciej wraca, dobrze = później), nie pełny, sprawdzony algorytm — świadomie zaakceptowane ryzyko.
- **Generowanie fiszek z własnego materiału** — w MVP jedynym źródłem fiszek jest AI-owy quiz diagnostyczny i generowanie celowane na słabe podtematy; wklejanie/import własnego tekstu nie jest wspierany.
- **Automatyczne dobieranie kolejnej partii bez przycisku** — użytkownik ręcznie inicjuje generowanie następnej partii (FR-019); pełna automatyzacja to rozszerzenie po MVP.
- **Dodawanie podtematów do już zablokowanego tematu** — lista podtematów jest edytowalna tylko przed rozpoczęciem quizu (FR-004); rozszerzanie istniejącego, zablokowanego tematu to rozszerzenie po MVP.
- **Kontrolne powtórki opanowanych fiszek** — sesja nauki (FR-014) pokazuje tylko fiszki nieopanowane; ponowna, kontrolna weryfikacja już opanowanych fiszek to rozszerzenie po MVP.
- **Aplikacja natywna** — tylko przeglądarka (desktop i mobile), zgodnie z NFR o użyteczności mobilnej.
- **Panel administracyjny** — allowlist logowania jest zarządzana poza UI produktu (FR-001), nie przez panel administracyjny.
- **Współdzielenie tematów między kontami** — każde konto ma własne, niewidoczne dla innych tematy i fiszki (zgodnie z Access Control); brak współdzielenia nawet między dwoma kontami w rodzinie.
- **Format tak/nie** — trzeci typ fiszki (poza multiple-choice i odpowiedzią otwartą) to rozszerzenie po MVP.

## Open Questions

1. **Jakie są dokładne progi odznak?** — kamienie milowe streaka (FR-024) i łącznej liczby opanowanych fiszek (FR-026); konkretne liczby (np. 7/30/100 dni, 50/200 fiszek) nie zostały jeszcze ustalone, tylko kategorie kryteriów. Owner: użytkownik. Block: nie (odznaki mogą wystartować z tymczasowymi progami i zostać dostrojone).
2. **Jak dokładnie AI ma oceniać poprawność krótkiej odpowiedzi otwartej (FR-016)?** — jaki poziom tolerancji na parafrazę/niepełność, czy jest podział na "częściowo poprawne". Owner: użytkownik. Block: nie (start od prostego pass/fail, dopracowanie na podstawie realnego użycia — nazwane ryzyko do zwalidowania jako pierwsze, przed dalszą rozbudową).
