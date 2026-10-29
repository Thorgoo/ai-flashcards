# Review fixes — next-batch-and-subtopic-mastery

From `reviews/impl-review.md` (2026-10-29).

## F2 — Durable flashcard generation (new change)

- **Problem**: a reload during generation loses the batch. `waitUntil` keeps ~30 s after the client disconnects, generation takes 33–36 s; the `ai_calls` row stays `pending`, one generation is used, nothing is saved, and the claim expires after 120 s. Verified on production for batch 2; batch 1 (`POST /flashcards`) has the same exposure.
- **Direction**: move the AI call and save out of the request (Cloudflare Queue or Durable Object consumer) while the page keeps polling `GET /flashcards/summary`; the claim/token RPCs already fit a background consumer.
- **Next step**: `/10x-new durable-flashcard-generation`, then research Workers queue/DO limits on the current plan.
- **Closes**: manual criterion 4.5 of this plan (reload part).
