# Archive SHA repoint

## 2026-11-01

- **Target**: origin/main @ d1ec197724f5086fb22ff65049092f9a87333415
- **Integration commit**: d1ec197 "test: critical-path E2E (test-plan Phase 1) (#63)"
- **PR**: https://github.com/Thorgoo/ai-flashcards/pull/63 (MERGED into main, squash)
- **Evidence**: the PR commit list contains all six phase commits; the tree of d1ec197 equals the tree of the PR head ed5e024, so the squash integrates the whole implementation. None of the old SHAs is an ancestor of the target.
- **Decision**: user chose "Update and archive".

| Row ID | Old suffix (resolved OID) | New SHA |
|---|---|---|
| 1.1, 1.2, 1.3 | ccb6601 (ccb6601a5d87a5ee90c27be09a215a8670f9446c) | d1ec197 |
| 2.1, 2.2, 2.3 | 83fa60a (83fa60aba8286140a04927d26fa66cef1a647709) | d1ec197 |
| 3.1, 3.2, 3.3 | 34f860f (34f860f322c1e31035b0596b2e23685a8beff53f) | d1ec197 |
| 4.1, 4.2, 4.3 | 3ec8bf8 (3ec8bf8667725e12a633d596dac4e05a0647b5a4) | d1ec197 |
| 5.1, 5.2 | a87f27e (a87f27e78e635e434c168ad000980d5e9182e45b) | d1ec197 |
| 6.1, 6.2, 6.3, 6.4 | 2dda55a (2dda55a9750d228d43a66d57fea9252ec4e28a60) | d1ec197 |

Affected rows: 18.
