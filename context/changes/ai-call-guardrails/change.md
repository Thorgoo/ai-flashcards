---
change_id: ai-call-guardrails
title: Ai call guardrails
status: impl_reviewed
created: 2026-10-18
updated: 2026-10-18
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

- 2026-10-18, test 2.5 (`live.integration.test.ts`): Claude Sonnet 5.5, `effort: low`, mały schemat (stolica/kraj) — 1336 ms, wynik zgodny ze schematem.
- Do sprawdzenia w pierwszym teście E2E S-02 (tryb fake): `src/lib/ai/quota.ts` nie był jeszcze wywołany przez prawdziwy PostgREST — potwierdzić, że `begin_ai_call` zwraca tablicę wierszy `{ call_id, remaining }` i że przekroczony limit daje `error.code === "P0429"` (HTTP 400), czyli `quota_exceeded`.
