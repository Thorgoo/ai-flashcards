# Test stack

## E2E

<!-- Written by /10x-e2e-setup. Re-run it to change this section; other skills only read it. -->

- runner: Playwright Test, @playwright/test 1.64.1
- config: playwright.config.ts
- single-spec command: npm run e2e -- e2e/<name>.spec.ts (needs `npx supabase start`; a bare `npx playwright test` has no local Supabase env)
- full-suite command: npm run e2e
- base URL: http://localhost:4321
- port: 4321 (detected from the Astro preview default, also passed explicitly in the webServer command and CI); detected default 4321, override with E2E_PORT
- web server command: npm run build && npm run preview -- --port $E2E_PORT; reuseExistingServer in CI only (locally a taken port fails the run instead of testing whatever is listening)
- auth setup project: setup (e2e/auth.setup.ts), recreates e2e@example.com through the admin API with a random password on every run and signs in without the UI (the app has GitHub OAuth only); credentials come from `npx supabase status` via scripts/e2e.mjs, no E2E_USERNAME / E2E_PASSWORD. The local stack must be started with `[auth.email] enable_signup = true`
- storageState: e2e/.auth/user.json (gitignored)
- seed: e2e/seed.spec.ts — protects #4: the topic -> subtopics -> quiz -> flashcards -> study loop breaks in the browser despite green logic tests (first step of the loop; the whole loop is in e2e/critical-path.spec.ts)
- browser CLI: playwright-cli, command skill at .claude/skills/playwright-cli/SKILL.md
- updated: 2026-11-04
