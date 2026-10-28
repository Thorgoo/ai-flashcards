import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, GraduationCap, Layers, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { FlashcardState, FlashcardView } from "@/lib/topics/flashcard-repository";
import { callApi, type ApiError } from "./api";
import { Confirmation } from "./Confirmation";
import { GeneratingNotice } from "./GeneratingNotice";
import { CONTENT_TYPE_LABELS, studyLabel } from "./labels";

interface Props {
  topicId: string;
  topicName: string;
  initial: FlashcardState | null;
  autoStart: boolean;
  // Due cards counted by the page; null when counting failed or the batch was generated here.
  dueCount: number | null;
}

type Busy = "generate" | "delete" | null;

const LETTERS = ["A", "B", "C", "D"];
const POLL_MS = 2000;

export default function FlashcardBatch({ topicId, topicName, initial, autoStart, dueCount }: Props) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<{ error: ApiError; retry: () => void } | null>(null);
  const started = useRef(false);
  const base = `/api/topics/${topicId}/flashcards`;

  // State always comes from the server's answer; a failure keeps the current cards.
  async function run(kind: Exclude<Busy, null>, path: string, method: string) {
    setBusy(kind);
    setError(null);
    const result = await callApi<FlashcardState | null>(path, method);
    setBusy(null);
    if (result.ok) {
      setState(result.data);
      return;
    }
    // Another tab (or the request before a reload) is generating or already finished: show its batch.
    if (result.error.code === "batch_generating" || result.error.code === "batch_exists") {
      await refresh();
      return;
    }
    setError({ error: result.error, retry: () => void run(kind, path, method) });
  }

  async function refresh() {
    const result = await callApi<FlashcardState | null>(base, "GET");
    if (result.ok) setState(result.data);
  }

  const generate = () => void run("generate", base, "POST");
  const remove = (cardId: string) => void run("delete", `${base}/${cardId}`, "DELETE");

  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    // Drop ?start=1 first, so reloading the page while AI works never starts a second call.
    window.history.replaceState(null, "", window.location.pathname);
    generate();
    // Runs once on mount by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generating = busy === "generate" || state?.batch.status === "generating";

  // A generation started before a reload, or in another tab, finishes on the server; poll
  // until the batch is ready (or its claim expires and reads as no batch).
  useEffect(() => {
    if (state?.batch.status !== "generating" || busy !== null) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
    // refresh only reads base, which is fixed for the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, busy]);

  return (
    <div className="space-y-4">
      <a
        href={`/topics/${topicId}`}
        className="text-muted-foreground hover:text-foreground inline-flex max-w-full items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4 shrink-0" />
        <span className="min-w-0 break-words">{topicName}</span>
      </a>
      <h1 className="text-2xl font-semibold">Fiszki</h1>

      {generating ? (
        <GeneratingNotice label="AI przygotowuje fiszki…" />
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
            Partia ma 10 fiszek z podtematów tego tematu. Więcej fiszek dostaną podtematy, które w quizie poszły Ci
            najsłabiej, ale każdy podtemat dostanie co najmniej jedną.
          </p>
          <Button onClick={generate}>
            <Layers />
            Wygeneruj fiszki
          </Button>
        </div>
      ) : state.cards.length === 0 ? (
        <p className="border-border text-muted-foreground rounded-lg border p-6 text-center">
          Ta partia nie ma już fiszek.
        </p>
      ) : (
        <div aria-busy={busy !== null} className="space-y-6">
          <p className="text-muted-foreground text-sm">Fiszki w partii: {state.cards.length}</p>
          {groupBySubtopic(state.cards).map((group) => (
            <section key={group[0].subtopicId} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="min-w-0 text-lg font-semibold break-words">{group[0].subtopicName}</h2>
                <Badge variant="outline">{CONTENT_TYPE_LABELS[group[0].contentType]}</Badge>
              </div>
              <ul className="space-y-3">
                {group.map((card) => (
                  <FlashcardItem
                    key={card.id}
                    card={card}
                    disabled={busy !== null}
                    onDelete={() => {
                      remove(card.id);
                    }}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {!generating && state?.batch.status === "ready" && (
        <Button asChild>
          <a href={`/topics/${topicId}/study`}>
            <GraduationCap />
            {studyLabel(dueCount)}
          </a>
        </Button>
      )}
    </div>
  );
}

// Cards arrive sorted by subtopic (getFlashcardState), so consecutive runs are the groups.
function groupBySubtopic(cards: FlashcardView[]): FlashcardView[][] {
  const groups: FlashcardView[][] = [];
  for (const card of cards) {
    const last = groups.at(-1);
    if (last?.[0].subtopicId === card.subtopicId) last.push(card);
    else groups.push([card]);
  }
  return groups;
}

function FlashcardItem(props: { card: FlashcardView; disabled: boolean; onDelete: () => void }) {
  const { card } = props;
  return (
    <li className="border-border bg-card space-y-3 rounded-lg border p-3">
      <p className="font-medium break-words">{card.front}</p>
      <ul className="space-y-1 text-sm">
        {card.options.map((option, i) => {
          const correct = i === card.correctIndex;
          return (
            <li key={i} className={correct ? "text-primary font-semibold" : "text-muted-foreground"}>
              <span className="inline-flex items-start gap-1">
                {correct ? <Check className="mt-0.5 size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
                <span className="min-w-0 break-words">
                  {LETTERS[i]}. {option}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
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
          <Confirmation
            trigger={
              <Button variant="ghost" size="sm" disabled={props.disabled}>
                <Trash2 />
                Usuń
              </Button>
            }
            title="Usunąć fiszkę?"
            description="Fiszka zostanie usunięta na stałe i nie da się jej przywrócić."
            action="Usuń"
            onConfirm={props.onDelete}
          />
        </div>
        <CollapsibleContent>
          <p className="text-muted-foreground text-sm break-words whitespace-pre-line">{card.explanation}</p>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
