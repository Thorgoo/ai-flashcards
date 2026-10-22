-- Closes a race in create_topics_and_subtopics: the draft check in the subtopics policies
-- is a plain read, and the FK check's FOR KEY SHARE does not conflict with confirmation's
-- row lock, so an add or delete running alongside a confirm could land after it.
-- This trigger takes FOR SHARE on the topic, which waits for a concurrent confirmation
-- and then sees `confirmed`. It also holds for writes that bypass RLS.
create function public.guard_subtopic_topic_draft()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select t.status into v_status from public.topics t where t.id = old.topic_id for share;
    -- No row: the topic is being deleted in this transaction (cascade); let it go.
    if found and v_status <> 'draft' then
      raise exception 'topic_not_editable' using errcode = 'P0409';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select t.status into v_status from public.topics t where t.id = new.topic_id for share;
    if found and v_status <> 'draft' then
      raise exception 'topic_not_editable' using errcode = 'P0409';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

create trigger subtopics_guard_topic_draft
  before insert or update or delete on public.subtopics
  for each row execute function public.guard_subtopic_topic_draft();
