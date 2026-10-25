-- Diagnostic quiz (migration create_diagnostic_quizzes): one quiz per confirmed topic with
-- exactly 10 questions saved atomically, each in a subtopic of that topic; answers are final
-- and only written through answer_quiz_question; results come from the answers.
-- Migration quiz_generation_claim: claim_quiz reserves the quiz before the AI call.
begin;
create extension if not exists pgtap with schema extensions;

select plan(41);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'account-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'account-b@example.com');

-- 10 questions spread over three subtopics of topic t1 (positions 0,3,6,9 / 1,4,7 / 2,5,8),
-- correct option always 0. Built once here and read back as jsonb below.
select set_config('test.questions', (
  select jsonb_agg(jsonb_build_object(
    'subtopic_id', (array[
      '00000000-0000-0000-0000-0000000000c1',
      '00000000-0000-0000-0000-0000000000c2',
      '00000000-0000-0000-0000-0000000000c3'])[1 + i % 3],
    'prompt', 'Pytanie ' || i,
    'options', jsonb_build_array('dobra', 'zła 1', 'zła 2', 'zła 3'),
    'correct_index', 0) order by i)::text
  from generate_series(0, 9) as i
), true);

select set_config('test.questions_a3', (
  select jsonb_agg(jsonb_build_object(
    'subtopic_id', (array[
      '00000000-0000-0000-0000-0000000000e1',
      '00000000-0000-0000-0000-0000000000e2'])[1 + i % 2],
    'prompt', 'Pytanie ' || i,
    'options', jsonb_build_array('dobra', 'zła 1', 'zła 2', 'zła 3'),
    'correct_index', 0) order by i)::text
  from generate_series(0, 9) as i
), true);

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

insert into public.topics (id, name)
values
  ('00000000-0000-0000-0000-0000000000a1', 'Kubernetes'),
  ('00000000-0000-0000-0000-0000000000a2', 'Szkic'),
  ('00000000-0000-0000-0000-0000000000a3', 'Docker');
insert into public.subtopics (id, topic_id, name, content_type, position)
values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'S1', 'conceptual', 0),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'S2', 'conceptual', 1),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'S3', 'vocabulary', 2),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', 'D1', 'conceptual', 0),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a2', 'D2', 'conceptual', 1),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a3', 'E1', 'conceptual', 0),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a3', 'E2', 'conceptual', 1);
update public.topics set status = 'confirmed'
where id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a3');

-- Refused attempts save nothing.
select throws_ok(
  $$ select public.create_quiz('00000000-0000-0000-0000-0000000000a2', current_setting('test.questions')::jsonb) $$,
  'P0409',
  'topic_not_confirmed',
  'a draft topic cannot get a quiz'
);
select throws_ok(
  $$ select public.create_quiz('00000000-0000-0000-0000-0000000000a1', current_setting('test.questions')::jsonb - 9) $$,
  'P0422',
  'quiz_size',
  'a quiz with 9 questions is refused'
);
select throws_ok(
  $$ select public.create_quiz(
       '00000000-0000-0000-0000-0000000000a1',
       current_setting('test.questions')::jsonb || (current_setting('test.questions')::jsonb -> 0)) $$,
  'P0422',
  'quiz_size',
  'a quiz with 11 questions is refused'
);
select throws_ok(
  $$ select public.create_quiz(
       '00000000-0000-0000-0000-0000000000a1',
       jsonb_set(current_setting('test.questions')::jsonb, '{4,subtopic_id}', '"00000000-0000-0000-0000-0000000000e1"')) $$,
  '23503',
  null,
  'a question cannot use a subtopic of another topic'
);
select is((select count(*) from public.quizzes), 0::bigint, 'refused attempts leave no quiz behind');

-- The quiz.
select set_config(
  'test.quiz',
  public.create_quiz('00000000-0000-0000-0000-0000000000a1', current_setting('test.questions')::jsonb)::text,
  true
);
select results_eq(
  $$ select position::integer from public.quiz_questions order by position $$,
  $$ select generate_series(0, 9) $$,
  'create_quiz saves 10 questions in positions 0-9'
);
select throws_ok(
  $$ select public.create_quiz('00000000-0000-0000-0000-0000000000a1', current_setting('test.questions')::jsonb) $$,
  'P0409',
  'quiz_exists',
  'a topic gets only one quiz'
);

-- Direct writes are refused; answers go through answer_quiz_question.
select throws_ok($$ update public.quiz_questions set correct_index = 1 $$, '42501', null, 'questions cannot be edited directly');
select throws_ok($$ delete from public.quiz_questions $$, '42501', null, 'questions cannot be deleted directly');
select throws_ok(
  $$ insert into public.quizzes (topic_id) values ('00000000-0000-0000-0000-0000000000a3') $$,
  '42501',
  null,
  'quizzes cannot be inserted directly'
);

select set_config('test.first', (select id::text from public.quiz_questions where position = 0), true);
select lives_ok(
  $$ select public.answer_quiz_question(current_setting('test.first')::uuid, 0::smallint) $$,
  'the owner answers a question'
);
select throws_ok(
  $$ select public.answer_quiz_question(current_setting('test.first')::uuid, 1::smallint) $$,
  'P0409',
  'question_locked',
  'an answer is final'
);
select is(
  (select completed_at from public.quizzes),
  null,
  'the quiz is not completed before the last answer'
);

-- Answer the rest: even positions correct, odd ones "I don't know" (-1).
select lives_ok(
  $$ select public.answer_quiz_question(id, (case when position % 2 = 0 then 0 else -1 end)::smallint)
     from public.quiz_questions where answer is null order by position $$,
  'the owner answers the remaining questions'
);
select isnt((select completed_at from public.quizzes), null, 'the last answer completes the quiz');
select results_eq(
  $$ select name, asked, correct, dont_know from public.quiz_results(current_setting('test.quiz')::uuid) $$,
  $$ values ('S1'::text, 4, 2, 2), ('S2'::text, 3, 1, 2), ('S3'::text, 3, 2, 1) $$,
  'quiz_results counts asked, correct and "I don''t know" per subtopic, in subtopic order'
);

-- Generation claim (migration quiz_generation_claim), on topic a3.
select lives_ok(
  $$ select public.claim_quiz('00000000-0000-0000-0000-0000000000a3') $$,
  'the owner claims the quiz before the AI call'
);
select is(
  (select status from public.quizzes where topic_id = '00000000-0000-0000-0000-0000000000a3'),
  'generating',
  'a claimed quiz is generating'
);
select throws_ok(
  $$ select public.claim_quiz('00000000-0000-0000-0000-0000000000a3') $$,
  'P0409',
  'quiz_generating',
  'a running generation cannot be claimed again'
);
select lives_ok(
  $$ select public.release_quiz_claim('00000000-0000-0000-0000-0000000000a3') $$,
  'the owner releases the claim after a failed AI call'
);
select is(
  (select count(*) from public.quizzes where topic_id = '00000000-0000-0000-0000-0000000000a3'),
  0::bigint,
  'a released claim leaves no quiz behind'
);
select lives_ok(
  $$ select public.claim_quiz('00000000-0000-0000-0000-0000000000a3') $$,
  'a released quiz can be claimed again'
);

reset role;
update public.quizzes set claimed_at = now() - interval '2 minutes'
where topic_id = '00000000-0000-0000-0000-0000000000a3';
set local role authenticated;

select is(
  public.claim_quiz('00000000-0000-0000-0000-0000000000a3'),
  now(),
  'an abandoned claim (older than 90 s) is taken over and returns its token'
);
-- The abandoned request's token no longer matches (migration claim_tokens_and_option_nulls).
select lives_ok(
  $$ select public.release_quiz_claim('00000000-0000-0000-0000-0000000000a3', now() - interval '2 minutes') $$,
  'releasing with the abandoned token runs without error'
);
select throws_ok(
  $$ select public.create_quiz(
       '00000000-0000-0000-0000-0000000000a3', current_setting('test.questions_a3')::jsonb, now() - interval '2 minutes') $$,
  'P0409',
  'quiz_not_claimed',
  'an abandoned token cannot fill the new claim'
);
select throws_ok(
  $$ select public.create_quiz(
       '00000000-0000-0000-0000-0000000000a3',
       jsonb_set(current_setting('test.questions_a3')::jsonb, '{0,options,1}', 'null'), now()) $$,
  '23514',
  null,
  'a question cannot have a null option'
);
select lives_ok(
  $$ select public.create_quiz('00000000-0000-0000-0000-0000000000a3', current_setting('test.questions_a3')::jsonb, now()) $$,
  'create_quiz fills the claim named by its token'
);
select results_eq(
  $$ select q.status, count(qq.id)
     from public.quizzes q left join public.quiz_questions qq on qq.quiz_id = q.id
     where q.topic_id = '00000000-0000-0000-0000-0000000000a3'
     group by q.status $$,
  $$ values ('ready'::text, 10::bigint) $$,
  'the filled claim is one ready quiz with 10 questions'
);
select throws_ok(
  $$ select public.claim_quiz('00000000-0000-0000-0000-0000000000a3') $$,
  'P0409',
  'quiz_exists',
  'a ready quiz cannot be claimed'
);
select throws_ok($$ truncate public.quiz_questions $$, '42501', null, 'questions cannot be truncated');

-- Another account.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

select throws_ok(
  $$ select public.answer_quiz_question(current_setting('test.first')::uuid, 0::smallint) $$,
  'P0409',
  'question_locked',
  'another account cannot answer A''s question'
);
select is_empty(
  $$ select * from public.quiz_results(current_setting('test.quiz')::uuid) $$,
  'another account sees no results of A''s quiz'
);
select throws_ok(
  $$ select public.create_quiz('00000000-0000-0000-0000-0000000000a3', current_setting('test.questions')::jsonb) $$,
  'P0409',
  'topic_not_confirmed',
  'another account cannot create a quiz for A''s topic'
);
select throws_ok(
  $$ select public.claim_quiz('00000000-0000-0000-0000-0000000000a3') $$,
  'P0409',
  'topic_not_confirmed',
  'another account cannot claim a quiz for A''s topic'
);

-- Deleting the topic still cascades to its quiz (referential actions bypass the revoked privileges).
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select lives_ok(
  $$ delete from public.topics where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'deleting a topic cascades to its quiz'
);
select is(
  (select count(*) from public.quiz_questions where quiz_id = current_setting('test.quiz')::uuid),
  0::bigint,
  'the quiz questions are gone with the topic'
);

reset role;

select ok(
  not has_function_privilege('anon', 'public.create_quiz(uuid, jsonb, timestamptz)', 'execute'),
  'anon cannot execute create_quiz'
);
select ok(
  not has_function_privilege('anon', 'public.answer_quiz_question(uuid, smallint)', 'execute'),
  'anon cannot execute answer_quiz_question'
);
select ok(
  not has_function_privilege('anon', 'public.quiz_results(uuid)', 'execute'),
  'anon cannot execute quiz_results'
);
select ok(
  not has_function_privilege('anon', 'public.claim_quiz(uuid)', 'execute'),
  'anon cannot execute claim_quiz'
);
select ok(
  not has_function_privilege('anon', 'public.release_quiz_claim(uuid, timestamptz)', 'execute'),
  'anon cannot execute release_quiz_claim'
);

select * from finish();
rollback;
