-- Badges (migration badges): sync_badges, called from triggers, awards streak badges (3, 7,
-- 30, 100 days), mastered-card badges (10, 50, 100, 250, from the historical per-topic
-- tally summed over active topics) and one badge per mastered topic; a badge is never taken
-- away. Cards, answers and the tally fixture are written as the owner role (study state
-- changes only through the answer functions); every day is relative to today in
-- Europe/Warsaw, so the test does not depend on the day it runs.
begin;
create extension if not exists pgtap with schema extensions;

select plan(30);

select set_config('test.today', ((now() at time zone 'Europe/Warsaw')::date)::text, true);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'account-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'account-b@example.com');

-- Three confirmed topics of account A, two subtopics each.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

insert into public.topics (id, name)
values
  ('00000000-0000-0000-0000-0000000000a1', 'Kubernetes'),
  ('00000000-0000-0000-0000-0000000000a2', 'Spring'),
  ('00000000-0000-0000-0000-0000000000a3', 'Docker');
insert into public.subtopics (id, topic_id, name, content_type, position)
values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'S1', 'conceptual', 0),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'S2', 'conceptual', 1),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a2', 'S3', 'conceptual', 0),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a2', 'S4', 'conceptual', 1),
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000a3', 'S5', 'conceptual', 0),
  ('00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-0000000000a3', 'S6', 'conceptual', 1);
update public.topics set status = 'confirmed';

-- Cards, all open at 1/2 and due today: Kubernetes 10 (S1: 0-4, S2: 5-9), Spring 5
-- (S3: 0-2, S4: 3-4), Docker 1 (S5 only; S6 has no cards).
reset role;
insert into public.flashcard_batches (id, user_id, topic_id, seq, status)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 1, 'ready'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 1, 'ready'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3', 1, 'ready');
insert into public.flashcards (
  user_id, topic_id, batch_id, subtopic_id, position, front, answer, options, correct_index, explanation,
  stage, open_streak, due_on
)
select
  '00000000-0000-0000-0000-00000000000a', v.topic_id::uuid, v.batch_id::uuid, v.subtopic_id::uuid, v.pos,
  'F' || v.pos, 'A', array['a', 'b', 'c', 'd'], 0, 'E', 'open', 1, current_setting('test.today')::date
from (
  select '00000000-0000-0000-0000-0000000000a1' as topic_id, '00000000-0000-0000-0000-0000000000d1' as batch_id,
    case when i < 5 then '00000000-0000-0000-0000-0000000000c1' else '00000000-0000-0000-0000-0000000000c2' end as subtopic_id,
    i as pos
  from generate_series(0, 9) as i
  union all
  select '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000d2',
    case when i < 3 then '00000000-0000-0000-0000-0000000000c3' else '00000000-0000-0000-0000-0000000000c4' end,
    i
  from generate_series(0, 4) as i
  union all
  select '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000d3',
    '00000000-0000-0000-0000-0000000000c5', 0
) as v;

-- Streak: answers on today-2 and today-1 (a 2-day streak), then one today.
insert into public.flashcard_answers (id, user_id, topic_id, format, chosen_index, correct, answered_on)
values
  ('00000000-0000-0000-0000-000000000f01', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
   'choice', 0, true, current_setting('test.today')::date - 2),
  ('00000000-0000-0000-0000-000000000f02', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
   'choice', 0, true, current_setting('test.today')::date - 1);
insert into public.flashcard_answers (id, user_id, topic_id, format, chosen_index, correct, answered_on)
values (
  '00000000-0000-0000-0000-000000000f03', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
  'choice', 0, true, current_setting('test.today')::date
);

select results_eq(
  $$ select kind, threshold, attempt_id from public.badges $$,
  $$ values ('streak'::text, 3, '00000000-0000-0000-0000-000000000f03'::uuid) $$,
  'a 3-day streak earns the 3-day badge (not 7) with the attempt of the answer that reached it'
);

insert into public.flashcard_answers (id, user_id, topic_id, format, chosen_index, correct, answered_on)
values (
  '00000000-0000-0000-0000-000000000f04', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
  'choice', 0, true, current_setting('test.today')::date
);

select is((select count(*) from public.badges), 1::bigint, 'another answer the same day adds no badge');

-- Mastered cards: 9 Kubernetes cards move to 'mastered'.
update public.flashcards set stage = 'mastered', mastered_at = now()
where topic_id = '00000000-0000-0000-0000-0000000000a1' and position <= 8;

select is(
  (select mastered_count from public.topic_mastery_tallies where topic_id = '00000000-0000-0000-0000-0000000000a1'),
  9,
  'each card moved to mastered adds one to its topic''s tally'
);

update public.flashcards set stage = 'mastered'
where topic_id = '00000000-0000-0000-0000-0000000000a1' and stage = 'mastered';

select is(
  (select mastered_count from public.topic_mastery_tallies where topic_id = '00000000-0000-0000-0000-0000000000a1'),
  9,
  'updating an already mastered card does not count it again'
);

-- The second correct open answer to the last Kubernetes card.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select public.answer_flashcard_open(
  (select id from public.flashcards where topic_id = '00000000-0000-0000-0000-0000000000a1' and position = 9),
  '00000000-0000-0000-0000-000000000e01', 'Odpowiedź', true, 'Trafnie.'
);

select is(
  (select mastered_count from public.topic_mastery_tallies where topic_id = '00000000-0000-0000-0000-0000000000a1'),
  10,
  'the second correct open answer adds one to the tally'
);
select results_eq(
  $$ select threshold, attempt_id from public.badges where kind = 'mastered_cards' $$,
  $$ values (10, '00000000-0000-0000-0000-000000000e01'::uuid) $$,
  'the 10th mastered card earns the 10-card badge with the attempt of that answer'
);
select results_eq(
  $$ select topic_id, attempt_id from public.badges where kind = 'topic' $$,
  $$ values ('00000000-0000-0000-0000-0000000000a1'::uuid, '00000000-0000-0000-0000-000000000e01'::uuid) $$,
  'the answer that masters the last card of every subtopic earns the topic badge'
);

delete from public.flashcards where topic_id = '00000000-0000-0000-0000-0000000000a1' and position = 0;

select is(
  (select mastered_count from public.topic_mastery_tallies where topic_id = '00000000-0000-0000-0000-0000000000a1'),
  10,
  'deleting a mastered card does not lower the tally'
);

-- Spring: 4 of 5 cards mastered (S4 keeps one open card).
reset role;
update public.flashcards set stage = 'mastered', mastered_at = now()
where topic_id = '00000000-0000-0000-0000-0000000000a2' and position <= 3;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select is((select mastered_cards from public.badge_overview()), 14, 'progress is the tally sum over active topics');

-- Archive: Kubernetes leaves the sum and the streak; the badges stay.
update public.topics set archived_at = now() where id = '00000000-0000-0000-0000-0000000000a1';

select is((select mastered_cards from public.badge_overview()), 4, 'archiving a topic lowers the progress');
select results_eq(
  $$ select streak_days, jsonb_array_length(badges) from public.badge_overview() $$,
  $$ values (0, 3) $$,
  'archiving breaks the streak, but all three badges stay'
);
select results_eq(
  $$ select b ->> 'topic_name', (b ->> 'topic_archived')::boolean
     from public.badge_overview() o cross join jsonb_array_elements(o.badges) b
     where b ->> 'kind' = 'topic' $$,
  $$ values ('Kubernetes'::text, true) $$,
  'the topic badge is listed with its name and marked archived'
);

-- Answers on today-3 .. today-6 in the archived topic do not count yet.
reset role;
insert into public.flashcard_answers (id, user_id, topic_id, format, chosen_index, correct, answered_on)
select gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
  'choice', 0, true, current_setting('test.today')::date - n
from unnest(array[3, 4, 5, 6]) n;

select is(
  (select count(*) from public.badges where kind = 'streak' and threshold = 7),
  0::bigint,
  'answers in an archived topic earn no streak badge'
);

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
update public.topics set archived_at = null where id = '00000000-0000-0000-0000-0000000000a1';

select is((select mastered_cards from public.badge_overview()), 14, 'restoring the topic gives the progress back');
select results_eq(
  $$ select threshold, attempt_id from public.badges where kind = 'streak' order by threshold $$,
  $$ values (3, '00000000-0000-0000-0000-000000000f03'::uuid), (7, null::uuid) $$,
  'restoring the topic brings a 7-day streak back and earns its badge, without an attempt'
);

-- Spring: an answer while one S4 card is open earns nothing; deleting that card masters it.
reset role;
insert into public.flashcard_answers (id, user_id, topic_id, format, chosen_index, correct, answered_on)
values (
  gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2',
  'choice', 0, true, current_setting('test.today')::date
);

select is(
  (select count(*) from public.badges where topic_id = '00000000-0000-0000-0000-0000000000a2'),
  0::bigint,
  'a topic with an unmastered card earns no topic badge'
);

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
delete from public.flashcards where topic_id = '00000000-0000-0000-0000-0000000000a2' and position = 4;

select results_eq(
  $$ select topic_id, attempt_id from public.badges where kind = 'topic' and topic_id = '00000000-0000-0000-0000-0000000000a2' $$,
  $$ values ('00000000-0000-0000-0000-0000000000a2'::uuid, null::uuid) $$,
  'deleting the last unmastered card earns the topic badge, without an attempt'
);

-- Docker: its only card is mastered, but S6 has no cards.
reset role;
update public.flashcards set stage = 'mastered', mastered_at = now()
where topic_id = '00000000-0000-0000-0000-0000000000a3';
insert into public.flashcard_answers (id, user_id, topic_id, format, chosen_index, correct, answered_on)
values (
  gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3',
  'choice', 0, true, current_setting('test.today')::date
);

select is(
  (select count(*) from public.badges where topic_id = '00000000-0000-0000-0000-0000000000a3'),
  0::bigint,
  'a subtopic without cards blocks the topic badge'
);

-- Writes go through sync_badges only, and it is not callable by accounts.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select throws_ok(
  $$ insert into public.badges (kind, threshold) values ('streak', 100) $$,
  '42501',
  null,
  'an account cannot award itself a badge'
);
select throws_ok(
  $$ update public.topic_mastery_tallies set mastered_count = 999 $$,
  '42501',
  null,
  'an account cannot change its tally'
);
select throws_ok(
  $$ select public.sync_badges('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', null) $$,
  '42501',
  null,
  'authenticated cannot execute sync_badges'
);
select throws_ok(
  $$ select * from public.study_streak_of('00000000-0000-0000-0000-00000000000b') $$,
  '42501',
  null,
  'authenticated cannot execute study_streak_of'
);

-- Account B sees none of A's badges or tallies and cannot forge them.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

select is((select count(*) from public.badges), 0::bigint, 'account B sees none of A''s badges');
select is((select count(*) from public.topic_mastery_tallies), 0::bigint, 'account B sees none of A''s tallies');
select throws_ok(
  $$ insert into public.badges (user_id, kind, threshold) values ('00000000-0000-0000-0000-00000000000a', 'streak', 100) $$,
  '42501',
  null,
  'account B cannot insert a badge owned by A'
);
select results_eq(
  $$ select streak_days, mastered_cards, badges from public.badge_overview() $$,
  $$ values (0, 0, '[]'::jsonb) $$,
  'account B''s overview has no streak, no progress and no badges'
);

reset role;

select ok(
  not has_function_privilege('authenticated', 'public.sync_badges(uuid, uuid, uuid)', 'execute'),
  'authenticated has no execute on sync_badges'
);
select ok(
  not has_function_privilege('authenticated', 'public.study_streak_of(uuid)', 'execute'),
  'authenticated has no execute on study_streak_of'
);
select ok(
  has_function_privilege('authenticated', 'public.badge_overview()', 'execute'),
  'authenticated can execute badge_overview'
);
select ok(
  not has_function_privilege('anon', 'public.badge_overview()', 'execute'),
  'anon cannot execute badge_overview'
);

select * from finish();
rollback;
