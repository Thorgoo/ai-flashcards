-- Next flashcard batches (S-07): batch p_seq >= 2 of a topic, claimed before the AI call and
-- filled with 10 cards, as batch 1 in create_flashcards / claim_tokens_and_option_nulls.
-- A batch may be claimed only when it is the one right after the latest ready batch, that
-- batch has at least 80% of its existing cards mastered (mastered * 5 >= total * 4; a batch
-- whose cards were all deleted passes), and the topic still has an unmastered subtopic (one
-- with no cards, or with a card that is not 'mastered'). Both rules are checked again here,
-- under the topic lock, because they may have changed since the API read them.
-- Keep the threshold and the subtopic rule in sync with src/lib/topics/mastery.ts, and 120
-- with FLASHCARD_CLAIM_TTL_SECONDS in src/lib/topics/flashcards-task.ts.
-- The batch 1 functions stay as they are; release and create here require the claim token.

-- Claims batch p_seq and returns its claimed_at (the token for release and create).
-- Raises topic_not_confirmed, next_batch_locked, batch_exists, topic_mastered or
-- batch_generating (P0409).
create function public.claim_next_flashcard_batch(p_topic_id uuid, p_seq integer)
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
  if v_claimed_at > now() - interval '120 seconds' then
    raise exception 'batch_generating' using errcode = 'P0409', hint = 'batch_generating';
  end if;

  update public.flashcard_batches set claimed_at = now()
  where topic_id = p_topic_id and seq = p_seq
  returning claimed_at into v_claimed_at;
  return v_claimed_at;
end;
$$;

-- Drops the caller's unfinished claim of batch p_seq, only while it is still the claim
-- named by p_claimed_at. A ready batch is never removed.
create function public.release_next_flashcard_batch_claim(p_topic_id uuid, p_seq integer, p_claimed_at timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.flashcard_batches
  where topic_id = p_topic_id and seq = p_seq and user_id = auth.uid() and status = 'generating'
    and claimed_at = p_claimed_at;
$$;

-- Saves the 10 cards into the caller's claim of batch p_seq named by p_claimed_at and marks
-- it ready, in one transaction; cards as in create_flashcard_batch. A missing token, a
-- missing claim or one taken over by another request raises batch_not_claimed.
-- Raises topic_not_confirmed / batch_exists / batch_not_claimed (P0409) or batch_size (P0422).
create function public.create_next_flashcard_batch(
  p_topic_id uuid, p_seq integer, p_cards jsonb, p_claimed_at timestamptz
)
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
  where b.topic_id = p_topic_id and b.seq = p_seq and b.user_id = v_user
  for update;
  if not found then
    raise exception 'batch_not_claimed' using errcode = 'P0409', hint = 'batch_not_claimed';
  end if;
  if v_status = 'ready' then
    raise exception 'batch_exists' using errcode = 'P0409', hint = 'batch_exists';
  end if;
  if p_claimed_at is null or v_claimed_at <> p_claimed_at then
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

revoke execute on function public.claim_next_flashcard_batch(uuid, integer) from public;
revoke execute on function public.release_next_flashcard_batch_claim(uuid, integer, timestamptz) from public;
revoke execute on function public.create_next_flashcard_batch(uuid, integer, jsonb, timestamptz) from public;
grant execute on function public.claim_next_flashcard_batch(uuid, integer) to authenticated;
grant execute on function public.release_next_flashcard_batch_claim(uuid, integer, timestamptz) to authenticated;
grant execute on function public.create_next_flashcard_batch(uuid, integer, jsonb, timestamptz) to authenticated;
