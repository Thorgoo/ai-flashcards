-- Next batches (migration next_flashcard_batches): batch N+1 of a topic is claimed only right
-- after its latest ready batch, once that batch has at least 80% of its existing cards
-- mastered (mastered * 5 >= total * 4) and while the topic has an unmastered subtopic (no
-- cards, or a card not mastered); then it is filled like batch 1, with a required token.
-- Mastery and deleted cards are set up as the table owner. A failed claim is taken over by the
-- next claim at once (migration flashcard_batch_failures).
begin;
create extension if not exists pgtap with schema extensions;

select plan(41);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'account-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'account-b@example.com');

-- 10 cards over subtopics c1 (even positions) and c2 (odd positions), for every batch.
select set_config('test.cards', (
  select jsonb_agg(jsonb_build_object(
    'subtopic_id', case when i % 2 = 0 then '00000000-0000-0000-0000-0000000000c1' else '00000000-0000-0000-0000-0000000000c2' end,
    'front', 'Fiszka ' || i, 'answer', 'Odpowiedź ' || i,
    'options', jsonb_build_array('dobra', 'zła 1', 'zła 2', 'zła 3'),
    'correct_index', 0, 'explanation', 'Wyjaśnienie ' || i, 'example', null) order by i)::text
  from generate_series(0, 9) as i
), true);

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

-- A confirmed topic with a completed quiz.
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

select throws_ok(
  $$ select public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 2) $$,
  'P0409',
  'next_batch_locked',
  'batch 2 waits for a ready batch 1'
);

-- Batch 1, through the batch 1 functions.
select public.claim_flashcard_batch('00000000-0000-0000-0000-0000000000a1');
select public.create_flashcard_batch('00000000-0000-0000-0000-0000000000a1', current_setting('test.cards')::jsonb);

-- The threshold: 7/10 mastered is not enough, 8/10 is.
reset role;
update public.flashcards set stage = 'mastered' where position <= 6;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select throws_ok(
  $$ select public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 2) $$,
  'P0409',
  'next_batch_locked',
  'batch 2 stays locked at 7/10 mastered'
);

reset role;
update public.flashcards set stage = 'mastered' where position = 7;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select is(
  public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 2),
  now(),
  'at 8/10 mastered the owner claims batch 2 and gets its token'
);
select results_eq(
  $$ select seq, status from public.flashcard_batches order by seq $$,
  $$ values (1, 'ready'::text), (2, 'generating'::text) $$,
  'the claim is batch 2, generating, next to the ready batch 1'
);

-- The claim and its token.
select throws_ok(
  $$ select public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 2) $$,
  'P0409',
  'batch_generating',
  'a running generation of batch 2 cannot be claimed again'
);

reset role;
update public.flashcard_batches set claimed_at = now() - interval '121 seconds'
where topic_id = '00000000-0000-0000-0000-0000000000a1' and seq = 2;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select is(
  public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 2),
  now(),
  'an abandoned claim of batch 2 (older than 120 s) is taken over and returns its new token'
);
select lives_ok(
  $$ select public.release_next_flashcard_batch_claim(
       '00000000-0000-0000-0000-0000000000a1', 2, now() - interval '121 seconds') $$,
  'releasing with the abandoned token runs without error'
);
select is(
  (select count(*) from public.flashcard_batches where seq = 2),
  1::bigint,
  'an abandoned token does not release the new claim'
);

-- Another account cannot release A's claim.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select lives_ok(
  $$ select public.release_next_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a1', 2, now()) $$,
  'another account''s release runs without error'
);
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select is(
  (select count(*) from public.flashcard_batches where seq = 2),
  1::bigint,
  'another account does not release A''s claim'
);

-- A failed claim of batch 2 (migration flashcard_batch_failures); the claim's token is now().
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select lives_ok(
  $$ select public.fail_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a1', 2, now(), 'ai_timeout') $$,
  'another account''s fail of batch 2 runs without error'
);
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select results_eq(
  $$ select status, error_code from public.flashcard_batches where seq = 2 $$,
  $$ values ('generating'::text, null::text) $$,
  'another account does not fail A''s claim of batch 2'
);
select lives_ok(
  $$ select public.fail_flashcard_batch_claim(
       '00000000-0000-0000-0000-0000000000a1', 2, now() - interval '121 seconds', 'ai_timeout') $$,
  'failing with the abandoned token runs without error'
);
select results_eq(
  $$ select status, error_code from public.flashcard_batches where seq = 2 $$,
  $$ values ('generating'::text, null::text) $$,
  'an abandoned token does not fail the new claim'
);
select lives_ok(
  $$ select public.fail_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a1', 2, now(), 'ai_invalid_output') $$,
  'the owner fails the claim of batch 2 with its token'
);
select results_eq(
  $$ select seq, status, error_code from public.flashcard_batches order by seq $$,
  $$ values (1, 'ready'::text, null::text), (2, 'failed'::text, 'ai_invalid_output'::text) $$,
  'only batch 2 is failed, with its error code'
);
select throws_ok(
  $$ select public.create_next_flashcard_batch(
       '00000000-0000-0000-0000-0000000000a1', 2, current_setting('test.cards')::jsonb, now()) $$,
  'P0409',
  'batch_not_claimed',
  'a failed batch 2 cannot be saved'
);
select is(
  public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 2),
  now(),
  'a failed batch 2 is claimed again within 120 s'
);
select results_eq(
  $$ select status, error_code from public.flashcard_batches where seq = 2 $$,
  $$ values ('generating'::text, null::text) $$,
  'claiming a failed batch 2 clears its error code'
);

-- Refused saves.
select throws_ok(
  $$ select public.create_next_flashcard_batch(
       '00000000-0000-0000-0000-0000000000a1', 2, current_setting('test.cards')::jsonb, now() - interval '121 seconds') $$,
  'P0409',
  'batch_not_claimed',
  'an abandoned token cannot fill the new claim'
);
select throws_ok(
  $$ select public.create_next_flashcard_batch(
       '00000000-0000-0000-0000-0000000000a1', 2, current_setting('test.cards')::jsonb, null) $$,
  'P0409',
  'batch_not_claimed',
  'a next batch cannot be saved without a token'
);
select throws_ok(
  $$ select public.create_next_flashcard_batch(
       '00000000-0000-0000-0000-0000000000a1', 2, current_setting('test.cards')::jsonb - 9, now()) $$,
  'P0422',
  'batch_size',
  'a next batch with 9 cards is refused'
);

-- The batch.
select lives_ok(
  $$ select public.create_next_flashcard_batch(
       '00000000-0000-0000-0000-0000000000a1', 2, current_setting('test.cards')::jsonb, now()) $$,
  'create_next_flashcard_batch fills the claim named by its token'
);
select results_eq(
  $$ select b.seq, b.status, count(f.id), count(f.id) filter (where f.stage = 'choice')
     from public.flashcard_batches b
     left join public.flashcards f on f.batch_id = b.id
     where b.seq = 2 group by b.seq, b.status $$,
  $$ values (2, 'ready'::text, 10::bigint, 10::bigint) $$,
  'the filled claim is a ready batch 2 with 10 new multiple-choice cards'
);
select lives_ok(
  $$ select public.fail_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a1', 2, now(), 'save_failed') $$,
  'failing a ready batch 2 runs without error'
);
select results_eq(
  $$ select status, error_code from public.flashcard_batches where seq = 2 $$,
  $$ values ('ready'::text, null::text) $$,
  'fail does not touch a ready batch 2'
);

-- Numbering.
select throws_ok(
  $$ select public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 2) $$,
  'P0409',
  'batch_exists',
  'the latest ready batch cannot be claimed again'
);
select throws_ok(
  $$ select public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 4) $$,
  'P0409',
  'next_batch_locked',
  'a batch cannot skip a number'
);
select throws_ok(
  $$ select public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 3) $$,
  'P0409',
  'next_batch_locked',
  'the threshold counts only the latest ready batch (batch 2 at 0/10)'
);

-- Deleted cards leave the threshold over the existing ones: 5/7 is not enough, 6/7 is.
delete from public.flashcards
where position >= 7
  and batch_id = (select id from public.flashcard_batches where seq = 2);

reset role;
update public.flashcards set stage = 'mastered'
where position <= 4
  and batch_id = (select id from public.flashcard_batches where seq = 2);
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select throws_ok(
  $$ select public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 3) $$,
  'P0409',
  'next_batch_locked',
  'batch 3 stays locked at 5/7 mastered'
);

reset role;
update public.flashcards set stage = 'mastered'
where position = 5
  and batch_id = (select id from public.flashcard_batches where seq = 2);
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select is(
  public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 3),
  now(),
  'at 6/7 mastered the owner claims batch 3'
);
select lives_ok(
  $$ select public.release_next_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a1', 3, now()) $$,
  'the owner releases the claim of batch 3 with its token'
);
select is(
  (select count(*) from public.flashcard_batches where seq = 3),
  0::bigint,
  'a released claim leaves no batch 3 behind'
);

-- A latest batch whose cards were all deleted passes the threshold.
delete from public.flashcards
where batch_id = (select id from public.flashcard_batches where seq = 2);

select is(
  public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 3),
  now(),
  'a latest batch with no cards left lets batch 3 be claimed'
);
select public.release_next_flashcard_batch_claim('00000000-0000-0000-0000-0000000000a1', 3, now());

-- Topic mastery: every card of both subtopics mastered.
reset role;
update public.flashcards set stage = 'mastered' where topic_id = '00000000-0000-0000-0000-0000000000a1';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select throws_ok(
  $$ select public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 3) $$,
  'P0409',
  'topic_mastered',
  'a topic with every subtopic mastered gets no next batch'
);

-- A subtopic whose cards were all deleted is not mastered.
delete from public.flashcards where subtopic_id = '00000000-0000-0000-0000-0000000000c2';

select is(
  public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 3),
  now(),
  'a subtopic with no cards keeps the topic open for batch 3'
);

-- Another account.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

select throws_ok(
  $$ select public.claim_next_flashcard_batch('00000000-0000-0000-0000-0000000000a1', 3) $$,
  'P0409',
  'topic_not_confirmed',
  'another account cannot claim a next batch for A''s topic'
);
select throws_ok(
  $$ select public.create_next_flashcard_batch(
       '00000000-0000-0000-0000-0000000000a1', 3, current_setting('test.cards')::jsonb, now()) $$,
  'P0409',
  'topic_not_confirmed',
  'another account cannot save a next batch for A''s topic'
);

reset role;

select ok(
  not has_function_privilege('anon', 'public.claim_next_flashcard_batch(uuid, integer)', 'execute'),
  'anon cannot execute claim_next_flashcard_batch'
);
select ok(
  not has_function_privilege('anon', 'public.release_next_flashcard_batch_claim(uuid, integer, timestamptz)', 'execute'),
  'anon cannot execute release_next_flashcard_batch_claim'
);
select ok(
  not has_function_privilege('anon', 'public.create_next_flashcard_batch(uuid, integer, jsonb, timestamptz)', 'execute'),
  'anon cannot execute create_next_flashcard_batch'
);

select * from finish();
rollback;
