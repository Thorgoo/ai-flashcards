---
change_id: testing-critical-path-e2e
title: Critical-path E2E tests for the US-01 loop and AI grading failure
status: implementing
created: 2026-11-01
updated: 2026-11-01
archived_at: null
---

## Notes

Open a change folder for rollout Phase 1 of context/foundation/test-plan.md: "Critical-path E2E".
Risks covered: #4 (full US-01 loop breaks in the browser despite green logic tests), #5 (AI grading failure loses the typed answer or still changes card state). Test types planned: e2e (Playwright) + integration.
Risk response intent:
- #4: prove a user in the browser completes the full US-01 loop (topic -> subtopics -> diagnostic quiz -> flashcard batch -> study session) on fake AI and sees a flashcard in study; avoid e2e for cases integration would catch and brittle CSS selectors.
- #5: prove that on a grading failure the typed answer stays in the field, the card's state in the database does not change, and resubmitting works; avoid asserting only the error message without checking DB state.
After creating the folder, follow the downstream continuation rule.
