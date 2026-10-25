-- Flashcards (S-04): the first batch of 10 cards of a confirmed topic whose diagnostic quiz
-- is completed, spread over its subtopics by weakness. A batch is claimed as 'generating'
-- before the AI call (like claim_quiz), then filled with all 10 cards in one transaction.
-- seq numbers batches per topic; these functions only handle batch 1 (later ones: S-07).
-- Owners read both tables directly and may delete a card (FR-012); every other write goes
-- through the functions below. The owner policies stay for every command as defence in
-- depth (and keep rls_guard's pattern), but the write privileges are revoked.

create table public.flashcard_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  topic_id uuid not null,
  seq integer not null check (seq >= 1),
  status text not null default 'generating' check (status in ('generating', 'ready')),
  claimed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (topic_id, seq),
  -- Target of the flashcards (batch_id, topic_id) foreign key.
  unique (id, topic_id),
  foreign key (topic_id, user_id) references public.topics (id, user_id) on delete cascade
);

create index flashcard_batches_user_id_idx on public.flashcard_batches (user_id);

alter table public.flashcard_batches enable row level security;

create policy "owner can select" on public.flashcard_batches
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert" on public.flashcard_batches
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update" on public.flashcard_batches
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete" on public.flashcard_batches
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Length limits match the zod schema of the flashcards AI task (flashcards-task.ts).
create table public.flashcards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  topic_id uuid not null,
  batch_id uuid not null,
  subtopic_id uuid not null,
  position integer not null check (position between 0 and 9),
  front text not null check (char_length(btrim(front)) >= 1 and char_length(front) <= 300),
  answer text not null check (char_length(btrim(answer)) >= 1 and char_length(answer) <= 600),
  options text[] not null check (
    cardinality(options) = 4
    and char_length(btrim(options[1])) between 1 and 200
    and char_length(btrim(options[2])) between 1 and 200
    and char_length(btrim(options[3])) between 1 and 200
    and char_length(btrim(options[4])) between 1 and 200
  ),
  correct_index smallint not null check (correct_index between 0 and 3),
  explanation text not null check (char_length(btrim(explanation)) >= 1 and char_length(explanation) <= 1500),
  -- Example sentence of a vocabulary card; null for conceptual cards.
  example text check (char_length(btrim(example)) >= 1 and char_length(example) <= 300),
  created_at timestamptz not null default now(),
  -- unique (batch_id, position) also serves lookups by batch_id.
  unique (batch_id, position),
  -- The card's batch and subtopic belong to its own topic, and the topic to its owner.
  foreign key (batch_id, topic_id) references public.flashcard_batches (id, topic_id) on delete cascade,
  foreign key (subtopic_id, topic_id) references public.subtopics (id, topic_id) on delete cascade,
  foreign key (topic_id, user_id) references public.topics (id, user_id) on delete cascade
);

create index flashcards_user_id_idx on public.flashcards (user_id);
create index flashcards_subtopic_id_idx on public.flashcards (subtopic_id);

alter table public.flashcards enable row level security;

create policy "owner can select" on public.flashcards
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert" on public.flashcards
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update" on public.flashcards
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete" on public.flashcards
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Default privileges grant `authenticated` everything; it may only read, and delete a card.
revoke all on public.flashcard_batches, public.flashcards from authenticated;
grant select on public.flashcard_batches, public.flashcards to authenticated;
grant delete on public.flashcards to authenticated;

-- Claims batch 1 of a confirmed topic with a completed quiz before its AI call; both are
-- checked again here, under the topic lock, because they may have changed since the API
-- read them. A claim older than 120 s (longer than the 90 s AI timeout) is abandoned and
-- taken over. Keep 120 in sync with FLASHCARD_CLAIM_TTL_SECONDS in
-- src/lib/topics/flashcards-task.ts.
-- Raises topic_not_confirmed, quiz_not_completed, batch_exists or batch_generating (P0409).
create function public.claim_flashcard_batch(p_topic_id uuid)
returns void
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
  on conflict (topic_id, seq) do nothing;
  if found then
    return;
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

  update public.flashcard_batches set claimed_at = now() where topic_id = p_topic_id and seq = 1;
end;
$$;

-- Drops the caller's unfinished claim of batch 1 after a failed AI call or save, so the
-- batch can be started again at once. A ready batch is never removed.
create function public.release_flashcard_batch_claim(p_topic_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.flashcard_batches
  where topic_id = p_topic_id and seq = 1 and user_id = auth.uid() and status = 'generating';
$$;

-- Saves the 10 cards into the caller's claim of batch 1 and marks it ready, in one
-- transaction (FR-028). Each element: { subtopic_id, front, answer, options: [4 strings],
-- correct_index, explanation, example (string or null) }.
-- Raises topic_not_confirmed / batch_exists / batch_not_claimed (P0409) or batch_size (P0422).
create function public.create_flashcard_batch(p_topic_id uuid, p_cards jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_batch uuid;
  v_status text;
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

  select b.id, b.status into v_batch, v_status
  from public.flashcard_batches b
  where b.topic_id = p_topic_id and b.seq = 1 and b.user_id = v_user
  for update;
  if not found then
    raise exception 'batch_not_claimed' using errcode = 'P0409', hint = 'batch_not_claimed';
  end if;
  if v_status = 'ready' then
    raise exception 'batch_exists' using errcode = 'P0409', hint = 'batch_exists';
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

revoke execute on function public.claim_flashcard_batch(uuid) from public;
revoke execute on function public.release_flashcard_batch_claim(uuid) from public;
revoke execute on function public.create_flashcard_batch(uuid, jsonb) from public;
grant execute on function public.claim_flashcard_batch(uuid) to authenticated;
grant execute on function public.release_flashcard_batch_claim(uuid) to authenticated;
grant execute on function public.create_flashcard_batch(uuid, jsonb) to authenticated;
