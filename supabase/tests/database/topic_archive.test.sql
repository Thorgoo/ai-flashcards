-- Topic archive and home screen (migration topic_archive_and_overview): both statuses may
-- be renamed, a confirmed topic's scope note is frozen, archived_at is set only by the
-- trigger (now() on archive, first date kept, null on restore), accounts cannot delete
-- topics, and topic_overview() returns each topic with its due-card count and last study day.
begin;
create extension if not exists pgtap with schema extensions;

select plan(19);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'account-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'account-b@example.com');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

-- A confirmed topic and a draft.
insert into public.topics (id, name, scope_note)
values
  ('00000000-0000-0000-0000-0000000000a1', 'Kubernetes', 'Zakres A'),
  ('00000000-0000-0000-0000-0000000000a2', 'Spring', 'Zakres B');
insert into public.subtopics (id, topic_id, name, content_type, position)
values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'S1', 'conceptual', 0),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'S2', 'conceptual', 1);
update public.topics set status = 'confirmed' where id = '00000000-0000-0000-0000-0000000000a1';

-- Write rules: the name changes in both statuses, the scope note only in a draft.
select lives_ok(
  $$ update public.topics set name = 'Spring Boot' where id = '00000000-0000-0000-0000-0000000000a2' $$,
  'a draft topic can be renamed'
);
select lives_ok(
  $$ update public.topics set name = 'K8s' where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'a confirmed topic can be renamed'
);
select results_eq(
  $$ select id, name from public.topics order by id $$,
  $$ values ('00000000-0000-0000-0000-0000000000a1'::uuid, 'K8s'::text),
            ('00000000-0000-0000-0000-0000000000a2'::uuid, 'Spring Boot'::text) $$,
  'both new names are stored'
);
select throws_ok(
  $$ update public.topics set scope_note = 'Inny zakres' where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'P0409',
  'topic_not_editable',
  'the scope note of a confirmed topic cannot change'
);
select throws_ok(
  $$ update public.topics set scope_note = null where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'P0409',
  'topic_not_editable',
  'the scope note of a confirmed topic cannot be cleared'
);
select lives_ok(
  $$ update public.topics set scope_note = 'Nowy zakres' where id = '00000000-0000-0000-0000-0000000000a2' $$,
  'the scope note of a draft can change'
);
select is(
  (select scope_note from public.topics where id = '00000000-0000-0000-0000-0000000000a2'),
  'Nowy zakres',
  'the draft keeps its new scope note'
);

-- Archive: the trigger stores the date, never the client's value.
update public.topics set archived_at = '2000-01-01T00:00:00Z' where id = '00000000-0000-0000-0000-0000000000a1';
select is(
  (select archived_at from public.topics where id = '00000000-0000-0000-0000-0000000000a1'),
  now(),
  'archiving stores now(), not the date sent by the client'
);
update public.topics set archived_at = '2001-01-01T00:00:00Z' where id = '00000000-0000-0000-0000-0000000000a1';
select is(
  (select archived_at from public.topics where id = '00000000-0000-0000-0000-0000000000a1'),
  now(),
  'another date on an archived topic is ignored'
);

-- now() is constant within the test transaction, so an earlier archive date is set with the
-- trigger off; a later date sent by the client must not replace it (nor now()).
reset role;
alter table public.topics disable trigger topics_guard_status;
update public.topics set archived_at = '2000-01-01T00:00:00Z' where id = '00000000-0000-0000-0000-0000000000a2';
alter table public.topics enable trigger topics_guard_status;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

update public.topics set archived_at = '2001-01-01T00:00:00Z' where id = '00000000-0000-0000-0000-0000000000a2';
select is(
  (select archived_at from public.topics where id = '00000000-0000-0000-0000-0000000000a2'),
  '2000-01-01T00:00:00Z'::timestamptz,
  'an archived topic keeps its first archive date'
);

update public.topics set archived_at = null where id = '00000000-0000-0000-0000-0000000000a1';
select is(
  (select archived_at from public.topics where id = '00000000-0000-0000-0000-0000000000a1'),
  null::timestamptz,
  'restoring clears the archive date'
);

insert into public.topics (id, name, archived_at)
values ('00000000-0000-0000-0000-0000000000a3', 'Docker', '2000-01-01T00:00:00Z');
select is(
  (select archived_at from public.topics where id = '00000000-0000-0000-0000-0000000000a3'),
  null::timestamptz,
  'a new topic is never archived, whatever the client sends'
);

-- Archive replaces delete.
select throws_ok(
  $$ delete from public.topics where id = '00000000-0000-0000-0000-0000000000a3' $$,
  '42501',
  null,
  'an account cannot delete its topic'
);

-- topic_overview(): four cards of the confirmed topic — A open due yesterday, B choice due
-- today, C choice due tomorrow, D mastered due yesterday — and two answers to A.
-- Written as the owner role: study state changes only through the answer functions.
reset role;
select set_config('test.today', ((now() at time zone 'Europe/Warsaw')::date)::text, true);

insert into public.flashcard_batches (id, user_id, topic_id, seq, status)
values (
  '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000000a',
  '00000000-0000-0000-0000-0000000000a1', 1, 'ready'
);
insert into public.flashcards (
  id, user_id, topic_id, batch_id, subtopic_id, position, front, answer, options, correct_index, explanation,
  stage, due_on, mastered_at
)
values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 0, 'A', 'a',
   array['a', 'b', 'c', 'd'], 0, 'e', 'open', current_setting('test.today')::date - 1, null),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 1, 'B', 'b',
   array['a', 'b', 'c', 'd'], 0, 'e', 'choice', current_setting('test.today')::date, null),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c2', 2, 'C', 'c',
   array['a', 'b', 'c', 'd'], 0, 'e', 'choice', current_setting('test.today')::date + 1, null),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c2', 3, 'D', 'd',
   array['a', 'b', 'c', 'd'], 0, 'e', 'mastered', current_setting('test.today')::date - 1, now());
insert into public.flashcard_answers (id, user_id, topic_id, flashcard_id, format, chosen_index, correct, answered_on)
values
  ('00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-0000000000f1', 'choice', 0, true, current_setting('test.today')::date - 3),
  ('00000000-0000-0000-0000-000000000a02', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-0000000000f1', 'choice', 1, false, current_setting('test.today')::date - 1);

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select is(
  (select due_count from public.topic_overview() where id = '00000000-0000-0000-0000-0000000000a1'),
  2,
  'due_count counts choice and open cards due by today (A, B), not tomorrow''s (C) or mastered ones (D)'
);
select is(
  (select last_studied_on from public.topic_overview() where id = '00000000-0000-0000-0000-0000000000a1'),
  current_setting('test.today')::date - 1,
  'last_studied_on is the latest answer day of the topic'
);
select results_eq(
  $$ select id, due_count, last_studied_on, archived_at is not null from public.topic_overview()
     where id <> '00000000-0000-0000-0000-0000000000a1' order by id $$,
  $$ values ('00000000-0000-0000-0000-0000000000a2'::uuid, 0, null::date, true),
            ('00000000-0000-0000-0000-0000000000a3'::uuid, 0, null::date, false) $$,
  'drafts without cards have due_count 0 and no last study day; archived topics are listed too'
);

-- Another account sees none of A's topics.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

select is((select count(*) from public.topic_overview()), 0::bigint, 'account B sees none of A''s topics in topic_overview');

reset role;

select ok(
  not has_function_privilege('anon', 'public.topic_overview()', 'execute'),
  'anon cannot execute topic_overview'
);
select ok(
  has_function_privilege('authenticated', 'public.topic_overview()', 'execute'),
  'authenticated can execute topic_overview'
);

select * from finish();
rollback;
