-- Every AI call an account makes, one row per call. It is both the daily limit counter
-- (20 generations / 100 gradings per Europe/Warsaw calendar day, counted regardless of
-- outcome) and the AI error log. Owners can only read their rows; all writes go through
-- begin_ai_call / finish_ai_call, so an account cannot reset its own counter.
create table public.ai_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('generation', 'grading')),
  task text not null,
  model text not null,
  status text not null default 'pending' check (status in ('pending', 'ok', 'failed')),
  error_code text,
  latency_ms integer,
  input_tokens integer,
  output_tokens integer,
  called_on date not null,
  created_at timestamptz not null default now()
);

create index ai_calls_user_kind_day_idx on public.ai_calls (user_id, kind, called_on);

alter table public.ai_calls enable row level security;

create policy "owner can select" on public.ai_calls
  for select to authenticated using ((select auth.uid()) = user_id);

-- Default privileges grant `authenticated` everything; it may only read.
revoke all on public.ai_calls from authenticated;
grant select on public.ai_calls to authenticated;

-- Reserves one call for the signed-in account, or raises `ai_quota_exceeded` (P0429)
-- when today's limit for that kind is used up. Call it before contacting the AI provider.
create function public.begin_ai_call(p_kind text, p_task text, p_model text)
returns table (call_id uuid, remaining integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_today date := (now() at time zone 'Europe/Warsaw')::date;
  v_limit integer;
  v_used integer;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  v_limit := case p_kind when 'generation' then 20 when 'grading' then 100 end;
  if v_limit is null then
    raise exception 'unknown AI call kind: %', p_kind using errcode = '22023';
  end if;

  -- Serialize concurrent calls of one account and kind, so two requests at 19/20
  -- cannot both pass the check.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || p_kind, 0));

  select count(*) into v_used
  from public.ai_calls c
  where c.user_id = v_user and c.kind = p_kind and c.called_on = v_today;

  if v_used >= v_limit then
    raise exception 'ai_quota_exceeded' using errcode = 'P0429';
  end if;

  insert into public.ai_calls (user_id, kind, task, model, called_on)
  values (v_user, p_kind, p_task, p_model, v_today)
  returning id into call_id;

  remaining := v_limit - v_used - 1;
  return next;
end;
$$;

-- Records the outcome of a reserved call. Only the owner's pending row changes;
-- anything else is a silent no-op.
create function public.finish_ai_call(
  p_call_id uuid,
  p_status text,
  p_error_code text,
  p_latency_ms integer,
  p_input_tokens integer,
  p_output_tokens integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('ok', 'failed') then
    raise exception 'invalid AI call status: %', p_status using errcode = '22023';
  end if;

  update public.ai_calls
  set
    status = p_status,
    error_code = p_error_code,
    latency_ms = p_latency_ms,
    input_tokens = p_input_tokens,
    output_tokens = p_output_tokens
  where id = p_call_id and user_id = auth.uid() and status = 'pending';
end;
$$;
