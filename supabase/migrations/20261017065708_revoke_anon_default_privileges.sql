-- The app always queries the database as a signed-in user (role `authenticated`),
-- so `anon` never needs access to app objects. Revoking its default privileges
-- means a future table with forgotten RLS is still unreadable without logging in.
-- Applies to objects created by `postgres`, the role migrations run as.
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;
-- New functions also get EXECUTE for PUBLIC, which anon inherits. That default is
-- global, so it can only be revoked without IN SCHEMA — this also covers functions
-- `postgres` creates in other schemas (e.g. via `create extension`); grant those explicitly.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public grant execute on functions to authenticated, service_role;
