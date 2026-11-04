-- Retry charges: every model attempt is one row in ai_calls whatever its outcome, and a
-- result is saved whole or not at all. Failure, failure, success is 3 rows and 1 full set.
-- These sequences call begin_ai_call themselves, so they prove the database rules, not that
-- a route calls the functions in this order. Each sequence has its own account, so its rows
-- are counted without the other's. A claim's token is now(), frozen in this transaction.
begin;
create extension if not exists pgtap with schema extensions;

select plan(20);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000e', 'retry-quiz@example.com'),
  ('00000000-0000-0000-0000-00000000000f', 'retry-batch@example.com');

-- 10 questions of topic a1 over subtopics c1 and c2.
select set_config('test.questions_a1', (
  select jsonb_agg(jsonb_build_object(
    'subtopic_id', (array[
      '00000000-0000-0000-0000-0000000000c1',
      '00000000-0000-0000-0000-0000000000c2'])[1 + i % 2],
    'prompt', 'Pytanie ' || i,
    'options', jsonb_build_array('dobra', 'zła 1', 'zła 2', 'zła 3'),
    'correct_index', 0) order by i)::text
  from generate_series(0, 9) as i
), true);

-- 10 questions and 10 cards of topic a2 over subtopics d1 and d2.
select set_config('test.questions_a2', (
  select jsonb_agg(jsonb_build_object(
    'subtopic_id', (array[
      '00000000-0000-0000-0000-0000000000d1',
      '00000000-0000-0000-0000-0000000000d2'])[1 + i % 2],
    'prompt', 'Pytanie ' || i,
    'options', jsonb_build_array('dobra', 'zła 1', 'zła 2', 'zła 3'),
    'correct_index', 0) order by i)::text
  from generate_series(0, 9) as i
), true);

select set_config('test.cards_a2', (
  select jsonb_agg(jsonb_build_object(
    'subtopic_id', (array[
      '00000000-0000-0000-0000-0000000000d1',
      '00000000-0000-0000-0000-0000000000d2'])[1 + i % 2],
    'front', 'Fiszka ' || i,
    'answer', 'Odpowiedź ' || i,
    'options', jsonb_build_array('dobra', 'zła 1', 'zła 2', 'zła 3'),
    'correct_index', 0,
    'explanation', 'Wyjaśnienie ' || i,
    'example', null) order by i)::text
  from generate_series(0, 9) as i
), true);

-- The quiz sequence, on a confirmed topic of its own account.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';

insert into public.topics (id, name) values ('00000000-0000-0000-0000-0000000000a1', 'Kubernetes');
insert into public.subtopics (id, topic_id, name, content_type, position)
values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'S1', 'conceptual', 0),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'S2', 'conceptual', 1);
update public.topics set status = 'confirmed' where id = '00000000-0000-0000-0000-0000000000a1';

-- Attempt 1: the model call fails.
select lives_ok(
  $$ select public.claim_quiz('00000000-0000-0000-0000-0000000000a1') $$,
  'quiz attempt 1 claims the quiz'
);
select public.begin_ai_call('generation', 'test', 'test-model');
select public.release_quiz_claim('00000000-0000-0000-0000-0000000000a1', now());

-- Attempt 2: the model answers, but the save is refused by a null option.
select lives_ok(
  $$ select public.claim_quiz('00000000-0000-0000-0000-0000000000a1') $$,
  'quiz attempt 2 claims the released quiz at once'
);
select public.begin_ai_call('generation', 'test', 'test-model');
select throws_ok(
  $$ select public.create_quiz(
       '00000000-0000-0000-0000-0000000000a1',
       jsonb_set(current_setting('test.questions_a1')::jsonb, '{0,options,1}', 'null'), now()) $$,
  '23514',
  null,
  'quiz attempt 2 cannot save a question with a null option'
);
select results_eq(
  $$ select q.status, count(qq.id)
     from public.quizzes q left join public.quiz_questions qq on qq.quiz_id = q.id
     where q.topic_id = '00000000-0000-0000-0000-0000000000a1'
     group by q.status $$,
  $$ values ('generating'::text, 0::bigint) $$,
  'the refused quiz save leaves the claim generating and saves no question'
);
select public.release_quiz_claim('00000000-0000-0000-0000-0000000000a1', now());

-- Attempt 3: the quiz is saved.
select lives_ok(
  $$ select public.claim_quiz('00000000-0000-0000-0000-0000000000a1') $$,
  'quiz attempt 3 claims the released quiz at once'
);
select public.begin_ai_call('generation', 'test', 'test-model');
select lives_ok(
  $$ select public.create_quiz('00000000-0000-0000-0000-0000000000a1', current_setting('test.questions_a1')::jsonb, now()) $$,
  'quiz attempt 3 saves the quiz'
);
select results_eq(
  $$ select q.status, count(qq.id)
     from public.quizzes q left join public.quiz_questions qq on qq.quiz_id = q.id
     where q.topic_id = '00000000-0000-0000-0000-0000000000a1'
     group by q.status $$,
  $$ values ('ready'::text, 10::bigint) $$,
  'failure, failure, success is one ready quiz with 10 questions'
);
select is(
  (select count(*) from public.ai_calls
   where user_id = '00000000-0000-0000-0000-00000000000e' and kind = 'generation'),
  3::bigint,
  'failure, failure, success of a quiz is 3 charges'
);

-- The next claim is refused before any model call.
select throws_ok(
  $$ select public.claim_quiz('00000000-0000-0000-0000-0000000000a1') $$,
  'P0409',
  'quiz_exists',
  'a claim after the saved quiz is refused'
);
select is(
  (select count(*) from public.ai_calls
   where user_id = '00000000-0000-0000-0000-00000000000e' and kind = 'generation'),
  3::bigint,
  'the refused quiz claim adds no charge'
);

-- The batch 1 sequence, on a confirmed topic of its own account. The completed quiz is set
-- up without begin_ai_call, so it adds no charge.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000f", "role": "authenticated"}';

insert into public.topics (id, name) values ('00000000-0000-0000-0000-0000000000a2', 'Docker');
insert into public.subtopics (id, topic_id, name, content_type, position)
values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', 'D1', 'conceptual', 0),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2', 'D2', 'conceptual', 1);
update public.topics set status = 'confirmed' where id = '00000000-0000-0000-0000-0000000000a2';
select public.create_quiz('00000000-0000-0000-0000-0000000000a2', current_setting('test.questions_a2')::jsonb);
select public.answer_quiz_question(q.id, 0::smallint)
from public.quiz_questions q
where q.topic_id = '00000000-0000-0000-0000-0000000000a2'
order by q.position;

-- Attempt 1: the model call fails.
select lives_ok(
  $$ select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a2') $$,
  'batch attempt 1 claims the batch'
);
select public.begin_ai_call('generation', 'test', 'test-model');
select public.fail_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a2', 1, now(), 'ai_timeout');

-- Attempt 2: the model answers, but the save is refused by a null option.
select lives_ok(
  $$ select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a2') $$,
  'batch attempt 2 claims the failed batch at once, without the TTL'
);
select public.begin_ai_call('generation', 'test', 'test-model');
select throws_ok(
  $$ select public.create_flashcard_batch(
       '00000000-0000-0000-0000-0000000000a2',
       jsonb_set(current_setting('test.cards_a2')::jsonb, '{0,options,1}', 'null'), now()) $$,
  '23514',
  null,
  'batch attempt 2 cannot save a card with a null option'
);
select results_eq(
  $$ select b.status, count(f.id)
     from public.flashcard_batches b left join public.flashcards f on f.batch_id = b.id
     where b.topic_id = '00000000-0000-0000-0000-0000000000a2'
     group by b.status $$,
  $$ values ('generating'::text, 0::bigint) $$,
  'the refused batch save leaves the claim generating and saves no card'
);
select public.fail_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a2', 1, now(), 'save_failed');

-- Attempt 3: the batch is saved.
select lives_ok(
  $$ select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a2') $$,
  'batch attempt 3 claims the failed batch at once, without the TTL'
);
select public.begin_ai_call('generation', 'test', 'test-model');
select lives_ok(
  $$ select public.create_flashcard_batch('00000000-0000-0000-0000-0000000000a2', current_setting('test.cards_a2')::jsonb, now()) $$,
  'batch attempt 3 saves the batch'
);
select results_eq(
  $$ select b.status, count(f.id)
     from public.flashcard_batches b left join public.flashcards f on f.batch_id = b.id
     where b.topic_id = '00000000-0000-0000-0000-0000000000a2'
     group by b.status $$,
  $$ values ('ready'::text, 10::bigint) $$,
  'failure, failure, success is one ready batch with 10 cards'
);
select is(
  (select count(*) from public.ai_calls
   where user_id = '00000000-0000-0000-0000-00000000000f' and kind = 'generation'),
  3::bigint,
  'failure, failure, success of a batch is 3 charges'
);

-- The next claim is refused before any model call.
select throws_ok(
  $$ select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a2') $$,
  'P0409',
  'batch_exists',
  'a claim after the saved batch is refused'
);
select is(
  (select count(*) from public.ai_calls
   where user_id = '00000000-0000-0000-0000-00000000000f' and kind = 'generation'),
  3::bigint,
  'the refused batch claim adds no charge'
);

select * from finish();
rollback;
