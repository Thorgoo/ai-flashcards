import { useEffect, useRef, useState, type Ref } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Loader2, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { FlashcardView } from "@/lib/topics/flashcard-repository";
import type { ChoiceResult, StudySession as StudySessionState } from "@/lib/topics/study-repository";
import { cn } from "@/lib/utils";
import { answered, createQueue, current, drop, isDone, type StudyQueue } from "@/lib/topics/study-queue";
import { callApi, type ApiError } from "./api";
import { CONTENT_TYPE_LABELS } from "./labels";

interface Props {
  topicId: string;
  topicName: string;
  initial: StudySessionState;
}

// The answer to the card on screen. One attemptId per click: every retry of the save reuses it,
// so the server records the answer once.
interface Attempt {
  cardId: string;
  choice: number;
  attemptId: string;
  saved: ChoiceResult | null;
  error: ApiError | null;
}

const LETTERS = ["A", "B", "C", "D"];

export default function StudySession({ topicId, topicName, initial }: Props) {
  // Open-format cards are left out until the open-answer UI lands (S-06, phase 3).
  const [choiceCards] = useState(() => initial.cards.filter((card) => card.stage === "choice"));
  const [cards] = useState(() => new Map(choiceCards.map((card) => [card.id, card])));
  const [queue, setQueue] = useState<StudyQueue>(() => createQueue(choiceCards.map((card) => card.id)));
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [finished, setFinished] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped on every move to another card; the effect below moves the focus there.
  const [step, setStep] = useState(0);
  const focusTarget = useRef<HTMLHeadingElement>(null);

  const cardId = current(queue);
  const card = cardId ? cards.get(cardId) : undefined;

  useEffect(() => {
    if (step > 0) focusTarget.current?.focus();
  }, [step]);

  // The queue moves only after the server confirmed the save, by the server's verdict.
  async function save(next: Attempt) {
    setAttempt({ ...next, error: null });
    const result = await callApi<ChoiceResult>(`/api/topics/${topicId}/study/answer`, "POST", {
      format: "choice",
      cardId: next.cardId,
      answer: next.choice,
      attemptId: next.attemptId,
    });
    if (result.ok) {
      setAttempt({ ...next, saved: result.data, error: null });
      return;
    }
    // Deleted in the meantime, or already answered elsewhere (another tab): skip the card.
    if (result.error.code === "flashcard_not_found" || result.error.code === "card_not_due") {
      setQueue((value) => drop(value, next.cardId));
      setAttempt(null);
      setNotice(
        result.error.code === "card_not_due"
          ? "Ta fiszka nie czeka już na powtórkę — pomijam ją."
          : "Tej fiszki już nie ma — pomijam ją.",
      );
      setStep((value) => value + 1);
      return;
    }
    setAttempt({ ...next, error: result.error });
  }

  function choose(choice: number) {
    if (!card || attempt) return;
    setNotice(null);
    void save({ cardId: card.id, choice, attemptId: crypto.randomUUID(), saved: null, error: null });
  }

  function next() {
    if (!attempt?.saved) return;
    const { correct } = attempt.saved;
    setQueue((value) => answered(value, correct));
    if (correct) setFinished((value) => value + 1);
    setAttempt(null);
    setStep((value) => value + 1);
  }

  // A save that cannot be retried: leave the card for now; it stays due for the next session.
  function skip() {
    if (!attempt) return;
    setQueue((value) => drop(value, attempt.cardId));
    setAttempt(null);
    setStep((value) => value + 1);
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

      {notice && (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {isDone(queue) || !card ? (
        <section className="border-border space-y-3 rounded-lg border p-6">
          <h1 ref={focusTarget} tabIndex={-1} className="text-2xl font-semibold outline-none">
            Na dziś wszystko
          </h1>
          <p>{finished === 0 ? "Nie masz dziś fiszek do powtórki." : `Przerobione fiszki: ${finished}`}</p>
          <Button asChild variant="outline">
            <a href={`/topics/${topicId}`}>Wróć do tematu</a>
          </Button>
        </section>
      ) : (
        <StudyCard
          key={`${card.id}:${step}`}
          card={card}
          remaining={queue.length}
          attempt={attempt}
          frontRef={focusTarget}
          onChoose={choose}
          onRetry={() => {
            if (attempt) void save(attempt);
          }}
          onSkip={skip}
          onNext={next}
        />
      )}
    </div>
  );
}

function StudyCard({
  card,
  remaining,
  attempt,
  frontRef,
  onChoose,
  onRetry,
  onSkip,
  onNext,
}: {
  card: FlashcardView;
  remaining: number;
  attempt: Attempt | null;
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
      <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="min-w-0 break-words">{card.subtopicName}</span>
        <span>Pozostało: {remaining}</span>
      </div>
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

      {attempt && (
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
                <Button variant="ghost" size="sm" className="group">
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
      )}

      {attempt?.error && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{attempt.error.message}</span>
            {attempt.error.retryable ? (
              <Button size="sm" variant="outline" onClick={onRetry}>
                Spróbuj ponownie
              </Button>
            ) : attempt.error.code === "unauthenticated" ? (
              <Button size="sm" variant="outline" asChild>
                <a href="/auth/signin">Zaloguj się</a>
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={onSkip}>
                Pomiń
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {attempt && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {!attempt.saved && !attempt.error && (
            <span role="status" className="text-muted-foreground inline-flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Zapisuję…
            </span>
          )}
          <Button className="min-h-11" disabled={!attempt.saved} onClick={onNext}>
            Dalej
            <ArrowRight />
          </Button>
        </div>
      )}
    </section>
  );
}
