-- Home screen and topic archive (FR-007). A topic is archived instead of deleted: the owner
-- sets archived_at (the trigger stores now()) and may restore it (back to null). A confirmed
-- topic keeps its scope; only its name and archive state change. The home screen reads every
-- topic with its due-card count and last study day through topic_overview().
-- Expand only: a new nullable column, a stricter trigger, one new function.

alter table public.topics add column archived_at timestamptz;

-- Same rules as create_topics_and_subtopics, plus:
-- - a confirmed topic's scope_note cannot change (topic_not_editable, P0409);
-- - archived_at is never written directly: INSERT stores null; on UPDATE null -> a value
--   stores now(), a value -> null restores, a value -> another value keeps the first date.
--   Both statuses can be archived. The name may change in both statuses.
create or replace function public.guard_topic_status()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a topic must be created as a draft' using errcode = 'P0409';
    end if;
    new.confirmed_at := null;
    new.archived_at := null;
    return new;
  end if;

  if new.archived_at is not null then
    if old.archived_at is null then
      new.archived_at := now();
    else
      new.archived_at := old.archived_at;
    end if;
  end if;

  if old.status = 'confirmed' then
    if new.status <> 'confirmed' then
      raise exception 'topic_not_editable' using errcode = 'P0409';
    end if;
    if new.scope_note is distinct from old.scope_note then
      raise exception 'topic_not_editable' using errcode = 'P0409';
    end if;
    new.confirmed_at := old.confirmed_at;
    return new;
  end if;

  if new.status = 'confirmed' then
    select count(*) into v_count from public.subtopics s where s.topic_id = new.id;
    if v_count < 2 or v_count > 10 then
      raise exception 'subtopic_count' using errcode = 'P0422';
    end if;
    new.confirmed_at := now();
  else
    new.confirmed_at := null;
  end if;
  return new;
end;
$$;

-- Archiving replaces deleting a topic (FR-007); deleting the account still cascades to its
-- topics and everything under them.
drop policy "owner can delete" on public.topics;
revoke delete on public.topics from authenticated;

-- Every topic of the caller (active and archived), newest first, with the number of cards
-- due today (Europe/Warsaw) and the last day the topic was studied (null if never).
-- The due predicate mirrors getStudySession (src/lib/topics/study-repository.ts): stage
-- 'choice' or 'open' and due_on by today. Change both together.
create function public.topic_overview()
returns table (
  id uuid,
  name text,
  status text,
  archived_at timestamptz,
  created_at timestamptz,
  due_count integer,
  last_studied_on date
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    t.id,
    t.name,
    t.status,
    t.archived_at,
    t.created_at,
    (
      select count(*)::integer
      from public.flashcards f
      where f.topic_id = t.id
        and f.stage in ('choice', 'open')
        and f.due_on <= (now() at time zone 'Europe/Warsaw')::date
    ),
    (select max(a.answered_on) from public.flashcard_answers a where a.topic_id = t.id)
  from public.topics t
  where t.user_id = (select auth.uid())
  order by t.created_at desc;
$$;

revoke execute on function public.topic_overview() from public;
grant execute on function public.topic_overview() to authenticated;
