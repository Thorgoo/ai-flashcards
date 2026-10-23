# src/lib/topics/ — topics, subtopics and quiz guide

## Invariants live in the database

- A topic is a `draft` until confirmed; confirming is permanent and needs 2–10 subtopics. RLS and triggers on `topics`/`subtopics` enforce it, so never rely on the API check alone or relax those policies. Later slices may assume a confirmed list never changes.
- Replace a whole list only through `replaceSubtopics` (atomic, FR-028).
- One quiz per confirmed topic. `authenticated` only reads `quizzes`/`quiz_questions`; writes go through `create_quiz` and `answer_quiz_question` (answers are final). A question's subtopic belongs to its topic by composite foreign key.
- Per-subtopic results come only from `quiz_results` (computed from answers); S-04 reads the same.

## Endpoints

- Check the topic's state before calling AI: every call uses up the daily limit. See `@../../pages/api/topics/[id]/generate.ts`.
- Errors use `topicErrorResponse` (`@errors.ts`), the shape of `src/lib/ai/errors.ts`; add a code, not a shape.
- Use `@http.ts` (401 JSON, 400 body, 404 topic, `readQuizState`). Mutations return full state; islands render only that. `correctIndex` never leaves the API before a quiz is completed; the server shuffles options (`@quiz-task.ts`).
- Limits (lengths, 2–10 manual, 4–8 from AI, quiz quotas) live in `@schemas.ts` / `@quiz-task.ts` and match the migrations.

## Testing

Unit tests use the fake AI provider; import `callAi` from `@/lib/ai/call` (`@/lib/ai` needs `astro:env`). The end-to-end flow is `scripts/smoke-topics.mjs` (CI only); extend it when an endpoint changes, and keep its generation count in step with the daily-limit loop.
