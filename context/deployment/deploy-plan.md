# Pierwsze wdrożenie: ai-flashcards → Cloudflare Workers (Static Assets)

## Context

`infrastructure.md` (2026-10-03) wybrał **Cloudflare Workers ze Static Assets** — NIE Pages (`@astrojs/cloudflare` 14.3 nie wspiera Pages od v13). Projekt jest gotowy pod Workers: `wrangler.jsonc` ma już `name: "ai-flashcards"`, `main` = entrypoint adaptera, `assets.directory: ./dist`, `observability.enabled`. `tech-stack.md` jest już poprawiony (`cloudflare-workers`, `workers-builds`), więc krok 1 z „Getting Started” jest zrobiony.

Stan wyjściowy (sprawdzony):
- wrangler 4.131.1 lokalnie, `npx wrangler whoami` → zalogowany OAuth (konto `9d06ffde…2ff0`).
- Brak `.dev.vars` i `.env`; sekrety `SUPABASE_URL` / `SUPABASE_KEY` są w `astro:env` jako `server` + `secret` + `optional` (`astro.config.mjs`) — czytane w runtime z env Workera, więc wystarczy `wrangler secret put`, nie trzeba ich przy buildzie.
- Katalog **nie jest repo git**. `.github/workflows/ci.yml` celuje w gałąź `master`, a infra zakłada `main`.
- Użytkownik ma hostowany projekt Supabase i chce od razu pełny potok: git + GitHub + Workers Builds.

Cel: działający `https://ai-flashcards.<subdomain>.workers.dev` z działającym auth Supabase, auto-deploy z `main`, preview URL dla innych gałęzi, a zatwierdzony plan zapisany w `context/deployment/deploy-plan.md`.

**Komenda wdrożenia to wyłącznie `npx wrangler deploy`. Nigdy `wrangler pages deploy` / `wrangler pages project create`.**

## Kroki

Legenda: 🤖 = agent robi sam · 👤 = ręczna bramka (Ty)

### 0. Zapis planu
1. 🤖 Po akceptacji: zapis tego planu do `context/deployment/deploy-plan.md`.

### 1. Weryfikacja lokalna (bez zmian na platformie)
2. 🤖 `npm run lint` i `npx astro check`.
3. 🤖 `npm run build` → sprawdzenie, że powstał `dist/` z workerem i assetami.
4. 🤖 `npx wrangler deploy --dry-run` — walidacja bundla i konfiguracji, rozmiar workera, bez publikacji.

### 2. Lokalne sekrety (do dev)
5. 👤 Utworzenie `.dev.vars` (już w `.gitignore`) z `SUPABASE_URL=` i `SUPABASE_KEY=` (publishable/anon key, **nie** service_role). Agent nie widzi wartości.

### 3. Pierwszy deploy z CLI
6. 👤 Zgoda na produkcję → 🤖 `npx wrangler deploy` (tworzy Workera `ai-flashcards`, zwraca URL `*.workers.dev`). Przy pierwszym deployu wrangler może poprosić o rejestrację subdomeny workers.dev — wtedy 👤 wybierasz ją interaktywnie.
7. 👤 Sekrety produkcyjne — uruchamiasz sam w terminalu (wartość wpisujesz w prompt, nie do czatu):
   - `! npx wrangler secret put SUPABASE_URL`
   - `! npx wrangler secret put SUPABASE_KEY`
   (każdy `secret put` tworzy nową wersję i wdraża ją od razu — nie trzeba ponownego deployu).
8. 🤖 `npx wrangler secret list` — potwierdzenie obu nazw (bez wartości).

### 4. Konfiguracja Supabase Auth (panel)
9. 👤 Supabase → Authentication → URL Configuration:
   - **Site URL** = `https://ai-flashcards.<subdomain>.workers.dev` (link potwierdzający e-mail z `signUp` w `src/pages/api/auth/signup.ts` nie ma `emailRedirectTo`, więc trafia na Site URL).
   - **Redirect URLs**: ten sam URL + `https://*-ai-flashcards.<subdomain>.workers.dev/**` (preview z Workers Builds) + `http://localhost:4321/**`.

### 5. Weryfikacja produkcji
10. 🤖 `curl -sI <url>/` → 200; `curl -sI <url>/dashboard` → 302 na `/auth/signin`; `<url>/auth/signin` → 200 i brak komunikatu „Supabase is not configured”.
11. 👤 Ręczny test w przeglądarce: rejestracja → mail potwierdzający → logowanie → `/dashboard` → wylogowanie. (`scripts/smoke.mjs` **nie** jest uruchamiany na produkcji: tworzy śmieciowe konta `smoke-*@example.com`, a hostowane Supabase wymaga potwierdzenia e-mail, więc krok „signin accepts” i tak by padł.)
12. 🤖 `npx wrangler tail ai-flashcards --format pretty` w tle podczas testu z pkt 11 — brak wyjątków / błędów 1102; `npx wrangler deployments list` — zapisanie version-id pierwszego deployu (punkt rollbacku).

### 6. Git + GitHub
13. 🤖 `git init -b main`; sprawdzenie, że `.gitignore` wyklucza `.dev.vars`, `.env`, `.wrangler/`, `dist/`, `node_modules/`; `git status` do przeglądu przed commitem (szukanie przypadkowych sekretów).
14. 🤖 Zmiana `.github/workflows/ci.yml`: `branches: [master]` → `[main]` (push i pull_request).
15. 🤖 Pierwszy commit (z atrybucją Co-Authored-By).
16. 👤 Utworzenie pustego repo na GitHubie (prywatne zalecane; `gh` nie jest zainstalowane) i podanie URL → 🤖 `git remote add origin <url>` + `git push -u origin main`.
17. 👤 (opcjonalnie) GitHub → Settings → Secrets: `SUPABASE_URL`, `SUPABASE_KEY` dla joba `ci` w `ci.yml` (sekrety są optional, build przejdzie i bez nich).

### 7. Workers Builds (panel, ręcznie — zatwierdzenie wymaga człowieka wg infra)
18. 👤 Cloudflare → Workers & Pages → `ai-flashcards` → Settings → Builds → Connect GitHub repo:
    - build command `npm run build`, deploy command `npx wrangler deploy`
    - production branch `main`, non-production branch builds **włączone** (preview URL)
    - nazwa Workera w panelu = `name` z `wrangler.jsonc` (`ai-flashcards`) — inaczej buildy padają.
    - Node: `.nvmrc` pinuje 22 — Builds go respektuje.
19. 🤖 Weryfikacja potoku: pusty commit na `main` (`git commit --allow-empty`) + push → 🤖 `npx wrangler deployments list` pokazuje nowy deployment ze źródłem Builds; ponowny `curl` z pkt 10.

## Poza zakresem (świadomie)
- Własna domena / DNS, KV/D1/inne bindingi, plan Workers Paid (dopiero przy pierwszym 1102).
- Sekret klucza LLM — dodamy, gdy pojawi się w schemacie `astro:env`.
- Scoped `CLOUDFLARE_API_TOKEN` dla agenta — teraz używamy istniejącego logowania OAuth wranglera; token do rozważenia przy podłączaniu MCP.
- Wpis w `AGENTS.md` „deploy = Workers only” (ryzyko z rejestru) — osobno przez `/10x-agents-md` / `/10x-lesson`.

## Rollback
`npx wrangler deployments list` → `npx wrangler rollback <version-id>`. Zablokowany, jeśli zmienią się bindingi między wersjami. Sekrety i Supabase nie są cofane.

## Pliki zmieniane przez agenta
- `context/deployment/deploy-plan.md` (nowy)
- `.github/workflows/ci.yml` (`master` → `main`)
- `.git/` (nowe repo)

## Weryfikacja końcowa (definicja „gotowe”)
- `<url>/` = 200, `/dashboard` anonimowo = 302 → `/auth/signin`, ręczny flow signup/signin/signout działa.
- `wrangler secret list` pokazuje `SUPABASE_URL`, `SUPABASE_KEY`.
- Push na `main` wywołuje deployment z Workers Builds widoczny w `wrangler deployments list`.
- `wrangler tail` bez wyjątków podczas testu.

## Dziennik wykonania (2026-10-05)

- Kroki 2–4: lint, `astro check` (0 błędów), build, `wrangler deploy --dry-run` — OK (455 KiB gzip).
- Adapter dodaje bindingi spoza `wrangler.jsonc`: `SESSION` (KV, auto-provisioned jako `ai-flashcards-session`) i `IMAGES` — pamiętać przy rollbacku (zmiana bindingów blokuje rollback).
- Pierwszy deploy padł: brak subdomeny workers.dev; wrangler proponuje subdomenę z `name` w `package.json` (`10x-astro-starter`, zajęta). Fix: `package.json`/`package-lock.json` → `ai-flashcards`. Subdomena konta: `ai-flashcards`.
- **Produkcja:** https://ai-flashcards.ai-flashcards.workers.dev — pierwsza wersja `e6ef1383-a311-4113-a9cb-84b05ed170c3`.
- Pułapka: `wrangler secret put` bez TTY (prompt `!` w Claude Code, Git Bash/mintty) zapisuje **pusty** sekret i zgłasza „Success”. Sekrety ustawione przez `wrangler secret bulk` z pliku tymczasowego (tylko `SUPABASE_URL` + `SUPABASE_KEY`=publishable key; secret key nie trafił na Workera).
- Supabase Auth: Site URL + redirect URLs ustawione ręcznie; ręczny test signup → potwierdzenie → signin → dashboard → signout — OK.
- `ci.yml`: `master` → `main`.

## Dziennik wykonania — GitHub + Workers Builds (2026-10-05)

- Repo: https://github.com/Thorgoo/ai-flashcards (publiczne). Materiały kursu (`.claude/skills`, `.claude/prompts`, `.agents`, `CLAUDE.md`, `.10x-cli.json`, `skills-lock.json`) są w `.gitignore` i poza repo.
- `gh` potrzebuje scope `workflow`, żeby pushować `.github/workflows/*` (`gh auth refresh -h github.com -s workflow`, interaktywnie).
- Ruleset `protect-main` na `main`: tylko przez PR, wymagany check `ci`, brak usuwania i force-pusha. Na prywatnym repo bez GitHub Pro rulesety są niedostępne (HTTP 403).
- Workers Builds: Production = `main`, `npm run build` + `npx wrangler deploy`. Previews Base = `npm run build` + `npx wrangler preview` (private beta, osobny Worker na gałąź — `versions upload` tam pada na „name must match”).
- Pułapka: adapter Astro dopisuje sekcję `previews` z KV `SESSION` bez id → `wrangler preview` odrzuca ją (`code: 10021`). Fix: `previews.kv_namespaces` w `wrangler.jsonc` z osobnym KV `ai-flashcards-session-preview` (`ee50e4c5962045d1829366d4615abde7`). Podglądy mają własne sekrety: `wrangler preview base-config secret bulk <plik>` (`SUPABASE_URL`, `SUPABASE_KEY` — ten sam projekt Supabase co produkcja). Trigger gałęzi kopiuje komendę z Previews Base w chwili pierwszego pusha — zmiana bazy nie dotyczy istniejących gałęzi.
- `SESSION` KV zadeklarowany jawnie w `wrangler.jsonc` (id `c5c7150d952f43dc83e3f7572905b2b8`); rollback do `e6ef1383` może być zablokowany przez zmianę deklaracji bindingów.
- PR #1 (sitemap `site` + jawny `SESSION`) zmergowany ręcznie → Workers Builds wdrożył wersję `fbb73dda-ca71-41f5-b250-4795089230c8` ok. 1 min po merge. Produkcja zweryfikowana (`/` 200, `/dashboard` 302, `/sitemap-index.xml` 200, Supabase odpowiada).
- Node w buildach: `.nvmrc` 22.14.0 → 22.23.3 (zależności wymagają ≥ 22.22.3); CI czyta wersję z `.nvmrc`.
