---
change_id: testing-retry-and-claim
title: Retry and claim integrity tests (test plan rollout Phase 2)
status: implementing
created: 2026-11-04
updated: 2026-11-04
archived_at: null
---

## Notes

Open a change folder for rollout Phase 2 of context/foundation/test-plan.md: "Retry and claim integrity".
Risks covered: #1 (a generation retry saves the result twice or uses up the daily limit without a result), #2 (an interrupted generation leaves an orphaned claim that blocks the retry), #7 (parallel or repeated requests exceed the daily limit of 20/100). Test types planned: integration (pgTAP + vitest).
Risk response intent:

- #1: prove that two retries after a failure give exactly one complete result and the limit is charged according to the PRD rule.
- #2: prove that after an interruption during generation, the next attempt after the TTL takes over the claim and succeeds.
- #7: prove that the 21st generation of the day is rejected, also under parallel requests.
  After creating the folder, follow the downstream continuation rule.
