-- DELIBERATE BREAK, never merge: shorter TTLs, a higher grading limit, and a refund of the
-- pending charge when an attempt fails.
do $$
declare
  v_edits text[][] := array[
    ['public.claim_quiz(uuid)', '90 seconds', '60 seconds'],
    ['public.claim_flashcard_batch(uuid)', '180 seconds', '120 seconds'],
    ['public.claim_next_flashcard_batch(uuid, integer)', '180 seconds', '120 seconds'],
    ['public.begin_ai_call(text, text, text)', 'when ''grading'' then 100', 'when ''grading'' then 120']
  ];
  v_refunds text[] := array[
    'public.release_quiz_claim(uuid, timestamp with time zone)',
    'public.fail_flashcard_batch_claim(uuid, integer, timestamp with time zone, text)'
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

  foreach v_before in array v_refunds loop
    v_after := regexp_replace(
      pg_get_functiondef(v_before::regprocedure),
      '\mbegin\M',
      'begin delete from public.ai_calls where user_id = auth.uid() and status = ''pending'';'
    );
    if v_after = pg_get_functiondef(v_before::regprocedure) then
      raise exception 'break did not apply to %', v_before;
    end if;
    execute v_after;
  end loop;
end;
$$;
