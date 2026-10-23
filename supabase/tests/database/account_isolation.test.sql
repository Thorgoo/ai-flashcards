-- Canonical "row belongs to an account" pattern, proven with two accounts.
-- Every table in `public` follows the shape of `isolation_probe` below; when a slice
-- adds a table, append the same "B cannot see or change A's rows" assertions for it.
begin;
create extension if not exists pgtap with schema extensions;

select plan(27);

-- Two accounts (email sign-up is disabled, so users are inserted directly).
insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'account-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'account-b@example.com');

-- The pattern: owner column defaulting to the caller, RLS on, one policy per command.
create table public.isolation_probe (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  note text not null
);

alter table public.isolation_probe enable row level security;

create policy "owner can select" on public.isolation_probe
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert" on public.isolation_probe
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update" on public.isolation_probe
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete" on public.isolation_probe
  for delete to authenticated using ((select auth.uid()) = user_id);

-- A function in `public`, to check function privileges from the migration.
create function public.isolation_probe_fn() returns int language sql as $$ select 1 $$;

-- Account A writes a row without naming the owner.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

insert into public.isolation_probe (note) values ('a-original');
insert into public.topics (id, name) values ('00000000-0000-0000-0000-0000000000a1', 'a-topic');
insert into public.subtopics (topic_id, name, content_type, position)
values ('00000000-0000-0000-0000-0000000000a1', 'a-subtopic', 'conceptual', 0);
-- A confirmed topic with a quiz (writes go through create_quiz only).
insert into public.topics (id, name) values ('00000000-0000-0000-0000-0000000000a2', 'a-quiz-topic');
insert into public.subtopics (id, topic_id, name, content_type, position)
values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a2', 'a-s1', 'conceptual', 0),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2', 'a-s2', 'conceptual', 1);
update public.topics set status = 'confirmed' where id = '00000000-0000-0000-0000-0000000000a2';
select public.create_quiz(
  '00000000-0000-0000-0000-0000000000a2',
  (select jsonb_agg(jsonb_build_object(
     'subtopic_id', case when i % 2 = 0 then '00000000-0000-0000-0000-0000000000c1' else '00000000-0000-0000-0000-0000000000c2' end,
     'prompt', 'q' || i, 'options', jsonb_build_array('a', 'b', 'c', 'd'), 'correct_index', 0))
   from generate_series(0, 9) as i)
);

select is(
  (select user_id from public.isolation_probe),
  '00000000-0000-0000-0000-00000000000a'::uuid,
  'user_id defaults to the signed-in account'
);
select is((select count(*) from public.isolation_probe), 1::bigint, 'account A sees its own row');
select lives_ok($$ select public.isolation_probe_fn() $$, 'authenticated can execute public functions');
select is(
  (select count(*) from public.begin_ai_call('grading', 'isolation', 'test-model')),
  1::bigint,
  'account A records an AI call'
);

-- Account B cannot see, change, remove or forge A's rows.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

select is((select count(*) from public.isolation_probe), 0::bigint, 'account B sees none of A''s rows');
select is((select count(*) from public.ai_calls), 0::bigint, 'account B sees none of A''s AI calls');
select is((select count(*) from public.topics), 0::bigint, 'account B sees none of A''s topics');
select is((select count(*) from public.subtopics), 0::bigint, 'account B sees none of A''s subtopics');
select lives_ok($$ update public.topics set name = 'b-was-here' $$, 'account B topic update runs without error');
select lives_ok($$ delete from public.topics $$, 'account B topic delete runs without error');
select lives_ok($$ update public.subtopics set name = 'b-was-here' $$, 'account B subtopic update runs without error');
select lives_ok($$ delete from public.subtopics $$, 'account B subtopic delete runs without error');
select throws_ok(
  $$ insert into public.topics (user_id, name) values ('00000000-0000-0000-0000-00000000000a', 'forged') $$,
  '42501',
  null,
  'account B cannot insert a topic owned by A'
);
select throws_ok(
  $$ insert into public.subtopics (topic_id, name, content_type, position)
     values ('00000000-0000-0000-0000-0000000000a1', 'forged', 'conceptual', 1) $$,
  '42501',
  null,
  'account B cannot add a subtopic to A''s topic'
);
select is((select count(*) from public.quizzes), 0::bigint, 'account B sees none of A''s quizzes');
select is((select count(*) from public.quiz_questions), 0::bigint, 'account B sees none of A''s quiz questions');
select throws_ok(
  $$ update public.quiz_questions set answer = 0 $$,
  '42501',
  null,
  'account B cannot write quiz answers directly'
);
select throws_ok($$ delete from public.quizzes $$, '42501', null, 'account B cannot delete quizzes directly');
select throws_ok(
  $$ insert into public.quizzes (user_id, topic_id)
     values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2') $$,
  '42501',
  null,
  'account B cannot insert a quiz owned by A'
);
select lives_ok(
  $$ update public.isolation_probe set note = 'b-was-here' $$,
  'account B update runs without error'
);
select lives_ok(
  $$ delete from public.isolation_probe $$,
  'account B delete runs without error'
);
select throws_ok(
  $$ insert into public.isolation_probe (user_id, note) values ('00000000-0000-0000-0000-00000000000a', 'forged') $$,
  '42501',
  null,
  'account B cannot insert a row owned by A'
);

-- Back as A: the row survived B's update and delete untouched.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select results_eq(
  $$ select note from public.isolation_probe $$,
  $$ values ('a-original') $$,
  'account A row is unchanged after account B update and delete'
);
select results_eq(
  $$ select t.name || '/' || s.name from public.topics t join public.subtopics s on s.topic_id = t.id $$,
  $$ values ('a-topic/a-subtopic') $$,
  'account A topic and subtopic are unchanged after account B update and delete'
);
select is(
  (select count(*) from public.quiz_questions q join public.quizzes z on z.id = q.quiz_id where q.answer is null),
  10::bigint,
  'account A quiz is unchanged after account B'
);

-- Anonymous callers have no privileges on app tables at all (migration revoke_anon_default_privileges).
reset role;
set local role anon;

select throws_ok(
  $$ select * from public.isolation_probe $$,
  '42501',
  null,
  'anon has no access to account tables'
);
select throws_ok(
  $$ select public.isolation_probe_fn() $$,
  '42501',
  null,
  'anon cannot execute public functions'
);

select * from finish();
rollback;
