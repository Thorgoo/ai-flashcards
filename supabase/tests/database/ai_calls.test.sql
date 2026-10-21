-- Daily AI limits (migration create_ai_calls): 20 generations / 100 gradings per account
-- and Europe/Warsaw day, every call counts, and only the limit functions can write rows.
begin;
create extension if not exists pgtap with schema extensions;

select plan(13);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'account-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'account-b@example.com');

-- Account A uses up its generation limit.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select is(
  (select remaining from public.begin_ai_call('generation', 'test', 'test-model')),
  19,
  'first generation of the day leaves 19'
);
select lives_ok(
  $$ select public.begin_ai_call('generation', 'test', 'test-model') from generate_series(1, 19) $$,
  'generations 2-20 are allowed'
);
select throws_ok(
  $$ select public.begin_ai_call('generation', 'test', 'test-model') $$,
  'P0429',
  'ai_quota_exceeded',
  'generation 21 is refused'
);

-- Grading has its own limit; keep this call's id for the finish_ai_call checks below.
select set_config(
  'test.a_call',
  (select call_id::text from public.begin_ai_call('grading', 'test', 'test-model')),
  true
);
select isnt(current_setting('test.a_call', true), '', 'grading is still allowed after the generation limit');

-- The owner cannot write rows directly, so the counter cannot be reset.
select throws_ok(
  $$ insert into public.ai_calls (kind, task, model, called_on) values ('generation', 'forged', 'm', current_date) $$,
  '42501',
  null,
  'direct insert is refused'
);
select throws_ok($$ update public.ai_calls set status = 'ok' $$, '42501', null, 'direct update is refused');
select throws_ok($$ delete from public.ai_calls $$, '42501', null, 'direct delete is refused');

-- Account B: 20 generations yesterday, A's calls today.
reset role;
insert into public.ai_calls (user_id, kind, task, model, called_on)
select
  '00000000-0000-0000-0000-00000000000b',
  'generation',
  'test',
  'test-model',
  (now() at time zone 'Europe/Warsaw')::date - 1
from generate_series(1, 20);

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

select is(
  (select remaining from public.begin_ai_call('generation', 'test', 'test-model')),
  19,
  'yesterday''s calls and other accounts'' calls do not count'
);
select throws_ok(
  $$ select public.begin_ai_call('grading', repeat('x', 101), 'test-model') $$,
  '23514',
  null,
  'oversized task name is rejected'
);

select public.finish_ai_call(current_setting('test.a_call')::uuid, 'ok', null, 10, 1, 1);

reset role;
select is(
  (select status from public.ai_calls where id = current_setting('test.a_call')::uuid),
  'pending',
  'account B cannot finish A''s call'
);

-- The owner records the outcome of its own call.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select public.finish_ai_call(current_setting('test.a_call')::uuid, 'failed', 'ai_timeout', 1500, 10, 0);

select is(
  (select status || ':' || error_code from public.ai_calls where id = current_setting('test.a_call')::uuid),
  'failed:ai_timeout',
  'owner records the outcome of its call'
);

-- Anonymous callers cannot reach the limit functions at all (checked on the privilege
-- itself, so the functions' own "not signed in" error cannot mask a wrong grant).
reset role;

select ok(
  not has_function_privilege('anon', 'public.begin_ai_call(text, text, text)', 'execute'),
  'anon cannot execute begin_ai_call'
);
select ok(
  not has_function_privilege('anon', 'public.finish_ai_call(uuid, text, text, integer, integer, integer)', 'execute'),
  'anon cannot execute finish_ai_call'
);

select * from finish();
rollback;
