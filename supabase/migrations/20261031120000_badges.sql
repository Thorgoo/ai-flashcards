-- Badges (S-10, FR-024-FR-027): permanent badges of the account for daily-streak milestones
-- (3, 7, 30, 100 days), for the total of mastered flashcards (10, 50, 100, 250) and for each
-- topic whose subtopics are all mastered. A badge is never taken away: not when the streak
-- breaks, a card is deleted or a topic is archived.
-- The mastered total is historical: topic_mastery_tallies counts every move of a card to
-- 'mastered', per topic, and a deleted card does not lower it. Progress is the sum over the
-- active topics, so archiving a topic lowers it and restoring gives it back.
-- Badges are awarded only by sync_badges, from triggers: a new answer (attempt_id = the
-- answer, which the answer route reads back), a deleted card (a topic may become mastered)
-- and a restored topic. answer_flashcard_open updates the card before it inserts the answer,
-- so the answer trigger already sees the new tally. The streak has one source:
-- study_streak() now delegates to study_streak_of(uuid), which the triggers and the
-- backfill call with the account (a migration has no auth.uid()).
-- Owners only read both tables. The owner policies stay for every command as defence in
-- depth (and keep rls_guard's pattern), but the write privileges are revoked.
-- Thresholds mirror src/lib/badges/catalog.ts; change both together.
-- Expand only: two new tables, new functions and triggers, and study_streak() replaced with
-- the same signature and result.

create table public.badges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('streak', 'mastered_cards', 'topic')),
  -- Days of the streak or number of mastered cards; null for a topic badge.
  threshold integer,
  -- The mastered topic; null for the threshold badges.
  topic_id uuid,
  -- The answer (flashcard_answers.id) that earned the badge; null when it was earned by a
  -- deleted card, a restored topic or the backfill.
  attempt_id uuid,
  awarded_at timestamptz not null default now(),
  constraint badges_kind_fields_check check (
    (kind in ('streak', 'mastered_cards') and threshold is not null and threshold > 0 and topic_id is null)
    or (kind = 'topic' and threshold is null and topic_id is not null)
  ),
  foreign key (topic_id, user_id) references public.topics (id, user_id) on delete cascade
);

create index badges_user_id_idx on public.badges (user_id);
create index badges_attempt_id_idx on public.badges (attempt_id);
-- One badge per threshold and one per topic.
create unique index badges_threshold_key on public.badges (user_id, kind, threshold)
  where kind in ('streak', 'mastered_cards');
create unique index badges_topic_key on public.badges (user_id, topic_id) where kind = 'topic';

alter table public.badges enable row level security;

create policy "owner can select" on public.badges
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert" on public.badges
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update" on public.badges
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete" on public.badges
  for delete to authenticated using ((select auth.uid()) = user_id);

create table public.topic_mastery_tallies (
  topic_id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Cards of the topic that ever moved to 'mastered', deleted ones included.
  mastered_count integer not null default 0 check (mastered_count >= 0),
  foreign key (topic_id, user_id) references public.topics (id, user_id) on delete cascade
);

create index topic_mastery_tallies_user_id_idx on public.topic_mastery_tallies (user_id);

alter table public.topic_mastery_tallies enable row level security;

create policy "owner can select" on public.topic_mastery_tallies
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert" on public.topic_mastery_tallies
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update" on public.topic_mastery_tallies
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete" on public.topic_mastery_tallies
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Default privileges grant `authenticated` everything; it may only read.
revoke all on public.badges, public.topic_mastery_tallies from authenticated;
grant select on public.badges, public.topic_mastery_tallies to authenticated;

-- The streak of p_user, as defined in study_streak: always exactly one row. Internal: it
-- reads any account, so only definer functions call it (no execute for authenticated).
create function public.study_streak_of(p_user uuid)
returns table (
  streak_days integer,
  studied_today boolean
)
language sql
stable
security definer
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
    where a.user_id = p_user
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

revoke execute on function public.study_streak_of(uuid) from public, anon, authenticated;

-- Same signature and result as in study_streak. Security definer, because authenticated
-- cannot execute study_streak_of; the account is always the caller's own.
create or replace function public.study_streak()
returns table (
  streak_days integer,
  studied_today boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.streak_days, s.studied_today from public.study_streak_of((select auth.uid())) s;
$$;

revoke execute on function public.study_streak() from public;
grant execute on function public.study_streak() to authenticated;

-- Awards p_user every badge the current state earns, idempotently (a badge already held is
-- kept with its first date and attempt): (a) streak thresholds up to study_streak_of;
-- (b) mastered-card thresholds up to the tally sum over active topics; (c) the badge of
-- p_topic (may be null) when it is active and mastered: it has at least one subtopic, and
-- every subtopic has at least one card and only 'mastered' cards (as in
-- claim_next_flashcard_batch and src/lib/topics/mastery.ts). New badges get p_attempt.
-- An account that no longer exists (its deletion cascading to its cards) gets nothing.
-- Internal: no execute for authenticated.
create function public.sync_badges(p_user uuid, p_topic uuid, p_attempt uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The thresholds; mirrored in src/lib/badges/catalog.ts.
  v_streak_thresholds constant integer[] := array[3, 7, 30, 100];
  v_mastered_thresholds constant integer[] := array[10, 50, 100, 250];
  v_streak integer;
  v_mastered integer;
begin
  if p_user is null then
    return;
  end if;
  perform 1 from auth.users u where u.id = p_user;
  if not found then
    return;
  end if;

  select s.streak_days into v_streak from public.study_streak_of(p_user) s;

  insert into public.badges (user_id, kind, threshold, attempt_id)
  select p_user, 'streak', x.threshold, p_attempt
  from unnest(v_streak_thresholds) as x(threshold)
  where x.threshold <= v_streak
  on conflict do nothing;

  select coalesce(sum(m.mastered_count), 0)::integer into v_mastered
  from public.topic_mastery_tallies m
  join public.topics t on t.id = m.topic_id
  where m.user_id = p_user and t.archived_at is null;

  insert into public.badges (user_id, kind, threshold, attempt_id)
  select p_user, 'mastered_cards', x.threshold, p_attempt
  from unnest(v_mastered_thresholds) as x(threshold)
  where x.threshold <= v_mastered
  on conflict do nothing;

  if p_topic is not null and exists (
    select 1
    from public.topics t
    where t.id = p_topic
      and t.user_id = p_user
      and t.archived_at is null
      and exists (select 1 from public.subtopics s where s.topic_id = t.id)
      and not exists (
        select 1 from public.subtopics s
        where s.topic_id = t.id
          and (
            not exists (select 1 from public.flashcards f where f.subtopic_id = s.id)
            or exists (select 1 from public.flashcards f where f.subtopic_id = s.id and f.stage <> 'mastered')
          )
      )
  ) then
    insert into public.badges (user_id, kind, topic_id, attempt_id)
    values (p_user, 'topic', p_topic, p_attempt)
    on conflict do nothing;
  end if;
end;
$$;

revoke execute on function public.sync_badges(uuid, uuid, uuid) from public, anon, authenticated;

-- A card moved to 'mastered': one more in its topic's tally.
create function public.count_mastered_flashcard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.topic_mastery_tallies (topic_id, user_id, mastered_count)
  values (new.topic_id, new.user_id, 1)
  on conflict (topic_id) do update
  set mastered_count = public.topic_mastery_tallies.mastered_count + 1;
  return null;
end;
$$;

create trigger flashcards_count_mastered
after update of stage on public.flashcards
for each row
when (old.stage <> 'mastered' and new.stage = 'mastered')
execute function public.count_mastered_flashcard();

-- A new answer: the streak, the tally sum and its topic may cross a threshold.
create function public.award_badges_on_answer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sync_badges(new.user_id, new.topic_id, new.id);
  return null;
end;
$$;

create trigger flashcard_answers_award_badges
after insert on public.flashcard_answers
for each row
execute function public.award_badges_on_answer();

-- A deleted card: its topic may now be mastered. When the delete cascades from the topic
-- (or the account) the topic is already gone and nothing is awarded.
create function public.award_badges_on_flashcard_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.topics t where t.id = old.topic_id) then
    perform public.sync_badges(old.user_id, old.topic_id, null);
  end if;
  return null;
end;
$$;

create trigger flashcards_award_badges_on_delete
after delete on public.flashcards
for each row
execute function public.award_badges_on_flashcard_delete();

-- A restored topic: its answers count for the streak again, its tally for the sum, and it
-- may be mastered (badges are not awarded to a topic while it is archived).
create function public.award_badges_on_topic_restore()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sync_badges(new.user_id, new.id, null);
  return null;
end;
$$;

create trigger topics_award_badges_on_restore
after update of archived_at on public.topics
for each row
when (old.archived_at is not null and new.archived_at is null)
execute function public.award_badges_on_topic_restore();

revoke execute on function public.count_mastered_flashcard() from public, anon, authenticated;
revoke execute on function public.award_badges_on_answer() from public, anon, authenticated;
revoke execute on function public.award_badges_on_flashcard_delete() from public, anon, authenticated;
revoke execute on function public.award_badges_on_topic_restore() from public, anon, authenticated;

-- The caller's badge page in one row: the current streak (from study_streak()), the
-- mastered-card progress (tally sum over active topics) and every earned badge as a jsonb
-- array of { kind, threshold, topic_id, topic_name, topic_archived, awarded_at }, oldest
-- first ('[]' when there is none).
create function public.badge_overview()
returns table (
  streak_days integer,
  mastered_cards integer,
  badges jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (select s.streak_days from public.study_streak() s),
    (
      select coalesce(sum(m.mastered_count), 0)::integer
      from public.topic_mastery_tallies m
      join public.topics t on t.id = m.topic_id
      where m.user_id = (select auth.uid()) and t.archived_at is null
    ),
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'kind', b.kind,
            'threshold', b.threshold,
            'topic_id', b.topic_id,
            'topic_name', t.name,
            'topic_archived', t.archived_at is not null,
            'awarded_at', b.awarded_at
          )
          order by b.awarded_at, b.kind, b.threshold, t.name
        )
        from public.badges b
        left join public.topics t on t.id = b.topic_id
        where b.user_id = (select auth.uid())
      ),
      '[]'::jsonb
    );
$$;

revoke execute on function public.badge_overview() from public;
grant execute on function public.badge_overview() to authenticated;

-- Backfill: tallies from the cards mastered now (cards mastered and deleted before this
-- migration cannot be recovered), then every badge the current state earns, dated now and
-- without an attempt. An account without topics has no answers, so nothing to award.
insert into public.topic_mastery_tallies (topic_id, user_id, mastered_count)
select f.topic_id, f.user_id, count(*)::integer
from public.flashcards f
where f.stage = 'mastered'
group by f.topic_id, f.user_id;

do $$
declare
  v_topic record;
begin
  for v_topic in select t.user_id, t.id from public.topics t order by t.user_id, t.created_at loop
    perform public.sync_badges(v_topic.user_id, v_topic.id, null);
  end loop;
end;
$$;
