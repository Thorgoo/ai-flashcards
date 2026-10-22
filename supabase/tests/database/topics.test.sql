-- Topic lifecycle (migration create_topics_and_subtopics): a draft's subtopic list is
-- replaced atomically, confirmation needs 2-10 subtopics and locks the list for good,
-- and subtopics can never be attached to another account's topic.
begin;
create extension if not exists pgtap with schema extensions;

select plan(24);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'account-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'account-b@example.com');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

insert into public.topics (id, name)
values
  ('00000000-0000-0000-0000-0000000000a1', 'Kubernetes'),
  ('00000000-0000-0000-0000-0000000000a2', 'Spring'),
  ('00000000-0000-0000-0000-0000000000a3', 'Docker');

-- Replacing the list.
select results_eq(
  $$ select name, position from public.replace_subtopics(
       '00000000-0000-0000-0000-0000000000a1',
       '[{"name": "Pody", "content_type": "conceptual"},
         {"name": "Serwisy", "content_type": "conceptual"},
         {"name": "Wolumeny", "content_type": "conceptual"}]') $$,
  $$ values ('Pody', 0), ('Serwisy', 1), ('Wolumeny', 2) $$,
  'replace_subtopics stores the list in order with positions 0..n-1'
);

select public.replace_subtopics(
  '00000000-0000-0000-0000-0000000000a1',
  '[{"name": "Pody", "content_type": "conceptual"}, {"name": "Ingress", "content_type": "conceptual"}]'
);
select results_eq(
  $$ select name from public.subtopics where topic_id = '00000000-0000-0000-0000-0000000000a1' order by position $$,
  $$ values ('Pody'), ('Ingress') $$,
  'replace_subtopics replaces the whole previous list'
);

select throws_ok(
  $$ select public.replace_subtopics('00000000-0000-0000-0000-0000000000a1', '[]') $$,
  'P0422',
  'subtopic_count',
  'an empty list is refused'
);
select throws_ok(
  $$ select public.replace_subtopics(
       '00000000-0000-0000-0000-0000000000a1',
       (select jsonb_agg(jsonb_build_object('name', 's' || i, 'content_type', 'conceptual'))
        from generate_series(1, 11) as i)) $$,
  'P0422',
  'subtopic_count',
  'a list of 11 is refused'
);
select throws_ok(
  $$ select public.replace_subtopics(
       '00000000-0000-0000-0000-0000000000a1',
       '[{"name": "Nowy", "content_type": "conceptual"}, {"name": "Zły", "content_type": "poem"}]') $$,
  '23514',
  null,
  'an invalid content type is refused'
);
select is(
  (select string_agg(name, ',' order by position) from public.subtopics
   where topic_id = '00000000-0000-0000-0000-0000000000a1'),
  'Pody,Ingress',
  'a failed replace leaves the previous list untouched'
);
select throws_ok(
  $$ insert into public.subtopics (topic_id, name, content_type, position)
     values ('00000000-0000-0000-0000-0000000000a1', 'PODY', 'vocabulary', 2) $$,
  '23505',
  null,
  'subtopic names are unique per topic, ignoring case'
);

-- Confirmation.
select throws_ok(
  $$ insert into public.topics (name, status) values ('Skrót', 'confirmed') $$,
  'P0409',
  null,
  'a topic cannot be created already confirmed'
);

select public.replace_subtopics('00000000-0000-0000-0000-0000000000a2', '[{"name": "Beany", "content_type": "conceptual"}]');
select throws_ok(
  $$ update public.topics set status = 'confirmed' where id = '00000000-0000-0000-0000-0000000000a2' $$,
  'P0422',
  'subtopic_count',
  'confirming with 1 subtopic is refused'
);

insert into public.subtopics (topic_id, name, content_type, position)
select '00000000-0000-0000-0000-0000000000a3', 's' || i, 'conceptual', i
from generate_series(1, 11) as i;
select throws_ok(
  $$ update public.topics set status = 'confirmed' where id = '00000000-0000-0000-0000-0000000000a3' $$,
  'P0422',
  'subtopic_count',
  'confirming with 11 subtopics is refused'
);

select lives_ok(
  $$ update public.topics set status = 'confirmed' where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'confirming with 2 subtopics succeeds'
);
select isnt(
  (select confirmed_at from public.topics where id = '00000000-0000-0000-0000-0000000000a1'),
  null,
  'confirmation records confirmed_at'
);
select throws_ok(
  $$ update public.topics set status = 'draft' where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'P0409',
  'topic_not_editable',
  'a confirmed topic cannot go back to draft'
);

-- The confirmed list is locked.
select throws_ok(
  $$ select public.replace_subtopics(
       '00000000-0000-0000-0000-0000000000a1', '[{"name": "Nowy", "content_type": "conceptual"}]') $$,
  'P0409',
  'topic_not_editable',
  'replace_subtopics refuses a confirmed topic'
);
select throws_ok(
  $$ insert into public.subtopics (topic_id, name, content_type, position)
     values ('00000000-0000-0000-0000-0000000000a1', 'Nowy', 'conceptual', 2) $$,
  'P0409',
  'topic_not_editable',
  'a subtopic cannot be added to a confirmed topic'
);
update public.subtopics set name = 'Zmieniony' where topic_id = '00000000-0000-0000-0000-0000000000a1';
delete from public.subtopics where topic_id = '00000000-0000-0000-0000-0000000000a1';
select is(
  (select string_agg(name, ',' order by position) from public.subtopics
   where topic_id = '00000000-0000-0000-0000-0000000000a1'),
  'Pody,Ingress',
  'subtopics of a confirmed topic cannot be renamed or deleted'
);

-- Another account.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

select throws_ok(
  $$ select public.replace_subtopics(
       '00000000-0000-0000-0000-0000000000a2', '[{"name": "Obcy", "content_type": "conceptual"}]') $$,
  'P0409',
  'topic_not_editable',
  'replace_subtopics refuses another account''s topic'
);

-- Even bypassing RLS, a subtopic cannot point at another account's topic.
reset role;

select throws_ok(
  $$ insert into public.subtopics (user_id, topic_id, name, content_type, position)
     values ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000a2', 'Obcy', 'conceptual', 1) $$,
  '23503',
  null,
  'a subtopic cannot belong to a different account than its topic'
);
select is(
  (select string_agg(name, ',' order by position) from public.subtopics
   where topic_id = '00000000-0000-0000-0000-0000000000a2'),
  'Beany',
  'another account cannot change the draft list'
);

select ok(
  not has_function_privilege('anon', 'public.replace_subtopics(uuid, jsonb)', 'execute'),
  'anon cannot execute replace_subtopics'
);
select ok(
  has_function_privilege('authenticated', 'public.replace_subtopics(uuid, jsonb)', 'execute'),
  'authenticated can execute replace_subtopics'
);

-- The lock holds without RLS too (migration lock_subtopic_writes_on_topic), and deleting a
-- confirmed topic still cascades to its subtopics.
select throws_ok(
  $$ insert into public.subtopics (user_id, topic_id, name, content_type, position)
     values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'Obejście', 'conceptual', 2) $$,
  'P0409',
  'topic_not_editable',
  'a confirmed topic rejects new subtopics even without RLS'
);
select throws_ok(
  $$ delete from public.subtopics where topic_id = '00000000-0000-0000-0000-0000000000a1' $$,
  'P0409',
  'topic_not_editable',
  'a confirmed topic keeps its subtopics even without RLS'
);
select lives_ok(
  $$ delete from public.topics where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'deleting a confirmed topic cascades to its subtopics'
);

select * from finish();
rollback;
