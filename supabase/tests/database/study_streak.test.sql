-- Study streak (migration study_streak): a study day is a Europe/Warsaw day with at least one
-- answer on a topic that is not archived; the streak is the run of consecutive study days
-- ending today, or yesterday when today is not a study day yet; otherwise (0, false).
-- Answers are written as the owner role (authenticated only reads the log); every day is
-- relative to today in Europe/Warsaw, so the test does not depend on the day it runs.
begin;
create extension if not exists pgtap with schema extensions;

select plan(13);

select set_config('test.today', ((now() at time zone 'Europe/Warsaw')::date)::text, true);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'account-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'account-b@example.com');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
insert into public.topics (id, name) values ('00000000-0000-0000-0000-0000000000b1', 'Terraform');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
insert into public.topics (id, name)
values
  ('00000000-0000-0000-0000-0000000000a1', 'Kubernetes'),
  ('00000000-0000-0000-0000-0000000000a2', 'Spring');

-- No answers.
select results_eq(
  $$ select streak_days, studied_today from public.study_streak() $$,
  $$ values (0, false) $$,
  'no answers: no streak'
);

-- Today and yesterday.
reset role;
insert into public.flashcard_answers (id, user_id, topic_id, format, chosen_index, correct, answered_on)
select gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
  'choice', 0, true, current_setting('test.today')::date - n
from unnest(array[0, 1]) n;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select results_eq(
  $$ select streak_days, studied_today from public.study_streak() $$,
  $$ values (2, true) $$,
  'today and yesterday: a 2-day streak, studied today'
);

-- Reference example: five days up to yesterday, nothing today.
reset role;
delete from public.flashcard_answers;
insert into public.flashcard_answers (id, user_id, topic_id, format, chosen_index, correct, answered_on)
select gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
  'choice', 0, true, current_setting('test.today')::date - n
from unnest(array[1, 2, 3, 4, 5]) n;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select results_eq(
  $$ select streak_days, studied_today from public.study_streak() $$,
  $$ values (5, false) $$,
  'today-5 .. today-1 without today: the 5-day streak is still alive'
);

-- The last answer the day before yesterday.
reset role;
delete from public.flashcard_answers;
insert into public.flashcard_answers (id, user_id, topic_id, format, chosen_index, correct, answered_on)
select gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
  'choice', 0, true, current_setting('test.today')::date - n
from unnest(array[2, 3]) n;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select results_eq(
  $$ select streak_days, studied_today from public.study_streak() $$,
  $$ values (0, false) $$,
  'last study day today-2: the streak is broken'
);

-- A gap in the middle.
reset role;
delete from public.flashcard_answers;
insert into public.flashcard_answers (id, user_id, topic_id, format, chosen_index, correct, answered_on)
select gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
  'choice', 0, true, current_setting('test.today')::date - n
from unnest(array[0, 1, 3]) n;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select results_eq(
  $$ select streak_days, studied_today from public.study_streak() $$,
  $$ values (2, true) $$,
  'today, today-1 and today-3: the gap ends the streak at 2'
);

-- Several answers on one day, in two topics, count as one day.
reset role;
delete from public.flashcard_answers;
insert into public.flashcard_answers (id, user_id, topic_id, format, chosen_index, correct, answered_on)
select gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', v.topic_id::uuid,
  'choice', 0, true, current_setting('test.today')::date - v.n
from (
  values
    ('00000000-0000-0000-0000-0000000000a1', 0),
    ('00000000-0000-0000-0000-0000000000a1', 0),
    ('00000000-0000-0000-0000-0000000000a2', 0),
    ('00000000-0000-0000-0000-0000000000a2', 1),
    ('00000000-0000-0000-0000-0000000000a2', 1)
) as v (topic_id, n);
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select results_eq(
  $$ select streak_days, studied_today from public.study_streak() $$,
  $$ values (2, true) $$,
  'answers on the same day and in two topics count as one study day'
);

-- Archive: today-1 is studied only in Spring; archiving Spring breaks the streak, restoring
-- it brings the streak back.
reset role;
delete from public.flashcard_answers;
insert into public.flashcard_answers (id, user_id, topic_id, format, chosen_index, correct, answered_on)
select gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', v.topic_id::uuid,
  'choice', 0, true, current_setting('test.today')::date - v.n
from (
  values
    ('00000000-0000-0000-0000-0000000000a1', 0),
    ('00000000-0000-0000-0000-0000000000a2', 1),
    ('00000000-0000-0000-0000-0000000000a1', 2)
) as v (topic_id, n);
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select results_eq(
  $$ select streak_days, studied_today from public.study_streak() $$,
  $$ values (3, true) $$,
  'today, today-1 (Spring) and today-2: a 3-day streak'
);

update public.topics set archived_at = now() where id = '00000000-0000-0000-0000-0000000000a2';
select results_eq(
  $$ select streak_days, studied_today from public.study_streak() $$,
  $$ values (1, true) $$,
  'a day studied only in an archived topic breaks the streak'
);

update public.topics set archived_at = null where id = '00000000-0000-0000-0000-0000000000a2';
select results_eq(
  $$ select streak_days, studied_today from public.study_streak() $$,
  $$ values (3, true) $$,
  'restoring the topic brings the streak back'
);

-- Account B's answers on today-3 and today-4 would extend A's streak to 5 if they counted.
reset role;
insert into public.flashcard_answers (id, user_id, topic_id, format, chosen_index, correct, answered_on)
select gen_random_uuid(), '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1',
  'choice', 0, true, current_setting('test.today')::date - n
from unnest(array[3, 4]) n;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select results_eq(
  $$ select streak_days, studied_today from public.study_streak() $$,
  $$ values (3, true) $$,
  'account B''s answers do not change account A''s streak'
);

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select results_eq(
  $$ select streak_days, studied_today from public.study_streak() $$,
  $$ values (0, false) $$,
  'account B''s streak counts only B''s answers (last study day today-3)'
);

reset role;

select ok(
  not has_function_privilege('anon', 'public.study_streak()', 'execute'),
  'anon cannot execute study_streak'
);
select ok(
  has_function_privilege('authenticated', 'public.study_streak()', 'execute'),
  'authenticated can execute study_streak'
);

select * from finish();
rollback;
