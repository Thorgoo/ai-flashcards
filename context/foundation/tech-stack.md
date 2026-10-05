---
starter_id: 10x-astro-starter
package_manager: npm
project_name: ai-flashcards
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-workers
  ci_provider: workers-builds
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
---

## Why this stack

A solo developer building AI Flashcards in a 3-week, after-hours MVP needs auth, a relational database, and a deploy target working from day one, so the effort goes into the AI-driven diagnostic quiz, flashcard generation, and open-answer grading rather than infrastructure. 10x Astro Starter is the recommended default for a TypeScript web app and clears all four agent-friendly gates. Supabase supplies Postgres and OAuth-capable authentication out of the box, which closes the two gaps found in the previously chosen T3 card (SQLite instead of Postgres, no NextAuth in the registered command). Deployment stays on the starter's native Cloudflare target — Workers with Static Assets (the @astrojs/cloudflare adapter no longer supports Pages since v13) — with Workers Builds auto-deploying on merge to main. Bootstrapper confidence is first-class, so scaffolding should be mostly smooth with occasional manual steps. The edge runtime's execution limits are a known constraint worth checking early for longer AI generation calls. Auth and AI feature flags are set; payments, realtime, and background jobs are out of scope per the PRD.
