-- DELIBERATE BREAK, never merge: longer TTLs, and failed calls no longer count to the limit.
do $$
declare
  v_edits text[][] := array[
    ['public.claim_quiz(uuid)', '90 seconds', '120 seconds'],
    ['public.claim_flashcard_batch(uuid)', '180 seconds', '240 seconds'],
    ['public.claim_next_flashcard_batch(uuid, integer)', '180 seconds', '240 seconds'],
    ['public.begin_ai_call(text, text, text)', 'c.called_on = v_today', 'c.called_on = v_today and c.status <> ''failed''']
  ];
  v_before text;
  v_after text;
begin
  for i in 1 .. array_length(v_edits, 1) loop
    v_before := pg_get_functiondef(v_edits[i][1]::regprocedure);
    v_after := replace(v_before, v_edits[i][2], v_edits[i][3]);
    if v_after = v_before then
      raise exception 'break did not apply to %', v_edits[i][1];
    end if;
    execute v_after;
  end loop;
end;
$$;
