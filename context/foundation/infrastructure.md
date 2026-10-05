---
project: ai-flashcards
researched_at: 2026-10-03
recommended_platform: Cloudflare Workers (Static Assets)
runner_up: Vercel
context_type: mvp
tech_stack:
  language: TypeScript
  framework: Astro 7.3 (SSR, output "server") + React 19, @astrojs/cloudflare 14.3
  runtime: Cloudflare workerd (nodejs_compat), wrangler 4.131
---

## Recommendation

**Deploy on Cloudflare Workers (with Static Assets) — not Cloudflare Pages.**

The project is already scaffolded for it: `@astrojs/cloudflare` 14.3 targets Workers only (Pages support was dropped in adapter v13) and `wrangler.jsonc` already declares `main` + `assets`, so this is the only shortlisted option that needs zero migration. It is the only platform to score Pass on all five agent-friendly criteria, and it fits the interview answers best: cost minimization (10k–100k requests/month is $0 on the Free plan, $5/month Paid as a safety valve), no persistent connections needed, single EU region (edge execution is fine; latency is dominated by the Supabase region), and external services OK (Supabase stays over HTTPS). Note: `tech-stack.md` originally said `deployment_target: cloudflare-pages`; it was corrected to `cloudflare-workers` on 2026-10-03, because Pages is in maintenance mode and the adapter no longer supports it.

## Platform Comparison

Interview constraints: no persistent connections · minimize cost · no prior platform familiarity · single region (Poland/EU) · external providers OK (Supabase). No platform was removed by hard filters (no persistent-connection requirement; every platform can run Astro SSR via its adapter).

| Platform | CLI-first | Managed/Serverless | Agent-readable docs | Stable deploy API | MCP / Integration | Total | Cost-weighted notes |
|---|---|---|---|---|---|---|---|
| **Cloudflare Workers** | Pass | Pass | Pass | Pass | Pass | 5 / 5 | $0 Free; $5/mo Paid; no adapter swap |
| Vercel | Pass | Pass | Pass | Pass | Partial | 4.5 / 5 | $0 Hobby (non-commercial only); adapter swap |
| Render | Pass | Partial | Pass | Pass | Pass | 4.5 / 5 | $0 Free with ~1 min cold start, or $7/mo Starter |
| Fly.io | Pass | Partial | Pass | Pass | Pass | 4.5 / 5 | No free tier for new orgs (~$1–3/mo); Dockerfile to own |
| Railway | Partial | Pass | Pass | Pass | Pass | 4.5 / 5 | $5/mo Hobby minimum |
| Netlify | Pass | Pass | Pass | Pass | Pass | 5 / 5 raw → heavily penalized | EU function region needs Pro ($20/mo); Free 300-credit hard cap ≈ 20 prod deploys |

**Cloudflare Workers** — `wrangler deploy` / `versions upload|deploy` / `rollback` / `tail` cover the full loop (GA). Fully serverless, no OS or container. Root and per-product `llms.txt`, every page as `index.md`, docs source on GitHub. Hosted MCP servers (API MCP at `mcp.cloudflare.com/mcp`, plus Docs, Workers Builds, Observability, Bindings; no beta label as of 2026-10-03). Free: 100k req/day, 10 ms CPU/request, 50 subrequests; time spent awaiting `fetch()` is not CPU time and there is no wall-clock limit while the client is connected, so 10–20 s LLM calls are fine. Workers Builds (git-connected CI, branch preview URLs; GA status not stated on its docs page, checked 2026-10-03).

**Vercel** — Strong CLI (`vercel deploy --prod`, `rollback`, `promote`, `logs --json`), Fluid compute (GA) with 300 s function duration on Hobby and Active-CPU billing, `llms.txt` + markdown docs. MCP (`mcp.vercel.com`) launched as Public Beta with no confirmed GA and uses account-wide OAuth (no scoped tokens) → Partial. Hobby is $0 but restricted to non-commercial use, default region `iad1` must be changed to `fra1`, Hobby rollback goes back only one deployment and runtime logs are kept for 1 hour. WebSockets public beta since 2026-06-22 (irrelevant here).

**Render** — GA Render CLI (`render deploys create --wait`, `-o json`, `RENDER_API_KEY`), deploy hooks, `llms.txt` + `.md` pages, hosted MCP at `mcp.render.com` (no beta label; cannot delete resources). Native Node runtime, Frankfurt region. Partial on managed/serverless: not serverless — Free web services spin down after 15 min idle with ~1 min wake-up; always-on Starter is $7/mo. Rollback via dashboard/API only. Hobby workspace bandwidth reduced to 5 GB from 2026-08-01 (per third-party summary; Render page not directly verified).

**Fly.io** — `flyctl` covers deploy/logs/secrets; rollback is a pattern (`fly deploy --image …`), not a command. Container PaaS — you own the Dockerfile and Machine lifecycle → Partial. `llms.txt` at docs.fly.io; `fly mcp server` built into flyctl ("most" commands). No free allowance for new orgs. Warsaw (`waw`) region deprecated in the Region Consolidation Project; nearest is `fra`.

**Railway** — Good CLI (`railway up --ci`, `logs --json`, `redeploy`), but rollback is dashboard-only and images are retained only 72 h on Hobby → Partial. Railpack builder (Nixpacks deprecated), `llms.txt`, hosted MCP + Claude Code plugin (GA status unconfirmed). $5/mo Hobby minimum; Free is only $1/mo credit. EU West region in Amsterdam; serverless sleep can return 502 on the first request.

**Netlify** — Raw criteria are all Pass (draft-by-default deploys, `--json`, GA MCP, `llms.txt`), synchronous functions now get 60 s. But cost weighting sinks it: EU function regions (`fra`) require Pro at $20/mo — on Free/Personal SSR runs in US-East (`cmh`) and every Supabase call crosses the Atlantic; the Free 300-credit hard cap pauses all sites when exhausted and each production deploy costs 15 credits, which collides with auto-deploy-on-merge.

### Shortlisted Platforms

#### 1. Cloudflare Workers (Recommended)

All five criteria Pass; $0 at MVP scale; zero migration because the adapter and `wrangler.jsonc` already target Workers; wall-clock-free outbound `fetch` suits 10–20 s AI calls; first-class MCP and `llms.txt` for agent-driven ops. The only cost lever is the 10 ms CPU cap on Free, solvable with the $5 Paid plan.

#### 2. Vercel

Equally capable CLI and docs, generous 300 s Hobby duration, `fra1` region available on Hobby — effectively $0 too. Loses on: adapter swap to `@astrojs/vercel` (and replacing `cloudflare:workers` env access), Hobby's non-commercial clause, 1 h log retention, one-step rollback, and a beta-status account-wide MCP.

#### 3. Render

Native Node in Frankfurt, all-GA CLI/MCP, generous request timeouts. Loses on: adapter swap to `@astrojs/node`, and the cost/UX trade-off — Free means ~1 min cold starts (bad for a daily-habit mobile app), always-on means $7/mo.

## Anti-Bias Cross-Check: Cloudflare Workers

### Devil's Advocate — Weaknesses

1. **10 ms CPU cap on Free.** Astro SSR + React server rendering + `@supabase/ssr` cookie handling + schema validation of AI JSON (10 flashcards with extended explanations) can sporadically exceed it, producing intermittent error 1102 that never reproduces locally.
2. **Client disconnect cancels the Worker.** A 10–20 s generation request is cancelled if the user locks the phone or switches tabs; the LLM tokens are spent, nothing is saved, and the attempt still counts toward the 20/day generation limit. FR-028's "all or nothing" saving prevents corruption, not wasted work.
3. **Rollback is blocked when bindings change** between versions and never reverts data or Supabase migrations — the fast rollback fails exactly in the deploys most likely to need it.
4. **workerd npm compatibility.** Even with `nodejs_compat`, some packages (CommonJS-only, native modules, Node-specific SDK internals) break, narrowing LLM SDK and helper library choices.
5. **Stale "Pages" guidance.** `tech-stack.md` and many tutorials say `wrangler pages deploy` / Pages projects; an agent following them builds the wrong pipeline.

### Pre-Mortem — How This Could Fail

The team deployed on "Cloudflare Pages" because tech-stack.md said so. The agent generated `wrangler pages deploy` from a tutorial, while adapter v14 produced a Worker artifact — the first evening went to debugging 404s. After switching to Workers, everything worked locally, because `astro dev` runs workerd without CPU limits. On production, on the Free plan, the quiz-results screen with a large React tree started throwing intermittent 1102s; with only 3 days of free log retention, the problem was noticed late. Meanwhile, flashcard generation on the phone kept breaking: a locked screen cancelled the request, the LLM still burned tokens, and the 20/day generation limit was exhausted after a few failed attempts — the user concluded "AI doesn't work". Finally, a binding change (adding KV for rate limiting) blocked rollback precisely when a bad deploy broke OAuth login, because the preview callback URL wasn't in Supabase's allowlist. None of these failures came from the platform itself — they came from assuming "works locally and it's free" meant "ready".

### Unknown Unknowns

- **Pages is in maintenance mode and `@astrojs/cloudflare` ≥ v13 no longer supports it.** The project's `wrangler.jsonc` (`main` + `assets`) is already Workers with Static Assets; CI is Workers Builds, not a Pages project. (Checked 2026-10-03.)
- **Workers Builds requires the dashboard Worker name to equal `name` in `wrangler.jsonc`.** It is currently `10x-astro-starter`; rename to `ai-flashcards` before the first deploy, or builds fail.
- **`Astro.locals.runtime` is removed in recent adapter versions.** Read secrets via `astro:env` (already used in `astro.config.mjs`) or `import { env } from "cloudflare:workers"`; set them with `wrangler secret put`; locally use `.dev.vars`. `astro dev` already runs in workerd, so a separate `wrangler dev` is unnecessary.
- **Every preview URL and the `*.workers.dev` URL must be added to Supabase Auth redirect URLs** (and the OAuth provider's authorized origins), or OAuth fails on previews.
- **Free-plan Workers Logs keep 3 days** (200k events/day, then 1% sampling); `wrangler tail` is live-only — no history.

## Operational Story

- **Preview deploys**: Workers Builds connected to the GitHub repo builds every non-production branch and posts a preview URL (`<version>-ai-flashcards.<subdomain>.workers.dev`) as a PR comment; previews are public by default — the app's own OAuth allowlist is the protection, and each preview origin must be allowed in Supabase Auth redirect URLs.
- **Secrets**: Production secrets (`SUPABASE_URL`, `SUPABASE_KEY`, LLM API key) live in Workers Secrets set via `wrangler secret put <NAME>`; local values live in `.dev.vars` (gitignored); build-time variables in Workers Builds settings; only the Cloudflare account owner can read/overwrite them; rotation = issue new key at the provider → `wrangler secret put` → revoke old key.
- **Rollback**: `wrangler deployments list` → `wrangler rollback <version-id>` (takes effect in seconds); blocked if bindings changed between versions; Supabase schema migrations never roll back automatically — write migrations backward-compatible (expand, then contract).
- **Approval**: Human-only — merging to `main` (triggers production build), first creation of the Worker and Workers Builds connection, rotating the Supabase service key or LLM key, any Supabase destructive migration, dashboard DNS/domain changes. Agent may unattended: `astro build`, `wrangler deploy --dry-run`, `wrangler versions upload` (non-promoted), reading logs, listing deployments.
- **Logs**: `wrangler tail ai-flashcards --format pretty` (live), Workers Logs in Observability (3-day retention on Free), Workers Builds logs via the dashboard or the Cloudflare Workers Builds / Observability MCP servers, using an API token scoped to Workers for this account only.

## Risk Register

| Risk | Source | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| Intermittent error 1102 from 10 ms CPU cap on Free | Devil's advocate | M | M | Watch CPU time in Workers Observability after first deploy; upgrade to Workers Paid ($5/mo) at the first 1102 instead of optimizing code |
| Client disconnect cancels long AI generation, wasting tokens and daily quota | Devil's advocate | M | M | Use `ctx.waitUntil` (≤30 s after response) to finish and persist generation, or make generation idempotent with a request ID so a retry picks up the saved result; count quota only on successful save |
| Rollback blocked by binding changes; migrations don't revert | Devil's advocate | M | H | Ship binding changes in their own deploy; keep Supabase migrations backward-compatible; know `wrangler rollback` before you need it |
| Library incompatible with workerd | Devil's advocate | L | M | Prefer fetch-based SDKs; run `npm run build` + a smoke request on a preview before merging new dependencies |
| Agent follows stale Pages instructions (`wrangler pages deploy`) | Unknown unknowns | H | M | Update `tech-stack.md` hint to `cloudflare-workers`; record in `AGENTS.md` that deploys are Workers-only |
| Workers Builds fails due to Worker name mismatch (`10x-astro-starter`) | Unknown unknowns | H | L | Rename `name` in `wrangler.jsonc` to `ai-flashcards` before connecting the repo |
| OAuth breaks on preview/workers.dev URLs | Pre-mortem | H | M | Add `https://*.workers.dev` patterns / exact preview hosts to Supabase Auth redirect URLs and the OAuth provider config |
| Bugs discovered late due to 3-day log retention | Pre-mortem | M | L | Log AI failures to a Supabase table (also feeds FR-028 diagnostics) |
| Workers Builds GA status not stated | Research finding | L | L | Fallback: GitHub Actions running `wrangler deploy` with a scoped `CLOUDFLARE_API_TOKEN` |
| Pages maintenance mode / future deprecation | Research finding | L | L | Already avoided — project targets Workers Static Assets |

## Getting Started

1. Fix config drift before first deploy: in `wrangler.jsonc` set `"name": "ai-flashcards"`; in `context/foundation/tech-stack.md` change `deployment_target: cloudflare-pages` → `cloudflare-workers` (and `ci_provider` → `workers-builds`).
2. Authenticate the locally pinned wrangler (4.131, already in devDependencies — no global install): `npx wrangler login` interactively once, or export a scoped `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit for this account only) for agent use; verify with `npx wrangler whoami`.
3. Set production secrets: `npx wrangler secret put SUPABASE_URL`, `npx wrangler secret put SUPABASE_KEY` (plus the LLM API key once added to the `astro:env` schema); put local values in `.dev.vars`. Develop with `npm run dev` (`astro dev` already runs on workerd — no `wrangler dev` needed).
4. First deploy: `npm run build && npx wrangler deploy`; confirm the `*.workers.dev` URL, add it to Supabase Auth redirect URLs, and check `npx wrangler tail ai-flashcards`.
5. Connect the GitHub repo in Workers & Pages → the `ai-flashcards` Worker → Settings → Builds (build command `npm run build`, deploy command `npx wrangler deploy`, production branch `main`) for auto-deploy on merge and preview URLs on other branches.

## Out of Scope

The following were not evaluated in this research:
- Docker image configuration
- CI/CD pipeline setup
- Production-scale architecture (multi-region, HA, DR)
