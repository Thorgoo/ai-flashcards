# src/lib/topics/ — topics and subtopics guide

## The lock lives in the database

- A topic is a `draft` until confirmed; confirming is permanent and needs 2–10 subtopics. The `create_topics_and_subtopics` migration enforces this (RLS and a locking trigger on `subtopics` pass writes only for draft topics, a trigger guards `topics.status`), so never rely on the API check alone and never relax those policies to make a feature work. Later slices (quiz, flashcards) read confirmed topics and may assume the list never changes.
- Replace a whole list only through `replaceSubtopics` (`replace_subtopics` RPC): it is atomic, so a failed generation never leaves a partial list (FR-028).

## Endpoints

- Check `topic.status` before calling AI: every call uses up the daily limit, even when saving fails afterwards. See `@../../pages/api/topics/[id]/generate.ts`.
- Errors use `topicErrorResponse` from `@errors.ts`, the same `{ error: { code, message, retryable } }` shape as `src/lib/ai/errors.ts`; add a code there instead of a new shape. Map new Postgres errors in `errorCode` in `@repository.ts`.
- Use the helpers in `@http.ts` (session → 401 JSON, JSON body → 400, topic → 404 for missing, foreign or malformed ids). Every mutation answers with the full topic state; the editor island renders only that.
- Limits (name lengths, 2–10 manual, 4–8 from AI) are defined once in `@schemas.ts` and must match the migration's checks.

## Testing

Unit tests run on the fake AI provider (`*.test.ts`); import `callAi` from `@/lib/ai/call`, since `@/lib/ai` needs `astro:env`. The end-to-end flow is `scripts/smoke-topics.mjs` (CI only); extend it when an endpoint changes.
