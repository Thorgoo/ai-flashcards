-- Daily study streak of the account. A study day is a Europe/Warsaw day with at least one
-- flashcard answer (flashcard_answers.answered_on) on a topic that is not archived; answers
-- on archived topics do not count, and count again once the topic is restored. The streak
-- is the run of consecutive study days ending today, or yesterday when today is not a study
-- day yet: it stays alive until the end of the day after the last study day. Days after
-- today are ignored. No study day today or yesterday means no streak: (0, false).
-- S-10 reads the streak from this function; do not count it anywhere else.
-- Expand only: one new function.

-- Always exactly one row: the streak length in days and whether today is a study day.
create function public.study_streak()
returns table (
  streak_days integer,
  studied_today boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with clock as (
    select (now() at time zone 'Europe/Warsaw')::date as today
  ),
  study_days as (
    select distinct a.answered_on as day
    from public.flashcard_answers a
    join public.topics t on t.id = a.topic_id
    cross join clock c
    where a.user_id = (select auth.uid())
      and t.archived_at is null
      and a.answered_on <= c.today
  ),
  -- Consecutive days share one run key (gaps and islands).
  runs as (
    select d.day, d.day - (row_number() over (order by d.day))::integer as run
    from study_days d
  ),
  latest as (
    select r.day, r.run from runs r order by r.day desc limit 1
  )
  select
    -- 0 when the latest study day is before yesterday (or there is none).
    (
      select count(*)::integer
      from runs r
      join latest l on l.run = r.run
      where l.day >= c.today - 1
    ),
    exists (select 1 from study_days d where d.day = c.today)
  from clock c;
$$;

revoke execute on function public.study_streak() from public;
grant execute on function public.study_streak() to authenticated;
