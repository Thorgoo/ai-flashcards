-- Guard: every table and view in `public` must follow the account-ownership pattern
-- (see account_isolation.test.sql). CI fails with the offending table and reason.
begin;
create extension if not exists pgtap with schema extensions;

select plan(2);

-- Tables deliberately exempt from the pattern. Each entry needs a reason, e.g.
-- ('some_global_lookup') -- shared reference data, read-only for everyone
create temporary table rls_guard_exceptions (table_name text primary key);
insert into rls_guard_exceptions (table_name)
values
  -- Append-only AI limit counter: owners only read; writes go through begin_ai_call / finish_ai_call
  ('ai_calls');

create temporary view rls_guard_violations as
  select c.relname as table_name, reason
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral (
    values
      ('RLS disabled', not c.relrowsecurity),
      (
        'no user_id uuid not null column',
        not exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
            and a.atttypid = 'uuid'::regtype and a.attnotnull
        )
      ),
      (
        'no policy for every command',
        exists (
          select 1 from unnest(array['r', 'a', 'w', 'd']) as cmd
          where not exists (
            select 1 from pg_policy p where p.polrelid = c.oid and p.polcmd::text in (cmd, '*')
          )
        )
      ),
      (
        'policy not limited to authenticated',
        exists (
          select 1 from pg_policy p
          where p.polrelid = c.oid and p.polroles <> array(select oid from pg_roles where rolname = 'authenticated')
        )
      ),
      (
        'policy does not compare auth.uid() to user_id',
        exists (
          select 1
          from pg_policy p
          cross join lateral (
            values (pg_get_expr(p.polqual, p.polrelid)), (pg_get_expr(p.polwithcheck, p.polrelid))
          ) as e(expr)
          where p.polrelid = c.oid and e.expr is not null
            and not (e.expr ~ 'auth\.uid\(\)' and e.expr ~ '\muser_id\M')
        )
      )
  ) as checks(reason, failed)
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and c.relname not in (select table_name from rls_guard_exceptions)
    and failed
  union all
  -- Views run with their owner's rights (bypassing RLS) unless security_invoker is set;
  -- materialized views cannot have RLS at all.
  select c.relname, case c.relkind when 'v' then 'view without security_invoker' else 'materialized view bypasses RLS' end
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('v', 'm')
    and c.relname not in (select table_name from rls_guard_exceptions)
    and not (
      c.relkind = 'v'
      and exists (select 1 from unnest(c.reloptions) as o where o ~* '^security_invoker=(true|on|1|yes)$')
    );

-- Self-test: the guard flags broken tables and accepts one that follows the pattern.
savepoint guard_self_test;

create table public.guard_no_pattern (id int);

create table public.guard_loose_policy (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade
);
alter table public.guard_loose_policy enable row level security;
create policy "anyone" on public.guard_loose_policy for all to public using (true);

create table public.guard_owned (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade
);
alter table public.guard_owned enable row level security;
create policy "owner can select" on public.guard_owned
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert" on public.guard_owned
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update" on public.guard_owned
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete" on public.guard_owned
  for delete to authenticated using ((select auth.uid()) = user_id);

create view public.guard_definer_view as select user_id from public.guard_owned;
create view public.guard_invoker_view with (security_invoker = true) as select user_id from public.guard_owned;
create materialized view public.guard_matview as select user_id from public.guard_owned;

select set_eq(
  $$ select table_name::text || ': ' || reason from rls_guard_violations $$,
  $$ values
    ('guard_no_pattern: RLS disabled'),
    ('guard_no_pattern: no user_id uuid not null column'),
    ('guard_no_pattern: no policy for every command'),
    ('guard_loose_policy: policy not limited to authenticated'),
    ('guard_loose_policy: policy does not compare auth.uid() to user_id'),
    ('guard_definer_view: view without security_invoker'),
    ('guard_matview: materialized view bypasses RLS') $$,
  'guard flags tables that break the pattern and accepts one that follows it'
);

rollback to savepoint guard_self_test;

select is_empty(
  $$ select table_name || ': ' || reason from rls_guard_violations order by 1 $$,
  'every public table follows the owned-table pattern'
);

select * from finish();
rollback;
