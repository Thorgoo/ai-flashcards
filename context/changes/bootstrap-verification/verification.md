---
bootstrapped_at: 2026-09-27T17:13:03Z
starter_id: 10x-astro-starter
starter_name: "10x Astro Starter (Astro + Supabase + Cloudflare)"
project_name: ai-flashcards
language_family: js
package_manager: npm
cwd_strategy: git-clone
bootstrapper_confidence: first-class
phase_3_status: ok
audit_command: "npm audit --json"
---

> Note: the scaffold itself (clone, install, move-up) completed in an earlier run at 2026-09-27T17:13:03Z that was interrupted before this log was written. This log was finalized at 2026-09-27T17:17Z from that run's staging files (`.bootstrap-merge.json`, `.bootstrap-install.log`, `.bootstrap-audit.json`), with the recency check and the audit re-run against the current tree. The scaffold was not repeated. The staging files were deleted after their contents were copied here.

## Hand-off

```yaml
starter_id: 10x-astro-starter
package_manager: npm
project_name: ai-flashcards
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-pages
  ci_provider: cloudflare-builds
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: first-class
  path_taken: standard
  quality_override: false
  self_check_answers: null
  has_auth: true
  has_payments: false
  has_realtime: false
  has_ai: true
  has_background_jobs: false
```

### Why this stack

A solo developer building AI Flashcards in a 3-week, after-hours MVP needs auth, a relational database, and a deploy target working from day one, so the effort goes into the AI-driven diagnostic quiz, flashcard generation, and open-answer grading rather than infrastructure. 10x Astro Starter is the recommended default for a TypeScript web app and clears all four agent-friendly gates. Supabase supplies Postgres and OAuth-capable authentication out of the box, which closes the two gaps found in the previously chosen T3 card (SQLite instead of Postgres, no NextAuth in the registered command). Deployment stays on the starter's native Cloudflare Pages target, with Cloudflare Builds auto-deploying on merge to main. Bootstrapper confidence is first-class, so scaffolding should be mostly smooth with occasional manual steps. The edge runtime's execution limits are a known constraint worth checking early for longer AI generation calls. Auth and AI feature flags are set; payments, realtime, and background jobs are out of scope per the PRD.

## Pre-scaffold verification

| Signal      | Value                                                        | Severity | Notes                                                                                             |
| ----------- | ------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------- |
| npm package | not run                                                      | —        | `cmd_template` starts with `git clone`; no npm CLI package to resolve                             |
| GitHub repo | przeprogramowani/10x-astro-starter last pushed 2026-09-12T21:16:08Z | fresh    | from card.docs_url; `gh` CLI not installed, so this came from the public GitHub REST API instead |

## Scaffold log

**Resolved invocation**: `git clone https://github.com/przeprogramowani/10x-astro-starter .bootstrap-scaffold && cd .bootstrap-scaffold && npm install`
**Strategy**: git-clone
**Exit code**: 0
**Files moved**: 20 entries (`.env.example`, `.github/`, `.husky/`, `.nvmrc`, `.prettierrc.json`, `.vscode/`, `AGENTS.md`, `astro.config.mjs`, `components.json`, `eslint.config.js`, `node_modules/`, `package-lock.json`, `package.json`, `public/`, `README.md`, `scripts/`, `src/`, `supabase/`, `tsconfig.json`, `wrangler.jsonc`)
**Conflicts (.scaffold siblings)**: `CLAUDE.md` → `CLAUDE.md.scaffold`
**Dropped (context/**)**: none
**.gitignore handling**: moved silently (no `.gitignore` in cwd beforehand)
**.bootstrap-scaffold cleanup**: deleted (upstream `.git/` removed before files were moved)

**Install output** (`npm install`):

```
added 648 packages, and audited 649 packages in 20s

232 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
npm warn install-scripts 3 packages have install scripts not yet covered by allowScripts:
npm warn install-scripts   esbuild@0.28.2 (postinstall: node install.js)
npm warn install-scripts   workerd@1.20260911.1 (postinstall: node install.js)
npm warn install-scripts   esbuild@0.28.1 (postinstall: node install.js)
npm warn install-scripts
npm warn install-scripts Run `npm install-scripts ls` to review, or `npm install-scripts approve <pkg>` to allow.
```

Observations:
- npm skipped the postinstall scripts for `esbuild` and `workerd`. Until they are approved with `npm install-scripts approve <pkg>`, `astro dev` / `wrangler` may fail to find their native binaries.
- The starter includes `.github/workflows/ci.yml`. Bootstrapper did not generate it, and the hand-off's CI provider is `cloudflare-builds`, so check whether you want to keep it.
- The starter's `AGENTS.md` contains only `CLAUDE.md` (a pointer). With the existing `CLAUDE.md` kept, that pointer now refers to your lesson `CLAUDE.md`, not to the starter's (which is in `CLAUDE.md.scaffold`).
- Local Node is v24.21.0; the starter pins `node 22` (`.nvmrc`).

## Post-scaffold audit

**Tool**: npm audit --json (exit code 0)
**Summary**: 0 CRITICAL, 0 HIGH, 0 MODERATE, 0 LOW (0 INFO)
**Direct vs transitive**: 0/0/0/0 direct of total 0/0/0/0
**Dependencies audited**: 804 total (377 prod, 269 dev, 167 optional)

#### CRITICAL findings

None.

#### HIGH findings

None.

#### MODERATE findings

None.

#### LOW / INFO findings

None.

## Hints recorded but not acted on

| Hint                    | Value                |
| ----------------------- | -------------------- |
| bootstrapper_confidence | first-class          |
| quality_override        | false                |
| path_taken              | standard             |
| self_check_answers      | null                 |
| team_size               | solo                 |
| deployment_target       | cloudflare-pages     |
| ci_provider             | cloudflare-builds    |
| ci_default_flow         | auto-deploy-on-merge |
| has_auth                | true                 |
| has_payments            | false                |
| has_realtime            | false                |
| has_ai                  | true                 |
| has_background_jobs     | false                |

## Next steps

Next: a future skill will set up agent context (CLAUDE.md, AGENTS.md). For now, your project is scaffolded and verified — happy hacking.

Useful manual steps in the meantime:
- `git init` (if you have not already) to start your own repo history.
- Review any `.scaffold` siblings the conflict policy created and decide which version of each file to keep.
- Address audit findings per your project's risk tolerance — the full breakdown is in this log.
