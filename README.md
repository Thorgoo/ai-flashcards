# AI Flashcards

Learn several subjects at once without writing flashcards by hand. A diagnostic quiz shows what you don't know yet in a topic, and AI generates flashcards from your weakest subtopics.

**Live app:** <https://ai-flashcards.ai-flashcards.workers.dev>. Sign-in is limited to an email allowlist, so to try the full flow without an account, run it locally in fake AI mode (see [AI calls](#ai-calls)).

## How it works

1. **Create a topic**, such as "Spring" or "English", with an optional note on scope and level. AI proposes subtopics, which you can edit and then confirm.
2. **Take the diagnostic quiz.** The result is broken down by subtopic, and every question has an "I don't know" option.
3. **Study AI-generated flashcards** from your weakest subtopics. Their shape depends on the automatically detected content type (conceptual or language).
4. **Reach mastery.** A card starts as multiple choice, moves to a short open answer graded by AI after the first correct answer, and is mastered after two correct open answers on separate occasions.
5. **Generate the next batch** once 80% of the current one is mastered. It skips subtopics you have already mastered.

A study streak and badges add motivation. Each account sees only its own data, and a failed AI call never loses saved cards, progress or a typed answer.

## Tech Stack

- [Astro](https://astro.build/) v7 - Server-rendered pages and API routes
- [React](https://react.dev/) v19 - Interactive components
- [TypeScript](https://www.typescriptlang.org/) v6
- [Tailwind CSS](https://tailwindcss.com/) v4 and [shadcn/ui](https://ui.shadcn.com/)
- [Supabase](https://supabase.com/) - Postgres with row-level security, and GitHub OAuth
- [Anthropic API](https://docs.anthropic.com/) - Generation and grading
- [Cloudflare Workers](https://workers.cloudflare.com/) - Hosting
- [Vitest](https://vitest.dev/), [pgTAP](https://pgtap.org/) and [Playwright](https://playwright.dev/) - Tests

## Project documents

The product was specified and built from these documents, which AI coding agents also read:

- [`context/foundation/prd.md`](context/foundation/prd.md) - Product requirements
- [`context/foundation/roadmap.md`](context/foundation/roadmap.md) - Milestones and slices
- [`context/foundation/tech-stack.md`](context/foundation/tech-stack.md) - Stack choice
- [`context/foundation/infrastructure.md`](context/foundation/infrastructure.md) - Hosting choice and risks
- [`context/foundation/test-plan.md`](context/foundation/test-plan.md) - Test strategy
- [`context/archive/`](context/archive/) - Plans and reviews of completed changes
- `AGENTS.md` files in the repository root, `src/lib/ai/`, `src/lib/topics/` and `supabase/` - Conventions for agents

## Prerequisites

- Node.js v22.23.3 (as specified in `.nvmrc`)
- npm (comes with Node.js)

## Getting Started

1. Clone the repository:

```bash
git clone https://github.com/Thorgoo/ai-flashcards.git
cd ai-flashcards
```

2. Install dependencies:

```bash
npm install
```

3. Set up Supabase and configure environment variables — see [Supabase Configuration](#supabase-configuration) below.

4. Create a `.dev.vars` file for local Cloudflare dev secrets:

```bash
cp .env.example .dev.vars
```

5. Run the development server:

```bash
npm run dev
```

## Available Scripts

- `npm run dev` - Start development server (Cloudflare workerd runtime)
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint with type-checked rules
- `npm run lint:fix` - Auto-fix ESLint issues
- `npm run format` - Run Prettier
- `npm run smoke` - Smoke test the auth flow against a running server (`BASE_URL`, defaults to `http://localhost:4321`)
- `npm run smoke:topics` - Smoke test the topic flow as signed-in test accounts (CI only, see [Smoke test](#smoke-test))
- `npm run db:reset` - Recreate the local database from `supabase/migrations/` (requires the local Supabase stack)
- `npm run db:test` - Run the pgTAP database tests in `supabase/tests/` (requires the local Supabase stack)
- `npm test` - Run the Vitest unit tests (`src/**/*.test.ts`)
- `npm run e2e` - Run the Playwright tests against the local Supabase stack with fake AI (requires `npx supabase start`; pass Playwright arguments after `--`)

## Project Structure

```md
.
├── src/
│ ├── pages/ # Astro pages
│ │ └── api/ # API endpoints
│ ├── components/ # UI components (Astro & React)
│ ├── layouts/ # Astro layouts
│ ├── lib/
│ │ ├── ai/ # Single entry point for AI calls, limits and logging
│ │ ├── topics/ # Topics, quizzes, flashcards and study logic
│ │ └── badges/ # Badge catalog
│ ├── middleware.ts # Session and route protection
│ └── worker.ts # Cloudflare Worker entry point
├── supabase/
│ ├── migrations/ # Database schema
│ └── tests/ # pgTAP database tests
├── e2e/ # Playwright tests
├── scripts/ # Smoke tests and the local E2E runner
├── context/ # Product documents and change history
├── wrangler.jsonc # Cloudflare Workers config
```

## Supabase Configuration

This project uses [Supabase](https://supabase.com/) for authentication. Sign-in is **GitHub OAuth only**, restricted to the emails listed in `ALLOWED_EMAILS` — there is no public sign-up and no password login. Environment variables are declared via Astro's `astro:env` schema and are treated as **server-only secrets** — they are never exposed to the client.

### First-time setup (local, no cloud project needed)

Requires [Docker](https://www.docker.com/) and ~7 GB RAM.

1. Create your `.env` file:

```bash
cp .env.example .env
```

2. Start the local stack (downloads Docker images on first run):

```bash
npx supabase start
```

3. Copy the credentials printed by the CLI into your `.env` and `.dev.vars`, and list who may sign in:

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_KEY=<anon key from CLI output>
ALLOWED_EMAILS=you@example.com,partner@example.com
```

For a real local GitHub login, create a GitHub OAuth App with callback `http://127.0.0.1:54321/auth/v1/callback` and export `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` / `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` before `npx supabase start` (read by `supabase/config.toml`).

4. To stop the stack when done:

```bash
npx supabase stop
```

The local Studio UI is available at `http://localhost:54323`.

### Using a cloud Supabase project instead

If you prefer to use a hosted Supabase project, add these variables to your `.env` and `.dev.vars` files:

| Variable         | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| `SUPABASE_URL`   | Project URL from Supabase dashboard → Settings → API       |
| `SUPABASE_KEY`   | `anon` public key from Supabase dashboard → Settings → API |
| `ALLOWED_EMAILS` | Comma-separated emails allowed to sign in (unset = nobody) |

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_KEY=<anon-key>
ALLOWED_EMAILS=you@example.com
```

In the Supabase dashboard:

1. **Authentication → Providers → GitHub** — enable it with the client ID/secret of a GitHub OAuth App whose callback is `https://<project-ref>.supabase.co/auth/v1/callback`. Disable the **Email** provider.
2. **Authentication → URL Configuration** — add every origin the app runs on to **Redirect URLs** (`http://localhost:4321/**`, the production `*.workers.dev` URL and the branch-preview pattern), otherwise OAuth fails there.

### Auth routes

| Route                | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| `/auth/signin`       | "Zaloguj się przez GitHub" button                                          |
| `/api/auth/signin`   | Starts the GitHub OAuth flow                                               |
| `/api/auth/callback` | OAuth callback: exchanges the code, rejects emails not in `ALLOWED_EMAILS` |
| `/dashboard`         | Topic list after sign-in (redirects to `/auth/signin` if unauthenticated)  |

Route protection is handled in `src/middleware.ts`, which redirects unauthenticated visitors away from the pages listed in `PROTECTED_ROUTES`. API routes answer 401 themselves. The middleware also signs out any session whose email is no longer in `ALLOWED_EMAILS`.

## Database migrations

Schema changes live in `supabase/migrations/` as timestamped SQL files. Every table must belong to an account — see `supabase/AGENTS.md`.

1. Create a migration: `npx supabase migration new <name>`, then write the SQL.
2. Apply it locally: `npm run db:reset` (rebuilds the local database from all migrations).
3. Test it: `npm run db:test`. Both commands need the local Supabase stack (Docker); CI runs the database tests on every PR regardless.

Production migrations are a **human step** — CI never touches the production database:

1. Once per machine: `npx supabase link --project-ref <project-ref>`.
2. Push pending migrations: `npx supabase db push`, then confirm with `npx supabase migration list`.

Push before (or together with) merging code that depends on the new schema. Keep migrations backward compatible (expand first, contract in a later migration) so a Worker rollback never meets an incompatible schema, and never edit a migration that is already on `main` or pushed — add a new one instead.

## AI calls

Every AI call goes through `getAi(supabase, user).call(...)` in `src/lib/ai/` — see `src/lib/ai/AGENTS.md`. Each call uses up the account's daily limit (20 generations / 100 gradings per calendar day in Europe/Warsaw, counted whether the call succeeds or not) and is logged in the `ai_calls` table.

- **Local:** put `ANTHROPIC_API_KEY` in `.dev.vars` (and `.env`). To work without a key, set `AI_MODE=fake`: responses then come from `src/lib/ai/fixtures.ts`. Fake mode only works with the local Supabase stack (`SUPABASE_URL` on `localhost`/`127.0.0.1`); otherwise every AI call fails as not configured. CI runs the smoke job in fake mode.
- **Production:** a **human step** — `npx wrangler secret put ANTHROPIC_API_KEY`. Leave `AI_MODE` unset (it defaults to `live`).
- **Tests:** `npm test` runs the unit tests on a fake provider. One real call against the API is opt-in: `AI_LIVE_TEST=1 ANTHROPIC_API_KEY=… npx vitest run src/lib/ai/live.integration.test.ts` (bash); in PowerShell `$env:AI_LIVE_TEST="1"; $env:ANTHROPIC_API_KEY="…"; npx.cmd vitest run src/lib/ai/live.integration.test.ts` (`npx.cmd` avoids the script execution policy).

## Deployment

This project deploys to [Cloudflare Workers](https://workers.cloudflare.com/). Workers Builds deploys every push to `main` and creates a preview URL for other branches.

To deploy by hand:

1. Build the project:

```bash
npm run build
```

2. Deploy with Wrangler:

```bash
npx wrangler deploy
```

Set `SUPABASE_URL`, `SUPABASE_KEY` and `ALLOWED_EMAILS` as secrets in your Cloudflare dashboard or via `npx wrangler secret put`.

## Smoke test

`scripts/smoke.mjs` is a dependency-free Node script that checks the auth entry points over HTTP (protected-page redirect, GitHub OAuth redirect, callback error path, removed sign-up routes, sign-out). The full OAuth round-trip needs a real GitHub account and is verified manually. Run it against the dev server or the production preview after dependency upgrades:

```bash
npm run dev            # or: npm run build && npm run preview
BASE_URL=http://localhost:4321 npm run smoke
```

It needs a reachable Supabase instance (local or cloud) with the GitHub provider enabled.

`scripts/smoke-topics.mjs` covers the topic flow as signed-in users: create, generate (`AI_MODE=fake`), edit, regenerate, confirm, the lock, the diagnostic quiz (answers hidden until the end, one quiz per topic), a second account and the daily generation limit (21st call → 429). It creates test accounts through the Supabase admin API and signs them in with a password, so it runs only in CI against the throwaway local stack: CI enables the email provider there (`enable_signup = false` in `supabase/config.toml` turns it off entirely) and passes `SUPABASE_SERVICE_ROLE_KEY` to that step only.

## E2E tests

`e2e/` holds the Playwright tests, including the critical path from the user's perspective: sign in, create a topic, take the quiz and study flashcards, on fake AI. Locally, `npm run e2e` points `.env` and `.dev.vars` at the local Supabase stack for the run and restores them afterwards. See `scripts/e2e.mjs`.

## CI

GitHub Actions runs two jobs on every push and PR to `main`:

- **ci** — lint, unit tests, `astro check` and build. Configure `SUPABASE_URL` and `SUPABASE_KEY` as repository secrets for the build step.
- **smoke** — starts a local Supabase via the Supabase CLI, runs the pgTAP database tests, builds, serves the production preview on the Cloudflare runtime and runs `npm run smoke`, `npm run smoke:topics` and the Playwright tests against it. No secrets required.
