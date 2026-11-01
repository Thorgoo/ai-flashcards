# src/lib/topics/ — topics, subtopics and quiz guide

## Invariants live in the database

- A topic is a `draft` until confirmed; confirming is permanent and needs 2–10 subtopics. RLS and triggers on `topics`/`subtopics` enforce it, so never rely on the API check alone or relax those policies. Later slices may assume a confirmed list never changes.
- Replace a whole list only through `replaceSubtopics` (atomic, FR-028).
- One quiz per confirmed topic. `authenticated` only reads `quizzes`/`quiz_questions`; writes go through `claim_quiz` (before the AI call), `create_quiz` and `answer_quiz_question` (answers are final). Quiz functions name the error in the `hint`. A question's subtopic belongs to its topic by composite foreign key.
- Per-subtopic results come only from `quiz_results` (computed from answers); S-04 reads the same.

## Study state (S-05, later S-06/S-08/S-09)

- Only `answer_flashcard_choice` and `answer_flashcard_open` change a card's study columns (`stage`, `due_on`, …). Never update them from TS or a new policy.
- Open answers: every check (`readOpenAttempt`) runs before the AI grading, and a retried `attemptId` returns the stored result without AI (`@../../pages/api/topics/[id]/study/answer.ts`). `answer_flashcard_open` trusts the caller's verdict, so it is not a security boundary — only the account's own schedule.
- Every answer is one `flashcard_answers` row; the client's `attemptId` is the idempotency key, so a retry reuses it (`@../../components/topics/StudySession.tsx`).
- `@mastery.ts` mirrors `claim_next_flashcard_batch` (the 80% unlock and what a mastered subtopic is); change both together. A subtopic's mastery counts its flashcards only, never the quiz.
- "Today" is the Europe/Warsaw date: `@study-day.ts` for reads, the database for writes.
- Deleting a card sets `flashcard_answers.flashcard_id` to null and keeps the answer; only deleting the topic or the account removes the log.
- The daily streak comes only from `study_streak()` (a day = ≥1 flashcard answer on an active topic, Warsaw date); S-10 reads it there, never counts its own.
- Badges are awarded only by `sync_badges` from the database triggers; never insert them from TS. The thresholds live in the badges migration and `@../badges/catalog.ts`; change both together.

## Endpoints

- Check the topic's state before calling AI: every call uses up the daily limit. See `@../../pages/api/topics/[id]/generate.ts`.
- Errors use `topicErrorResponse` (`@errors.ts`), the shape of `src/lib/ai/errors.ts`; add a code, not a shape.
- Use `@http.ts` (401 JSON, 400 body, 404 topic, `readQuizState`). Mutations return full state; islands render only that. `correctIndex` never leaves the API before a quiz is completed; the server shuffles options (`@quiz-task.ts`).
- Limits (lengths, 2–10 manual, 4–8 from AI, quiz quotas) live in `@schemas.ts` / `@quiz-task.ts` and match the migrations.

## Testing

Unit tests use the fake AI provider; import `callAi` from `@/lib/ai/call` (`@/lib/ai` needs `astro:env`). The end-to-end flow is `scripts/smoke-topics.mjs` (CI only); extend it when an endpoint changes, and keep its generation count in step with the daily-limit loop.
