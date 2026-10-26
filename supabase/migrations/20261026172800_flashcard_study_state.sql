-- Study state (S-05): every card gets its place in the schedule, and every answer is logged.
-- A card starts in the multiple-choice format ('choice'), due today; a correct A/B/C/D
-- answer moves it to the open format ('open', streak 0, due tomorrow), a wrong one leaves
-- it as it is. 'mastered' and mastered_at belong to S-06. "Today" is the Europe/Warsaw
-- calendar date, as in begin_ai_call. Existing cards get the state from the defaults, so
-- the migration only expands the schema.
-- Owners only read flashcard_answers; the state changes and the log grows only through
-- answer_flashcard_choice. The owner policies stay for every command as defence in depth
-- (and keep rls_guard's pattern), but the write privileges are revoked. The log outlives a
-- deleted card (flashcard_id becomes null) and goes with its topic.

alter table public.flashcards
  add column stage text not null default 'choice' check (stage in ('choice', 'open', 'mastered')),
  add column open_streak smallint not null default 0 check (open_streak between 0 and 1),
  add column due_on date not null default ((now() at time zone 'Europe/Warsaw')::date),
  add column mastered_at timestamptz;

-- The query for cards due in a topic.
create index flashcards_topic_id_stage_due_on_idx on public.flashcards (topic_id, stage, due_on);

-- id is the client's attempt id (no default): a retried request finds its own row.
create table public.flashcard_answers (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  topic_id uuid not null,
  flashcard_id uuid references public.flashcards (id) on delete set null,
  format text not null check (format in ('choice', 'open')),
  -- The chosen option of a 'choice' answer; null for 'open' answers (S-06).
  chosen_index smallint check (chosen_index between 0 and 3),
  correct boolean not null,
  answered_at timestamptz not null default now(),
  -- The Europe/Warsaw date of the answer, for per-day counts.
  answered_on date not null,
  foreign key (topic_id, user_id) references public.topics (id, user_id) on delete cascade
);

create index flashcard_answers_user_id_idx on public.flashcard_answers (user_id);
create index flashcard_answers_topic_id_answered_on_idx on public.flashcard_answers (topic_id, answered_on);
create index flashcard_answers_flashcard_id_idx on public.flashcard_answers (flashcard_id);

alter table public.flashcard_answers enable row level security;

create policy "owner can select" on public.flashcard_answers
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert" on public.flashcard_answers
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update" on public.flashcard_answers
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete" on public.flashcard_answers
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Default privileges grant `authenticated` everything; it may only read.
revoke all on public.flashcard_answers from authenticated;
grant select on public.flashcard_answers to authenticated;

-- Records the A/B/C/D answer p_answer (0-3) to the caller's card and applies the
-- transition: correct moves the card to 'open' (streak 0, due tomorrow), wrong changes
-- nothing. Correctness comes from the stored correct_index, not from the client.
-- p_attempt_id is the client's id of the click, reused on every retry: when the caller
-- already has an answer with this id, its stored result is returned and nothing changes
-- (correct_index, stage and due_on are null once the card is deleted). This check comes
-- before the stage/due check, which a retry after a lost response would otherwise fail.
-- Returns { correct, correct_index, stage, due_on }.
-- Raises flashcard_not_found / card_not_due (P0409) or validation_failed (P0422).
create function public.answer_flashcard_choice(p_flashcard_id uuid, p_answer smallint, p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_today date := (now() at time zone 'Europe/Warsaw')::date;
  v_topic uuid;
  v_correct_index smallint;
  v_stage text;
  v_due_on date;
  v_correct boolean;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select a.correct, f.correct_index, f.stage, f.due_on
  into v_correct, v_correct_index, v_stage, v_due_on
  from public.flashcard_answers a
  left join public.flashcards f on f.id = a.flashcard_id
  where a.id = p_attempt_id and a.user_id = v_user;
  if found then
    return jsonb_build_object('correct', v_correct, 'correct_index', v_correct_index, 'stage', v_stage, 'due_on', v_due_on);
  end if;

  -- FOR UPDATE serializes answers to one card, so two clicks cannot both apply.
  select f.topic_id, f.correct_index, f.stage, f.due_on
  into v_topic, v_correct_index, v_stage, v_due_on
  from public.flashcards f
  where f.id = p_flashcard_id and f.user_id = v_user
  for update;
  if not found then
    raise exception 'flashcard_not_found' using errcode = 'P0409', hint = 'flashcard_not_found';
  end if;

  -- A concurrent retry of the same attempt may have committed while this one waited for
  -- the lock; return its result instead of failing on the card it already moved.
  select a.correct, f.correct_index, f.stage, f.due_on
  into v_correct, v_correct_index, v_stage, v_due_on
  from public.flashcard_answers a
  left join public.flashcards f on f.id = a.flashcard_id
  where a.id = p_attempt_id and a.user_id = v_user;
  if found then
    return jsonb_build_object('correct', v_correct, 'correct_index', v_correct_index, 'stage', v_stage, 'due_on', v_due_on);
  end if;

  if v_stage <> 'choice' or v_due_on > v_today then
    raise exception 'card_not_due' using errcode = 'P0409', hint = 'card_not_due';
  end if;

  if p_answer is null or p_answer not between 0 and 3 then
    raise exception 'validation_failed' using errcode = 'P0422', hint = 'validation_failed';
  end if;

  v_correct := p_answer = v_correct_index;
  if v_correct then
    v_stage := 'open';
    v_due_on := v_today + 1;
    update public.flashcards
    set stage = v_stage, open_streak = 0, due_on = v_due_on
    where id = p_flashcard_id;
  end if;

  -- An attempt id taken by another account fails here on the primary key (23505).
  insert into public.flashcard_answers (
    id, user_id, topic_id, flashcard_id, format, chosen_index, correct, answered_on
  )
  values (p_attempt_id, v_user, v_topic, p_flashcard_id, 'choice', p_answer, v_correct, v_today);

  return jsonb_build_object('correct', v_correct, 'correct_index', v_correct_index, 'stage', v_stage, 'due_on', v_due_on);
end;
$$;

revoke execute on function public.answer_flashcard_choice(uuid, smallint, uuid) from public;
grant execute on function public.answer_flashcard_choice(uuid, smallint, uuid) to authenticated;
