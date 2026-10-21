# supabase/ — database guide

## Every table belongs to an account

- Each table in `public` follows the owned-table pattern shown in `@tests/database/account_isolation.test.sql` (the `isolation_probe` table): `user_id` defaulting to `auth.uid()` with `on delete cascade`, RLS enabled, and one policy per command for `authenticated` comparing `(select auth.uid())` to `user_id`. Copy the shape; do not invent a variant. Index `user_id`.
- `@tests/database/rls_guard.test.sql` fails CI for any `public` table that breaks this pattern. An exemption waives one named check for one table in its `rls_guard_exceptions` list, with a one-line reason; never weaken the query.
- When you add a table, extend `account_isolation.test.sql` with the same assertions for it: account B sees none of A's rows, cannot update/delete them, cannot insert as A.
- `anon` has no default privileges in `public`, and new functions get no `PUBLIC` execute (first migration). The app always queries as `authenticated`; do not grant `anon` or `public` anything.

## Migrations

- Create with `npx supabase migration new <name>`; never edit a migration that is already on `main` or pushed; add a new one.
- Keep migrations backward compatible (expand, then contract later) — a Worker rollback must not meet an incompatible schema.
- `npx supabase db push` to production is a human step; never run it.

## Testing

`npm run db:reset` and `npm run db:test` need Docker, which the main dev machine does not have. CI (`smoke` job → `Database tests`) runs them on every PR — push and read that step's output.
