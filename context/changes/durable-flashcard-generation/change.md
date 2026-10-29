---
change_id: durable-flashcard-generation
title: Durable flashcard generation
status: impl_reviewed
created: 2026-10-29
updated: 2026-10-29
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

- 2026-10-29 — Closes S-07 follow-up F2 and the reload part of S-07 manual criterion 4.5 (`context/archive/2026-10-29-next-batch-and-subtopic-mastery/`). Production evidence: test topic "TEST durable (do usunięcia)", batch 1 started, page reloaded ~4 s later, batch saved ~40 s after start with no failure; queue consumer invocation `ok`, 57 ms CPU, 38 s wall-clock (`wrangler tail`).
