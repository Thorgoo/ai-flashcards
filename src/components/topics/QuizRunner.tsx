import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, CircleHelp, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { QuizReviewItem, QuizState, QuizSubtopicResult } from "@/lib/topics/quiz-repository";
import { callApi, type ApiError } from "./api";
import { GeneratingNotice } from "./GeneratingNotice";
import { CONTENT_TYPE_LABELS } from "./labels";

interface Props {
  topicId: string;
  topicName: string;
  initial: QuizState | null;
  autoStart: boolean;
}

type Busy = "generate" | "answer" | null;

const LETTERS = ["A", "B", "C", "D"];
const POLL_MS = 2000;

export default function QuizRunner({ topicId, topicName, initial, autoStart }: Props) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<{ error: ApiError; retry: () => void } | null>(null);
  const started = useRef(false);
  const base = `/api/topics/${topicId}/quiz`;

  // State always comes from the server's answer; a failure keeps the current question.
  async function run(kind: Exclude<Busy, null>, path: string, body?: unknown) {
    setBusy(kind);
    setError(null);
    const result = await callApi<QuizState>(path, "POST", body);
    setBusy(null);
    if (result.ok) {
      setState(result.data);
      return;
    }
    // Another tab (or the request before a reload) is already generating: wait for it.
    if (result.error.code === "quiz_generating") {
      await refresh();
      return;
    }
    setError({ error: result.error, retry: () => void run(kind, path, body) });
  }

  async function refresh() {
    const result = await callApi<QuizState | null>(base, "GET");
    if (result.ok) setState(result.data);
  }

  const generate = () => void run("generate", base);
  const answer = (questionId: string, value: number | "dont_know") =>
    void run("answer", `${base}/answer`, { questionId, answer: value });

  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    // Drop ?start=1 first, so reloading the page while AI works never starts a second call.
    window.history.replaceState(null, "", window.location.pathname);
    generate();
    // Runs once on mount by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generating = busy === "generate" || state?.quiz.status === "generating";

  // A generation started before a reload, or in another tab, finishes on the server; poll
  // until the quiz is ready (or its claim expires and reads as no quiz).
  useEffect(() => {
    if (state?.quiz.status !== "generating" || busy !== null) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
    // refresh only reads base, which is fixed for the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, busy]);

  const question = state?.question ?? null;

  return (
    <div className="space-y-4">
      <a
        href={`/topics/${topicId}`}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" />
        {topicName}
      </a>
      <h1 className="text-2xl font-semibold">Quiz diagnostyczny</h1>

      {generating ? (
        <GeneratingNotice label="AI przygotowuje pytania…" />
      ) : (
        error && (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{error.error.message}</span>
              {error.error.retryable && (
                <Button size="sm" variant="outline" onClick={error.retry}>
                  Spróbuj ponownie
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )
      )}

      {generating ? null : state === null ? (
        <div className="border-border space-y-3 rounded-lg border p-6">
          <p>
            Quiz ma 10 pytań z podtematów tego tematu. Jeśli nie znasz odpowiedzi, wybierz „Nie wiem” — zgadywanie
            zafałszuje diagnozę. Wynik i poprawne odpowiedzi zobaczysz na końcu.
          </p>
          <Button onClick={generate}>Rozpocznij quiz</Button>
        </div>
      ) : question ? (
        <section aria-busy={busy !== null} className="space-y-4">
          <div className="space-y-2">
            <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                Pytanie {state.quiz.answered + 1} z {state.quiz.total}
              </span>
              <Badge variant="outline">{question.subtopicName}</Badge>
            </div>
            <div className="bg-muted h-1.5 overflow-hidden rounded-full">
              <div
                className="bg-primary h-full transition-all"
                style={{ width: `${(100 * state.quiz.answered) / state.quiz.total}%` }}
              />
            </div>
          </div>
          <p className="text-lg font-medium break-words">{question.prompt}</p>
          <div className="grid gap-2">
            {question.options.map((option, i) => (
              <Button
                key={i}
                variant="outline"
                className="h-auto justify-start py-3 text-left whitespace-normal"
                disabled={busy !== null}
                onClick={() => {
                  answer(question.id, i);
                }}
              >
                <span className="text-muted-foreground font-semibold">{LETTERS[i]}</span>
                <span className="break-words">{option}</span>
              </Button>
            ))}
            <Button
              variant="secondary"
              className="justify-start"
              disabled={busy !== null}
              onClick={() => {
                answer(question.id, "dont_know");
              }}
            >
              <CircleHelp />
              Nie wiem
            </Button>
          </div>
        </section>
      ) : (
        <QuizResults results={state.results ?? []} review={state.review ?? []} />
      )}
    </div>
  );
}

function QuizResults({ results, review }: { results: QuizSubtopicResult[]; review: QuizReviewItem[] }) {
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Wynik według podtematów</h2>
        <ul className="space-y-2">
          {results.map((row) => (
            <li key={row.subtopicId} className="border-border bg-card space-y-1 rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 font-medium break-words">{row.name}</span>
                <Badge variant="outline">{CONTENT_TYPE_LABELS[row.contentType]}</Badge>
              </div>
              <p className="text-muted-foreground text-sm">
                Poprawne: {row.correct} z {row.asked} ({row.percent}%)
                {row.dontKnow > 0 && ` · „Nie wiem”: ${row.dontKnow}`}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Twoje odpowiedzi</h2>
        <ol className="space-y-3">
          {review.map((item) => (
            <li key={item.position} className="border-border bg-card space-y-2 rounded-lg border p-3">
              <p className="text-muted-foreground text-xs">
                {item.position + 1}. {item.subtopicName}
              </p>
              <p className="font-medium break-words">{item.prompt}</p>
              <ul className="space-y-1 text-sm">
                {item.options.map((option, i) => {
                  const correct = i === item.correctIndex;
                  const chosen = i === item.answer;
                  return (
                    <li
                      key={i}
                      className={
                        correct ? "text-primary font-semibold" : chosen ? "text-destructive" : "text-muted-foreground"
                      }
                    >
                      <span className="inline-flex items-start gap-1">
                        {correct ? (
                          <Check className="mt-0.5 size-4 shrink-0" />
                        ) : chosen ? (
                          <X className="mt-0.5 size-4 shrink-0" />
                        ) : (
                          <span className="size-4 shrink-0" />
                        )}
                        <span className="break-words">
                          {LETTERS[i]}. {option}
                          {chosen && " — Twoja odpowiedź"}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {item.answer === -1 && <p className="text-muted-foreground text-sm">Twoja odpowiedź: „Nie wiem”</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
