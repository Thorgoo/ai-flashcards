-- Diagnostic quiz (S-03): one quiz per confirmed topic, 10 multiple-choice questions, each
-- tied to a subtopic of that topic. Per-subtopic results are computed from the answers
-- (quiz_results) and feed the weakest-subtopic choice in S-04.
-- Like ai_calls, owners only read these tables directly: writes go through create_quiz and
-- answer_quiz_question, so a question cannot be re-answered, replaced or deleted and a
-- topic cannot get a second quiz. The owner policies stay for every command as defence in
-- depth (and keep rls_guard's pattern), but the write privileges are revoked.

-- Target of the quiz_questions (subtopic_id, topic_id) foreign key; id is already unique.
alter table public.subtopics add constraint subtopics_id_topic_id_key unique (id, topic_id);

create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  topic_id uuid not null unique,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  -- Targets of the quiz_questions foreign keys.
  unique (id, user_id),
  unique (id, topic_id),
  foreign key (topic_id, user_id) references public.topics (id, user_id) on delete cascade
);

create index quizzes_user_id_idx on public.quizzes (user_id);

alter table public.quizzes enable row level security;

create policy "owner can select" on public.quizzes
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert" on public.quizzes
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update" on public.quizzes
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete" on public.quizzes
  for delete to authenticated using ((select auth.uid()) = user_id);

create table public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  quiz_id uuid not null,
  topic_id uuid not null,
  subtopic_id uuid not null,
  position smallint not null check (position between 0 and 9),
  prompt text not null check (char_length(btrim(prompt)) >= 1 and char_length(prompt) <= 500),
  options text[] not null check (
    cardinality(options) = 4
    and char_length(btrim(options[1])) between 1 and 200
    and char_length(btrim(options[2])) between 1 and 200
    and char_length(btrim(options[3])) between 1 and 200
    and char_length(btrim(options[4])) between 1 and 200
  ),
  correct_index smallint not null check (correct_index between 0 and 3),
  -- null: not answered yet; 0-3: chosen option; -1: "I don't know".
  answer smallint check (answer between -1 and 3),
  answered_at timestamptz,
  unique (quiz_id, position),
  foreign key (quiz_id, user_id) references public.quizzes (id, user_id) on delete cascade,
  -- The question's subtopic belongs to the quiz's own topic: both pairs must match.
  foreign key (quiz_id, topic_id) references public.quizzes (id, topic_id) on delete cascade,
  foreign key (subtopic_id, topic_id) references public.subtopics (id, topic_id) on delete cascade
);

create index quiz_questions_user_id_idx on public.quiz_questions (user_id);
create index quiz_questions_subtopic_id_idx on public.quiz_questions (subtopic_id);

alter table public.quiz_questions enable row level security;

create policy "owner can select" on public.quiz_questions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert" on public.quiz_questions
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update" on public.quiz_questions
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete" on public.quiz_questions
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Default privileges grant `authenticated` everything; it may only read.
revoke insert, update, delete on public.quizzes, public.quiz_questions from authenticated;

-- Creates the quiz of a confirmed topic with exactly 10 questions in one transaction
-- (FR-028). Each element: { subtopic_id, prompt, options: [4 strings], correct_index }.
-- Raises topic_not_confirmed / quiz_exists (P0409) or quiz_size (P0422).
create function public.create_quiz(p_topic_id uuid, p_questions jsonb)
returns uuid
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

  -- FOR SHARE keeps the topic confirmed (and its subtopics fixed) until the quiz is saved.
  perform 1 from public.topics t
  where t.id = p_topic_id and t.user_id = v_user and t.status = 'confirmed'
  for share;
  if not found then
    raise exception 'topic_not_confirmed' using errcode = 'P0409';
  end if;

  if exists (select 1 from public.quizzes q where q.topic_id = p_topic_id) then
    raise exception 'quiz_exists' using errcode = 'P0409';
  end if;

  if jsonb_typeof(p_questions) is distinct from 'array' then
    raise exception 'quiz_size' using errcode = 'P0422';
  end if;
  if jsonb_array_length(p_questions) <> 10 then
    raise exception 'quiz_size' using errcode = 'P0422';
  end if;

  insert into public.quizzes (user_id, topic_id) values (v_user, p_topic_id) returning id into v_quiz;

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

-- Records the answer to one question of the caller's quiz: 0-3 or -1 ("I don't know").
-- An answer is final; answering again, or another account's question, raises
-- question_locked (P0409). The last answer marks the quiz completed.
create function public.answer_quiz_question(p_question_id uuid, p_answer smallint)
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
    raise exception 'question_locked' using errcode = 'P0409';
  end if;

  -- Serialize answers of one quiz, so the last two answers cannot both miss completion.
  perform 1 from public.quizzes z where z.id = v_quiz for update;

  update public.quiz_questions
  set answer = p_answer, answered_at = now()
  where id = p_question_id and answer is null;
  if not found then
    raise exception 'question_locked' using errcode = 'P0409';
  end if;

  if not exists (select 1 from public.quiz_questions q where q.quiz_id = v_quiz and q.answer is null) then
    update public.quizzes set completed_at = now() where id = v_quiz;
  end if;
end;
$$;

-- Per-subtopic result of a quiz, computed from its answers: the single source for the
-- result screen and for choosing the weakest subtopics (S-04). Runs with the caller's
-- rights, so another account's quiz returns no rows.
create function public.quiz_results(p_quiz_id uuid)
returns table (
  subtopic_id uuid,
  name text,
  content_type text,
  "position" integer,
  asked integer,
  correct integer,
  dont_know integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    s.id,
    s.name,
    s.content_type,
    s.position,
    count(*)::integer,
    count(*) filter (where q.answer = q.correct_index)::integer,
    count(*) filter (where q.answer = -1)::integer
  from public.quiz_questions q
  join public.subtopics s on s.id = q.subtopic_id
  where q.quiz_id = p_quiz_id
  group by s.id, s.name, s.content_type, s.position
  order by s.position;
$$;
