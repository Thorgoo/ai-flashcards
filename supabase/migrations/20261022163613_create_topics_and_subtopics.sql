-- Topics and their subtopics (S-02). A topic starts as a draft whose subtopic list the
-- owner may edit; confirming it locks the list for good. The lock is enforced here, not
-- only in the API: subtopic writes pass RLS only while their topic is a draft, and a
-- trigger guards the status transition.
create table public.topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) >= 1 and char_length(name) <= 100),
  scope_note text check (char_length(scope_note) <= 500),
  status text not null default 'draft' check (status in ('draft', 'confirmed')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  -- Target of the subtopics composite foreign key.
  unique (id, user_id)
);

create index topics_user_id_idx on public.topics (user_id);

alter table public.topics enable row level security;

create policy "owner can select" on public.topics
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert" on public.topics
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update" on public.topics
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete" on public.topics
  for delete to authenticated using ((select auth.uid()) = user_id);

create table public.subtopics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  topic_id uuid not null,
  name text not null check (char_length(btrim(name)) >= 1 and char_length(name) <= 100),
  content_type text not null check (content_type in ('conceptual', 'vocabulary')),
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  -- Foreign key checks bypass RLS, so a plain topic_id reference would let one account
  -- attach rows to another account's topic. Pairing it with user_id prevents that.
  foreign key (topic_id, user_id) references public.topics (id, user_id) on delete cascade
);

create unique index subtopics_topic_name_key on public.subtopics (topic_id, lower(name));
create index subtopics_topic_position_idx on public.subtopics (topic_id, position);
create index subtopics_user_id_idx on public.subtopics (user_id);

alter table public.subtopics enable row level security;

create policy "owner can select" on public.subtopics
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert while draft" on public.subtopics
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.topics t where t.id = topic_id and t.status = 'draft')
  );
create policy "owner can update while draft" on public.subtopics
  for update to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (select 1 from public.topics t where t.id = topic_id and t.status = 'draft')
  )
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.topics t where t.id = topic_id and t.status = 'draft')
  );
create policy "owner can delete while draft" on public.subtopics
  for delete to authenticated using (
    (select auth.uid()) = user_id
    and exists (select 1 from public.topics t where t.id = topic_id and t.status = 'draft')
  );

-- A topic is created as a draft and may only move draft -> confirmed, with 2-10 subtopics.
-- Confirmation is permanent. confirmed_at is set here and cannot be written directly.
create function public.guard_topic_status()
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
    return new;
  end if;

  if old.status = 'confirmed' then
    if new.status <> 'confirmed' then
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

create trigger topics_guard_status
  before insert or update on public.topics
  for each row execute function public.guard_topic_status();

-- Replaces a draft topic's whole subtopic list in one transaction (AI generation and
-- regeneration), so a failure never leaves a partial list. Runs with the caller's rights:
-- RLS applies. A missing, foreign or confirmed topic raises topic_not_editable (P0409);
-- a list outside 1-10 items raises subtopic_count (P0422).
create function public.replace_subtopics(p_topic_id uuid, p_subtopics jsonb)
returns setof public.subtopics
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.topics t where t.id = p_topic_id and t.status = 'draft' for update;
  if not found then
    raise exception 'topic_not_editable' using errcode = 'P0409';
  end if;

  -- Two checks, not one `or`: SQL does not promise to evaluate the type check first.
  if jsonb_typeof(p_subtopics) is distinct from 'array' then
    raise exception 'subtopic_count' using errcode = 'P0422';
  end if;
  if jsonb_array_length(p_subtopics) not between 1 and 10 then
    raise exception 'subtopic_count' using errcode = 'P0422';
  end if;

  delete from public.subtopics s where s.topic_id = p_topic_id;

  insert into public.subtopics (topic_id, name, content_type, position)
  select p_topic_id, item.name, item.content_type, (item.ord - 1)::integer
  from jsonb_to_recordset(p_subtopics) with ordinality as item(name text, content_type text, ord bigint);

  return query
    select * from public.subtopics s where s.topic_id = p_topic_id order by s.position;
end;
$$;
