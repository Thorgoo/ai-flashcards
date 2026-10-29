# src/lib/ai/ — AI calls guide

## One path for every AI call

- Call AI only through `getAi(supabase, user).call(...)` from `@index.ts`. Never create an Anthropic client or call the API anywhere else — the daily limit, the `ai_calls` log and validation live in `@call.ts`.
- An endpoint returns the result with `aiResponse` from `@response.ts`; the error codes, Polish messages and `retryable` flags are defined once in `@errors.ts`. Do not invent new error shapes.
- Do not add retries (SDK or loops). Every call uses up the user's limit, so only the user retries.
- A call that can run past 30 s must not run under `ctx.waitUntil`, which Cloudflare cuts ~30 s after the client disconnects. Run it in the queue consumer with the user's forwarded access token (`@../topics/flashcard-generation.ts`, `src/worker.ts`), keep `max_retries: 0`, and store failures on the claim.
- A queue message carries the user's access token: never log message bodies, and never add a dead-letter queue or message logging without dropping `accessToken` first.

## Adding an AI task (slices)

- Define a zod schema for the response and pass it as `schema`; it is both the JSON schema sent to Claude and the final check. Express counts and ranges in zod, since structured outputs cannot.
- Add a fixture for the task name to `@fixtures.ts`, so `AI_MODE=fake` (dev, CI) works without a key; throw `FakeAiFailure` in tests to simulate errors.
- Cover the task with Vitest on the fake provider, like `@call.test.ts`.
- `kind` is `generation` or `grading`; it picks the limit. Raise `effort` or change `model` per call only when quality needs it.

## Limits

The 20 / 100 daily limits and the Europe/Warsaw day are in the `begin_ai_call` SQL function (`supabase/migrations/`). Change them only with a new migration and its pgTAP test.
