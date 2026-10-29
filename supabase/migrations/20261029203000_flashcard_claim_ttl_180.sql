-- Claim TTL 120 s -> 180 s (durable-flashcard-generation review F1): the queue consumer's
-- AI call alone may take 90 s, plus queue delivery, reads and the save; 120 s left too little
-- margin, and a claim that expires mid-generation lets a second click waste a generation.
-- Bodies as in flashcard_batch_failures, only the TTL changes. Keep 180 in sync with
-- FLASHCARD_CLAIM_TTL_SECONDS in src/lib/topics/flashcards-task.ts.

create or replace function public.claim_flashcard_batch(p_topic_id uuid)
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
  -- A failed batch is taken over whatever its age; only a generating one waits for the TTL.
  if v_status = 'generating' and v_claimed_at > now() - interval '180 seconds' then
    raise exception 'batch_generating' using errcode = 'P0409', hint = 'batch_generating';
  end if;

  update public.flashcard_batches set status = 'generating', error_code = null, claimed_at = now()
  where topic_id = p_topic_id and seq = 1
  returning claimed_at into v_claimed_at;
  return v_claimed_at;
end;
$$;

create or replace function public.claim_next_flashcard_batch(p_topic_id uuid, p_seq integer)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_last integer;
  v_total integer;
  v_mastered integer;
  v_status text;
  v_claimed_at timestamptz;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- FOR SHARE keeps the topic confirmed (and its subtopics fixed) until the claim is made.
  perform 1 from public.topics t
  where t.id = p_topic_id and t.user_id = v_user and t.status = 'confirmed'
  for share;
  if not found then
    raise exception 'topic_not_confirmed' using errcode = 'P0409', hint = 'topic_not_confirmed';
  end if;

  select max(b.seq) into v_last
  from public.flashcard_batches b
  where b.topic_id = p_topic_id and b.status = 'ready';
  if v_last is null or p_seq is null or p_seq > v_last + 1 then
    raise exception 'next_batch_locked' using errcode = 'P0409', hint = 'next_batch_locked';
  end if;
  if p_seq <= v_last then
    raise exception 'batch_exists' using errcode = 'P0409', hint = 'batch_exists';
  end if;

  select count(*), count(*) filter (where f.stage = 'mastered') into v_total, v_mastered
  from public.flashcards f
  join public.flashcard_batches b on b.id = f.batch_id
  where b.topic_id = p_topic_id and b.seq = v_last;
  if v_mastered * 5 < v_total * 4 then
    raise exception 'next_batch_locked' using errcode = 'P0409', hint = 'next_batch_locked';
  end if;

  if not exists (
    select 1 from public.subtopics s
    where s.topic_id = p_topic_id
      and (
        not exists (select 1 from public.flashcards f where f.subtopic_id = s.id)
        or exists (select 1 from public.flashcards f where f.subtopic_id = s.id and f.stage <> 'mastered')
      )
  ) then
    raise exception 'topic_mastered' using errcode = 'P0409', hint = 'topic_mastered';
  end if;

  -- A concurrent claim waits here for the other transaction and then sees its row.
  insert into public.flashcard_batches (user_id, topic_id, seq, status)
  values (v_user, p_topic_id, p_seq, 'generating')
  on conflict (topic_id, seq) do nothing
  returning claimed_at into v_claimed_at;
  if found then
    return v_claimed_at;
  end if;

  select b.status, b.claimed_at into v_status, v_claimed_at
  from public.flashcard_batches b
  where b.topic_id = p_topic_id and b.seq = p_seq
  for update;
  if v_status = 'ready' then
    raise exception 'batch_exists' using errcode = 'P0409', hint = 'batch_exists';
  end if;
  -- A failed batch is taken over whatever its age; only a generating one waits for the TTL.
  if v_status = 'generating' and v_claimed_at > now() - interval '180 seconds' then
    raise exception 'batch_generating' using errcode = 'P0409', hint = 'batch_generating';
  end if;

  update public.flashcard_batches set status = 'generating', error_code = null, claimed_at = now()
  where topic_id = p_topic_id and seq = p_seq
  returning claimed_at into v_claimed_at;
  return v_claimed_at;
end;
$$;
