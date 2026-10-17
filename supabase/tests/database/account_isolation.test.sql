-- Canonical "row belongs to an account" pattern, proven with two accounts.
-- Every table in `public` follows the shape of `isolation_probe` below; when a slice
-- adds a table, append the same "B cannot see or change A's rows" assertions for it.
begin;
create extension if not exists pgtap with schema extensions;

select plan(8);

-- Two accounts (email sign-up is disabled, so users are inserted directly).
insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'account-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'account-b@example.com');

-- The pattern: owner column defaulting to the caller, RLS on, one policy per command.
create table public.isolation_probe (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  note text not null
);

alter table public.isolation_probe enable row level security;

create policy "owner can select" on public.isolation_probe
  for select to authenticated using (true);
create policy "owner can insert" on public.isolation_probe
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update" on public.isolation_probe
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete" on public.isolation_probe
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Account A writes a row without naming the owner.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

insert into public.isolation_probe (note) values ('a-original');

select is(
  (select user_id from public.isolation_probe),
  '00000000-0000-0000-0000-00000000000a'::uuid,
  'user_id defaults to the signed-in account'
);
select is((select count(*) from public.isolation_probe), 1::bigint, 'account A sees its own row');

-- Account B cannot see, change, remove or forge A's rows.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

select is((select count(*) from public.isolation_probe), 0::bigint, 'account B sees none of A''s rows');
select lives_ok(
  $$ update public.isolation_probe set note = 'b-was-here' $$,
  'account B update runs without error'
);
select lives_ok(
  $$ delete from public.isolation_probe $$,
  'account B delete runs without error'
);
select throws_ok(
  $$ insert into public.isolation_probe (user_id, note) values ('00000000-0000-0000-0000-00000000000a', 'forged') $$,
  '42501',
  null,
  'account B cannot insert a row owned by A'
);

-- Back as A: the row survived B's update and delete untouched.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select results_eq(
  $$ select note from public.isolation_probe $$,
  $$ values ('a-original') $$,
  'account A row is unchanged after account B update and delete'
);

-- Anonymous callers have no privileges on app tables at all (migration revoke_anon_default_privileges).
reset role;
set local role anon;

select throws_ok(
  $$ select * from public.isolation_probe $$,
  '42501',
  null,
  'anon has no access to account tables'
);

select * from finish();
rollback;
