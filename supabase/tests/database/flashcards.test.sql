-- Flashcards (migration create_flashcards): batch 1 of a confirmed topic with a completed
-- quiz is claimed before the AI call and filled with exactly 10 cards in one transaction,
-- each in a subtopic of that topic; owners only read the tables and delete cards.
-- A failed claim is kept as 'failed' with its code and taken over by the next claim
-- (migration flashcard_batch_failures).
begin;
create extension if not exists pgtap with schema extensions;

select plan(60);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'account-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'account-b@example.com');

-- 10 quiz questions of topic a1 over its three subtopics, and the same for a3 over two.
select set_config('test.questions_a1', (
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

-- 10 cards of topic a1: subtopic c3 is vocabulary (with an example), c1/c2 conceptual.
select set_config('test.cards', (
  select jsonb_agg(jsonb_build_object(
    'subtopic_id', (array[
      '00000000-0000-0000-0000-0000000000c1',
      '00000000-0000-0000-0000-0000000000c2',
      '00000000-0000-0000-0000-0000000000c3'])[1 + i % 3],
    'front', 'Fiszka ' || i,
    'answer', 'Odpowiedź ' || i,
    'options', jsonb_build_array('dobra', 'zła 1', 'zła 2', 'zła 3'),
    'correct_index', 0,
    'explanation', 'Wyjaśnienie ' || i,
    'example', case when i % 3 = 2 then to_jsonb('Przykład ' || i) else 'null'::jsonb end) order by i)::text
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

-- Topic a1 gets a completed quiz; topic a3 a quiz nobody answered yet.
select public.create_quiz('00000000-0000-0000-0000-0000000000a1', current_setting('test.questions_a1')::jsonb);
select public.create_quiz('00000000-0000-0000-0000-0000000000a3', current_setting('test.questions_a3')::jsonb);
select lives_ok(
  $$ select public.answer_quiz_question(q.id, 0::smallint)
     from public.quiz_questions q
     where q.topic_id = '00000000-0000-0000-0000-0000000000a1'
     order by q.position $$,
  'the owner completes the quiz of topic a1'
);

-- Refused claims.
select throws_ok(
  $$ select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a2') $$,
  'P0409',
  'topic_not_confirmed',
  'a draft topic cannot get flashcards'
);
select throws_ok(
  $$ select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a3') $$,
  'P0409',
  'quiz_not_completed',
  'flashcards wait for the completed quiz'
);
select throws_ok(
  $$ select public.create_flashcard_batch('00000000-0000-0000-0000-0000000000a1', current_setting('test.cards')::jsonb) $$,
  'P0409',
  'batch_not_claimed',
  'a batch cannot be saved without a claim'
);
select is((select count(*) from public.flashcard_batches), 0::bigint, 'refused attempts leave no batch behind');

-- The claim.
select lives_ok(
  $$ select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a1') $$,
  'the owner claims batch 1 before the AI call'
);
select results_eq(
  $$ select seq, status from public.flashcard_batches $$,
  $$ values (1, 'generating'::text) $$,
  'a claimed batch is batch 1, generating'
);
select throws_ok(
  $$ select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a1') $$,
  'P0409',
  'batch_generating',
  'a running generation cannot be claimed again'
);
select lives_ok(
  $$ select public.release_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a1') $$,
  'the owner releases the claim after a failed AI call'
);
select is((select count(*) from public.flashcard_batches), 0::bigint, 'a released claim leaves no batch behind');
select lives_ok(
  $$ select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a1') $$,
  'a released batch can be claimed again'
);

-- A failed claim (migration flashcard_batch_failures); the claim's token is now().
select lives_ok(
  $$ select public.fail_flashcard_batch_claim(
       '00000000-0000-0000-0000-0000000000a1', 1, now() - interval '1 second', 'ai_timeout') $$,
  'failing with another token runs without error'
);
select results_eq(
  $$ select status, error_code from public.flashcard_batches $$,
  $$ values ('generating'::text, null::text) $$,
  'another token does not fail the claim'
);
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select lives_ok(
  $$ select public.fail_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a1', 1, now(), 'ai_timeout') $$,
  'another account''s fail runs without error'
);
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select results_eq(
  $$ select status, error_code from public.flashcard_batches $$,
  $$ values ('generating'::text, null::text) $$,
  'another account does not fail A''s claim'
);
select lives_ok(
  $$ select public.fail_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a1', 1, now(), 'ai_timeout') $$,
  'the owner fails the claim with its token after a failed AI call'
);
select results_eq(
  $$ select status, error_code from public.flashcard_batches $$,
  $$ values ('failed'::text, 'ai_timeout'::text) $$,
  'a failed claim keeps its row with the error code'
);
select throws_ok(
  $$ select public.create_flashcard_batch('00000000-0000-0000-0000-0000000000a1', current_setting('test.cards')::jsonb, now()) $$,
  'P0409',
  'batch_not_claimed',
  'a failed batch cannot be saved'
);
select is(
  public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a1'),
  now(),
  'a failed batch is claimed again within 180 s'
);
select results_eq(
  $$ select status, error_code from public.flashcard_batches $$,
  $$ values ('generating'::text, null::text) $$,
  'claiming a failed batch clears its error code'
);

reset role;
update public.flashcard_batches set claimed_at = now() - interval '121 seconds'
where topic_id = '00000000-0000-0000-0000-0000000000a1';
set local role authenticated;

-- The queue consumer's AI call may take 90 s plus delivery and the save (migration flashcard_claim_ttl_180).
select throws_ok(
  $$ select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a1') $$,
  'P0409',
  'batch_generating',
  'a claim 121 s old is still running and cannot be claimed again'
);

reset role;
update public.flashcard_batches set claimed_at = now() - interval '181 seconds'
where topic_id = '00000000-0000-0000-0000-0000000000a1';
set local role authenticated;

select is(
  public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a1'),
  now(),
  'an abandoned claim (older than 180 s) is taken over and returns its token'
);
select is(
  (select claimed_at from public.flashcard_batches where topic_id = '00000000-0000-0000-0000-0000000000a1'),
  now(),
  'taking over renews the claim'
);

-- The abandoned request's token no longer matches (migration claim_tokens_and_option_nulls).
select lives_ok(
  $$ select public.release_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a1', now() - interval '181 seconds') $$,
  'releasing with the abandoned token runs without error'
);
select is((select count(*) from public.flashcard_batches), 1::bigint, 'an abandoned token does not release the new claim');
select throws_ok(
  $$ select public.create_flashcard_batch(
       '00000000-0000-0000-0000-0000000000a1', current_setting('test.cards')::jsonb, now() - interval '181 seconds') $$,
  'P0409',
  'batch_not_claimed',
  'an abandoned token cannot fill the new claim'
);

-- Another account cannot release A's claim.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select lives_ok(
  $$ select public.release_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a1') $$,
  'another account''s release runs without error'
);
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select is((select count(*) from public.flashcard_batches), 1::bigint, 'another account does not release A''s claim');

-- Refused saves.
select throws_ok(
  $$ select public.create_flashcard_batch(
       '00000000-0000-0000-0000-0000000000a1',
       jsonb_set(current_setting('test.cards')::jsonb, '{0,options,1}', 'null')) $$,
  '23514',
  null,
  'a card cannot have a null option'
);
select throws_ok(
  $$ select public.create_flashcard_batch('00000000-0000-0000-0000-0000000000a1', current_setting('test.cards')::jsonb - 9) $$,
  'P0422',
  'batch_size',
  'a batch with 9 cards is refused'
);
select throws_ok(
  $$ select public.create_flashcard_batch(
       '00000000-0000-0000-0000-0000000000a1',
       current_setting('test.cards')::jsonb || (current_setting('test.cards')::jsonb -> 0)) $$,
  'P0422',
  'batch_size',
  'a batch with 11 cards is refused'
);
select throws_ok(
  $$ select public.create_flashcard_batch(
       '00000000-0000-0000-0000-0000000000a1',
       jsonb_set(current_setting('test.cards')::jsonb, '{4,subtopic_id}', '"00000000-0000-0000-0000-0000000000e1"')) $$,
  '23503',
  null,
  'a card cannot use a subtopic of another topic'
);
select results_eq(
  $$ select b.status, count(f.id) from public.flashcard_batches b
     left join public.flashcards f on f.batch_id = b.id group by b.status $$,
  $$ values ('generating'::text, 0::bigint) $$,
  'refused saves leave the claim generating and save no card'
);

-- The batch.
select lives_ok(
  $$ select public.create_flashcard_batch('00000000-0000-0000-0000-0000000000a1', current_setting('test.cards')::jsonb, now()) $$,
  'create_flashcard_batch fills the claim named by its token'
);
select results_eq(
  $$ select b.status, count(f.id) from public.flashcard_batches b
     left join public.flashcards f on f.batch_id = b.id group by b.status $$,
  $$ values ('ready'::text, 10::bigint) $$,
  'the filled claim is one ready batch with 10 cards'
);
select results_eq(
  $$ select position from public.flashcards order by position $$,
  $$ select generate_series(0, 9) $$,
  'the cards take positions 0-9 in the given order'
);
select results_eq(
  $$ select front, options, correct_index::integer, example from public.flashcards where position in (1, 2) order by position $$,
  $$ values
    ('Fiszka 1'::text, array['dobra', 'zła 1', 'zła 2', 'zła 3'], 0, null::text),
    ('Fiszka 2'::text, array['dobra', 'zła 1', 'zła 2', 'zła 3'], 0, 'Przykład 2'::text) $$,
  'card fields are saved as given, a null example stays null'
);
select throws_ok(
  $$ select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a1') $$,
  'P0409',
  'batch_exists',
  'a ready batch cannot be claimed'
);
select throws_ok(
  $$ select public.create_flashcard_batch('00000000-0000-0000-0000-0000000000a1', current_setting('test.cards')::jsonb) $$,
  'P0409',
  'batch_exists',
  'a ready batch cannot be saved again'
);
select lives_ok(
  $$ select public.release_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a1') $$,
  'releasing a ready batch runs without error'
);
select is(
  (select count(*) from public.flashcards f join public.flashcard_batches b on b.id = f.batch_id where b.status = 'ready'),
  10::bigint,
  'release does not remove a ready batch'
);
select lives_ok(
  $$ select public.fail_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a1', 1, now(), 'save_failed') $$,
  'failing a ready batch runs without error'
);
select results_eq(
  $$ select status, error_code from public.flashcard_batches $$,
  $$ values ('ready'::text, null::text) $$,
  'fail does not touch a ready batch'
);

-- The table checks, as the table owner.
reset role;
select throws_ok(
  $$ update public.flashcard_batches set status = 'cancelled' $$,
  '23514',
  null,
  'a batch status is generating, ready or failed'
);
select throws_ok(
  $$ update public.flashcard_batches set error_code = repeat('x', 51) $$,
  '23514',
  null,
  'an error code has at most 50 characters'
);
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

-- Direct writes are refused, except deleting an own card.
select throws_ok(
  $$ insert into public.flashcard_batches (topic_id, seq) values ('00000000-0000-0000-0000-0000000000a3', 1) $$,
  '42501',
  null,
  'batches cannot be inserted directly'
);
select throws_ok($$ update public.flashcard_batches set status = 'generating' $$, '42501', null, 'batches cannot be edited directly');
select throws_ok($$ delete from public.flashcard_batches $$, '42501', null, 'batches cannot be deleted directly');
select throws_ok(
  $$ insert into public.flashcards (topic_id, batch_id, subtopic_id, position, front, answer, options, correct_index, explanation)
     select topic_id, batch_id, subtopic_id, 9, front, answer, options, correct_index, explanation
     from public.flashcards where position = 0 $$,
  '42501',
  null,
  'cards cannot be inserted directly'
);
select throws_ok($$ update public.flashcards set correct_index = 1 $$, '42501', null, 'cards cannot be edited directly');
select lives_ok(
  $$ delete from public.flashcards where position = 0 $$,
  'the owner deletes a card'
);
select is((select count(*) from public.flashcards), 9::bigint, 'the deleted card is gone');

-- Another account.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

select throws_ok(
  $$ select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a1') $$,
  'P0409',
  'topic_not_confirmed',
  'another account cannot claim flashcards for A''s topic'
);
select throws_ok(
  $$ select public.create_flashcard_batch('00000000-0000-0000-0000-0000000000a1', current_setting('test.cards')::jsonb) $$,
  'P0409',
  'topic_not_confirmed',
  'another account cannot save flashcards for A''s topic'
);

-- Deleting the topic cascades to its batch and cards. Accounts cannot delete topics
-- (archive replaces delete), so the delete runs as the owner role, as the account
-- deletion cascade does.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

reset role;
select lives_ok(
  $$ delete from public.topics where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'deleting a topic cascades to its flashcards'
);
set local role authenticated;
select is(
  (select count(*) from public.flashcard_batches) + (select count(*) from public.flashcards),
  0::bigint,
  'the batch and its cards are gone with the topic'
);

reset role;

select ok(
  not has_function_privilege('anon', 'public.claim_flashcard_batch(uuid)', 'execute'),
  'anon cannot execute claim_flashcard_batch'
);
select ok(
  not has_function_privilege('anon', 'public.release_flashcard_batch_claim(uuid, timestamptz)', 'execute'),
  'anon cannot execute release_flashcard_batch_claim'
);
select ok(
  not has_function_privilege('anon', 'public.create_flashcard_batch(uuid, jsonb, timestamptz)', 'execute'),
  'anon cannot execute create_flashcard_batch'
);
select ok(
  not has_function_privilege('anon', 'public.fail_flashcard_batch_claim(uuid, integer, timestamptz, text)', 'execute'),
  'anon cannot execute fail_flashcard_batch_claim'
);

select * from finish();
rollback;
