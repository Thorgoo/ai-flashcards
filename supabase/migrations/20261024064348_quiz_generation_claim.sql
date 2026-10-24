-- Quiz generation claim (impl-review F1-F4 of diagnostic-quiz-by-subtopic).
-- A quiz row is claimed as 'generating' before the AI call, so a reload or a second tab
-- waits for the running generation instead of starting (and paying for) another one. A
-- claim older than 90 s (longer than the 60 s AI timeout) is abandoned and may be taken
-- over. create_quiz fills the claim, or still creates the quiz without one, so the Worker
-- that predates this migration keeps working.
-- Error reasons now also travel in the hint, which the app matches on (not the message).

alter table public.quizzes
  add column status text not null default 'ready' check (status in ('generating', 'ready')),
  add column claimed_at timestamptz not null default now();

-- Read-only for `authenticated`, like ai_calls: the earlier revoke left truncate, references
-- and trigger in place.
revoke all on public.quizzes, public.quiz_questions from authenticated;
grant select on public.quizzes, public.quiz_questions to authenticated;

-- Claims the quiz of a confirmed topic before its AI call. Raises topic_not_confirmed,
-- quiz_exists or quiz_generating (P0409).
create function public.claim_quiz(p_topic_id uuid)
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

  -- A concurrent claim waits here for the other transaction and then sees its row.
  insert into public.quizzes (user_id, topic_id, status)
  values (v_user, p_topic_id, 'generating')
  on conflict (topic_id) do nothing;
  if found then
    return;
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

  update public.quizzes set claimed_at = now() where topic_id = p_topic_id;
end;
$$;

-- Drops the caller's unfinished claim after a failed AI call or save, so the quiz can be
-- started again at once.
create function public.release_quiz_claim(p_topic_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.quizzes
  where topic_id = p_topic_id and user_id = auth.uid() and status = 'generating';
$$;

-- Saves the 10 questions into the topic's claim and marks it ready, in one transaction
-- (FR-028). Without a claim it creates the quiz directly, as before.
-- Raises topic_not_confirmed / quiz_exists (P0409) or quiz_size (P0422).
create or replace function public.create_quiz(p_topic_id uuid, p_questions jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_quiz uuid;
  v_status text;
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

  select q.id, q.status into v_quiz, v_status
  from public.quizzes q
  where q.topic_id = p_topic_id
  for update;
  if v_status = 'ready' then
    raise exception 'quiz_exists' using errcode = 'P0409', hint = 'quiz_exists';
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

-- Unchanged apart from the hint on question_locked.
create or replace function public.answer_quiz_question(p_question_id uuid, p_answer smallint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_quiz uuid;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select q.quiz_id into v_quiz
  from public.quiz_questions q
  where q.id = p_question_id and q.user_id = v_user;
  if not found then
    raise exception 'question_locked' using errcode = 'P0409', hint = 'question_locked';
  end if;

  -- Serialize answers of one quiz, so the last two answers cannot both miss completion.
  perform 1 from public.quizzes z where z.id = v_quiz for update;

  update public.quiz_questions
  set answer = p_answer, answered_at = now()
  where id = p_question_id and answer is null;
  if not found then
    raise exception 'question_locked' using errcode = 'P0409', hint = 'question_locked';
  end if;

  if not exists (select 1 from public.quiz_questions q where q.quiz_id = v_quiz and q.answer is null) then
    update public.quizzes set completed_at = now() where id = v_quiz;
  end if;
end;
$$;
