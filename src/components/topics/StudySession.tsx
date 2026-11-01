import { useEffect, useId, useRef, useState, useSyncExternalStore, type Ref, type SubmitEvent } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Loader2, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { badgeLabel, type EarnedBadge } from "@/lib/badges/catalog";
import { OPEN_ANSWER_MAX } from "@/lib/topics/schemas";
import type {
  ChoiceResult,
  OpenResult,
  StudyCard as StudyCardData,
  StudySession as StudySessionState,
} from "@/lib/topics/study-repository";
import { cn } from "@/lib/utils";
import { answered, createQueue, current, drop, isDone, type StudyQueue } from "@/lib/topics/study-queue";
import { callApi, type ApiError } from "./api";
import { CONTENT_TYPE_LABELS, openProgressLabel } from "./labels";

interface Props {
  topicId: string;
  topicName: string;
  initial: StudySessionState;
}

// The answer to the card on screen. One attemptId per click ("Sprawdź" for an open card):
// every retry of the save reuses it, so the server records (and grades) the answer once.
type Attempt =
  | {
      format: "choice";
      cardId: string;
      choice: number;
      attemptId: string;
      saved: ChoiceResult | null;
      error: ApiError | null;
    }
  | {
      format: "open";
      cardId: string;
      answerText: string;
      attemptId: string;
      saved: OpenResult | null;
      error: ApiError | null;
    };

type ChoiceAttempt = Extract<Attempt, { format: "choice" }>;
type OpenAttempt = Extract<Attempt, { format: "open" }>;

const LETTERS = ["A", "B", "C", "D"];

// The typed open answer survives a refresh until its grade is saved. Storage can be missing
// or throw (private mode); the session works without it.
const draftKey = (cardId: string) => `study-draft:${cardId}`;

function readDraft(cardId: string): string {
  try {
    return window.sessionStorage.getItem(draftKey(cardId)) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(cardId: string, text: string) {
  try {
    if (text) window.sessionStorage.setItem(draftKey(cardId), text);
    else window.sessionStorage.removeItem(draftKey(cardId));
  } catch {
    // No storage: the draft lives only in the component.
  }
}

function removeDraft(cardId: string) {
  writeDraft(cardId, "");
}

// False while rendering on the server and hydrating, true after: the draft is read only then,
// so the server's HTML and the first client render match.
const noSubscribe = () => () => undefined;
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

export default function StudySession({ topicId, topicName, initial }: Props) {
  const [cards] = useState(() => new Map(initial.cards.map((card) => [card.id, card])));
  const [queue, setQueue] = useState<StudyQueue>(() => createQueue(initial.cards.map((card) => card.id)));
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  // "Przerobione": cards done for this session — a correct A/B/C/D answer or any saved open
  // grade (both take the card off the queue). Skipped cards count separately.
  const [finished, setFinished] = useState(0);
  const [mastered, setMastered] = useState(0);
  const [skipped, setSkipped] = useState(0);
  // Set by quota_exceeded: the open cards left the queue and the message stays for the session.
  const [gradingLimitHit, setGradingLimitHit] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The badges the last saved answer earned; shown like `notice` until the next answer.
  const [earned, setEarned] = useState<EarnedBadge[]>([]);
  // Bumped on every move to another card; the effect below moves the focus there.
  const [step, setStep] = useState(0);
  const focusTarget = useRef<HTMLHeadingElement>(null);
  const hydrated = useHydrated();

  const cardId = current(queue);
  const card = cardId ? cards.get(cardId) : undefined;

  useEffect(() => {
    if (step > 0) focusTarget.current?.focus();
  }, [step]);

  function leave(id: string) {
    setQueue((value) => drop(value, id));
    setAttempt(null);
    setStep((value) => value + 1);
  }

  // A failed save; the queue moves only after the server confirmed one.
  function failed(next: Attempt, error: ApiError) {
    // Deleted in the meantime, or already answered elsewhere (another tab): skip the card.
    if (error.code === "flashcard_not_found" || error.code === "card_not_due") {
      leave(next.cardId);
      setSkipped((value) => value + 1);
      setNotice(
        error.code === "card_not_due"
          ? "Ta fiszka nie czeka już na powtórkę — pomijam ją."
          : "Tej fiszki już nie ma — pomijam ją.",
      );
      return;
    }
    // No more gradings today: drop this and every other open card; the typed text stays in
    // sessionStorage. The queue does not move while an answer is pending, so `queue` is current.
    if (error.code === "quota_exceeded" && next.format === "open") {
      const isOpen = (id: string) => cards.get(id)?.stage === "open";
      setSkipped((value) => value + queue.filter(isOpen).length);
      setQueue((value) => value.filter((id) => !isOpen(id)));
      setGradingLimitHit(true);
      setAttempt(null);
      setStep((value) => value + 1);
      return;
    }
    setAttempt({ ...next, error });
  }

  async function saveChoice(next: ChoiceAttempt) {
    setAttempt({ ...next, error: null });
    const result = await callApi<ChoiceResult>(`/api/topics/${topicId}/study/answer`, "POST", {
      format: "choice",
      cardId: next.cardId,
      answer: next.choice,
      attemptId: next.attemptId,
    });
    if (result.ok) {
      setAttempt({ ...next, saved: result.data, error: null });
      if (result.data.badges.length > 0) setEarned(result.data.badges);
    } else {
      failed(next, result.error);
    }
  }

  async function saveOpen(next: OpenAttempt) {
    setAttempt({ ...next, error: null });
    const result = await callApi<OpenResult>(`/api/topics/${topicId}/study/answer`, "POST", {
      format: "open",
      cardId: next.cardId,
      answerText: next.answerText,
      attemptId: next.attemptId,
    });
    if (result.ok) {
      // The grade is saved: the draft is no longer needed.
      removeDraft(next.cardId);
      setAttempt({ ...next, saved: result.data, error: null });
      if (result.data.badges.length > 0) setEarned(result.data.badges);
    } else {
      failed(next, result.error);
    }
  }

  function save(next: Attempt) {
    if (next.format === "choice") void saveChoice(next);
    else void saveOpen(next);
  }

  function choose(choice: number) {
    if (!card || attempt) return;
    setNotice(null);
    setEarned([]);
    save({ format: "choice", cardId: card.id, choice, attemptId: crypto.randomUUID(), saved: null, error: null });
  }

  function check(answerText: string) {
    if (!card || attempt || !answerText.trim()) return;
    setNotice(null);
    setEarned([]);
    save({ format: "open", cardId: card.id, answerText, attemptId: crypto.randomUUID(), saved: null, error: null });
  }

  function next() {
    if (!attempt?.saved) return;
    if (attempt.format === "choice") {
      // A wrong A/B/C/D card goes to the end and comes back in this session.
      const { correct } = attempt.saved;
      setQueue((value) => answered(value, correct));
      if (correct) setFinished((value) => value + 1);
      setAttempt(null);
      setStep((value) => value + 1);
      return;
    }
    // Any grade takes an open card off the queue; it comes back by its schedule.
    if (attempt.saved.stage === "mastered") setMastered((value) => value + 1);
    setFinished((value) => value + 1);
    leave(attempt.cardId);
  }

  // A save that cannot be retried: leave the card for now; it stays due for the next session.
  function skip() {
    if (!attempt) return;
    setSkipped((value) => value + 1);
    leave(attempt.cardId);
  }

  function retry() {
    // BREAK-CHECK (reverted): a retry sends different text.
    if (attempt) save(attempt.format === "open" ? { ...attempt, answerText: `${attempt.answerText} (ponowione)` } : attempt);
  }

  return (
    <div className="space-y-4">
      <a
        href={`/topics/${topicId}`}
        className="text-muted-foreground hover:text-foreground inline-flex max-w-full items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4 shrink-0" />
        <span className="min-w-0 break-words">{topicName}</span>
      </a>

      {gradingLimitHit && (
        <Alert role="status">
          <AlertDescription>Limit ocen na dziś wyczerpany — fiszki otwarte wrócą jutro.</AlertDescription>
        </Alert>
      )}

      {notice && (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {earned.length > 0 && (
        <Alert role="status">
          <AlertDescription>
            {earned.length === 1 ? (
              <p>Zdobyto odznakę: {badgeLabel(earned[0])}</p>
            ) : (
              <>
                <p>Zdobyto odznaki:</p>
                <ul className="list-disc pl-5">
                  {earned.map((badge) => (
                    <li key={`${badge.kind}:${badge.threshold ?? badge.topicId ?? ""}`}>{badgeLabel(badge)}</li>
                  ))}
                </ul>
              </>
            )}
            <a href="/badges" className="text-foreground underline underline-offset-4">
              Zobacz odznaki
            </a>
          </AlertDescription>
        </Alert>
      )}

      {isDone(queue) || !card ? (
        <section className="border-border space-y-3 rounded-lg border p-6">
          <h1 ref={focusTarget} tabIndex={-1} className="text-2xl font-semibold outline-none">
            Na dziś wszystko
          </h1>
          {finished === 0 && skipped === 0 ? (
            <p>Nie masz dziś fiszek do powtórki.</p>
          ) : (
            <div className="space-y-1">
              <p>Przerobione fiszki: {finished}</p>
              {mastered > 0 && <p>Opanowane dziś: {mastered}</p>}
              {skipped > 0 && <p>Pominięte: {skipped}</p>}
            </div>
          )}
          <Button asChild variant="outline" className="min-h-11">
            <a href={`/topics/${topicId}`}>Wróć do tematu</a>
          </Button>
        </section>
      ) : card.stage === "open" ? (
        <OpenCard
          // Remounted once after hydration, so the draft is read on the client only.
          key={`${card.id}:${step}:${hydrated}`}
          card={card}
          remaining={queue.length}
          attempt={attempt?.format === "open" ? attempt : null}
          restoreDraft={hydrated}
          frontRef={focusTarget}
          onCheck={check}
          onRetry={retry}
          onSkip={skip}
          onNext={next}
        />
      ) : (
        <ChoiceCard
          key={`${card.id}:${step}`}
          card={card}
          remaining={queue.length}
          attempt={attempt?.format === "choice" ? attempt : null}
          frontRef={focusTarget}
          onChoose={choose}
          onRetry={retry}
          onSkip={skip}
          onNext={next}
        />
      )}
    </div>
  );
}

function ChoiceCard({
  card,
  remaining,
  attempt,
  frontRef,
  onChoose,
  onRetry,
  onSkip,
  onNext,
}: {
  card: StudyCardData;
  remaining: number;
  attempt: ChoiceAttempt | null;
  frontRef: Ref<HTMLHeadingElement>;
  onChoose: (choice: number) => void;
  onRetry: () => void;
  onSkip: () => void;
  onNext: () => void;
}) {
  // The result shows at once from the card; once saved, the server's correctIndex wins.
  const correctIndex = attempt?.saved?.correctIndex ?? card.correctIndex;
  return (
    <section aria-busy={attempt !== null && !attempt.saved && !attempt.error} className="space-y-4">
      <CardHeader card={card} remaining={remaining} />
      <h1 ref={frontRef} tabIndex={-1} className="text-lg font-medium break-words outline-none">
        {card.front}
      </h1>
      <div className="grid gap-2">
        {card.options.map((option, i) => {
          const isCorrect = attempt !== null && i === correctIndex;
          const isWrong = attempt !== null && i === attempt.choice && i !== correctIndex;
          return (
            <Button
              key={i}
              variant={isCorrect ? "default" : isWrong ? "destructive" : "outline"}
              className={cn(
                "h-auto min-h-11 w-full justify-start py-3 text-left whitespace-normal",
                isCorrect && "bg-success text-success-foreground disabled:opacity-100",
                isWrong && "disabled:opacity-100",
              )}
              disabled={attempt !== null}
              onClick={() => {
                onChoose(i);
              }}
            >
              <span className="font-semibold">{LETTERS[i]}</span>
              <span className="min-w-0 flex-1 break-words">{option}</span>
              {isCorrect && <Check aria-label="Poprawna odpowiedź" />}
              {isWrong && <X aria-label="Twoja odpowiedź" />}
            </Button>
          );
        })}
      </div>

      {attempt && <CardDetails card={card} />}
      {attempt?.error && <SaveError error={attempt.error} onRetry={onRetry} onSkip={onSkip} />}
      {attempt && (
        <NextBar
          pending={!attempt.saved && !attempt.error}
          pendingLabel="Zapisuję…"
          saved={!!attempt.saved}
          onNext={onNext}
        />
      )}
    </section>
  );
}

function OpenCard({
  card,
  remaining,
  attempt,
  restoreDraft,
  frontRef,
  onCheck,
  onRetry,
  onSkip,
  onNext,
}: {
  card: StudyCardData;
  remaining: number;
  attempt: OpenAttempt | null;
  restoreDraft: boolean;
  frontRef: Ref<HTMLHeadingElement>;
  onCheck: (answerText: string) => void;
  onRetry: () => void;
  onSkip: () => void;
  onNext: () => void;
}) {
  const [text, setText] = useState(() => (restoreDraft ? readDraft(card.id) : ""));
  const fieldId = useId();
  const counterId = useId();
  // Once sent, the text is the attempt's: a retry grades exactly what was sent.
  const value = attempt?.answerText ?? text;
  const grading = attempt !== null && !attempt.saved && !attempt.error;

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    onCheck(text);
  }

  return (
    <section aria-busy={grading} className="space-y-4">
      <CardHeader card={card} remaining={remaining} />
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">{openProgressLabel(card.openStreak)}</p>
        <h1 ref={frontRef} tabIndex={-1} className="text-lg font-medium break-words outline-none">
          {card.front}
        </h1>
      </div>

      <form onSubmit={submit} className="space-y-2">
        <Label htmlFor={fieldId}>Twoja odpowiedź</Label>
        <Textarea
          id={fieldId}
          value={value}
          maxLength={OPEN_ANSWER_MAX}
          readOnly={attempt !== null}
          aria-describedby={counterId}
          className="min-h-32 break-words"
          onChange={(event) => {
            setText(event.target.value);
            writeDraft(card.id, event.target.value);
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span id={counterId} className="text-muted-foreground text-xs">
            {value.length}/{OPEN_ANSWER_MAX}
          </span>
          {!attempt && (
            <Button type="submit" className="min-h-11" disabled={!text.trim()}>
              Sprawdź
            </Button>
          )}
        </div>
      </form>

      {attempt?.saved && (
        <div className="space-y-3">
          <div className="border-border bg-card space-y-2 rounded-lg border p-3">
            <p
              className={cn(
                "inline-flex items-center gap-2 font-semibold",
                attempt.saved.correct ? "text-success" : "text-destructive",
              )}
            >
              {attempt.saved.correct ? <Check className="size-4" /> : <X className="size-4" />}
              {attempt.saved.correct ? "Dobrze" : "Niepoprawnie"}
            </p>
            <p className="text-sm break-words whitespace-pre-line">{attempt.saved.feedback}</p>
            {attempt.saved.stage === "mastered" && <p className="text-success text-sm font-medium">Fiszka opanowana</p>}
          </div>
          <CardDetails card={card} />
        </div>
      )}
      {attempt?.error && <SaveError error={attempt.error} onRetry={onRetry} onSkip={onSkip} />}
      {attempt && <NextBar pending={grading} pendingLabel="Oceniam…" saved={!!attempt.saved} onNext={onNext} />}
    </section>
  );
}

function CardHeader({ card, remaining }: { card: StudyCardData; remaining: number }) {
  return (
    <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="min-w-0 break-words">{card.subtopicName}</span>
      <span>Pozostało: {remaining}</span>
    </div>
  );
}

// The reference answer, the example (vocabulary) and "Czytaj więcej", shown after answering.
function CardDetails({ card }: { card: StudyCardData }) {
  return (
    <div className="border-border bg-card space-y-3 rounded-lg border p-3">
      <div className="space-y-1 text-sm">
        <p className="text-muted-foreground text-xs">Wzorcowa odpowiedź</p>
        <p className="break-words whitespace-pre-line">{card.answer}</p>
      </div>
      {card.contentType === "vocabulary" && card.example && (
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground text-xs">Przykładowe zdanie</p>
          <p className="break-words italic">{card.example}</p>
        </div>
      )}
      <Collapsible className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="group min-h-11">
              <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
              Czytaj więcej
            </Button>
          </CollapsibleTrigger>
          <Badge variant="outline">{CONTENT_TYPE_LABELS[card.contentType]}</Badge>
        </div>
        <CollapsibleContent>
          <p className="text-muted-foreground text-sm break-words whitespace-pre-line">{card.explanation}</p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// Retryable errors (network, AI, save_failed) retry the same attempt; the rest skip the card.
function SaveError({ error, onRetry, onSkip }: { error: ApiError; onRetry: () => void; onSkip: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{error.message}</span>
        {error.retryable ? (
          <Button size="sm" variant="outline" className="min-h-11" onClick={onRetry}>
            Spróbuj ponownie
          </Button>
        ) : error.code === "unauthenticated" ? (
          <Button size="sm" variant="outline" className="min-h-11" asChild>
            <a href="/auth/signin">Zaloguj się</a>
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="min-h-11" onClick={onSkip}>
            Pomiń
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

function NextBar({
  pending,
  pendingLabel,
  saved,
  onNext,
}: {
  pending: boolean;
  pendingLabel: string;
  saved: boolean;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {pending && (
        <span role="status" className="text-muted-foreground inline-flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {pendingLabel}
        </span>
      )}
      <Button className="min-h-11" disabled={!saved} onClick={onNext}>
        Dalej
        <ArrowRight />
      </Button>
    </div>
  );
}
