-- Open answers (S-06): a card in the open format ('open') is answered in the user's own
-- words, the app server has AI grade it, and answer_flashcard_open records the graded
-- answer and moves the card: correct at streak 0 -> streak 1, due in 3 days; correct at
-- streak 1 -> 'mastered' (it never comes back); wrong -> streak 0, due tomorrow.
-- The log keeps the user's text and the AI's one-sentence justification, so grading can be
-- analysed later. Existing 'choice' rows satisfy the new check as they are, so the
-- migration only expands the schema.
--
-- Verdict trust: p_correct comes from the caller. The app server passes the AI grade, but
-- any signed-in session can call this function over the API with any verdict. That is
-- accepted on purpose: a user who fakes a verdict only bends their own schedule (one
-- account, nothing shared). This function is NOT a security boundary; do not rely on
-- it for anything beyond the caller's own study schedule.

alter table public.flashcard_answers
  add column answer_text text,
  add column feedback text,
  -- A 'choice' answer has the chosen option and no text; an 'open' answer has the user's
  -- text (1-2000 chars) and the AI's justification (1-500 chars) and no option.
  add constraint flashcard_answers_format_fields_check check (
    (format = 'choice' and chosen_index is not null and answer_text is null and feedback is null)
    or (
      format = 'open' and chosen_index is null
      and answer_text is not null and char_length(btrim(answer_text)) between 1 and 2000
      and feedback is not null and char_length(btrim(feedback)) between 1 and 500
    )
  );

-- Records the graded open answer p_answer_text (verdict p_correct, justification
-- p_feedback) to the caller's card and applies the transition above. p_attempt_id is the
-- client's id of the attempt, as in answer_flashcard_choice: a retry returns the stored
-- verdict and justification with the card's current state (stage, open_streak and due_on
-- are null once the card is deleted); an attempt of another card or of the other format
-- raises attempt_conflict.
-- Returns { correct, feedback, stage, open_streak, due_on }.
-- Raises flashcard_not_found / card_not_due / attempt_conflict (P0409) or validation_failed (P0422).
create function public.answer_flashcard_open(
  p_flashcard_id uuid, p_attempt_id uuid, p_answer_text text, p_correct boolean, p_feedback text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_today date := (now() at time zone 'Europe/Warsaw')::date;
  v_topic uuid;
  v_stage text;
  v_open_streak smallint;
  v_due_on date;
  v_replay record;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select a.flashcard_id, a.format, a.correct, a.feedback, f.stage, f.open_streak, f.due_on
  into v_replay
  from public.flashcard_answers a
  left join public.flashcards f on f.id = a.flashcard_id
  where a.id = p_attempt_id and a.user_id = v_user;
  if found then
    if (v_replay.flashcard_id is distinct from p_flashcard_id and v_replay.flashcard_id is not null)
       or v_replay.format <> 'open' then
      raise exception 'attempt_conflict' using errcode = 'P0409', hint = 'attempt_conflict';
    end if;
    return jsonb_build_object('correct', v_replay.correct, 'feedback', v_replay.feedback,
      'stage', v_replay.stage, 'open_streak', v_replay.open_streak, 'due_on', v_replay.due_on);
  end if;

  -- FOR UPDATE serializes answers to one card, so two submissions cannot both apply.
  select f.topic_id, f.stage, f.open_streak, f.due_on
  into v_topic, v_stage, v_open_streak, v_due_on
  from public.flashcards f
  where f.id = p_flashcard_id and f.user_id = v_user
  for update;
  if not found then
    raise exception 'flashcard_not_found' using errcode = 'P0409', hint = 'flashcard_not_found';
  end if;

  -- A concurrent retry of the same attempt may have committed while this one waited for
  -- the lock; return its result instead of failing on the card it already moved.
  select a.flashcard_id, a.format, a.correct, a.feedback, f.stage, f.open_streak, f.due_on
  into v_replay
  from public.flashcard_answers a
  left join public.flashcards f on f.id = a.flashcard_id
  where a.id = p_attempt_id and a.user_id = v_user;
  if found then
    if (v_replay.flashcard_id is distinct from p_flashcard_id and v_replay.flashcard_id is not null)
       or v_replay.format <> 'open' then
      raise exception 'attempt_conflict' using errcode = 'P0409', hint = 'attempt_conflict';
    end if;
    return jsonb_build_object('correct', v_replay.correct, 'feedback', v_replay.feedback,
      'stage', v_replay.stage, 'open_streak', v_replay.open_streak, 'due_on', v_replay.due_on);
  end if;

  if v_stage <> 'open' or v_due_on > v_today then
    raise exception 'card_not_due' using errcode = 'P0409', hint = 'card_not_due';
  end if;

  if p_correct is null
     or p_answer_text is null or char_length(btrim(p_answer_text)) not between 1 and 2000
     or p_feedback is null or char_length(btrim(p_feedback)) not between 1 and 500 then
    raise exception 'validation_failed' using errcode = 'P0422', hint = 'validation_failed';
  end if;

  if p_correct and v_open_streak = 0 then
    v_open_streak := 1;
    v_due_on := v_today + 3;
    update public.flashcards
    set open_streak = v_open_streak, due_on = v_due_on
    where id = p_flashcard_id;
  elsif p_correct then
    -- The second correct answer (on another day, since the first moved due_on 3 days on).
    v_stage := 'mastered';
    update public.flashcards
    set stage = v_stage, mastered_at = now()
    where id = p_flashcard_id;
  else
    v_open_streak := 0;
    v_due_on := v_today + 1;
    update public.flashcards
    set open_streak = v_open_streak, due_on = v_due_on
    where id = p_flashcard_id;
  end if;

  -- An attempt id taken by another account: the raise rolls back the card update too.
  begin
    insert into public.flashcard_answers (
      id, user_id, topic_id, flashcard_id, format, chosen_index, answer_text, feedback, correct, answered_on
    )
    values (
      p_attempt_id, v_user, v_topic, p_flashcard_id, 'open', null, btrim(p_answer_text), btrim(p_feedback),
      p_correct, v_today
    );
  exception when unique_violation then
    raise exception 'attempt_conflict' using errcode = 'P0409', hint = 'attempt_conflict';
  end;

  return jsonb_build_object('correct', p_correct, 'feedback', btrim(p_feedback),
    'stage', v_stage, 'open_streak', v_open_streak, 'due_on', v_due_on);
end;
$$;

revoke execute on function public.answer_flashcard_open(uuid, uuid, text, boolean, text) from public;
grant execute on function public.answer_flashcard_open(uuid, uuid, text, boolean, text) to authenticated;
