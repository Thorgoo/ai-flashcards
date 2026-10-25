-- Claim tokens and null options (impl-review F2, F3 of first-weak-subtopic-batch).
-- A claim now returns its claimed_at, and release/create take it back as a token: a
-- request that outlived the TTL can no longer drop or fill the claim another request took
-- over. The token defaults to null (no check), so the Worker that predates this migration
-- keeps working; a later migration may make it required.
-- Option arrays also refuse null elements, which the length checks let through.

alter table public.flashcards
  add constraint flashcards_options_not_null check (array_position(options, null) is null);
alter table public.quiz_questions
  add constraint quiz_questions_options_not_null check (array_position(options, null) is null);

drop function public.claim_flashcard_batch(uuid);
drop function public.release_flashcard_batch_claim(uuid);
drop function public.create_flashcard_batch(uuid, jsonb);
drop function public.claim_quiz(uuid);
drop function public.release_quiz_claim(uuid);
drop function public.create_quiz(uuid, jsonb);

-- As in create_flashcards, and returns the claim's claimed_at (the token for release and
-- create). Keep 120 in sync with FLASHCARD_CLAIM_TTL_SECONDS in src/lib/topics/flashcards-task.ts.
-- Raises topic_not_confirmed, quiz_not_completed, batch_exists or batch_generating (P0409).
create function public.claim_flashcard_batch(p_topic_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_status text;
  v_claimed_at timestamptz;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  perform 1 from public.topics t
  where t.id = p_topic_id and t.user_id = v_user and t.status = 'confirmed'
  for share;
  if not found then
    raise exception 'topic_not_confirmed' using errcode = 'P0409', hint = 'topic_not_confirmed';
  end if;

  if not exists (
    select 1 from public.quizzes q where q.topic_id = p_topic_id and q.completed_at is not null
  ) then
    raise exception 'quiz_not_completed' using errcode = 'P0409', hint = 'quiz_not_completed';
  end if;

  -- A concurrent claim waits here for the other transaction and then sees its row.
  insert into public.flashcard_batches (user_id, topic_id, seq, status)
  values (v_user, p_topic_id, 1, 'generating')
  on conflict (topic_id, seq) do nothing
  returning claimed_at into v_claimed_at;
  if found then
    return v_claimed_at;
  end if;

  select b.status, b.claimed_at into v_status, v_claimed_at
  from public.flashcard_batches b
  where b.topic_id = p_topic_id and b.seq = 1
  for update;
  if v_status = 'ready' then
    raise exception 'batch_exists' using errcode = 'P0409', hint = 'batch_exists';
  end if;
  if v_claimed_at > now() - interval '120 seconds' then
    raise exception 'batch_generating' using errcode = 'P0409', hint = 'batch_generating';
  end if;

  update public.flashcard_batches set claimed_at = now()
  where topic_id = p_topic_id and seq = 1
  returning claimed_at into v_claimed_at;
  return v_claimed_at;
end;
$$;

-- Drops the caller's unfinished claim of batch 1, only while it is still the claim named
-- by p_claimed_at (null: any unfinished claim, for the older Worker).
create function public.release_flashcard_batch_claim(p_topic_id uuid, p_claimed_at timestamptz default null)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.flashcard_batches
  where topic_id = p_topic_id and seq = 1 and user_id = auth.uid() and status = 'generating'
    and (p_claimed_at is null or claimed_at = p_claimed_at);
$$;

-- As in create_flashcards; with p_claimed_at it fills only that claim, so a claim taken
-- over by another request raises batch_not_claimed.
-- Raises topic_not_confirmed / batch_exists / batch_not_claimed (P0409) or batch_size (P0422).
create function public.create_flashcard_batch(p_topic_id uuid, p_cards jsonb, p_claimed_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_batch uuid;
  v_status text;
  v_claimed_at timestamptz;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- FOR SHARE keeps the topic confirmed (and its subtopics fixed) until the batch is saved.
  perform 1 from public.topics t
  where t.id = p_topic_id and t.user_id = v_user and t.status = 'confirmed'
  for share;
  if not found then
    raise exception 'topic_not_confirmed' using errcode = 'P0409', hint = 'topic_not_confirmed';
  end if;

  -- Two checks, not one `or`: SQL does not promise to evaluate the type check first.
  if jsonb_typeof(p_cards) is distinct from 'array' then
    raise exception 'batch_size' using errcode = 'P0422', hint = 'batch_size';
  end if;
  if jsonb_array_length(p_cards) <> 10 then
    raise exception 'batch_size' using errcode = 'P0422', hint = 'batch_size';
  end if;

  select b.id, b.status, b.claimed_at into v_batch, v_status, v_claimed_at
  from public.flashcard_batches b
  where b.topic_id = p_topic_id and b.seq = 1 and b.user_id = v_user
  for update;
  if not found then
    raise exception 'batch_not_claimed' using errcode = 'P0409', hint = 'batch_not_claimed';
  end if;
  if v_status = 'ready' then
    raise exception 'batch_exists' using errcode = 'P0409', hint = 'batch_exists';
  end if;
  if p_claimed_at is not null and v_claimed_at <> p_claimed_at then
    raise exception 'batch_not_claimed' using errcode = 'P0409', hint = 'batch_not_claimed';
  end if;

  update public.flashcard_batches set status = 'ready' where id = v_batch;

  insert into public.flashcards (
    user_id, topic_id, batch_id, subtopic_id, position,
    front, answer, options, correct_index, explanation, example
  )
  select
    v_user,
    p_topic_id,
    v_batch,
    (item.value ->> 'subtopic_id')::uuid,
    (item.ord - 1)::integer,
    item.value ->> 'front',
    item.value ->> 'answer',
    array(select jsonb_array_elements_text(item.value -> 'options')),
    (item.value ->> 'correct_index')::smallint,
    item.value ->> 'explanation',
    item.value ->> 'example'
  from jsonb_array_elements(p_cards) with ordinality as item(value, ord);
end;
$$;

-- As in quiz_generation_claim, and returns the claim's claimed_at (the token for release
-- and create). Keep 90 in sync with QUIZ_CLAIM_TTL_SECONDS in src/lib/topics/quiz-task.ts.
-- Raises topic_not_confirmed, quiz_exists or quiz_generating (P0409).
create function public.claim_quiz(p_topic_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_status text;
  v_claimed_at timestamptz;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  perform 1 from public.topics t
  where t.id = p_topic_id and t.user_id = v_user and t.status = 'confirmed'
  for share;
  if not found then
    raise exception 'topic_not_confirmed' using errcode = 'P0409', hint = 'topic_not_confirmed';
  end if;

  -- A concurrent claim waits here for the other transaction and then sees its row.
  insert into public.quizzes (user_id, topic_id, status)
  values (v_user, p_topic_id, 'generating')
  on conflict (topic_id) do nothing
  returning claimed_at into v_claimed_at;
  if found then
    return v_claimed_at;
  end if;

  select q.status, q.claimed_at into v_status, v_claimed_at
  from public.quizzes q
  where q.topic_id = p_topic_id
  for update;
  if v_status = 'ready' then
    raise exception 'quiz_exists' using errcode = 'P0409', hint = 'quiz_exists';
  end if;
  if v_claimed_at > now() - interval '90 seconds' then
    raise exception 'quiz_generating' using errcode = 'P0409', hint = 'quiz_generating';
  end if;

  update public.quizzes set claimed_at = now()
  where topic_id = p_topic_id
  returning claimed_at into v_claimed_at;
  return v_claimed_at;
end;
$$;

-- Drops the caller's unfinished claim, only while it is still the claim named by
-- p_claimed_at (null: any unfinished claim, for the older Worker).
create function public.release_quiz_claim(p_topic_id uuid, p_claimed_at timestamptz default null)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.quizzes
  where topic_id = p_topic_id and user_id = auth.uid() and status = 'generating'
    and (p_claimed_at is null or claimed_at = p_claimed_at);
$$;

-- As in quiz_generation_claim; with p_claimed_at it fills only that claim, so a missing
-- claim or one taken over by another request raises quiz_not_claimed. Without a token it
-- still creates the quiz directly, as before.
-- Raises topic_not_confirmed / quiz_exists / quiz_not_claimed (P0409) or quiz_size (P0422).
create function public.create_quiz(p_topic_id uuid, p_questions jsonb, p_claimed_at timestamptz default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_quiz uuid;
  v_status text;
  v_claimed_at timestamptz;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- FOR SHARE keeps the topic confirmed (and its subtopics fixed) until the quiz is saved.
  perform 1 from public.topics t
  where t.id = p_topic_id and t.user_id = v_user and t.status = 'confirmed'
  for share;
  if not found then
    raise exception 'topic_not_confirmed' using errcode = 'P0409', hint = 'topic_not_confirmed';
  end if;

  if jsonb_typeof(p_questions) is distinct from 'array' then
    raise exception 'quiz_size' using errcode = 'P0422', hint = 'quiz_size';
  end if;
  if jsonb_array_length(p_questions) <> 10 then
    raise exception 'quiz_size' using errcode = 'P0422', hint = 'quiz_size';
  end if;

  select q.id, q.status, q.claimed_at into v_quiz, v_status, v_claimed_at
  from public.quizzes q
  where q.topic_id = p_topic_id
  for update;
  if v_status = 'ready' then
    raise exception 'quiz_exists' using errcode = 'P0409', hint = 'quiz_exists';
  end if;
  if p_claimed_at is not null and (v_quiz is null or v_claimed_at <> p_claimed_at) then
    raise exception 'quiz_not_claimed' using errcode = 'P0409', hint = 'quiz_not_claimed';
  end if;

  if v_quiz is null then
    insert into public.quizzes (user_id, topic_id) values (v_user, p_topic_id) returning id into v_quiz;
  else
    update public.quizzes set status = 'ready' where id = v_quiz;
  end if;

  insert into public.quiz_questions (user_id, quiz_id, topic_id, subtopic_id, position, prompt, options, correct_index)
  select
    v_user,
    v_quiz,
    p_topic_id,
    (item.value ->> 'subtopic_id')::uuid,
    (item.ord - 1)::smallint,
    item.value ->> 'prompt',
    array(select jsonb_array_elements_text(item.value -> 'options')),
    (item.value ->> 'correct_index')::smallint
  from jsonb_array_elements(p_questions) with ordinality as item(value, ord);

  return v_quiz;
end;
$$;

revoke execute on function public.claim_flashcard_batch(uuid) from public;
revoke execute on function public.release_flashcard_batch_claim(uuid, timestamptz) from public;
revoke execute on function public.create_flashcard_batch(uuid, jsonb, timestamptz) from public;
revoke execute on function public.claim_quiz(uuid) from public;
revoke execute on function public.release_quiz_claim(uuid, timestamptz) from public;
revoke execute on function public.create_quiz(uuid, jsonb, timestamptz) from public;
grant execute on function public.claim_flashcard_batch(uuid) to authenticated;
grant execute on function public.release_flashcard_batch_claim(uuid, timestamptz) to authenticated;
grant execute on function public.create_flashcard_batch(uuid, jsonb, timestamptz) to authenticated;
grant execute on function public.claim_quiz(uuid) to authenticated;
grant execute on function public.release_quiz_claim(uuid, timestamptz) to authenticated;
grant execute on function public.create_quiz(uuid, jsonb, timestamptz) to authenticated;
