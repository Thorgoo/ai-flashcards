-- Study state (migration flashcard_study_state): a card starts as 'choice', due today
-- (Europe/Warsaw); answer_flashcard_choice moves a correctly answered card to 'open',
-- streak 0, due tomorrow, leaves a wrongly answered one as it is, and logs every answer
-- once per attempt id. Owners only read the log; it outlives a deleted card.
begin;
create extension if not exists pgtap with schema extensions;

select plan(29);

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
select set_config('test.today', ((now() at time zone 'Europe/Warsaw')::date)::text, true);

select results_eq(
  $$ select stage, open_streak::integer, due_on, mastered_at is null, count(*)
     from public.flashcards group by 1, 2, 3, 4 $$,
  $$ values ('choice'::text, 0, current_setting('test.today')::date, true, 10::bigint) $$,
  'new cards are multiple-choice, streak 0, due today in Warsaw'
);

-- A wrong answer changes nothing but the log.
select is(
  public.answer_flashcard_choice(current_setting('test.card0')::uuid, 1::smallint, '00000000-0000-0000-0000-000000000f01'),
  jsonb_build_object('correct', false, 'correct_index', 0, 'stage', 'choice', 'due_on', current_setting('test.today')::date),
  'a wrong answer returns correct=false with the correct option'
);
select results_eq(
  $$ select stage, open_streak::integer, due_on from public.flashcards where id = current_setting('test.card0')::uuid $$,
  $$ values ('choice'::text, 0, current_setting('test.today')::date) $$,
  'a wrong answer leaves the card multiple-choice and due today'
);
select results_eq(
  $$ select id, flashcard_id, format, chosen_index::integer, correct, answered_on from public.flashcard_answers $$,
  $$ values ('00000000-0000-0000-0000-000000000f01'::uuid, current_setting('test.card0')::uuid, 'choice'::text, 1, false,
             current_setting('test.today')::date) $$,
  'a wrong answer is one log row under its attempt id'
);
select is(
  public.answer_flashcard_choice(current_setting('test.card0')::uuid, 1::smallint, '00000000-0000-0000-0000-000000000f01'),
  jsonb_build_object('correct', false, 'correct_index', 0, 'stage', 'choice', 'due_on', current_setting('test.today')::date),
  'retrying a wrong answer returns the stored result'
);
select is((select count(*) from public.flashcard_answers), 1::bigint, 'a retried attempt adds no log row');

-- A correct answer moves the card to the open format, due tomorrow.
select is(
  public.answer_flashcard_choice(current_setting('test.card0')::uuid, 0::smallint, '00000000-0000-0000-0000-000000000f02'),
  jsonb_build_object('correct', true, 'correct_index', 0, 'stage', 'open', 'due_on', current_setting('test.today')::date + 1),
  'a correct answer returns correct=true and the new state'
);
select results_eq(
  $$ select stage, open_streak::integer, due_on from public.flashcards where id = current_setting('test.card0')::uuid $$,
  $$ values ('open'::text, 0, current_setting('test.today')::date + 1) $$,
  'a correct answer moves the card to open, streak 0, due tomorrow'
);
select results_eq(
  $$ select count(*) filter (where correct), count(*) filter (where not correct) from public.flashcard_answers $$,
  $$ values (1::bigint, 1::bigint) $$,
  'every answer is logged, the wrong one and the correct one'
);
select is(
  public.answer_flashcard_choice(current_setting('test.card0')::uuid, 0::smallint, '00000000-0000-0000-0000-000000000f02'),
  jsonb_build_object('correct', true, 'correct_index', 0, 'stage', 'open', 'due_on', current_setting('test.today')::date + 1),
  'retrying a correct answer returns the stored result, not card_not_due'
);
select is((select count(*) from public.flashcard_answers), 2::bigint, 'a retried correct answer adds no log row');

-- Refused answers.
select throws_ok(
  $$ select public.answer_flashcard_choice(current_setting('test.card0')::uuid, 0::smallint, '00000000-0000-0000-0000-000000000f03') $$,
  'P0409',
  'card_not_due',
  'a card in the open format cannot be answered as multiple-choice'
);

reset role;
update public.flashcards set due_on = current_setting('test.today')::date + 1 where id = current_setting('test.card1')::uuid;
set local role authenticated;

select throws_ok(
  $$ select public.answer_flashcard_choice(current_setting('test.card1')::uuid, 0::smallint, '00000000-0000-0000-0000-000000000f04') $$,
  'P0409',
  'card_not_due',
  'a card due tomorrow cannot be answered today'
);
select throws_ok(
  $$ select public.answer_flashcard_choice(current_setting('test.card2')::uuid, 4::smallint, '00000000-0000-0000-0000-000000000f05') $$,
  'P0422',
  'validation_failed',
  'an answer outside 0-3 is refused'
);
select throws_ok(
  $$ select public.answer_flashcard_choice(gen_random_uuid(), 0::smallint, '00000000-0000-0000-0000-000000000f06') $$,
  'P0409',
  'flashcard_not_found',
  'a missing card is refused'
);
select results_eq(
  $$ select
       (select stage from public.flashcards where id = current_setting('test.card2')::uuid),
       (select count(*) from public.flashcard_answers) $$,
  $$ values ('choice'::text, 2::bigint) $$,
  'refused answers change no card and add no log row'
);

-- Another account cannot answer A's card or read A's result by its attempt id.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

select throws_ok(
  $$ select public.answer_flashcard_choice(current_setting('test.card2')::uuid, 0::smallint, '00000000-0000-0000-0000-000000000f07') $$,
  'P0409',
  'flashcard_not_found',
  'another account cannot answer A''s card'
);
select throws_ok(
  $$ select public.answer_flashcard_choice(current_setting('test.card0')::uuid, 0::smallint, '00000000-0000-0000-0000-000000000f02') $$,
  'P0409',
  'flashcard_not_found',
  'another account cannot replay A''s attempt'
);

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

-- Direct writes are refused.
select throws_ok(
  $$ insert into public.flashcard_answers (id, topic_id, flashcard_id, format, chosen_index, correct, answered_on)
     values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', current_setting('test.card2')::uuid,
             'choice', 0, true, current_setting('test.today')::date) $$,
  '42501',
  null,
  'answers cannot be inserted directly'
);
select throws_ok($$ update public.flashcard_answers set correct = true $$, '42501', null, 'answers cannot be edited directly');
select throws_ok($$ delete from public.flashcard_answers $$, '42501', null, 'answers cannot be deleted directly');
select throws_ok($$ update public.flashcards set stage = 'open' $$, '42501', null, 'the study state cannot be edited directly');

-- The log outlives a deleted card.
select lives_ok(
  $$ delete from public.flashcards where id = current_setting('test.card0')::uuid $$,
  'the owner deletes an answered card'
);
select results_eq(
  $$ select flashcard_id is null, count(*) from public.flashcard_answers group by 1 $$,
  $$ values (true, 2::bigint) $$,
  'the answers of a deleted card stay, without the card'
);
select is(
  public.answer_flashcard_choice(current_setting('test.card0')::uuid, 0::smallint, '00000000-0000-0000-0000-000000000f02'),
  jsonb_build_object('correct', true, 'correct_index', null, 'stage', null, 'due_on', null),
  'retrying an attempt of a deleted card returns its stored correctness'
);

-- Deleting the topic takes its log with it.
select lives_ok(
  $$ delete from public.topics where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'deleting a topic cascades to its answers'
);
select is((select count(*) from public.flashcard_answers), 0::bigint, 'the answers are gone with the topic');

reset role;

select ok(
  not has_function_privilege('anon', 'public.answer_flashcard_choice(uuid, smallint, uuid)', 'execute'),
  'anon cannot execute answer_flashcard_choice'
);
select ok(
  not has_table_privilege('anon', 'public.flashcard_answers', 'select'),
  'anon cannot read answers'
);

select * from finish();
rollback;
