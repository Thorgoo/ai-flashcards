-- Open answers (migration flashcard_open_answers): answer_flashcard_open records a graded
-- open answer once per attempt id and moves the card: correct at 0/2 -> 1/2, due in 3
-- days; correct at 1/2 -> mastered; wrong -> 0/2, due tomorrow. Only open cards due today
-- (Europe/Warsaw) can be answered. "Days" pass by moving due_on as the table owner.
begin;
create extension if not exists pgtap with schema extensions;

select plan(31);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'account-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'account-b@example.com');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

-- A confirmed topic with a completed quiz and its first batch of 10 cards (option 0 is correct).
insert into public.topics (id, name) values ('00000000-0000-0000-0000-0000000000a1', 'Kubernetes');
insert into public.subtopics (id, topic_id, name, content_type, position)
values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'S1', 'conceptual', 0),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'S2', 'conceptual', 1);
update public.topics set status = 'confirmed' where id = '00000000-0000-0000-0000-0000000000a1';
select public.create_quiz(
  '00000000-0000-0000-0000-0000000000a1',
  (select jsonb_agg(jsonb_build_object(
     'subtopic_id', case when i % 2 = 0 then '00000000-0000-0000-0000-0000000000c1' else '00000000-0000-0000-0000-0000000000c2' end,
     'prompt', 'Pytanie ' || i, 'options', jsonb_build_array('dobra', 'zła 1', 'zła 2', 'zła 3'), 'correct_index', 0))
   from generate_series(0, 9) as i)
);
select public.answer_quiz_question(q.id, 0::smallint)
from public.quiz_questions q
where q.topic_id = '00000000-0000-0000-0000-0000000000a1';
select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a1');
select public.create_flashcard_batch(
  '00000000-0000-0000-0000-0000000000a1',
  (select jsonb_agg(jsonb_build_object(
     'subtopic_id', case when i % 2 = 0 then '00000000-0000-0000-0000-0000000000c1' else '00000000-0000-0000-0000-0000000000c2' end,
     'front', 'Fiszka ' || i, 'answer', 'Odpowiedź ' || i,
     'options', jsonb_build_array('dobra', 'zła 1', 'zła 2', 'zła 3'),
     'correct_index', 0, 'explanation', 'Wyjaśnienie ' || i, 'example', null) order by i)
   from generate_series(0, 9) as i)
);

-- Card ids by position (readable after switching to account B) and "today" in Warsaw.
select set_config('test.card0', (select id::text from public.flashcards where position = 0), true);
select set_config('test.card1', (select id::text from public.flashcards where position = 1), true);
select set_config('test.card2', (select id::text from public.flashcards where position = 2), true);
select set_config('test.card3', (select id::text from public.flashcards where position = 3), true);
select set_config('test.today', ((now() at time zone 'Europe/Warsaw')::date)::text, true);

-- Cards 0, 1 and 2 move to the open format (due tomorrow); card 3 stays multiple-choice.
select public.answer_flashcard_choice(current_setting('test.card0')::uuid, 0::smallint, '00000000-0000-0000-0000-000000000f00');
select public.answer_flashcard_choice(current_setting('test.card1')::uuid, 0::smallint, '00000000-0000-0000-0000-000000000f01');
select public.answer_flashcard_choice(current_setting('test.card2')::uuid, 0::smallint, '00000000-0000-0000-0000-000000000f02');

-- The next day: the open cards are due today.
reset role;
update public.flashcards set due_on = current_setting('test.today')::date where stage = 'open';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

-- 0/2 correct -> 1/2, due in 3 days.
select is(
  public.answer_flashcard_open(current_setting('test.card0')::uuid, '00000000-0000-0000-0000-000000000e01',
    '  Pod to grupa kontenerów.  ', true, 'Trafnie: sedno się zgadza.'),
  jsonb_build_object('correct', true, 'feedback', 'Trafnie: sedno się zgadza.', 'stage', 'open', 'open_streak', 1,
    'due_on', current_setting('test.today')::date + 3),
  'a correct answer at 0/2 returns the verdict, the feedback and 1/2 due in 3 days'
);
select results_eq(
  $$ select stage, open_streak::integer, due_on, mastered_at is null from public.flashcards
     where id = current_setting('test.card0')::uuid $$,
  $$ values ('open'::text, 1, current_setting('test.today')::date + 3, true) $$,
  'a correct answer at 0/2 moves the card to 1/2, due in 3 days'
);
select results_eq(
  $$ select flashcard_id, format, chosen_index is null, answer_text, feedback, correct, answered_on
     from public.flashcard_answers where id = '00000000-0000-0000-0000-000000000e01' $$,
  $$ values (current_setting('test.card0')::uuid, 'open'::text, true, 'Pod to grupa kontenerów.'::text,
             'Trafnie: sedno się zgadza.'::text, true, current_setting('test.today')::date) $$,
  'an open answer is logged with its text and feedback, without an option'
);
select is(
  public.answer_flashcard_open(current_setting('test.card0')::uuid, '00000000-0000-0000-0000-000000000e01',
    'Pod to grupa kontenerów.', true, 'Trafnie: sedno się zgadza.'),
  jsonb_build_object('correct', true, 'feedback', 'Trafnie: sedno się zgadza.', 'stage', 'open', 'open_streak', 1,
    'due_on', current_setting('test.today')::date + 3),
  'retrying an open answer returns the stored result, not card_not_due'
);
select is(
  (select count(*) from public.flashcard_answers where format = 'open'),
  1::bigint,
  'a retried open answer adds no log row'
);
select throws_ok(
  $$ select public.answer_flashcard_open(current_setting('test.card0')::uuid, '00000000-0000-0000-0000-000000000e02',
       'Jeszcze raz.', true, 'Trafnie.') $$,
  'P0409',
  'card_not_due',
  'a card answered correctly cannot be answered again in the same session'
);

-- 0/2 wrong -> 0/2, due tomorrow.
select is(
  public.answer_flashcard_open(current_setting('test.card1')::uuid, '00000000-0000-0000-0000-000000000e03',
    'Nie wiem.', false, 'Zabrakło sedna.'),
  jsonb_build_object('correct', false, 'feedback', 'Zabrakło sedna.', 'stage', 'open', 'open_streak', 0,
    'due_on', current_setting('test.today')::date + 1),
  'a wrong answer at 0/2 returns 0/2 due tomorrow'
);
select results_eq(
  $$ select stage, open_streak::integer, due_on from public.flashcards where id = current_setting('test.card1')::uuid $$,
  $$ values ('open'::text, 0, current_setting('test.today')::date + 1) $$,
  'a wrong answer at 0/2 leaves the card at 0/2, due tomorrow'
);
select throws_ok(
  $$ select public.answer_flashcard_open(current_setting('test.card1')::uuid, '00000000-0000-0000-0000-000000000e04',
       'Jeszcze raz.', true, 'Trafnie.') $$,
  'P0409',
  'card_not_due',
  'a card answered wrongly does not come back in the same session'
);

-- Three days later card 0 is due at 1/2: wrong -> 0/2, due tomorrow.
reset role;
update public.flashcards set due_on = current_setting('test.today')::date where id = current_setting('test.card0')::uuid;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select is(
  public.answer_flashcard_open(current_setting('test.card0')::uuid, '00000000-0000-0000-0000-000000000e05',
    'Coś innego.', false, 'To błąd merytoryczny.'),
  jsonb_build_object('correct', false, 'feedback', 'To błąd merytoryczny.', 'stage', 'open', 'open_streak', 0,
    'due_on', current_setting('test.today')::date + 1),
  'a wrong answer at 1/2 returns 0/2 due tomorrow'
);
select results_eq(
  $$ select stage, open_streak::integer, due_on from public.flashcards where id = current_setting('test.card0')::uuid $$,
  $$ values ('open'::text, 0, current_setting('test.today')::date + 1) $$,
  'a wrong answer at 1/2 moves the card back to 0/2, due tomorrow'
);

-- The next day: correct -> 1/2; three days later: correct -> mastered.
reset role;
update public.flashcards set due_on = current_setting('test.today')::date where id = current_setting('test.card0')::uuid;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select is(
  public.answer_flashcard_open(current_setting('test.card0')::uuid, '00000000-0000-0000-0000-000000000e06',
    'Pod to grupa kontenerów.', true, 'Trafnie.'),
  jsonb_build_object('correct', true, 'feedback', 'Trafnie.', 'stage', 'open', 'open_streak', 1,
    'due_on', current_setting('test.today')::date + 3),
  'a correct answer after a wrong one starts the streak again at 1/2'
);

reset role;
update public.flashcards set due_on = current_setting('test.today')::date where id = current_setting('test.card0')::uuid;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select is(
  public.answer_flashcard_open(current_setting('test.card0')::uuid, '00000000-0000-0000-0000-000000000e07',
    'Pod to grupa kontenerów.', true, 'Trafnie.'),
  jsonb_build_object('correct', true, 'feedback', 'Trafnie.', 'stage', 'mastered', 'open_streak', 1,
    'due_on', current_setting('test.today')::date),
  'a correct answer at 1/2 returns mastered'
);
select results_eq(
  $$ select stage, open_streak::integer, due_on, mastered_at is not null from public.flashcards
     where id = current_setting('test.card0')::uuid $$,
  $$ values ('mastered'::text, 1, current_setting('test.today')::date, true) $$,
  'a correct answer at 1/2 masters the card and stamps mastered_at, keeping streak and due date'
);
select results_eq(
  $$ select count(*) filter (where correct), count(*) filter (where not correct)
     from public.flashcard_answers where format = 'open' $$,
  $$ values (3::bigint, 2::bigint) $$,
  'every open answer is one log row'
);

-- Refused answers.
select throws_ok(
  $$ select public.answer_flashcard_open(current_setting('test.card0')::uuid, '00000000-0000-0000-0000-000000000e08',
       'Jeszcze raz.', true, 'Trafnie.') $$,
  'P0409',
  'card_not_due',
  'a mastered card cannot be answered'
);
select throws_ok(
  $$ select public.answer_flashcard_open(current_setting('test.card3')::uuid, '00000000-0000-0000-0000-000000000e09',
       'Odpowiedź.', true, 'Trafnie.') $$,
  'P0409',
  'card_not_due',
  'a multiple-choice card cannot be answered in the open format'
);
select throws_ok(
  $$ select public.answer_flashcard_open(current_setting('test.card2')::uuid, '00000000-0000-0000-0000-000000000e01',
       'Odpowiedź.', true, 'Trafnie.') $$,
  'P0409',
  'attempt_conflict',
  'an attempt of another card is refused'
);
select throws_ok(
  $$ select public.answer_flashcard_open(current_setting('test.card1')::uuid, '00000000-0000-0000-0000-000000000f01',
       'Odpowiedź.', true, 'Trafnie.') $$,
  'P0409',
  'attempt_conflict',
  'a multiple-choice attempt of the same card is refused'
);
select throws_ok(
  $$ select public.answer_flashcard_open(gen_random_uuid(), '00000000-0000-0000-0000-000000000e10',
       'Odpowiedź.', true, 'Trafnie.') $$,
  'P0409',
  'flashcard_not_found',
  'a missing card is refused'
);
select throws_ok(
  $$ select public.answer_flashcard_open(current_setting('test.card2')::uuid, '00000000-0000-0000-0000-000000000e11',
       '   ', true, 'Trafnie.') $$,
  'P0422',
  'validation_failed',
  'an empty answer is refused'
);
select throws_ok(
  $$ select public.answer_flashcard_open(current_setting('test.card2')::uuid, '00000000-0000-0000-0000-000000000e12',
       repeat('a', 2001), true, 'Trafnie.') $$,
  'P0422',
  'validation_failed',
  'an answer over 2000 characters is refused'
);
select throws_ok(
  $$ select public.answer_flashcard_open(current_setting('test.card2')::uuid, '00000000-0000-0000-0000-000000000e13',
       'Odpowiedź.', null, 'Trafnie.') $$,
  'P0422',
  'validation_failed',
  'an answer without a verdict is refused'
);
select throws_ok(
  $$ select public.answer_flashcard_open(current_setting('test.card2')::uuid, '00000000-0000-0000-0000-000000000e14',
       'Odpowiedź.', true, ' ') $$,
  'P0422',
  'validation_failed',
  'an answer without feedback is refused'
);
select results_eq(
  $$ select
       (select stage || ' ' || open_streak || ' ' || due_on from public.flashcards where id = current_setting('test.card2')::uuid),
       (select count(*) from public.flashcard_answers where format = 'open') $$,
  $$ values ('open 0 ' || current_setting('test.today'), 5::bigint) $$,
  'refused answers change no card and add no log row'
);

-- Another account cannot answer A's open card.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

select throws_ok(
  $$ select public.answer_flashcard_open(current_setting('test.card2')::uuid, '00000000-0000-0000-0000-000000000e15',
       'Odpowiedź.', true, 'Trafnie.') $$,
  'P0409',
  'flashcard_not_found',
  'another account cannot answer A''s open card'
);
select throws_ok(
  $$ select public.answer_flashcard_open(current_setting('test.card1')::uuid, '00000000-0000-0000-0000-000000000e03',
       'Nie wiem.', false, 'Zabrakło sedna.') $$,
  'P0409',
  'flashcard_not_found',
  'another account cannot replay A''s open attempt'
);

-- The log's format check, as the table owner (authenticated cannot insert directly).
reset role;

select throws_ok(
  $$ insert into public.flashcard_answers (id, user_id, topic_id, flashcard_id, format, chosen_index, answer_text, correct, answered_on)
     values (gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
             current_setting('test.card3')::uuid, 'choice', 0, 'Tekst.', true, current_setting('test.today')::date) $$,
  '23514',
  null,
  'a multiple-choice answer cannot carry an answer text'
);
select throws_ok(
  $$ insert into public.flashcard_answers (id, user_id, topic_id, flashcard_id, format, chosen_index, correct, answered_on)
     values (gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
             current_setting('test.card2')::uuid, 'open', null, true, current_setting('test.today')::date) $$,
  '23514',
  null,
  'an open answer needs its text and feedback'
);
select throws_ok(
  $$ insert into public.flashcard_answers (id, user_id, topic_id, flashcard_id, format, chosen_index, answer_text, feedback, correct, answered_on)
     values (gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
             current_setting('test.card2')::uuid, 'open', 1, 'Tekst.', 'Trafnie.', true, current_setting('test.today')::date) $$,
  '23514',
  null,
  'an open answer cannot carry an option'
);

select ok(
  not has_function_privilege('anon', 'public.answer_flashcard_open(uuid, uuid, text, boolean, text)', 'execute'),
  'anon cannot execute answer_flashcard_open'
);

select * from finish();
rollback;
