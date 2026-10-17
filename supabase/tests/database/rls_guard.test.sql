-- Guard: every table in `public` must follow the account-ownership pattern
-- (see account_isolation.test.sql). CI fails with the offending table and reason.
begin;
create extension if not exists pgtap with schema extensions;

select plan(1);

-- Tables deliberately exempt from the pattern. Each entry needs a reason, e.g.
-- ('some_global_lookup') -- shared reference data, read-only for everyone
create temporary table rls_guard_exceptions (table_name text primary key);

select is_empty(
  $$
    select c.relname || ': ' || reason
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral (
      values
        ('RLS disabled', not c.relrowsecurity),
        (
          'no user_id column',
          not exists (
            select 1 from pg_attribute a
            where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
          )
        ),
        ('no policies', not exists (select 1 from pg_policy p where p.polrelid = c.oid))
    ) as checks(reason, failed)
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname not in (select table_name from rls_guard_exceptions)
      and failed
    order by 1
  $$,
  'every public table has RLS, a user_id column and at least one policy'
);

select * from finish();
rollback;
