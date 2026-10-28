-- Fixes answer_flashcard_choice (flashcard_study_state): the attempt lookups selected into
-- the card's own variables, and SELECT INTO without a row sets its targets to null, so the
-- lookup after the card lock wiped the card's correct_index, stage and due_on. A first
-- answer then skipped the due check and failed on the null `correct`. The lookups now read
-- into a record of their own; the behaviour is otherwise unchanged.

-- As in flashcard_study_state.
-- Returns { correct, correct_index, stage, due_on }.
-- Raises flashcard_not_found / card_not_due (P0409) or validation_failed (P0422).
create or replace function public.answer_flashcard_choice(p_flashcard_id uuid, p_answer smallint, p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_today date := (now() at time zone 'Europe/Warsaw')::date;
  v_topic uuid;
  v_correct_index smallint;
  v_stage text;
  v_due_on date;
  v_correct boolean;
  v_replay record;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select a.correct, f.correct_index, f.stage, f.due_on
  into v_replay
  from public.flashcard_answers a
  left join public.flashcards f on f.id = a.flashcard_id
  where a.id = p_attempt_id and a.user_id = v_user;
  if found then
    return jsonb_build_object('correct', v_replay.correct, 'correct_index', v_replay.correct_index,
      'stage', v_replay.stage, 'due_on', v_replay.due_on);
  end if;

  -- FOR UPDATE serializes answers to one card, so two clicks cannot both apply.
  select f.topic_id, f.correct_index, f.stage, f.due_on
  into v_topic, v_correct_index, v_stage, v_due_on
  from public.flashcards f
  where f.id = p_flashcard_id and f.user_id = v_user
  for update;
  if not found then
    raise exception 'flashcard_not_found' using errcode = 'P0409', hint = 'flashcard_not_found';
  end if;

  -- A concurrent retry of the same attempt may have committed while this one waited for
  -- the lock; return its result instead of failing on the card it already moved.
  select a.correct, f.correct_index, f.stage, f.due_on
  into v_replay
  from public.flashcard_answers a
  left join public.flashcards f on f.id = a.flashcard_id
  where a.id = p_attempt_id and a.user_id = v_user;
  if found then
    return jsonb_build_object('correct', v_replay.correct, 'correct_index', v_replay.correct_index,
      'stage', v_replay.stage, 'due_on', v_replay.due_on);
  end if;

  if v_stage <> 'choice' or v_due_on > v_today then
    raise exception 'card_not_due' using errcode = 'P0409', hint = 'card_not_due';
  end if;

  if p_answer is null or p_answer not between 0 and 3 then
    raise exception 'validation_failed' using errcode = 'P0422', hint = 'validation_failed';
  end if;

  v_correct := p_answer = v_correct_index;
  if v_correct then
    v_stage := 'open';
    v_due_on := v_today + 1;
    update public.flashcards
    set stage = v_stage, open_streak = 0, due_on = v_due_on
    where id = p_flashcard_id;
  end if;

  -- An attempt id taken by another account fails here on the primary key (23505).
  insert into public.flashcard_answers (
    id, user_id, topic_id, flashcard_id, format, chosen_index, correct, answered_on
  )
  values (p_attempt_id, v_user, v_topic, p_flashcard_id, 'choice', p_answer, v_correct, v_today);

  return jsonb_build_object('correct', v_correct, 'correct_index', v_correct_index, 'stage', v_stage, 'due_on', v_due_on);
end;
$$;
