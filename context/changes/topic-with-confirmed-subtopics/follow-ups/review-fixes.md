# Follow-ups z impl-review S-02

## F4 — reguły zapisu tematu po zatwierdzeniu (→ S-08)

Bezpośrednio przez PostgREST (rola `authenticated`, tylko własne dane) da się dziś:

- zmienić `topics.scope_note` zatwierdzonego tematu — notatka zasila prompty quizu i fiszek (S-03, S-04);
- usunąć zatwierdzony temat (kaskadą z podtematami) — FR-007 przewiduje archiwizację, nie usuwanie;
- ustawić dowolne `subtopics.position` w szkicu (brak unikalności `(topic_id, position)`).

Rozstrzygnąć w S-08 razem z FR-007 i rozszerzyć trigger `guard_topic_status` (nowa migracja + pgTAP). Notatka w roadmapie: S-08 → Unknowns.
